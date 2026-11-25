import type { Guild } from "discord.js";
import { EndBehaviorType } from "@discordjs/voice";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { meetingTranscriptStore } from "@db/stores/meetingTranscriptStore.js";
import { createElevenLabsStt } from "@features/voice/elevenLabsStt.js";
import { createOpusDecoder, DECODE_CHANNELS, DECODE_SAMPLE_RATE, type OpusPacketDecoder } from "@features/voice/opusDecoder.js";
import { SCRIBE_V2_USD_PER_HOUR } from "@features/voice/pricing.js";
import { pcm48kStereoTo16kMono } from "@features/voice/resample.js";
import { refund, tryReserve, type SpendReservation } from "@features/voice/spendMeter.js";
import { SttError, type SttProvider } from "@features/voice/sttProvider.js";
import type { ReceiveStreamLike, ReceiverLike } from "@features/voice/voiceListener.js";
import { wavFromPcm16kMono } from "@features/voice/wavFile.js";
import { elevenLabsApiKey } from "@utils/config.js";
import { hasMeetingConsent, hasMeetingConsentNow } from "./meetingConsent.js";

// ── meetingRecorder ─────────────────────────────────────────────────────────
// What:  Dero's ears in a Meeting Hall recording (2026-11 item 388 Phase 3). One subscription
//        per member who agreed, each speaker's audio decoded into a PCM buffer, cut into chunks,
//        transcribed by ElevenLabs batch speech to text and written as one
//        MeetingTranscriptSegment per chunk the moment its text returns, so a restart loses at
//        most the one chunk each speaker had not flushed yet.
// Who:   voiceSessions starts it for a meeting mode session (main.ts registers
//        createMeetingListener under mode "meeting"); meetingLifecycle flushes it when the
//        meeting ends; consentNotice drops a member who presses Stop recording me.
// Why not voiceListener and turnLoop: they hear only the task list, keep 20 seconds, answer
//        speech addressed to Dero and run one turn at a time. A meeting needs every member who
//        agreed, for as long as they talk, so this is a second listener and those stay as they are.
//
// ⚠️ PRIVACY INVARIANTS, each one a promise in the consent notice:
//   ① A member is subscribed only after hasMeetingConsent said yes on THIS speaking start
//     (trusted CONSENT_TRUST_MS). A bot, a member who never agreed and a member who revoked
//     are never subscribed, so Discord never hands their audio to this process at all.
//   ② Audio lives only in memory, in the speaker's buffer, until its chunk is transcribed or
//     dropped. Nothing here writes a file, and no log line carries audio or text: only ids,
//     durations and error kinds (privacyTripwire.test.ts scans this folder).
//   ③ A withdrawal drops the member's unflushed buffer unsent, and a chunk already at the
//     provider is thrown away when its text returns, never written, even when the member agreed
//     again while it was there (2026-11 item 420).
//   ④ Consent is read again before a chunk is paid for, and again, from the row itself, before
//     and after its words are written. A no, or a read that fails, is a no: the chunk is dropped.
//
// Spend (owner decision D3): a meeting meters at the real rate, not estimateSttCents' one cent
// floor per call, which would let one busy hour spend a free server's whole month. Each chunk
// adds its exact millicents to the meeting's running total, and tryReserve is called for whole
// cents only as that total passes the cents already reserved. meetingLifecycle reserves the
// first cent before it joins (so a spent cap refuses Start), which is why a recorder starts
// with one cent reserved. A refused reserve stops capture and asks the lifecycle to end the
// meeting with cap_spend.

const BYTES_PER_SAMPLE = 2;
const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 3_600_000;
const MILLICENTS_PER_CENT = 1000;
const MILLICENTS_PER_USD = 100_000;
const PCM_BYTES_PER_MS = (DECODE_SAMPLE_RATE * DECODE_CHANNELS * BYTES_PER_SAMPLE) / MS_PER_SECOND;
const CHUNK_MAX_BYTES = BOT_CONSTANTS.MEETINGS.CHUNK_MAX_SPEECH_MS * PCM_BYTES_PER_MS;
// The three byte Opus frame Discord sends after a member stops talking; it is not speech, so
// it never resets the speaker's silence clock (the same frame voiceListener.ts reads).
const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
/** The cent meetingLifecycle reserved before the join, which a recorder starts already holding. */
export const PREPAID_CENTS = 1;

