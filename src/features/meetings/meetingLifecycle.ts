import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type Client, type Guild, type GuildMember, type RepliableInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy, type ICopyConfig, type IPluginCopy } from "@base/copy/index.js";
import type { IMeeting, MeetingEndReason } from "@db/models/Meeting.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { meetingSummaryJobStore } from "@db/stores/meetingSummaryJobStore.js";
import { meetingTranscriptStore } from "@db/stores/meetingTranscriptStore.js";
import { cancelRemindersFor } from "@features/reminders/dueReminders.js";
import { isTtsKeyConfigured } from "@features/voice/elevenLabsTts.js";
import { refund, tryReserve, type SpendReservation } from "@features/voice/spendMeter.js";
import { VOICE_PRIORITY_CATEGORIES } from "@features/voice/voicePriority.js";
import { voiceQueue } from "@features/voice/voiceQueue.js";
import { voiceSessions, type CallEnded, type ListenStart, type StartListening } from "@features/voice/voiceSessions.js";
import { editCardMessage, syncCardMessage, type CardPayload } from "@utils/cardMessage.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { shortId } from "@utils/shortId.js";
import { showNotice } from "@utils/textModal.js";
import { postConsentNotice, registerConsentButtons } from "./consentNotice.js";
import { consentingMembers } from "./meetingConsent.js";
import { isMeetingHost } from "./meetingHosts.js";
import { defaultMeetingRecorderDeps, getMeetingRecorder, PREPAID_CENTS, startMeetingRecorder } from "./meetingRecorder.js";
import { buildRemovedNotesCard } from "./notesCard.js";
import { cancelScheduledMeeting, meetingCustomId, MEETING_ACTIONS, redrawScheduledMeetingCard, useRecordingControls } from "./scheduledMeetings.js";

// ── meetingLifecycle ────────────────────────────────────────────────────────
// What:  the start and the end of a Meeting Hall recording (2026-11 item 388 Phase 3).
//        startMeeting checks the host and the server, marks the Meeting row recording (the
//        scheduled row when started from its card), joins through the one join path
//        (voiceQueue.requestVoice, then commands/utility/dero.ts runQueuedJoin) in meeting
//        mode, posts the consent notice and the live card. endMeeting is the ONE way a meeting
//        stops, whatever stopped it: it flushes the recorder, leaves the call, edits the live
//        card into the notes card and queues one summary job.
// Who:   the Start recording and End recording buttons (through scheduledMeetings'
//        useRecordingControls), /meeting start and end, the recorder's spend refusal,
//        voiceSessions.onEnd (any session end), meetingPresence (the empty room) and
//        meetingBootRecovery (a restart).
// How an end happens once: every path calls endMeeting, whose first step is a conditional
//        write from recording to summarizing; the second caller's write matches nothing and it
//        returns. So End pressed as the time cap fires, or a leave this function makes itself
//        landing back here through onEnd, ends the meeting exactly once.
// Does NOT: summarize. Phase 4's launcher claims the job; this only creates it.

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const SECONDS = (ms: number): number => Math.floor(ms / 1000);
const MAX_HOURS = BOT_CONSTANTS.MEETINGS.MAX_MS / MS_PER_HOUR;
const EMPTY_MINUTES = BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS / MS_PER_MINUTE;
const MONGO_DUPLICATE_KEY = 11000;

/** Why Start recording was refused, each with its own line naming the fix. */
export type StartRefusal = "notHost" | "noChannel" | "noHall" | "notInHall" | "voiceOff" | "unavailable" | "busyElsewhere" | "alreadyRecording" | "joinFailed" | "notScheduled";
export type StartResult = { ok: true; meeting: IMeeting } | { ok: false; reason: StartRefusal; busyChannelId?: string };

interface LiveMeeting {
	guildId: string;
	meetingId: string;
	hallId: string;
	notesChannelId: string;
	title: string;
	hostId: string;
	copy: IPluginCopy;
	maxTimer: ReturnType<typeof setTimeout>;
	emptyTimer: ReturnType<typeof setTimeout> | null;
	// Members already asked in this meeting, so a member who leaves and comes back is pinged once.
	pinged: Set<string>;
}

// Memory only, keyed by guild (one recording per guild, held by the Meeting partial unique
// index). A restart loses it, and meetingBootRecovery ends every meeting it held.
const live = new Map<string, LiveMeeting>();

