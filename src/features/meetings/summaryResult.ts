import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/index.js";
import type { IMeeting, IMeetingSummary } from "@db/models/Meeting.js";
import type { IMeetingSummaryJob } from "@db/models/MeetingSummaryJob.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { meetingSummaryJobStore } from "@db/stores/meetingSummaryJobStore.js";
import { syncCardMessage, type CardPayload } from "@utils/cardMessage.js";
import { createActionItemTodos } from "./actionItemsToTodos.js";
import { removeWithdrawnWords, withdrawnAmong } from "./meetingConsent.js";
import { buildFailedNotesCard, buildSummaryCard } from "./notesCard.js";
import { matchAssignee, resolveSpeakerNames } from "./speakerNames.js";

// ── summaryResult ───────────────────────────────────────────────────────────
// What:  the result side of the meeting summary contract (2026-11 item 388 Phase 4): the
//        strict guard on what the launcher posts, and what an accepted result does: the
//        summary written onto the Meeting row, the notes card edited in place, one todo per
//        action item. Also the one way a summary job fails, with an honest card line.
// Who:   POST /brain/meeting-summary/result (api/routes/meetingSummary.routes.ts) and
//        summaryJobs (a job that cannot be worked). The launcher's twin of SummaryResult is
//        meetingSummaryResultSchema in dev-launcher src/dero/brainContracts.ts.
// How:   the lease is checked FIRST, by the conditional write that closes it, so a result
//        for a lease a member's Stop recording me reset (or a second result for one job) is
//        refused before anything is written. A withdrawal can land after the lease closed, when
//        no reset can refuse the result, so every speaker's consent is checked before the summary
//        is written and once more after it, before any todo or card (2026-11 item 420, L5). The
//        summary is kept in the language it was written in; the bot translates nothing.
// Does NOT: log the summary, a decision or an action item; logs carry ids, counts and codes.

const MEETINGS = BOT_CONSTANTS.MEETINGS;
// Ids are utils/shortId values; the bound is loose so a longer id is still read, not refused.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// A launcher failure code is a short snake case word, stored and logged as is.
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const OK_KEYS = ["jobId", "leaseId", "ok", "summary", "decisions", "actionItems"];
const FAILED_KEYS = ["jobId", "leaseId", "ok", "code"];
const ACTION_ITEM_KEYS = ["text", "assignee"];

/** A result the guard accepted: the summary, or the launcher saying it could not write one. */
export type SummaryResult =
	| { jobId: string; leaseId: string; ok: true; summary: string; decisions: string[]; actionItems: Array<{ text: string; assignee: string | null }> }
	| { jobId: string; leaseId: string; ok: false; code: string };

export type ParsedSummaryResult = { ok: true; value: SummaryResult } | { ok: false; reason: string };

export type SummaryOutcome = "accepted" | "not_found";

// ── the guard (the bot has no zod, so this is written out like parseBrainResult) ──

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Exactly these own keys, no more and no fewer: an extra key is a contract drift to refuse.
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

const isId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);

function readActionItems(value: unknown): Array<{ text: string; assignee: string | null }> | null {
	if (!Array.isArray(value) || value.length > MEETINGS.MAX_ACTION_ITEMS) return null;
	const items: Array<{ text: string; assignee: string | null }> = [];
	for (const item of value as unknown[]) {
		if (!isRecord(item) || !hasExactKeys(item, ACTION_ITEM_KEYS)) return null;
		if (!isText(item.text, MEETINGS.ITEM_MAX_CHARS)) return null;
		if (item.assignee !== null && !isText(item.assignee, MEETINGS.ITEM_MAX_CHARS)) return null;
		items.push({ text: item.text.trim(), assignee: item.assignee === null ? null : item.assignee.trim() });
	}
	return items;
}

/** The strict guard on a posted result. A reason code, never the body, on refusal. */
export function parseSummaryResult(body: unknown): ParsedSummaryResult {
	if (!isRecord(body)) return { ok: false, reason: "not_object" };
	if (!isId(body.jobId) || !isId(body.leaseId)) return { ok: false, reason: "bad_id" };
	if (body.ok === false) {
		if (!hasExactKeys(body, FAILED_KEYS)) return { ok: false, reason: "bad_keys" };
		if (typeof body.code !== "string" || !CODE_PATTERN.test(body.code)) return { ok: false, reason: "bad_code" };
		return { ok: true, value: { jobId: body.jobId, leaseId: body.leaseId, ok: false, code: body.code } };
	}
	if (body.ok !== true || !hasExactKeys(body, OK_KEYS)) return { ok: false, reason: "bad_keys" };
	if (!isText(body.summary, MEETINGS.SUMMARY_MAX_CHARS)) return { ok: false, reason: "bad_summary" };
	const decisions = readDecisions(body.decisions);
	if (!decisions) return { ok: false, reason: "bad_decisions" };
	const actionItems = readActionItems(body.actionItems);
	if (!actionItems) return { ok: false, reason: "bad_action_items" };
	return { ok: true, value: { jobId: body.jobId, leaseId: body.leaseId, ok: true, summary: body.summary.trim(), decisions, actionItems } };
}