/** The exact cost of `durationMs` of speech to text, in millicents (a hundred thousandth of a dollar). */
export function sttMillicents(durationMs: number): number {
	return (durationMs * SCRIBE_V2_USD_PER_HOUR * MILLICENTS_PER_USD) / MS_PER_HOUR;
}

/** One transcribed chunk, as the transcript store keeps it. */
export interface RecordedSegment {
	meetingId: string;
	guildId: string;
	speakerId: string;
	offsetMs: number;
	durationMs: number;
	text: string;
}

/** What a chunk's words may be written on: a consent current now, in a meeting that still takes words. */
export interface WriteStanding {
	consents: boolean;
	meeting: "open" | "closed" | "gone";
}

export interface MeetingRecorderDeps {
	now(): number;
	createDecoder(): OpusPacketDecoder;
	isBot(guild: Guild, userId: string): boolean;
	hasConsent(guildId: string, userId: string): Promise<boolean>;
	stt: SttProvider;
	reserve(guildId: string, cents: number, sttSeconds: number): Promise<SpendReservation | null>;
	refund(reservation: SpendReservation): Promise<void>;
	/** The member's consent and the meeting as their rows stand now, never from a cache. */
	readStanding(guildId: string, meetingId: string, userId: string): Promise<WriteStanding>;
	writeSegment(segment: RecordedSegment): Promise<void>;
	addSpeaker(guildId: string, meetingId: string, userId: string): Promise<void>;
	/** Take one member's words, then their speaker entry, out of this meeting. */
	removeSpeakerWords(guildId: string, meetingId: string, userId: string): Promise<void>;
	/** Take every word out of a meeting that no longer exists. */
	removeMeetingWords(guildId: string, meetingId: string): Promise<void>;
	addUsage(guildId: string, meetingId: string, sttSeconds: number, cents: number): Promise<void>;
	/** Told once, when a reserve is refused; meetingLifecycle ends the meeting with cap_spend. */
	onSpendRefused(guildId: string, meetingId: string): void;
}

// The meeting speech to text client: the same provider as command voice, with a longer timeout
// because a chunk carries up to CHUNK_MAX_SPEECH_MS of speech rather than one short sentence.
const meetingStt: SttProvider = createElevenLabsStt({ apiKey: elevenLabsApiKey, timeoutMs: BOT_CONSTANTS.MEETINGS.STT_TIMEOUT_MS });

export const defaultMeetingRecorderDeps: MeetingRecorderDeps = {
	now: () => Date.now(),
	createDecoder: createOpusDecoder,
	isBot: (guild, userId) => guild.members.cache.get(userId)?.user.bot ?? false,
	hasConsent: (guildId, userId) => hasMeetingConsent(guildId, userId),
	stt: meetingStt,
	reserve: async (guildId, cents, sttSeconds) => {
		const result = await tryReserve(guildId, cents, { sttSeconds });
		return result.status === "ok" ? result.reservation : null;
	},
	refund,
	readStanding: async (guildId, meetingId, userId) => {
		const consents = await hasMeetingConsentNow(guildId, userId);
		const meeting = await meetingStore.findById(guildId, meetingId);
		if (!meeting) return { consents, meeting: "gone" };
		return { consents, meeting: meeting.status === "recording" || meeting.status === "summarizing" ? "open" : "closed" };
	},
	writeSegment: (segment) => meetingTranscriptStore.insertSegment(segment),
	addSpeaker: (guildId, meetingId, userId) => meetingStore.addSpeaker(guildId, meetingId, userId),
	removeSpeakerWords: async (guildId, meetingId, userId) => {
		await meetingTranscriptStore.deleteForSpeaker(guildId, [meetingId], userId);
		// Last, so a failure in between leaves the mark that words are still owed a removal.
		await meetingStore.removeSpeaker(guildId, meetingId, userId);
	},
	removeMeetingWords: (guildId, meetingId) => meetingTranscriptStore.deleteForMeeting(guildId, meetingId),
	addUsage: (guildId, meetingId, sttSeconds, cents) => meetingStore.addUsage(guildId, meetingId, sttSeconds, cents),
	onSpendRefused: () => undefined,
};