/** The recording in this guild that this process is running, or null. meetingPresence reads it. */
export function liveMeetingIn(guildId: string): Readonly<Pick<LiveMeeting, "meetingId" | "hallId" | "notesChannelId" | "title" | "hostId" | "copy" | "pinged">> | null {
	return live.get(guildId) ?? null;
}

// ── the cards ───────────────────────────────────────────────────────────────

const quiet = { parse: [], users: [], roles: [] } as CardPayload["allowedMentions"];

/** The live card, with End recording. Exported for the tests. */
export function buildLiveCard(meeting: IMeeting, copy: IPluginCopy): CardPayload {
	const words = copy.meetingRecording;
	const started = SECONDS(new Date(meeting.startedAt ?? Date.now()).getTime());
	return {
		embeds: [infoEmbed(words.live.title(meeting.title), words.live.description(meeting.hostId, started, MAX_HOURS, EMPTY_MINUTES), copy.COLORS.SCHEDULE)],
		components: [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(meetingCustomId(MEETING_ACTIONS.end, meeting.meetingId)).setLabel(words.endButton).setEmoji("⏹️").setStyle(ButtonStyle.Danger)
			),
		],
		allowedMentions: quiet,
	};
}

/** The line a notes card gives for how the recording ended. */
export function endReasonLine(reason: MeetingEndReason, copy: IPluginCopy): string {
	const lines = copy.meetingRecording.endReasons;
	return reason === "cap_time" ? lines.cap_time(MAX_HOURS) : lines[reason];
}

/** The notes card as the recording ends: pending its summary, or saying nothing was recorded. Exported for the tests. */
export function buildEndedCard(meeting: IMeeting, copy: IPluginCopy, recorded: boolean): CardPayload {
	const words = copy.meetingRecording.notes;
	const reason = meeting.endReason ? endReasonLine(meeting.endReason, copy) : "";
	const minutes = Math.max(1, Math.round((new Date(meeting.endedAt ?? 0).getTime() - new Date(meeting.startedAt ?? 0).getTime()) / MS_PER_MINUTE));
	const body = recorded ? words.pending(minutes, meeting.speakerIds.length) : words.nothing;
	return { embeds: [infoEmbed(words.title(meeting.title), [reason, body].filter(Boolean).join("\n\n"), copy.COLORS.SCHEDULE)], components: [], allowedMentions: quiet };
}

// ── timers and the empty room ───────────────────────────────────────────────

function clearTimers(state: LiveMeeting): void {
	clearTimeout(state.maxTimer);
	if (state.emptyTimer) clearTimeout(state.emptyTimer);
	state.emptyTimer = null;
}

function humansInHall(guild: Guild, hallId: string): string[] {
	const channel = guild.channels.cache.get(hallId);
	if (!channel?.isVoiceBased()) return [];
	return [...channel.members.values()].filter((member) => !member.user.bot).map((member) => member.id);
}

/**
 * Recount who in 🏛️ Meeting Hall agreed, and arm or clear the empty room end (D22): the
 * meeting ends EMPTY_ROOM_END_MS after no member who agreed remains. Run at start, on every
 * hall join and leave (meetingPresence) and on every consent change (consentNotice). At start
 * nobody may have agreed yet, so the same clock gives the room that long to answer.
 */
export async function checkRoom(client: Client, guildId: string): Promise<void> {
	const state = live.get(guildId);
	if (!state) return;
	const guild = client.guilds.cache.get(guildId);
	if (!guild) return;
	const agreed = await consentingMembers(guildId, humansInHall(guild, state.hallId));
	if (live.get(guildId) !== state) return;
	if (agreed.size > 0) {
		if (state.emptyTimer) clearTimeout(state.emptyTimer);
		state.emptyTimer = null;
		return;
	}
	if (state.emptyTimer) return;
	state.emptyTimer = setTimeout(() => void endMeeting(client, guildId, state.meetingId, "empty_room"), BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS);
	state.emptyTimer.unref?.();
}

// ── start ───────────────────────────────────────────────────────────────────

interface StartChecks {
	notesChannelId: string;
	hallId: string;
	copy: IPluginCopy;
}

