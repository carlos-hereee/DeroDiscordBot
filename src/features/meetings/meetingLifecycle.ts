import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, RESTJSONErrorCodes, type Client, type Guild, type GuildMember, type RepliableInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy, type ICopyConfig, type IPluginCopy } from "@base/copy/index.js";
import type { IMeeting, MeetingEndReason } from "@db/models/Meeting.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { meetingSummaryJobStore } from "@db/stores/meetingSummaryJobStore.js";
import { meetingTranscriptStore } from "@db/stores/meetingTranscriptStore.js";
import { cancelRemindersFor } from "@features/reminders/dueReminders.js";
import { useNotesChannelHook } from "@features/setup/removeChannel.js";
import { useWipeHook } from "@features/setup/serverReset.js";
import { isTtsKeyConfigured } from "@features/voice/elevenLabsTts.js";
import { refund, tryReserve, type SpendReservation } from "@features/voice/spendMeter.js";
import { VOICE_PRIORITY_CATEGORIES } from "@features/voice/voicePriority.js";
import { voiceQueue } from "@features/voice/voiceQueue.js";
import { voiceSessions, type CallEnded, type ListenStart, type StartListening } from "@features/voice/voiceSessions.js";
import { deleteCardMessage, editCardMessage, syncCardMessage, type CardPayload } from "@utils/cardMessage.js";
import { isGone } from "@utils/discordGone.js";
import { drainWithin } from "@utils/drainWithin.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { shortId } from "@utils/shortId.js";
import { showNotice } from "@utils/textModal.js";
import { postConsentNotice, registerConsentButtons } from "./consentNotice.js";
import { consentingMembers, hasMeetingConsent } from "./meetingConsent.js";
import { isMeetingHost } from "./meetingHosts.js";
import { defaultMeetingRecorderDeps, getMeetingRecorder, PREPAID_CENTS, startMeetingRecorder } from "./meetingRecorder.js";
import { buildRemovedNotesCard } from "./notesCard.js";
import { cancelScheduledMeeting, meetingCustomId, MEETING_ACTIONS, redrawScheduledMeetingCard, useRecordingControls } from "./scheduledMeetings.js";

// ── meetingLifecycle ────────────────────────────────────────────────────────
// What:  the start and the end of a Meeting Hall recording (2026-11 item 388 Phase 3).
//        startMeeting checks the host and the server, marks the Meeting row recording (the
//        scheduled row when started from its card), joins through the one join path
//        (voiceQueue.requestVoice, then commands/utility/dero.ts runQueuedJoin) in meeting
//        mode, posts the consent notices and the live card, and only then opens the recorder's
//        ears: a member is heard only once Discord accepted a notice naming them, and a start
//        whose notice or card was refused is undone whole (2026-11 item 420). endMeeting is the
//        ONE way a meeting stops, whatever stopped it: it flushes the recorder, leaves the call,
//        edits the live card into the notes card and queues one summary job. The one exception
//        is a deleted 📝meeting-notes, which took every withdraw button with it: that end drops
//        the unsent audio and queues no summary (endForDeletedNotesChannel).
// Who:   the Start recording and End recording buttons (through scheduledMeetings'
//        useRecordingControls), /meeting start and end, the recorder's spend refusal,
//        voiceSessions.onEnd (any session end), meetingPresence (the empty room) and
//        meetingBootRecovery (a restart).
// How an end happens once: every path calls endMeeting, whose first write is a conditional one
//        from recording to summarizing; a second caller finds the first still in flight, or its
//        write matches nothing, and returns. So End pressed as the time cap fires, or a leave this
//        function makes itself landing back here through onEnd, ends the meeting exactly once.
// How an end survives (2026-11 item 420): the recorder stops hearing before that first write, and a
//        write that fails leaves an ending mark on the live meeting, which the repair pass
//        (meetingBootRecovery) retries. A stop after it leaves the row summarizing, which the
//        same pass finishes through finishEndedMeeting.
// Does NOT: summarize. Phase 4's launcher claims the job; this only creates it.

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const SECONDS = (ms: number): number => Math.floor(ms / 1000);
const MAX_HOURS = BOT_CONSTANTS.MEETINGS.MAX_MS / MS_PER_HOUR;
const EMPTY_MINUTES = BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS / MS_PER_MINUTE;
const MONGO_DUPLICATE_KEY = 11000;