export interface MeetingRecorderStart {
	guild: Guild;
	receiver: ReceiverLike;
	meetingId: string;
}

export interface MeetingRecorder {
	readonly meetingId: string;
	readonly guildId: string;
	/** Members subscribed right now. */
	readonly capturingCount: number;
	/** Stop hearing: unsubscribe everyone and stop the clocks. Unflushed buffers stay for flush(). */
	stop(): void;
	/** Stop, transcribe every unflushed buffer, and wait for every chunk still at the provider. */
	flush(): Promise<void>;
	/**
	 * Stop, drop every unflushed buffer unsent and throw away every chunk still at the provider.
	 * Resolves once a write that had already begun has ended, without waiting on the provider,
	 * and releases a flush() that was waiting on it. Whoever calls it makes the recorder
	 * unreachable: a start undone, a meeting deleted, a notes channel gone (2026-11 item 420).
	 */
	discard(): Promise<void>;
	/** Stop recording one member now: buffer dropped, stream closed, a chunk in flight discarded. */
	dropSpeaker(userId: string): Promise<void>;
	/**
	 * A member left the hall: what they said is sent and their slot is free for another speaker.
	 * Not a withdrawal (2026-11 item 420, L12), so they are heard again when they come back.
	 */
	releaseSpeaker(userId: string): void;
	/** A member who agreed again after a revoke in this meeting may be subscribed again. */
	allowAgain(userId: string): void;
}

interface SpeakerCapture {
	userId: string;
	stream: ReceiveStreamLike;
	decoder: OpusPacketDecoder;
	chunks: Buffer[];
	bytes: number;
	// Where in the meeting the chunk's first audio fell, or null while the chunk is empty.
	chunkOffsetMs: number | null;
	silenceTimer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
}

// The live recorders, keyed by meeting, so the lifecycle can flush one and a revoke can reach
// every recorder in its server. Memory only: a restart ends the meeting through boot recovery.
const recorders = new Map<string, MeetingRecorder>();

/** The live recorder for this meeting, or null. */
export function getMeetingRecorder(meetingId: string): MeetingRecorder | null {
	return recorders.get(meetingId) ?? null;
}

/** Drop a member from every live recorder in this server (Stop recording me). */
export async function dropSpeakerEverywhere(guildId: string, userId: string): Promise<void> {
	await Promise.all([...recorders.values()].filter((recorder) => recorder.guildId === guildId).map((recorder) => recorder.dropSpeaker(userId)));
}

/** Let a member who agreed again be heard in every live recorder in this server. */
export function allowSpeakerEverywhere(guildId: string, userId: string): void {
	for (const recorder of recorders.values()) if (recorder.guildId === guildId) recorder.allowAgain(userId);
}