// ① to ⑥, with nothing written and nothing spent.
async function checkStart(guild: Guild, host: GuildMember): Promise<{ ok: true; checks: StartChecks } | { ok: false; reason: StartRefusal; busyChannelId?: string }> {
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!config?.meetingNotesChannelId) return { ok: false, reason: "noChannel" };
	if (!(await isMeetingHost(host, guild))) return { ok: false, reason: "notHost" };
	const hallId = config.meetingVoiceChannelId;
	if (!hallId) return { ok: false, reason: "noHall" };
	if (host.voice.channelId !== hallId) return { ok: false, reason: "notInHall" };
	const voice = await deroVoiceConfigStore.findByGuildId(guild.id);
	if (!voice) return { ok: false, reason: "unavailable" };
	if (!voice.enabled) return { ok: false, reason: "voiceOff" };
	if (!isTtsKeyConfigured()) return { ok: false, reason: "unavailable" };
	// D5: one call per guild and nothing queued. A recording already running is its own line.
	const session = voiceSessions.get(guild.id);
	if (session) return session.mode === "meeting" ? { ok: false, reason: "alreadyRecording" } : { ok: false, reason: "busyElsewhere", busyChannelId: session.channelId };
	if (await meetingStore.findRecording(guild.id)) return { ok: false, reason: "alreadyRecording" };
	return { ok: true, checks: { notesChannelId: config.meetingNotesChannelId, hallId, copy: getPluginCopy(config as unknown as ICopyConfig) } };
}

// Mark the meeting recording: the scheduled row in one conditional write, or a new row. The
// partial unique index (one recording per guild) refuses a second start that raced this one.
async function claimRecording(guildId: string, hostId: string, notesChannelId: string, input: { title?: string; scheduledMeetingId?: string }, startedAt: Date): Promise<IMeeting | StartRefusal> {
	try {
		if (input.scheduledMeetingId) {
			const claimed = await meetingStore.claimTransition(guildId, input.scheduledMeetingId, "scheduled", { status: "recording", hostId, startedAt, notesChannelId, spentCents: PREPAID_CENTS });
			return claimed ?? "notScheduled";
		}
		return await meetingStore.insert({
			meetingId: shortId(),
			guildId,
			title: (input.title ?? "").trim().slice(0, BOT_CONSTANTS.MEETINGS.TITLE_MAX) || startedAt.toISOString().slice(0, 10),
			status: "recording",
			endReason: null,
			hostId,
			scheduledFor: null,
			rsvpIds: [],
			startedAt,
			endedAt: null,
			speakerIds: [],
			notesChannelId,
			notesMessageId: null,
			scheduleMessageId: null,
			summary: null,
			sttSeconds: 0,
			spentCents: PREPAID_CENTS,
		});
	}
	catch (error) {
		if ((error as { code?: number } | null)?.code === MONGO_DUPLICATE_KEY) return "alreadyRecording";
		throw error;
	}
}

// Undo a claim whose join never landed: a scheduled row goes back to scheduled, a new row goes.
async function releaseClaim(meeting: IMeeting, fromScheduled: boolean): Promise<void> {
	if (fromScheduled) await meetingStore.claimTransition(meeting.guildId, meeting.meetingId, "recording", { status: "scheduled", startedAt: null, spentCents: 0 });
	else await meetingStore.remove(meeting.guildId, meeting.meetingId);
}

// The join, through the one join path. requestVoice drains at once because Dero is free, so the
// runner has run by the time it resolves; a request left waiting is taken out, because D5 queues
// no meeting.
async function joinHall(guild: Guild, hostId: string, checks: StartChecks, meetingId: string): Promise<boolean> {
	await voiceQueue.requestVoice({ guild, requesterId: hostId, channelId: checks.hallId, controlChannelId: checks.notesChannelId, category: "meeting-hall", meeting: { meetingId } });
	for (const request of voiceQueue.list(guild.id, VOICE_PRIORITY_CATEGORIES)) {
		if (request.meeting?.meetingId === meetingId) voiceQueue.remove(guild.id, request.id);
	}
	return voiceSessions.get(guild.id)?.meetingId === meetingId;
}

/**
 * Start recording in 🏛️ Meeting Hall: ① to ⑥ the checks, ⑦ the first cent reserved (a spent
 * cap refuses here), ⑧ the row marked recording, ⑨ the join in meeting mode, ⑩ the consent
 * notice, the live card and the clocks. A step that fails undoes the ones before it.
 */