/** Why Start recording was refused, each with its own line naming the fix. */
export type StartRefusal =
	| "notHost"
	| "noChannel"
	| "noHall"
	| "notInHall"
	| "voiceOff"
	| "unavailable"
	| "busyElsewhere"
	| "alreadyRecording"
	| "joinFailed"
	| "notScheduled"
	| "noticeNotPosted"
	| "notRecording";
export type StartResult = { ok: true; meeting: IMeeting } | { ok: false; reason: StartRefusal; busyChannelId?: string };

/** Who a recording may hear. `open` turns true once, when every post of the start was accepted. */
interface AskedMembers {
	open: boolean;
	// Members Discord accepted a consent notice for.
	accepted: Set<string>;
	// Members whose notice is being posted right now, so two hall changes never ping one twice.
	asking: Set<string>;
}

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
	asked: AskedMembers;
	// Set by an end that arrives while the start is still posting: the start undoes itself instead.
	cancelled: StartRefusal | null;
	// Set as the first end begins and kept until it stood, so one whose write failed is retried.
	ending: (EndRequest & { failed: boolean }) | null;
}

// A row marked recording by a start, and the scheduled row as it stood before, or null when the
// start made the row.
interface ClaimedStart {
	meeting: IMeeting;
	scheduled: IMeeting | null;
}

interface EndRequest {
	reason: MeetingEndReason;
	// The notes channel or the server's data is gone: unsent audio is dropped and no job is made.
	withoutSummary: boolean;
}

interface EndInFlight {
	guildId: string;
	meetingId: string;
	work: Promise<void>;
}

// Memory only, keyed by guild (one recording per guild, held by the Meeting partial unique
// index). A restart loses it, and meetingBootRecovery ends every meeting it held.
const live = new Map<string, LiveMeeting>();

// The same AskedMembers as the live meeting's, keyed by meeting, because the recorder starts
// inside the join, before the meeting is live, and still has chunks to send after it no longer is.
// A meeting with no entry here hears nobody.
const askedIn = new Map<string, AskedMembers>();

// Memory only: the ends and starts under way, for shutdown, a delete and a wipe to wait on, and
// the undos whose write failed, for the repair pass.
const endsInFlight = new Map<string, EndInFlight>();
const startsInFlight = new Set<Promise<void>>();
const owedUndos = new Map<string, ClaimedStart>();

const quietly = (work: Promise<unknown>): Promise<void> =>
	work.then(
		() => undefined,
		() => undefined
	);

/** True while this process is ending that meeting. The repair pass leaves it alone. */
export function isEndInFlight(meetingId: string): boolean {
	return endsInFlight.has(meetingId);
}

/** Every start and end under way, for shutdown to wait on. None of them rejects. */
export function meetingWorkInFlight(): Promise<void>[] {
	return [...startsInFlight, ...[...endsInFlight.values()].map((end) => end.work)];
}

/** The recording in this guild that this process is running, or null. meetingPresence reads it. */
export function liveMeetingIn(guildId: string): Readonly<Pick<LiveMeeting, "meetingId" | "hallId">> | null {
	return live.get(guildId) ?? null;
}

function liveMeeting(guildId: string, meetingId: string): LiveMeeting | null {
	const state = live.get(guildId);
	return state?.meetingId === meetingId ? state : null;
}

function forgetLive(state: LiveMeeting): void {
	clearTimers(state);
	if (live.get(state.guildId) === state) live.delete(state.guildId);
}

function mayBeHeard(meetingId: string, userId: string): boolean {
	const asked = askedIn.get(meetingId);
	return asked !== undefined && asked.open && asked.accepted.has(userId);
}