/** Start one meeting's recorder. Never throws on a member's audio; flush() or stop() ends it. */
export function startMeetingRecorder(start: MeetingRecorderStart, deps: MeetingRecorderDeps = defaultMeetingRecorderDeps): MeetingRecorder {
	const { guild, receiver, meetingId } = start;
	const guildId = guild.id;
	const startedAt = deps.now();
	const captures = new Map<string, SpeakerCapture>();
	const checking = new Set<string>();
	// Members who pressed Stop recording me during this meeting: a consent read already in
	// flight when they pressed it must not subscribe them.
	const revoked = new Set<string>();
	// How often each member withdrew during this meeting. `revoked` alone cannot tell a chunk cut
	// before a withdrawal from one cut after the member agreed again, because agreeing clears it.
	const withdrawals = new Map<string, number>();
	const withdrawalsOf = (userId: string): number => withdrawals.get(userId) ?? 0;
	const inflight = new Map<string, Set<Promise<void>>>();
	// The database writes of chunks whose text came back, the only work discard() waits for.
	const writing = new Set<Promise<void>>();
	let releaseFlush: () => void = () => undefined;
	const discarded = new Promise<void>((resolve) => (releaseFlush = resolve));
	let isDiscarded = false;
	let stopped = false;
	let capped = false;
	let accruedMillicents = 0;
	let reservedCents = PREPAID_CENTS;
	let unreservedSeconds = 0;

	// ── metering ──

	// The cents this chunk must reserve so the reserved total covers the running cost. Counted
	// before the await so two speakers flushing at once never reserve the same cent twice.
	function centsOwedFor(millicents: number): number {
		accruedMillicents += millicents;
		const owed = Math.ceil(accruedMillicents / MILLICENTS_PER_CENT) - reservedCents;
		if (owed <= 0) return 0;
		reservedCents += owed;
		return owed;
	}

	function giveBack(millicents: number, cents: number): void {
		accruedMillicents -= millicents;
		reservedCents -= cents;
	}

	function refuseSpend(): void {
		if (capped) return;
		capped = true;
		console.info(`[meetings] spend refused guild=${guildId} meeting=${meetingId}`);
		stopHearing();
		deps.onSpendRefused(guildId, meetingId);
	}

	// ── one chunk ──

	// ① consent ② meter ③ transcribe ④ write. Every failure ends only this chunk; the meeting goes on.
	async function transcribe(userId: string, pcm48kStereo: Buffer, offsetMs: number, durationMs: number): Promise<void> {
		const cutAt = withdrawalsOf(userId);
		const withdrawnSince = (): boolean => revoked.has(userId) || withdrawalsOf(userId) !== cutAt;
		if (capped || isDiscarded || withdrawnSince()) return;
		// A read that throws rejects this chunk's promise, which track() logs: unreadable is a no.
		if (!(await deps.hasConsent(guildId, userId))) {
			silence(userId);
			return;
		}
		// Asked again after the wait: a cap, a discard or a withdrawal may have landed in it.
		if (capped || isDiscarded || withdrawnSince()) return;
		const millicents = sttMillicents(durationMs);
		const seconds = durationMs / MS_PER_SECOND;
		const cents = centsOwedFor(millicents);
		let reservation: SpendReservation | null = null;
		if (cents > 0) {
			// The seconds since the last reservation ride along, so the monthly row counts them all.
			reservation = await deps.reserve(guildId, cents, Math.round(unreservedSeconds + seconds));
			if (!reservation) {
				giveBack(millicents, cents);
				refuseSpend();
				return;
			}
			unreservedSeconds = 0;
		}
		else unreservedSeconds += seconds;

		let text: string;
		try {
			const wav = wavFromPcm16kMono(pcm48kStereoTo16kMono(pcm48kStereo));
			text = (await deps.stt.transcribe({ wav, durationMs })).text.trim();
		}
		catch (error) {
			giveBack(millicents, cents);
			if (reservation) await deps.refund(reservation).catch(() => undefined);
			const kind = error instanceof SttError ? error.kind : "unexpected";
			console.warn(`[meetings] chunk not transcribed guild=${guildId} meeting=${meetingId} speaker=${userId} kind=${kind} ms=${durationMs}`);
			return;
		}
		// ④ A withdrawal while the chunk was at the provider: its words are never written.
		if (isDiscarded || withdrawnSince() || text.length === 0) return;
		const before = await deps.readStanding(guildId, meetingId, userId);
		if (!before.consents) silence(userId);
		if (!before.consents || before.meeting !== "open") return;
		if (isDiscarded || withdrawnSince()) return;
		const kept = await keep(writeWords({ meetingId, guildId, speakerId: userId, offsetMs, durationMs, text }, withdrawnSince));
		if (kept) await deps.addUsage(guildId, meetingId, seconds, cents);
	}

	// Write one chunk's words and look once more, because a withdrawal or a delete can land while
	// the insert runs. The speaker entry goes first: with a revoked row it is the mark a restart
	// leaves of words still to be removed, so no word may land before it. True when they were kept.
	async function writeWords(segment: RecordedSegment, withdrawnSince: () => boolean): Promise<boolean> {
		const userId = segment.speakerId;
		await deps.addSpeaker(guildId, meetingId, userId);
		await deps.writeSegment(segment);
		// A read that fails here leaves the words: the read just before the write said yes, a
		// withdrawal since runs its own removal, and no summary is built without reading again.
		const after = await deps.readStanding(guildId, meetingId, userId).catch(() => null);
		if (after?.meeting === "gone") {
			await deps.removeMeetingWords(guildId, meetingId);
			return false;
		}
		const consentEnded = after !== null && !after.consents;
		if (consentEnded) silence(userId);
		if (!consentEnded && !withdrawnSince()) return true;
		await deps.removeSpeakerWords(guildId, meetingId, userId);
		return false;
	}

	// Hold a write where discard() can wait for it.
	function keep<T>(write: Promise<T>): Promise<T> {
		const settled: Promise<void> = write
			.then(
				() => undefined,
				() => undefined
			)
			.finally(() => writing.delete(settled));
		writing.add(settled);
		return write;
	}

	function track(userId: string, work: Promise<void>): void {
		const set = inflight.get(userId) ?? new Set<Promise<void>>();
		inflight.set(userId, set);
		const settled = work
			.catch((error: unknown) => {
				console.warn(`[meetings] chunk write failed guild=${guildId} meeting=${meetingId} speaker=${userId}`, error instanceof Error ? error.name : "unknown");
			})
			.finally(() => set.delete(settled));
		set.add(settled);
	}

	// Cut the speaker's current chunk. A burst under MIN_UTTERANCE_MS is noise and is dropped.
	function flushChunk(capture: SpeakerCapture): void {
		if (capture.silenceTimer) clearTimeout(capture.silenceTimer);
		capture.silenceTimer = null;
		const chunks = capture.chunks;
		const bytes = capture.bytes;
		const offsetMs = capture.chunkOffsetMs ?? 0;
		capture.chunks = [];
		capture.bytes = 0;
		capture.chunkOffsetMs = null;
		const durationMs = Math.round(bytes / PCM_BYTES_PER_MS);
		if (durationMs < BOT_CONSTANTS.MEETINGS.MIN_UTTERANCE_MS) return;
		track(capture.userId, transcribe(capture.userId, Buffer.concat(chunks), offsetMs, durationMs));
	}

	// ── one speaker ──

	function armSilence(capture: SpeakerCapture): void {
		if (capture.silenceTimer) clearTimeout(capture.silenceTimer);
		capture.silenceTimer = setTimeout(() => {
			capture.silenceTimer = null;
			flushChunk(capture);
		}, BOT_CONSTANTS.MEETINGS.CHUNK_SPEAKER_SILENCE_MS);
		capture.silenceTimer.unref?.();
	}

	function onPacket(capture: SpeakerCapture, packet: Buffer): void {
		if (capture.closed || stopped) return;
		if (packet.equals(OPUS_SILENCE_FRAME)) return;
		const pcm = capture.decoder.decode(packet);
		if (!pcm) return;
		if (capture.chunkOffsetMs === null) capture.chunkOffsetMs = deps.now() - startedAt;
		capture.chunks.push(pcm);
		capture.bytes += pcm.length;
		armSilence(capture);
		if (capture.bytes >= CHUNK_MAX_BYTES) flushChunk(capture);
	}

	// A stream that ends, closes or errors (DAVE destroys one on a packet it cannot decrypt)
	// ends its chunk; the member is subscribed again on their next speaking start.
	function onStreamGone(capture: SpeakerCapture): void {
		if (capture.closed) return;
		capture.closed = true;
		if (captures.get(capture.userId) === capture) captures.delete(capture.userId);
		flushChunk(capture);
		capture.decoder.close();
	}

	function subscribe(userId: string): void {
		if (stopped || capped || captures.has(userId) || revoked.has(userId)) return;
		if (captures.size >= BOT_CONSTANTS.MEETINGS.MAX_SPEAKERS) {
			console.info(`[meetings] capture skipped guild=${guildId} meeting=${meetingId} speaker=${userId} reason=too_many_speakers`);
			return;
		}
		// Manual: the recorder cuts chunks on its own clock, and an AfterSilence stream would end
		// at every pause and lose the start of the next sentence to a resubscribe.
		const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
		const capture: SpeakerCapture = { userId, stream, decoder: deps.createDecoder(), chunks: [], bytes: 0, chunkOffsetMs: null, silenceTimer: null, closed: false };
		captures.set(userId, capture);
		stream.on("data", (packet) => onPacket(capture, packet));
		stream.once("end", () => onStreamGone(capture));
		stream.once("close", () => onStreamGone(capture));
		stream.once("error", () => onStreamGone(capture));
	}

	// ① The consent gate, on every speaking start of a member not already subscribed.
	function onSpeakingStart(userId: string): void {
		if (stopped || capped || captures.has(userId) || checking.has(userId) || revoked.has(userId)) return;
		if (deps.isBot(guild, userId)) return;
		checking.add(userId);
		deps
			.hasConsent(guildId, userId)
			.then((agreed) => {
				// Gone from `checking` means they left the hall during the read: a slot taken now
				// would be held by somebody who is not there.
				if (agreed && checking.has(userId)) subscribe(userId);
			})
			.catch((error: unknown) => {
				console.warn(`[meetings] consent check failed guild=${guildId} speaker=${userId}`, error instanceof Error ? error.name : "unknown");
			})
			.finally(() => checking.delete(userId));
	}

	function close(capture: SpeakerCapture, keepBuffer: boolean): void {
		if (capture.silenceTimer) clearTimeout(capture.silenceTimer);
		capture.silenceTimer = null;
		capture.closed = true;
		if (!keepBuffer) {
			capture.chunks = [];
			capture.bytes = 0;
		}
		try {
			capture.stream.destroy();
		}
		catch {
			// A stream the library already tore down has nothing left to close.
		}
	}

	// Stop hearing one member and drop what they said, at once. The synchronous half of
	// dropSpeaker, and all a chunk may run on itself: the other half waits for the member's chunks,
	// and a chunk that waited for itself would never end (2026-11 item 420, risk R6).
	function silence(userId: string): void {
		revoked.add(userId);
		withdrawals.set(userId, withdrawalsOf(userId) + 1);
		const capture = captures.get(userId);
		if (capture) {
			captures.delete(userId);
			close(capture, false);
			capture.decoder.close();
		}
		for (let index = pending.length - 1; index >= 0; index -= 1) {
			if (pending[index].userId !== userId) continue;
			pending[index].chunks = [];
			pending[index].bytes = 0;
			pending.splice(index, 1);
		}
	}

	// Unsubscribe everyone, keeping each unflushed buffer for flush().
	const pending: SpeakerCapture[] = [];
	function stopHearing(): void {
		if (stopped) return;
		stopped = true;
		receiver.speaking.off("start", onSpeakingStart);
		for (const capture of [...captures.values()]) {
			close(capture, true);
			pending.push(capture);
		}
		captures.clear();
	}

	async function settle(userId?: string): Promise<void> {
		const sets = userId ? [inflight.get(userId) ?? new Set<Promise<void>>()] : [...inflight.values()];
		await Promise.all(sets.flatMap((set) => [...set]));
	}

	receiver.speaking.on("start", onSpeakingStart);
	console.info(`[meetings] recording guild=${guildId} meeting=${meetingId}`);

	const recorder: MeetingRecorder = {
		meetingId,
		guildId,
		get capturingCount() {
			return captures.size;
		},
		stop: stopHearing,
		async flush() {
			stopHearing();
			for (const capture of pending.splice(0)) {
				flushChunk(capture);
				capture.decoder.close();
			}
			await Promise.race([settle(), discarded]);
			if (recorders.get(meetingId) === recorder) recorders.delete(meetingId);
		},
		async discard() {
			isDiscarded = true;
			stopHearing();
			for (const capture of pending.splice(0)) {
				capture.chunks = [];
				capture.bytes = 0;
				capture.decoder.close();
			}
			if (recorders.get(meetingId) === recorder) recorders.delete(meetingId);
			await Promise.all([...writing]);
			releaseFlush();
		},
		async dropSpeaker(userId) {
			silence(userId);
			// A chunk at the provider writes nothing once `revoked` holds them; waiting for it
			// means the caller's delete runs after any write that had already begun.
			await settle(userId);
		},
		releaseSpeaker(userId) {
			checking.delete(userId);
			// The close it raises lands in onStreamGone, which sends the chunk and frees the slot.
			captures.get(userId)?.stream.destroy();
		},
		allowAgain(userId) {
			revoked.delete(userId);
		},
	};
	recorders.set(meetingId, recorder);
	return recorder;
}
