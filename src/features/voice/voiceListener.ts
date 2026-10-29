import type { Guild } from "discord.js";
import { EndBehaviorType, type EndBehavior } from "@discordjs/voice";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { isAuthorizedSpeaker, type AuthorizableMember } from "@features/dero-brain/authorizer.js";
import { readSpeakerAdminRoleId } from "@features/dero-brain/speakerAdminRole.js";
import { createOpusDecoder, DECODE_CHANNELS, DECODE_SAMPLE_RATE, type OpusPacketDecoder } from "./opusDecoder.js";
import { createTurnLoop, type TurnLoop, type TurnTarget } from "./turnLoop.js";
import type { VoiceSpeaker } from "./voiceSpeaker.js";

// ── voice listener ─────────────────────────────────────────────────────────
// What:  Dero's ears in one call. Hears ONLY members on the task list, one
//        utterance at a time, and hands each finished utterance to the turn loop.
// Who:   voiceSessions starts one per call once the call is Ready, and stops it
//        when the call ends. main.ts hands this factory to voiceSessions.
// When:  on every "started speaking" event the receiver raises for a member.
// Where: the OPERATOR GATE lives here and only here. A member who fails it is
//        never subscribed to: the receiver keeps dropping their packets
//        undecrypted and undecoded, exactly as it does for a deafened bot.
// How:   ① the gate, in this order: a bot is refused; a member outside Dero's
//        channel is refused; then the member must pass isAuthorizedSpeaker
//        against the stored allowlist with the kill switch on. A pass is
//        trusted for 60 seconds (a member pauses every few words, and each
//        pause is a new start event); a refusal is never cached. ② barge in: a
//        member who passes the gate while Dero is talking stops Dero at once.
//        ③ at most 3 members captured at a time per call. ④ subscribe with an
//        end after 800 ms of silence; one opusscript decoder per utterance;
//        concatenate the PCM. ⑤ past 20 seconds of audio the capture is cut
//        and discarded whole; under 400 ms it is discarded; otherwise it goes
//        to the turn loop, which serializes turns.
//
// ⚠️ PRIVACY: this file never logs, stores or writes audio. A capture holds its
// PCM in memory until it is handed over or discarded, and nothing else. Log
// lines carry ids, counts, milliseconds and reason codes only.

/** The slice of a receive stream the listener uses. An AudioReceiveStream fits it. */
export interface ReceiveStreamLike {
	on(event: "data", listener: (packet: Buffer) => void): unknown;
	once(event: "end" | "close" | "error", listener: () => void): unknown;
	destroy(): void;
}

/** The slice of a VoiceReceiver the listener uses. */
export interface ReceiverLike {
	speaking: {
		on(event: "start", listener: (userId: string) => void): unknown;
		off(event: "start", listener: (userId: string) => void): unknown;
	};
	subscribe(userId: string, options: { end: EndBehavior }): ReceiveStreamLike;
}

/** What the gate reads from a member. A GuildMember fits it. */
export interface ListenMember extends AuthorizableMember {
	user: { bot: boolean };
	voice: { channelId: string | null };
}

export interface ListenTarget extends TurnTarget {
	speaker: Pick<VoiceSpeaker, "speak" | "stop" | "status" | "lastOwnLineEndedAt">;
	receiver: ReceiverLike;
}

export interface VoiceListenerDeps {
	now(): number;
	createDecoder(): OpusPacketDecoder;
	/** The gateway cache only, so the common path never waits. */
	cachedMember(guild: Guild, userId: string): ListenMember | null;
	fetchMember(guild: Guild, userId: string): Promise<ListenMember | null>;
	loadConfig(guildId: string): Promise<IDeroVoiceConfig | null>;
	/**
	 * GuildConfig.adminRoleId, which authorizes by itself (post-launch plan item 12).
	 * Optional so a test rig that never builds it keeps the allowlist only rule; the
	 * default deps always wire it to readSpeakerAdminRoleId.
	 */
	loadAdminRoleId?(guildId: string): Promise<string | null>;
	createTurnLoop(target: TurnTarget): TurnLoop;
}