function readDecisions(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > MEETINGS.MAX_DECISIONS) return null;
	const decisions: string[] = [];
	for (const decision of value as unknown[]) {
		if (!isText(decision, MEETINGS.ITEM_MAX_CHARS)) return null;
		decisions.push(decision.trim());
	}
	return decisions;
}

// ── writing the outcome ─────────────────────────────────────────────────────

async function guildContext(guildId: string): Promise<{ copy: ReturnType<typeof getPluginCopy>; todosChannelId: string | null }> {
	const config = await guildConfigStore.findByGuildId(guildId);
	return { copy: getPluginCopy(config as unknown as ICopyConfig | null), todosChannelId: config?.todosChannelId ?? null };
}

// Fire and forget after the primary write (house rule 7): a card Discord refuses never
// turns a written summary back into a failure.
async function showNotesCard(client: Client, meeting: IMeeting, payload: CardPayload): Promise<void> {
	if (!meeting.notesChannelId) return;
	try {
		const messageId = await syncCardMessage(client, meeting.notesChannelId, meeting.notesMessageId, payload);
		if (messageId && messageId !== meeting.notesMessageId) await meetingStore.update(meeting.guildId, meeting.meetingId, { notesMessageId: messageId });
	} catch (error) {
		console.error(`[meetings] notes card could not be drawn meeting=${meeting.meetingId}`, error instanceof Error ? error.name : "unknown");
	}
}

/**
 * The meeting's side of a failed job: status failed and the card line, once. Also
 * meetingBootRecovery's, for a job whose meeting was never told.
 */
export async function failSummarizingMeeting(client: Client, guildId: string, meetingId: string, code: string): Promise<void> {
	const meeting = await meetingStore.claimTransition(guildId, meetingId, "summarizing", { status: "failed" });
	if (!meeting) return;
	const { copy } = await guildContext(guildId);
	await showNotesCard(client, meeting, buildFailedNotesCard(meeting, copy, code));
}

/**
 * Fail a summary job whatever its lease (the attempt cap, an expired or emptied transcript),
 * and say so on its meeting's notes card.
 */
export async function failSummaryJob(client: Client, job: Pick<IMeetingSummaryJob, "jobId" | "guildId" | "meetingId">, code: string): Promise<void> {
	await meetingSummaryJobStore.markFailed(job.jobId, code);
	await failSummarizingMeeting(client, job.guildId, job.meetingId, code);
	console.warn(`[meetings] summary job failed job=${job.jobId} guild=${job.guildId} code=${code}`);
}

// The launcher could not write it: try again on the next claim, until the attempts run out.
async function acceptFailure(client: Client, job: IMeetingSummaryJob, result: Extract<SummaryResult, { ok: false }>): Promise<SummaryOutcome> {
	if (job.attempts < MEETINGS.SUMMARY_MAX_ATTEMPTS) {
		const released = await meetingSummaryJobStore.releaseLease(job.jobId, result.leaseId);
		console.warn(`[meetings] summary attempt failed job=${job.jobId} code=${result.code} attempt=${job.attempts} retry=${released}`);
		return released ? "accepted" : "not_found";
	}
	const closed = await meetingSummaryJobStore.finishLease(job.jobId, result.leaseId, { status: "failed", failureCode: result.code });
	if (!closed) return "not_found";
	await failSummarizingMeeting(client, job.guildId, job.meetingId, result.code);
	console.warn(`[meetings] summary job failed job=${job.jobId} code=${result.code} attempt=${job.attempts}`);
	return "accepted";
}

// Memory only: summaries whose taking back failed to write, for the repair pass. Nothing durable
// marks one, since a summarized meeting keeps its notes when a speaker withdraws later.
const owedTakeBacks = new Map<string, { job: IMeetingSummaryJob; withdrawn: readonly string[] }>();

// The snapshot's speakers who withdrew, or null when that cannot be read, which is a no.
async function readWithdrawn(guildId: string, speakerIds: readonly string[]): Promise<readonly string[] | null> {
	return withdrawnAmong(guildId, speakerIds).catch((error: unknown) => {
		console.error(`[meetings] consent unreadable, summary refused guild=${guildId}`, error instanceof Error ? error.name : "unknown");
		return null;
	});
}

