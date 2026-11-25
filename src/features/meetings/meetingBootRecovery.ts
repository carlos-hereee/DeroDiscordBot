import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IMeeting } from "@db/models/Meeting.js";
import { meetingConsentStore } from "@db/stores/meetingConsentStore.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { meetingSummaryJobStore } from "@db/stores/meetingSummaryJobStore.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { removeWithdrawnWords, retryOwedWithdrawals } from "./meetingConsent.js";
import { endMeeting, finishEndedMeeting, isEndInFlight, retryOwedEnds, retryOwedUndos } from "./meetingLifecycle.js";
import { failSummarizingMeeting, retryOwedTakeBacks } from "./summaryResult.js";

// ── meetingBootRecovery ─────────────────────────────────────────────────────
// What:  finishes what a restart or a failed write left of a meeting. recoverInterruptedMeetings
//        ends every meeting a restart cut off (2026-11 item 388, assumption A3): a recording lives
//        in this process's memory (the recorder, its clocks), so a Railway deploy or a crash
//        leaves its row marked recording with nothing behind it, and each such row ends as
//        interrupted through the one end path, which summarizes the segments already written
//        (each chunk is persisted as it is made, so at most one unflushed chunk per speaker was
//        lost) or says nothing was recorded. runMeetingRepairs (2026-11 item 420) finishes the
//        rest: ends, undos, withdrawals and taken back summaries whose write failed here, meetings
//        stuck summarizing, and, once after a boot, the removals of words a restart cut off.
// Who:   main.ts, once after the client is ready (both), and ReminderScheduler's guarded minute
//        tick (runMeetingRepairs).
// Why a live session is skipped: recovery runs once at boot, before any recording can start,
//        so in practice no meeting has one; the check keeps a late call from ending a meeting
//        this process did start.
// How a repair never races a live end: a meeting is touched only past REPAIR_GRACE_MS, with no end
//        of it in flight here, and every write is conditional, so this process and an older one
//        Railway still runs beside it do each repair once.

const MS_PER_DAY = 86_400_000;

/** End every recording meeting with no live session as interrupted. Returns how many it ended. */
export async function recoverInterruptedMeetings(client: Client): Promise<number> {
	const stranded = await meetingStore.findAllRecording();
	let ended = 0;
	for (const meeting of stranded) {
		if (voiceSessions.get(meeting.guildId)?.meetingId === meeting.meetingId) continue;
		try {
			if (await endMeeting(client, meeting.guildId, meeting.meetingId, "interrupted")) ended += 1;
		}
		catch (error) {
			console.error(`[meetings] boot recovery failed guild=${meeting.guildId} meeting=${meeting.meetingId}`, error instanceof Error ? error.name : "unknown");
		}
	}
	if (stranded.length > 0) console.info(`[meetings] boot recovery ended=${ended} of ${stranded.length}`);
	return ended;
}

// ── the repair pass ─────────────────────────────────────────────────────────

let isRepairing = false;
// The removals a restart cut off are looked for until one whole look succeeds: the minute tick can
// reach the pass before the boot call does, and a failed read must not lose them.
let bootRemovalsPending = true;

/**
 * One pass over everything still owed. Withdrawals go first, so nothing after them reads a
 * consent that was already taken back. Never throws, and never runs beside itself.
 */
export async function runMeetingRepairs(client: Client, now: Date = new Date()): Promise<void> {
	if (isRepairing) return;
	isRepairing = true;
	try {
		await attempt("withdrawals", retryOwedWithdrawals);
		await attempt("undone starts", retryOwedUndos);
		await attempt("ends", () => retryOwedEnds(client));
		await attempt("taken back summaries", retryOwedTakeBacks);
		if (bootRemovalsPending) await attempt("removals cut off by a restart", () => finishCutOffRemovals(now));
		await attempt("stuck meetings", () => repairStuckMeetings(client, now));
	}
	finally {
		isRepairing = false;
	}
}

async function attempt(what: string, repair: () => Promise<void>): Promise<void> {
	try {
		await repair();
	}
	catch (error) {
		console.error(`[meetings] repair failed: ${what}`, error instanceof Error ? error.name : "unknown");
	}
}

// A member revoked and still on an open meeting's speaker list is a removal that never finished,
// since the speaker entry goes last. Past the transcript's life there are no words left to remove.
async function finishCutOffRemovals(now: Date): Promise<void> {
	const endedAfter = new Date(now.getTime() - BOT_CONSTANTS.MEETINGS.TRANSCRIPT_TTL_DAYS * MS_PER_DAY);
	const speakersByGuild = new Map<string, Set<string>>();
	for (const meeting of await meetingStore.findOpenWithSpeakers(endedAfter)) {
		const speakers = speakersByGuild.get(meeting.guildId) ?? new Set<string>();
		meeting.speakerIds.forEach((userId) => speakers.add(userId));
		speakersByGuild.set(meeting.guildId, speakers);
	}
	let allRemoved = true;
	for (const [guildId, speakers] of speakersByGuild) {
		for (const userId of await meetingConsentStore.findRevokedIds(guildId, [...speakers])) {
			if (!(await removeWithdrawnWords(guildId, userId))) allRemoved = false;
		}
	}
	bootRemovalsPending = !allRemoved;
}

async function repairStuckMeetings(client: Client, now: Date): Promise<void> {
	const before = new Date(now.getTime() - BOT_CONSTANTS.MEETINGS.REPAIR_GRACE_MS);
	for (const meeting of await meetingStore.findSummarizingEndedBefore(before)) {
		if (isEndInFlight(meeting.meetingId)) continue;
		await attempt(`meeting=${meeting.meetingId}`, () => repairStuckMeeting(client, meeting, before));
	}
}

// ① no job: the end was cut off before it, so make it, or close the meeting as nothing recorded;
// ② a failed job whose meeting was never told; ③ a job closed as done whose summary was never
// written. A waiting or leased job is simply not summarized yet.
async function repairStuckMeeting(client: Client, meeting: IMeeting, before: Date): Promise<void> {
	const { guildId, meetingId } = meeting;
	const job = await meetingSummaryJobStore.findForMeeting(guildId, meetingId);
	if (!job) return finishEndedMeeting(client, guildId, meetingId);
	if (job.updatedAt && new Date(job.updatedAt) > before) return;
	if (job.status === "failed") return failSummarizingMeeting(client, guildId, meetingId, job.failureCode ?? "attempts");
	if (job.status === "done" && !meeting.summary) await meetingSummaryJobStore.reopenDone(job.jobId);
}

/** Forget a pass under way and look for cut off removals again. Tests only. */
export function _resetMeetingRepairs(): void {
	isRepairing = false;
	bootRemovalsPending = true;
}