export interface VoiceListener {
	stop(): void;
	/** Members being captured right now. */
	readonly capturingCount: number;
}

export const defaultVoiceListenerDeps: VoiceListenerDeps = {
	now: () => Date.now(),
	createDecoder: createOpusDecoder,
	cachedMember: (guild, userId) => guild.members.cache.get(userId) ?? null,
	fetchMember: (guild, userId) => guild.members.fetch(userId).catch(() => null),
	loadConfig: (guildId) => deroVoiceConfigStore.findByGuildId(guildId),
	loadAdminRoleId: readSpeakerAdminRoleId,
	createTurnLoop: (target) => createTurnLoop(target),
};

const BYTES_PER_SAMPLE = 2;
const MS_PER_SECOND = 1000;
const PCM_BYTES_PER_MS = (DECODE_SAMPLE_RATE * DECODE_CHANNELS * BYTES_PER_SAMPLE) / MS_PER_SECOND;
const MAX_UTTERANCE_BYTES = BOT_CONSTANTS.DERO_VOICE_UTTERANCE_MAX_MS * PCM_BYTES_PER_MS;
// The three byte Opus frame Discord clients send for silence at the end of
// speech. It is audio packet traffic, not the member's voice, so it does not
// move the "speech ended" time.
const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

interface Capture {
	userId: string;
	stream: ReceiveStreamLike;
	decoder: OpusPacketDecoder;
	chunks: Buffer[];
	bytes: number;
	lastVoiceAt: number;
	tooLong: boolean;
	finished: boolean;
}