export async function startMeeting(client: Client, guild: Guild, host: GuildMember, input: { title?: string; scheduledMeetingId?: string }): Promise<StartResult> {
	const checked = await checkStart(guild, host);
	if (!checked.ok) return checked;
	const { checks } = checked;

	const prepaid = await reservePrepaid(guild.id);
	if (!prepaid) return { ok: false, reason: "unavailable" };
	const claimed = await claimRecording(guild.id, host.id, checks.notesChannelId, input, new Date());
	if (typeof claimed === "string") {
		await refund(prepaid).catch(() => undefined);
		return { ok: false, reason: claimed };
	}

	const joined = await joinHall(guild, host.id, checks, claimed.meetingId).catch(() => false);
	if (!joined) {
		await releaseClaim(claimed, Boolean(input.scheduledMeetingId));
		await refund(prepaid).catch(() => undefined);
		return { ok: false, reason: "joinFailed" };
	}

	const state: LiveMeeting = {
		guildId: guild.id,
		meetingId: claimed.meetingId,
		hallId: checks.hallId,
		notesChannelId: checks.notesChannelId,
		title: claimed.title,
		hostId: host.id,
		copy: checks.copy,
		maxTimer: setTimeout(() => void endMeeting(client, guild.id, claimed.meetingId, "cap_time"), BOT_CONSTANTS.MEETINGS.MAX_MS),
		emptyTimer: null,
		pinged: new Set(humansInHall(guild, checks.hallId)),
	};
	state.maxTimer.unref?.();
	live.set(guild.id, state);
	// The call can end between the join and this line; its onEnd found no live meeting, so the
	// end is made here instead of leaving a row marked recording with nothing behind it.
	if (voiceSessions.get(guild.id)?.meetingId !== claimed.meetingId) {
		await endMeeting(client, guild.id, claimed.meetingId, "session_end");
		return { ok: false, reason: "joinFailed" };
	}

	await postConsentNotice(client, checks.notesChannelId, checks.copy, { meetingId: claimed.meetingId, title: claimed.title, hostId: host.id, memberIds: [...state.pinged] });
	const liveMessageId = await syncCardMessage(client, checks.notesChannelId, null, buildLiveCard(claimed, checks.copy));
	const meeting = (liveMessageId ? await meetingStore.update(guild.id, claimed.meetingId, { notesMessageId: liveMessageId }) : null) ?? claimed;
	// A scheduled meeting started: its card loses its buttons and its "starts soon" reminders go.
	if (input.scheduledMeetingId) {
		void redrawScheduledMeetingCard(client, meeting).catch(() => undefined);
		void cancelRemindersFor(meeting.meetingId).catch(() => undefined);
	}
	await checkRoom(client, guild.id);
	console.info(`[meetings] started guild=${guild.id} meeting=${meeting.meetingId}`);
	return { ok: true, meeting };
}

async function reservePrepaid(guildId: string): Promise<SpendReservation | null> {
	const result = await tryReserve(guildId, PREPAID_CENTS).catch(() => null);
	return result?.status === "ok" ? result.reservation : null;
}

// ── end ─────────────────────────────────────────────────────────────────────

/**
 * End a recording, once, whatever ended it: ① the conditional write recording to summarizing
 * (a second caller stops here), ② the clocks off and every unflushed chunk transcribed, ③ Dero
 * leaves the call (its own onEnd lands back here and stops at ①), ④ the live card becomes the
 * notes card, pending its summary with one MeetingSummaryJob, or saying nothing was recorded
 * when no segment was written, in which case the meeting is done with no job. True when this
 * call ended it.
 */