// Hand the meeting back for a summary without the withdrawn members: their words first, and only
// then the job, its attempt given back. A removal that fails keeps the job closed, so nothing is
// claimed over words still owed a removal; the repair pass finishes both.
async function reopenWithout(job: IMeetingSummaryJob, withdrawn: readonly string[]): Promise<void> {
	let allRemoved = true;
	for (const userId of withdrawn) if (!(await removeWithdrawnWords(job.guildId, userId))) allRemoved = false;
	if (!allRemoved) return;
	await meetingSummaryJobStore.reopenDone(job.jobId).catch((error: unknown) =>
		console.error(`[meetings] refused job not reopened, kept for the repair pass job=${job.jobId}`, error instanceof Error ? error.name : "unknown")
	);
}

async function takeSummaryBack(job: IMeetingSummaryJob, withdrawn: readonly string[]): Promise<void> {
	try {
		// Null means the meeting was deleted or taken back already, and then nothing is owed.
		const takenBack = await meetingStore.claimTransition(job.guildId, job.meetingId, "done", { status: "summarizing", summary: null });
		owedTakeBacks.delete(job.meetingId);
		if (!takenBack) return;
	}
	catch (error) {
		owedTakeBacks.set(job.meetingId, { job, withdrawn });
		console.error(`[meetings] summary not taken back, kept for the repair pass meeting=${job.meetingId}`, error instanceof Error ? error.name : "unknown");
		return;
	}
	await reopenWithout(job, withdrawn);
}

/** Retry every summary whose taking back failed. meetingBootRecovery's repair pass. */
export async function retryOwedTakeBacks(): Promise<void> {
	for (const { job, withdrawn } of [...owedTakeBacks.values()]) await takeSummaryBack(job, withdrawn);
}

async function acceptSummary(client: Client, job: IMeetingSummaryJob, result: Extract<SummaryResult, { ok: true }>): Promise<SummaryOutcome> {
	// ① everything slow is read first, so no Discord call sits between closing the lease and
	// writing the summary. The speakers are a snapshot: a withdrawal takes its member off the row;
	const current = await meetingStore.findById(job.guildId, job.meetingId);
	const heard = current?.speakerIds ?? [];
	const speakers = await resolveSpeakerNames(client, job.guildId, heard);

	// ② close the lease; a reset or reclaimed lease, or a job already answered, stops here;
	const closed = await meetingSummaryJobStore.finishLease(job.jobId, result.leaseId, { status: "done", failureCode: null });
	if (!closed) return "not_found";
	if (!current) return "accepted";

	// ③ nobody heard may have withdrawn by now, then match each assignee and write the summary once;
	const withdrawn = await readWithdrawn(job.guildId, heard);
	if (withdrawn === null || withdrawn.length > 0) {
		await reopenWithout(job, withdrawn ?? []);
		return "not_found";
	}
	const summary: IMeetingSummary = {
		text: result.summary,
		decisions: result.decisions,
		actionItems: result.actionItems.map((item) => ({ text: item.text, assigneeName: item.assignee, assigneeId: matchAssignee(item.assignee, speakers) })),
	};
	const meeting = await meetingStore.claimTransition(job.guildId, job.meetingId, "summarizing", { status: "done", summary });
	if (!meeting) return "accepted";

	// ④ once more now it is written: a withdrawal since ③ found no lease to reset. One after this
	// is of a meeting already summarized, which keeps its notes (D1 sub answer);
	const withdrawnSince = await readWithdrawn(job.guildId, heard);
	if (withdrawnSince === null || withdrawnSince.length > 0) {
		await takeSummaryBack(job, withdrawnSince ?? []);
		return "not_found";
	}

	// ⑤ the todos, then the card that points at them; neither undoes the summary.
	const { copy, todosChannelId } = await guildContext(job.guildId);
	const created = await createActionItemTodos(client, meeting).catch((error: unknown) => {
		console.error(`[meetings] action item todos could not be made meeting=${meeting.meetingId}`, error instanceof Error ? error.name : "unknown");
		return 0;
	});
	await showNotesCard(client, meeting, buildSummaryCard(meeting, copy, todosChannelId));
	console.info(
		`[meetings] summary accepted job=${job.jobId} meeting=${meeting.meetingId} decisions=${summary.decisions.length} items=${summary.actionItems.length} todos=${created}`
	);
	return "accepted";
}

/**
 * Apply a result the guard accepted. "not_found" for a job that is unknown, or no longer
 * leased under the result's leaseId (answered already, reclaimed, or reset by a member's
 * withdrawal), or whose speakers include one who withdrew; "accepted" otherwise.
 */
export async function acceptSummaryResult(client: Client, result: SummaryResult): Promise<SummaryOutcome> {
	const job = await meetingSummaryJobStore.findByJobId(result.jobId);
	if (!job || job.status !== "leased" || job.leaseId !== result.leaseId) return "not_found";
	return result.ok ? acceptSummary(client, job, result) : acceptFailure(client, job, result);
}