/** Start listening in one Ready call. Never throws on a member's audio; stop() ends it all. */
export function startVoiceListener(target: ListenTarget, deps: VoiceListenerDeps = defaultVoiceListenerDeps): VoiceListener {
	const { guild, receiver } = target;
	const turnLoop = deps.createTurnLoop(target);
	const captures = new Map<string, Capture>();
	const checking = new Set<string>();
	const trustedUntil = new Map<string, number>();
	let stopped = false;

	// ── ① the operator gate ──

	// Bot and channel are re-read from the live member on every start event, so
	// a member who walks out of the call is refused at once even while trusted.
	function isInCallHuman(member: ListenMember): boolean {
		return !member.user.bot && member.voice.channelId === target.channelId;
	}

	function isTrusted(userId: string): boolean {
		const until = trustedUntil.get(userId);
		return until !== undefined && deps.now() < until;
	}

	async function passesAllowlist(member: ListenMember): Promise<boolean> {
		const config = await deps.loadConfig(guild.id);
		if (!config || !config.enabled) return false;
		const adminRoleId = deps.loadAdminRoleId ? await deps.loadAdminRoleId(guild.id) : null;
		return isAuthorizedSpeaker({ member, guildOwnerId: guild.ownerId, adminRoleId, voiceConfig: config });
	}

	async function verify(userId: string): Promise<boolean> {
		const member = deps.cachedMember(guild, userId) ?? (await deps.fetchMember(guild, userId));
		if (!member || !isInCallHuman(member)) return false;
		if (!(await passesAllowlist(member))) return false;
		trustedUntil.set(userId, deps.now() + BOT_CONSTANTS.DERO_VOICE_AUTHORIZED_CACHE_MS);
		return true;
	}

	// ── ② barge in ──

	function bargeIn(): void {
		if (target.speaker.status === "playing") target.speaker.stop();
	}

	// ── ④ ⑤ capture ──

	function onPacket(capture: Capture, packet: Buffer): void {
		if (capture.finished || capture.tooLong) return;
		if (!packet.equals(OPUS_SILENCE_FRAME)) capture.lastVoiceAt = deps.now();
		const pcm = capture.decoder.decode(packet);
		if (!pcm) return;
		if (capture.bytes + pcm.length > MAX_UTTERANCE_BYTES) {
			// ⑤ too long: everything captured so far goes, nothing is sent
			capture.tooLong = true;
			capture.chunks = [];
			capture.bytes = 0;
			capture.stream.destroy();
			return;
		}
		capture.chunks.push(pcm);
		capture.bytes += pcm.length;
	}

	function finish(capture: Capture): void {
		if (capture.finished) return;
		capture.finished = true;
		if (captures.get(capture.userId) === capture) captures.delete(capture.userId);
		capture.decoder.close();
		const chunks = capture.chunks;
		capture.chunks = [];
		if (stopped) return;

		const durationMs = Math.round(capture.bytes / PCM_BYTES_PER_MS);
		if (capture.tooLong || durationMs < BOT_CONSTANTS.DERO_VOICE_UTTERANCE_MIN_MS) {
			// A too short capture is a cough, a click or a game sound through an open mic, many a
			// minute in a busy call, so it is dropped without a line (the owner's call: it flooded
			// the terminal). A too long one is rare and worth knowing about, so it still logs.
			if (capture.tooLong) console.info(`[dero-voice] utterance discarded guild=${guild.id} speaker=${capture.userId} reason=too_long ms=${durationMs}`);
			return;
		}
		turnLoop.submit({
			speakerId: capture.userId,
			pcm48kStereo: Buffer.concat(chunks),
			durationMs,
			speechEndedAt: capture.lastVoiceAt,
		});
	}

	function begin(userId: string): void {
		if (stopped || captures.has(userId)) return;
		// ②
		bargeIn();
		// ③
		if (captures.size >= BOT_CONSTANTS.DERO_VOICE_MAX_CONCURRENT_CAPTURES) {
			console.info(`[dero-voice] capture skipped guild=${guild.id} speaker=${userId} reason=too_many_speakers`);
			return;
		}
		// ④
		const stream = receiver.subscribe(userId, {
			end: { behavior: EndBehaviorType.AfterSilence, duration: BOT_CONSTANTS.DERO_VOICE_UTTERANCE_SILENCE_MS },
		});
		const capture: Capture = {
			userId,
			stream,
			decoder: deps.createDecoder(),
			chunks: [],
			bytes: 0,
			lastVoiceAt: deps.now(),
			tooLong: false,
			finished: false,
		};
		captures.set(userId, capture);
		stream.on("data", (packet) => onPacket(capture, packet));
		stream.once("end", () => finish(capture));
		stream.once("close", () => finish(capture));
		// The library destroys the stream on a packet it cannot decrypt; what was
		// captured so far still counts, the error itself carries no audio.
		stream.once("error", () => finish(capture));
	}

	function onSpeakingStart(userId: string): void {
		if (stopped) return;
		// Already capturing: this member passed the gate for this very utterance,
		// so a new start (they paused and went on) only matters for barge in.
		if (captures.has(userId)) {
			bargeIn();
			return;
		}
		if (checking.has(userId)) return;

		// A cached member who is a bot or outside the call is refused with no
		// config read at all; a trusted member in the call is let in at once, so
		// the first syllable is not lost to a database round trip.
		const cached = deps.cachedMember(guild, userId);
		if (cached && !isInCallHuman(cached)) return;
		if (cached && isTrusted(userId)) {
			begin(userId);
			return;
		}

		checking.add(userId);
		verify(userId)
			.then((allowed) => {
				if (allowed) begin(userId);
			})
			.catch((error: unknown) => {
				console.warn(`[dero-voice] operator check failed guild=${guild.id} speaker=${userId}`, error);
			})
			.finally(() => checking.delete(userId));
	}

	receiver.speaking.on("start", onSpeakingStart);
	console.info(`[dero-voice] listening guild=${guild.id} channel=${target.channelId}`);

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			receiver.speaking.off("start", onSpeakingStart);
			for (const capture of [...captures.values()]) {
				capture.chunks = [];
				capture.decoder.close();
				capture.stream.destroy();
			}
			captures.clear();
			checking.clear();
			trustedUntil.clear();
			turnLoop.close();
		},
		get capturingCount() {
			return captures.size;
		},
	};
}