export async function endMeeting(client: Client, guildId: string, meetingId: string, reason: MeetingEndReason): Promise<boolean> {
	const ended = await meetingStore.claimTransition(guildId, meetingId, "recording", { status: "summarizing", endReason: reason, endedAt: new Date() });
	if (!ended) return false;

	const state = live.get(guildId);
	if (state?.meetingId === meetingId) {
		clearTimers(state);
		live.delete(guildId);
	}
	await getMeetingRecorder(meetingId)?.flush();
	if (voiceSessions.get(guildId)?.meetingId === meetingId) voiceSessions.leave(guildId, "left");

	const meeting = (await meetingStore.findById(guildId, meetingId)) ?? ended;
	const recorded = await meetingTranscriptStore.hasAny(guildId, meetingId);
	if (recorded) await meetingSummaryJobStore.create({ jobId: shortId(), guildId, meetingId });
	else await meetingStore.update(guildId, meetingId, { status: "done" });

	const copy = state?.copy ?? getPluginCopy((await guildConfigStore.findByGuildId(guildId)) as unknown as ICopyConfig | null);
	if (meeting.notesChannelId) {
		const messageId = await syncCardMessage(client, meeting.notesChannelId, meeting.notesMessageId, buildEndedCard(meeting, copy, recorded)).catch(() => null);
		if (messageId && messageId !== meeting.notesMessageId) await meetingStore.update(guildId, meetingId, { notesMessageId: messageId });
	}
	console.info(`[meetings] ended guild=${guildId} meeting=${meetingId} reason=${reason} recorded=${recorded}`);
	return true;
}

// ── the dashboard's delete ──────────────────────────────────────────────────

/** Why the dashboard could not delete a meeting. */
export type DeleteMeetingRefusal = "notFound" | "recording" | "noChannel";
export type DeleteMeetingResult = { ok: true; outcome: "cancelled" | "deleted" } | { ok: false; reason: DeleteMeetingRefusal };

/**
 * DELETE /api/meetings/:meetingId (2026-11 item 388 Phase 5a, owner decision D19). A scheduled
 * meeting is cancelled through scheduledMeetings, the one schedule write path, and keeps its
 * row. A meeting that is recording is refused: End recording comes first. Any other meeting is
 * deleted: ① its summary job, first, so the launcher cannot claim it and a result already in
 * flight finds no lease and answers 404, ② its transcript, ③ its reminders and its row, then
 * ④ its cards edited to say it was removed, never posted again. Its todos stay (D19).
 */
export async function deleteMeeting(client: Client, guildId: string, meetingId: string): Promise<DeleteMeetingResult> {
	const meeting = await meetingStore.findById(guildId, meetingId);
	if (!meeting) return { ok: false, reason: "notFound" };
	if (meeting.status === "recording") return { ok: false, reason: "recording" };
	if (meeting.status === "scheduled") {
		const cancelled = await cancelScheduledMeeting(client, guildId, meetingId, { fromDashboard: true });
		if (cancelled.ok) return { ok: true, outcome: "cancelled" };
		// notScheduled here means Start recording won the race since the read above.
		if (cancelled.reason === "notScheduled") return { ok: false, reason: "recording" };
		return { ok: false, reason: cancelled.reason === "noChannel" ? "noChannel" : "notFound" };
	}

	await meetingSummaryJobStore.deleteForMeeting(guildId, meetingId);
	await meetingTranscriptStore.deleteForMeeting(guildId, meetingId);
	await cancelRemindersFor(meetingId).catch((error: unknown) =>
		console.error("[meetings] the deleted meeting's reminders could not be cancelled", { meetingId, error: error instanceof Error ? error.name : "unknown" })
	);
	if (!(await meetingStore.remove(guildId, meetingId))) return { ok: false, reason: "notFound" };
	void markCardsRemoved(client, meeting).catch((error: unknown) =>
		console.error("[meetings] the deleted meeting's cards could not be edited", { meetingId, error: error instanceof Error ? error.name : "unknown" })
	);
	console.info(`[meetings] deleted guild=${guildId} meeting=${meetingId}`);
	return { ok: true, outcome: "deleted" };
}

// Both cards a meeting can have in 📝meeting-notes: the notes card and a cancelled schedule card.
async function markCardsRemoved(client: Client, meeting: IMeeting): Promise<void> {
	if (!meeting.notesChannelId) return;
	const card = buildRemovedNotesCard(meeting, await copyFor(meeting.guildId));
	for (const messageId of [meeting.notesMessageId, meeting.scheduleMessageId]) {
		if (messageId) await editCardMessage(client, meeting.notesChannelId, messageId, card);
	}
}

// ── the presses ─────────────────────────────────────────────────────────────

function refusalLine(result: Extract<StartResult, { ok: false }>, copy: IPluginCopy): string {
	const lines = copy.meetingRecording.refusals;
	if (result.reason === "noChannel") return copy.todoReminders.meetings.channelMissing;
	if (result.reason === "busyElsewhere") return lines.busyElsewhere(result.busyChannelId ?? "");
	return lines[result.reason];
}