function leaveMeetingCall(guildId: string, meetingId: string): void {
	if (voiceSessions.get(guildId)?.meetingId === meetingId) voiceSessions.leave(guildId, "left");
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

// How many in the hall agreed, or null when that cannot be read now.
async function countAgreed(client: Client, state: LiveMeeting): Promise<number | null> {
	const guild = client.guilds.cache.get(state.guildId);
	if (!guild) return null;
	const agreed = await consentingMembers(state.guildId, humansInHall(guild, state.hallId)).catch((error: unknown) => {
		console.warn(`[meetings] hall count failed guild=${state.guildId}`, error instanceof Error ? error.name : "unknown");
		return null;
	});
	return agreed === null ? null : agreed.size;
}

const isOver = (state: LiveMeeting): boolean => live.get(state.guildId) !== state || state.ending !== null;

/**
 * Recount who in 🏛️ Meeting Hall agreed, and arm or clear the empty room end (D22): the
 * meeting ends EMPTY_ROOM_END_MS after no member who agreed remains. Run at start, on every
 * hall join and leave (meetingPresence) and on every consent change (consentNotice). At start
 * nobody may have agreed yet, so the same clock gives the room that long to answer. A count that
 * cannot be read arms the clock too, which counts again before it ends anything.
 */
export async function checkRoom(client: Client, guildId: string): Promise<void> {
	const state = live.get(guildId);
	if (!state || isOver(state)) return;
	const agreed = await countAgreed(client, state);
	if (isOver(state)) return;
	if (agreed !== null && agreed > 0) {
		if (state.emptyTimer) clearTimeout(state.emptyTimer);
		state.emptyTimer = null;
		return;
	}
	armEmptyRoom(client, state);
}

function armEmptyRoom(client: Client, state: LiveMeeting): void {
	if (state.emptyTimer) return;
	state.emptyTimer = setTimeout(() => {
		// Cleared as it fires: a spent timer left here would keep the clock from ever arming again.
		state.emptyTimer = null;
		void endIfStillEmpty(client, state);
	}, BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS);
	state.emptyTimer.unref?.();
}

// The count the clock was armed on is two minutes old, so it is taken again before it ends a
// meeting a member may have agreed to since.
async function endIfStillEmpty(client: Client, state: LiveMeeting): Promise<void> {
	const agreed = await countAgreed(client, state);
	if (isOver(state)) return;
	if (agreed === null) armEmptyRoom(client, state);
	else if (agreed === 0) endQuietly(client, state.guildId, state.meetingId, "empty_room");
}

// ── asking ──────────────────────────────────────────────────────────────────

/** True when every one of `memberIds` has an accepted notice, or one being posted elsewhere. */
async function askMembers(client: Client, state: LiveMeeting, memberIds: readonly string[]): Promise<boolean> {
	const { accepted, asking } = state.asked;
	const unasked = memberIds.filter((id) => !accepted.has(id) && !asking.has(id));
	if (unasked.length === 0) return true;
	unasked.forEach((id) => asking.add(id));
	try {
		const askedNow = await postConsentNotice(client, state.notesChannelId, state.copy, { meetingId: state.meetingId, title: state.title, hostId: state.hostId, memberIds: unasked });
		askedNow.forEach((id) => accepted.add(id));
		return askedNow.length === unasked.length;
	}
	finally {
		unasked.forEach((id) => asking.delete(id));
	}
}

/**
 * Ask every member in the hall with no accepted notice yet (meetingPresence, on every hall
 * change). A member whose notice was refused stays unheard and is asked again on the next one,
 * unless the refusal is Discord saying the channel is gone, which ends the recording.
 */
export async function askUnaskedInHall(client: Client, guildId: string): Promise<void> {
	const state = live.get(guildId);
	const guild = client.guilds.cache.get(guildId);
	if (!state || !guild || state.ending) return;
	const everyoneAsked = await askMembers(client, state, humansInHall(guild, state.hallId));
	if (everyoneAsked || !state.asked.open) return;
	// Only Discord's Unknown Channel counts: a timeout or a lost permission leaves the recording
	// as it is, with the unasked member unheard.
	if (await isGone(() => client.channels.fetch(state.notesChannelId, { force: true }), RESTJSONErrorCodes.UnknownChannel)) {
		await endForDeletedNotesChannel(client, state.notesChannelId);
	}
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
async function claimRecording(guildId: string, hostId: string, notesChannelId: string, input: { title?: string; scheduledMeetingId?: string }, startedAt: Date): Promise<ClaimedStart | StartRefusal> {
	try {
		if (input.scheduledMeetingId) {
			// Read first, because the claim overwrites what an undo must give back.
			const scheduled = await meetingStore.findById(guildId, input.scheduledMeetingId);
			if (!scheduled) return "notScheduled";
			const meeting = await meetingStore.claimTransition(guildId, input.scheduledMeetingId, "scheduled", { status: "recording", hostId, startedAt, notesChannelId, spentCents: PREPAID_CENTS });
			return meeting ? { meeting, scheduled } : "notScheduled";
		}
		const meeting = await meetingStore.insert({
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
		return { meeting, scheduled: null };
	}
	catch (error) {
		if ((error as { code?: number } | null)?.code === MONGO_DUPLICATE_KEY) return "alreadyRecording";
		throw error;
	}
}

// Undo a claim, in one write: a scheduled row gets back everything the start wrote over, so it is
// as it was found (2026-11 item 420, L15), and a new row goes.
async function releaseClaim({ meeting, scheduled }: ClaimedStart): Promise<void> {
	const { guildId, meetingId } = meeting;
	if (!scheduled) {
		await meetingStore.remove(guildId, meetingId);
		return;
	}
	const { hostId, startedAt, notesChannelId, notesMessageId, spentCents } = scheduled;
	await meetingStore.claimTransition(guildId, meetingId, "recording", { status: "scheduled", hostId, startedAt, notesChannelId, notesMessageId, spentCents });
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

// Undo a start whole, whichever step stopped it. The live state goes first, so the end of the
// call finds no meeting to end, and the recorder is discarded, so nothing it might hold is sent.
async function undoStart(start: ClaimedStart, prepaid: SpendReservation, reason: StartRefusal): Promise<StartResult> {
	const { guildId, meetingId } = start.meeting;
	const state = liveMeeting(guildId, meetingId);
	if (state) forgetLive(state);
	askedIn.delete(meetingId);
	void getMeetingRecorder(meetingId)?.discard();
	leaveMeetingCall(guildId, meetingId);
	await releaseClaim(start).catch((error: unknown) => {
		owedUndos.set(meetingId, start);
		console.error(`[meetings] start not undone, kept for the repair pass guild=${guildId} meeting=${meetingId}`, error instanceof Error ? error.name : "unknown");
	});
	await refund(prepaid).catch(() => undefined);
	return { ok: false, reason };
}

/** Retry every undone start whose write failed. meetingBootRecovery's repair pass. */
export async function retryOwedUndos(): Promise<void> {
	for (const [meetingId, undo] of [...owedUndos.entries()]) {
		const row = await meetingStore.findById(undo.meeting.guildId, meetingId);
		// Read first because a new row's undo is a delete with no status of its own to match: a
		// meeting someone ended or removed meanwhile is no longer this start's to undo.
		if (row?.status === "recording") await releaseClaim(undo);
		owedUndos.delete(meetingId);
	}
}

// Why a start under way must stop now, or null: an end that arrived during it, or a call that
// ended under it (its own onEnd leaves a start in progress to be undone here).
function startStopped(state: LiveMeeting): StartRefusal | null {
	if (state.cancelled) return state.cancelled;
	return voiceSessions.get(state.guildId)?.meetingId === state.meetingId ? null : "joinFailed";
}

/**
 * Post the consent notices, then the live card, and open the recorder's ears only when Discord
 * accepted all of them and the call still stands. The refusal to undo the start with, or the row
 * with its live card.
 */
async function announceRecording(client: Client, guild: Guild, state: LiveMeeting, claimed: IMeeting): Promise<IMeeting | StartRefusal> {
	const { guildId, meetingId, notesChannelId } = state;
	const everyoneAsked = startStopped(state) === null && (await askMembers(client, state, humansInHall(guild, state.hallId)));
	const stoppedAsking = startStopped(state);
	if (stoppedAsking) return stoppedAsking;
	if (!everyoneAsked) return "noticeNotPosted";

	const liveMessageId = await syncCardMessage(client, notesChannelId, null, buildLiveCard(claimed, state.copy));
	if (!liveMessageId) return startStopped(state) ?? "noticeNotPosted";
	const meeting = await meetingStore.update(guildId, meetingId, { notesMessageId: liveMessageId }).catch(() => null);
	const refusal = startStopped(state) ?? (meeting ? null : "joinFailed");
	if (refusal || !meeting) {
		// A card saying a meeting records, over one that never did, is worse than no card.
		await deleteCardMessage(client, notesChannelId, liveMessageId);
		return refusal ?? "joinFailed";
	}
	state.asked.open = true;
	return meeting;
}

/**
 * Start recording in 🏛️ Meeting Hall: ① to ⑥ the checks, ⑦ the first cent reserved (a spent
 * cap refuses here), ⑧ the row marked recording, ⑨ the join in meeting mode, ⑩ the consent
 * notices, the live card and the clocks, and only then does the recorder hear anyone. A step
 * that fails undoes the ones before it.
 */
export function startMeeting(client: Client, guild: Guild, host: GuildMember, input: { title?: string; scheduledMeetingId?: string }): Promise<StartResult> {
	const start = beginMeeting(client, guild, host, input);
	const settled: Promise<void> = quietly(start).finally(() => startsInFlight.delete(settled));
	startsInFlight.add(settled);
	return start;
}

async function beginMeeting(client: Client, guild: Guild, host: GuildMember, input: { title?: string; scheduledMeetingId?: string }): Promise<StartResult> {
	const checked = await checkStart(guild, host);
	if (!checked.ok) return checked;
	const { checks } = checked;

	const prepaid = await reservePrepaid(guild.id);
	if (!prepaid) return { ok: false, reason: "unavailable" };
	const start = await claimRecording(guild.id, host.id, checks.notesChannelId, input, new Date());
	if (typeof start === "string") {
		await refund(prepaid).catch(() => undefined);
		return { ok: false, reason: start };
	}

	const claimed = start.meeting;
	const undo = (reason: StartRefusal): Promise<StartResult> => undoStart(start, prepaid, reason);
	// Before the join, because the call starts the recorder itself: closed until ⑩ is done.
	const asked: AskedMembers = { open: false, accepted: new Set(), asking: new Set() };
	askedIn.set(claimed.meetingId, asked);
	const joined = await joinHall(guild, host.id, checks, claimed.meetingId).catch(() => false);
	if (!joined) return undo("joinFailed");

	const state: LiveMeeting = {
		guildId: guild.id,
		meetingId: claimed.meetingId,
		hallId: checks.hallId,
		notesChannelId: checks.notesChannelId,
		title: claimed.title,
		hostId: host.id,
		copy: checks.copy,
		maxTimer: setTimeout(() => endQuietly(client, guild.id, claimed.meetingId, "cap_time"), BOT_CONSTANTS.MEETINGS.MAX_MS),
		emptyTimer: null,
		asked,
		cancelled: null,
		ending: null,
	};
	state.maxTimer.unref?.();
	live.set(guild.id, state);

	const announced = await announceRecording(client, guild, state, claimed).catch((error: unknown): StartRefusal => {
		console.error(`[meetings] start could not be announced guild=${guild.id} meeting=${claimed.meetingId}`, error instanceof Error ? error.name : "unknown");
		return "noticeNotPosted";
	});
	if (typeof announced === "string") return undo(announced);
	const meeting = announced;
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
 * End a recording, once, whatever ended it: ① the recorder stops hearing and the clocks stop,
 * before anything that can fail, ② the conditional write recording to summarizing, ③ every
 * unflushed chunk transcribed, ④ Dero leaves the call (its own onEnd lands back here and finds
 * this end in flight), ⑤ finishEndedMeeting. True when this call ended it. Rejects when ② failed,
 * with the end marked for the repair pass, or when ⑤ did, which the same pass finishes.
 */
export function endMeeting(client: Client, guildId: string, meetingId: string, reason: MeetingEndReason): Promise<boolean> {
	return requestEnd(client, guildId, meetingId, { reason, withoutSummary: false });
}

// Every end nobody is waiting on: the clocks, a spent cap and a call that ended. What it logs is
// retried by the repair pass.
function endQuietly(client: Client, guildId: string, meetingId: string, reason: MeetingEndReason): void {
	endMeeting(client, guildId, meetingId, reason).catch((error: unknown) =>
		console.error(`[meetings] end failed, kept for the repair pass guild=${guildId} meeting=${meetingId} reason=${reason}`, error instanceof Error ? error.name : "unknown")
	);
}

async function requestEnd(client: Client, guildId: string, meetingId: string, wanted: EndRequest): Promise<boolean> {
	const state = liveMeeting(guildId, meetingId);
	if (state && !state.asked.open) {
		// Nothing was heard yet, so there is nothing to end: the start undoes itself.
		state.cancelled ??= "notRecording";
		return false;
	}
	if (endsInFlight.has(meetingId)) return false;
	const end = runEnd(client, guildId, meetingId, state, wanted);
	const inFlight: EndInFlight = { guildId, meetingId, work: quietly(end).finally(() => endsInFlight.delete(meetingId)) };
	endsInFlight.set(meetingId, inFlight);
	return end;
}

async function runEnd(client: Client, guildId: string, meetingId: string, state: LiveMeeting | null, wanted: EndRequest): Promise<boolean> {
	getMeetingRecorder(meetingId)?.stop();
	const isRetry = state?.ending?.failed ?? false;
	if (state) {
		clearTimers(state);
		// The first end's reason stands, except that an end without a summary is never softened
		// into one with.
		const request = wanted.withoutSummary || !state.ending ? wanted : state.ending;
		state.ending = { reason: request.reason, withoutSummary: request.withoutSummary, failed: false };
	}
	const { reason, withoutSummary } = state?.ending ?? wanted;

	let hasEnded: boolean;
	try {
		hasEnded = withoutSummary
			? await closeWithoutSummary(guildId, meetingId, reason)
			: (await meetingStore.claimTransition(guildId, meetingId, "recording", { status: "summarizing", endReason: reason, endedAt: new Date() })) !== null;
		// A write that landed but answered an error matches nothing the second time. The row says
		// so, and the end goes on rather than dropping what the recorder still holds.
		if (!hasEnded && !withoutSummary && isRetry) hasEnded = (await meetingStore.findById(guildId, meetingId))?.status === "summarizing";
	}
	catch (error) {
		if (state?.ending) state.ending.failed = true;
		throw error;
	}

	if (state) forgetLive(state);
	if (hasEnded && !withoutSummary) await getMeetingRecorder(meetingId)?.flush();
	// The row was ended elsewhere (an overlapping process), so nothing here may still be sent.
	else if (state) await getMeetingRecorder(meetingId)?.discard();
	askedIn.delete(meetingId);
	if (state || hasEnded) leaveMeetingCall(guildId, meetingId);
	if (!hasEnded) return false;
	console.info(`[meetings] ended guild=${guildId} meeting=${meetingId} reason=${reason} withoutSummary=${withoutSummary}`);
	if (!withoutSummary) await finishEndedMeeting(client, guildId, meetingId, state?.copy);
	return true;
}

/**
 * What follows an end once its last chunk is written: one MeetingSummaryJob, or the meeting done
 * with nothing recorded, then the live card becomes the notes card. Safe to run again, which is
 * how the repair pass finishes an end a restart or a failed write cut off: a job already there
 * counts as made. A meeting deleted meanwhile takes its last words with it and gets no job and no
 * card (2026-11 item 420, L11).
 */
export async function finishEndedMeeting(client: Client, guildId: string, meetingId: string, knownCopy?: IPluginCopy): Promise<void> {
	const meeting = await meetingStore.findById(guildId, meetingId);
	if (!meeting) {
		await meetingTranscriptStore.deleteForMeeting(guildId, meetingId);
		return;
	}
	if (meeting.status !== "summarizing") return;
	const recorded = await meetingTranscriptStore.hasAny(guildId, meetingId);
	if (recorded) await queueSummary(guildId, meetingId);
	else if (!(await meetingStore.claimTransition(guildId, meetingId, "summarizing", { status: "done" }))) return;

	if (!meeting.notesChannelId) return;
	const card = buildEndedCard(meeting, knownCopy ?? (await copyFor(guildId)), recorded);
	const messageId = await syncCardMessage(client, meeting.notesChannelId, meeting.notesMessageId, card).catch(() => null);
	if (messageId && messageId !== meeting.notesMessageId) await meetingStore.update(guildId, meetingId, { notesMessageId: messageId });
}

async function queueSummary(guildId: string, meetingId: string): Promise<void> {
	try {
		await meetingSummaryJobStore.create({ jobId: shortId(), guildId, meetingId });
	}
	catch (error) {
		if ((error as { code?: number } | null)?.code !== MONGO_DUPLICATE_KEY) throw error;
	}
}

/** Retry every end whose first write failed. meetingBootRecovery's repair pass. */
export async function retryOwedEnds(client: Client): Promise<void> {
	for (const state of [...live.values()]) {
		if (!state.ending?.failed) continue;
		await requestEnd(client, state.guildId, state.meetingId, state.ending).catch((error: unknown) =>
			console.error(`[meetings] end failed again guild=${state.guildId} meeting=${state.meetingId}`, error instanceof Error ? error.name : "unknown")
		);
	}
}

/**
 * The end of a recording whose 📝meeting-notes is gone (2026-11 item 420, L2; meetingPresence's
 * ChannelDelete, a Remove that deleted it, or Discord's own Unknown Channel). Every withdraw
 * button went with the channel, so unsent audio is dropped and no summary is made. Stored words
 * are kept, under their expiry and Delete my data: they were consented, and deleting them cannot
 * be undone. One write takes the row from recording to its final status, never through
 * summarizing, so a restart in between cannot give it a summary job. Failed rather than done
 * when it holds words, because a failed meeting still counts as open for a later withdrawal.
 */
export async function endForDeletedNotesChannel(client: Client, channelId: string): Promise<void> {
	for (const state of [...live.values()]) {
		if (state.notesChannelId !== channelId) continue;
		if (!state.asked.open) {
			state.cancelled ??= "noChannel";
			continue;
		}
		await requestEnd(client, state.guildId, state.meetingId, { reason: "session_end", withoutSummary: true });
	}
}

// One write to the final status, after the unsent audio is dropped.
async function closeWithoutSummary(guildId: string, meetingId: string, reason: MeetingEndReason): Promise<boolean> {
	await getMeetingRecorder(meetingId)?.discard();
	const hasWords = await meetingTranscriptStore.hasAny(guildId, meetingId).catch(() => true);
	return (await meetingStore.claimTransition(guildId, meetingId, "recording", { status: hasWords ? "failed" : "done", endReason: reason, endedAt: new Date() })) !== null;
}

// A Remove from the setup cards: a deleted channel ends the recording without a summary, and a
// released one, whose notices still stand, ends it in the ordinary way.
async function onNotesChannelRemoved(client: Client, guildId: string, outcome: "deleted" | "released"): Promise<void> {
	const state = live.get(guildId);
	if (!state) return;
	if (outcome === "deleted") await endForDeletedNotesChannel(client, state.notesChannelId);
	else await endMeeting(client, guildId, state.meetingId, "session_end");
}

// ── the dashboard's delete ──────────────────────────────────────────────────

/** Why the dashboard could not delete a meeting. */
export type DeleteMeetingRefusal = "notFound" | "recording" | "noChannel";
export type DeleteMeetingResult = { ok: true; outcome: "cancelled" | "deleted" } | { ok: false; reason: DeleteMeetingRefusal };

/**
 * DELETE /api/meetings/:meetingId (2026-11 item 388 Phase 5a, owner decision D19). A scheduled
 * meeting is cancelled through scheduledMeetings, the one schedule write path, and keeps its
 * row. A meeting that is recording is refused: End recording comes first. Any other meeting is
 * deleted: ① whatever still writes it here stops, its recorder discarded and an end in flight
 * waited for, or a last chunk and a job would land behind the delete (2026-11 item 420, L11),
 * ② its summary job, so the launcher cannot claim it and a result already in flight finds no
 * lease and answers 404, ③ its transcript, ④ its reminders and its row, then ⑤ its cards edited
 * to say it was removed, never posted again. Its todos stay (D19).
 */
export async function deleteMeeting(client: Client, guildId: string, meetingId: string): Promise<DeleteMeetingResult> {
	let meeting = await meetingStore.findById(guildId, meetingId);
	if (!meeting) return { ok: false, reason: "notFound" };
	if (meeting.status === "recording") return { ok: false, reason: "recording" };
	if (meeting.status === "scheduled") {
		const cancelled = await cancelScheduledMeeting(client, guildId, meetingId, { fromDashboard: true });
		if (cancelled.ok) return { ok: true, outcome: "cancelled" };
		// notScheduled here means Start recording won the race since the read above.
		if (cancelled.reason === "notScheduled") return { ok: false, reason: "recording" };
		return { ok: false, reason: cancelled.reason === "noChannel" ? "noChannel" : "notFound" };
	}

	await stopWrites([meetingId], [endsInFlight.get(meetingId)?.work]);
	// The end just waited for may have posted the card anew, and ⑤ edits the card the row names.
	meeting = (await meetingStore.findById(guildId, meetingId)) ?? meeting;

	await meetingSummaryJobStore.deleteForMeeting(guildId, meetingId);
	await meetingTranscriptStore.deleteForMeeting(guildId, meetingId);
	await cancelRemindersFor(meetingId).catch((error: unknown) =>
		console.error("[meetings] the deleted meeting's reminders could not be cancelled", { meetingId, error: error instanceof Error ? error.name : "unknown" })
	);
	if (!(await meetingStore.remove(guildId, meetingId))) return { ok: false, reason: "notFound" };
	const removed = meeting;
	void markCardsRemoved(client, removed).catch((error: unknown) =>
		console.error("[meetings] the deleted meeting's cards could not be edited", { meetingId, error: error instanceof Error ? error.name : "unknown" })
	);
	console.info(`[meetings] deleted guild=${guildId} meeting=${meetingId}`);
	return { ok: true, outcome: "deleted" };
}

// Discard the recorders, which releases an end waiting on the provider, then wait for that end.
async function stopWrites(meetingIds: readonly string[], work: readonly (Promise<void> | undefined)[]): Promise<void> {
	const discards = meetingIds.map((meetingId) => getMeetingRecorder(meetingId)?.discard());
	await drainWithin([...discards, ...work], BOT_CONSTANTS.MEETINGS.END_WAIT_MS);
}

// Before self destruct's Delete my data wipes a server (2026-11 item 420, L11): a recording ends
// with no summary, its call is left and its recorder discarded, and an end already in flight is
// waited for, so nothing is written behind the wipe. Throws when the end could not be written, so
// the wipe names it; the recorder hears nobody either way.
async function stopForWipe(client: Client, guildId: string): Promise<void> {
	const state = live.get(guildId);
	if (state && !state.asked.open) state.cancelled ??= "notRecording";
	const starts = state && !state.asked.open ? [...startsInFlight] : [];
	// Asked for before the call is left, whose own end would otherwise get in first with a summary.
	const ending = state?.asked.open ? requestEnd(client, guildId, state.meetingId, { reason: "session_end", withoutSummary: true }) : Promise.resolve(false);
	if (voiceSessions.get(guildId)?.mode === "meeting") voiceSessions.leave(guildId, "switched_off");
	const ends = [...endsInFlight.values()].filter((end) => end.guildId === guildId);
	await stopWrites(
		ends.map((end) => end.meetingId),
		[...starts, quietly(ending), ...ends.map((end) => end.work)]
	);
	if (state?.ending?.failed) throw new Error(`the recording's end could not be written meeting=${state.meetingId}`);
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

/**
 * The meeting mode listener factory: a recorder that hears a member only once Discord accepted
 * a notice naming them in this meeting, and whose spend refusal ends its meeting. The asked set
 * comes before the consent read, so an old yes is never enough on its own.
 */
export function createMeetingListener(client: Client): StartListening {
	return (start: ListenStart) => {
		if (start.mode !== "meeting" || !start.meetingId) return { stop: () => undefined };
		const meetingId = start.meetingId;
		return startMeetingRecorder(
			{ guild: start.guild, receiver: start.receiver, meetingId },
			{
				...defaultMeetingRecorderDeps,
				hasConsent: async (guildId, userId) => mayBeHeard(meetingId, userId) && hasMeetingConsent(guildId, userId),
				onSpendRefused: (guildId) => endQuietly(client, guildId, meetingId, "cap_spend"),
			}
		);
	};
}

// Any session end in a guild whose recording this process runs ends that recording. Keyed by
// the live meeting rather than the session, because a meeting is live only once its join landed:
// a join that never reached Ready ends a session too, and startMeeting undoes that claim itself.
// A start still posting its notices sees the call gone at its next step and undoes itself too.
function onSessionEnded(client: Client, ended: CallEnded): void {
	const state = live.get(ended.guildId);
	if (!state || !state.asked.open) return;
	endQuietly(client, ended.guildId, state.meetingId, "session_end");
}

/**
 * Wire recording into the bot, once at boot from main.ts: the recorder as the meeting mode
 * listener (D24), every session end routed to endMeeting, the Start and End presses, the
 * consent buttons with the room recount as their follow up, and the two setup hooks, the cards'
 * Remove of 📝meeting-notes and self destruct's Delete my data.
 */
export function registerMeetingRecording(client: Client): void {
	voiceSessions.useListener(createMeetingListener(client), "meeting");
	voiceSessions.onEnd((ended) => onSessionEnded(client, ended));
	useRecordingControls({ start: pressStartRecording, end: pressEndRecording });
	registerConsentButtons((eventClient, guildId) => checkRoom(eventClient, guildId));
	useNotesChannelHook((guildId, outcome) => onNotesChannelRemoved(client, guildId, outcome));
	useWipeHook((guildId) => stopForWipe(client, guildId));
}

/** Forget every live meeting and its clocks. Tests only. */
export function _resetLiveMeetings(): void {
	for (const state of live.values()) clearTimers(state);
	live.clear();
	askedIn.clear();
	endsInFlight.clear();
	startsInFlight.clear();
	owedUndos.clear();
}