async function copyFor(guildId: string): Promise<IPluginCopy> {
	return getPluginCopy((await guildConfigStore.findByGuildId(guildId)) as unknown as ICopyConfig | null);
}

const notice = (interaction: RepliableInteraction, copy: IPluginCopy, line: string): Promise<void> =>
	showNotice(interaction, { title: copy.meetingRecording.noticeTitle, sections: [line] });

/**
 * Start recording, from the 📝meeting-notes intro, a scheduled card or /meeting start. The join
 * can take up to twenty seconds, past Discord's window, so the press is acknowledged first and
 * privately; the live card in 📝meeting-notes is the answer, and a refusal is said privately.
 */
export async function pressStartRecording(interaction: RepliableInteraction, input: { title?: string; scheduledMeetingId?: string }): Promise<void> {
	if (!interaction.inCachedGuild()) return;
	await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
	const result = await startMeeting(interaction.client, interaction.guild, interaction.member, input).catch((error: unknown): StartResult => {
		console.error(`[meetings] start failed guild=${interaction.guildId}`, error instanceof Error ? error.name : "unknown");
		return { ok: false, reason: "joinFailed" };
	});
	if (result.ok) {
		await interaction.deleteReply().catch(() => undefined);
		return;
	}
	const copy = await copyFor(interaction.guildId);
	await notice(interaction, copy, refusalLine(result, copy));
}

/** End recording, from the live card or /meeting end: hosts only. The notes card is the answer. */
export async function pressEndRecording(interaction: RepliableInteraction, meetingId: string | null): Promise<void> {
	if (!interaction.inCachedGuild()) return;
	const copy = await copyFor(interaction.guildId);
	if (!(await isMeetingHost(interaction.member, interaction.guild))) return notice(interaction, copy, copy.meetingRecording.refusals.notHost);
	const target = meetingId ?? (await meetingStore.findRecording(interaction.guildId))?.meetingId ?? null;
	await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
	const ended = target ? await endMeeting(interaction.client, interaction.guildId, target, "host") : false;
	if (ended) {
		await interaction.deleteReply().catch(() => undefined);
		return;
	}
	await notice(interaction, copy, copy.meetingRecording.refusals.notRecording);
}

// ── wiring ──────────────────────────────────────────────────────────────────

/** The meeting mode listener factory: a recorder whose spend refusal ends its meeting. */
export function createMeetingListener(client: Client): StartListening {
	return (start: ListenStart) => {
		if (start.mode !== "meeting" || !start.meetingId) return { stop: () => undefined };
		const meetingId = start.meetingId;
		return startMeetingRecorder(
			{ guild: start.guild, receiver: start.receiver, meetingId },
			{ ...defaultMeetingRecorderDeps, onSpendRefused: (guildId) => void endMeeting(client, guildId, meetingId, "cap_spend") }
		);
	};
}

// Any session end in a guild whose recording this process runs ends that recording. Keyed by
// the live meeting rather than the session, because a meeting is live only once its join landed:
// a join that never reached Ready ends a session too, and startMeeting undoes that claim itself.
function onSessionEnded(client: Client, ended: CallEnded): void {
	const state = live.get(ended.guildId);
	if (!state) return;
	void endMeeting(client, ended.guildId, state.meetingId, "session_end").catch((error: unknown) =>
		console.error(`[meetings] end after the call ended failed guild=${ended.guildId}`, error instanceof Error ? error.name : "unknown")
	);
}

/**
 * Wire recording into the bot, once at boot from main.ts: the recorder as the meeting mode
 * listener (D24), every session end routed to endMeeting, the Start and End presses, and the
 * consent buttons with the room recount as their follow up.
 */
export function registerMeetingRecording(client: Client): void {
	voiceSessions.useListener(createMeetingListener(client), "meeting");
	voiceSessions.onEnd((ended) => onSessionEnded(client, ended));
	useRecordingControls({ start: pressStartRecording, end: pressEndRecording });
	registerConsentButtons((eventClient, guildId) => checkRoom(eventClient, guildId));
}

/** Forget every live meeting and its clocks. Tests only. */
export function _resetLiveMeetings(): void {
	for (const state of live.values()) clearTimers(state);
	live.clear();
}
