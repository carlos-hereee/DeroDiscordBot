import type { Guild, GuildMember } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { isAuthorizedSpeaker } from "@features/dero-brain/authorizer.js";
import {
	describeBrainTurn,
	runBrainTurn,
	type BrainTurnInput,
	type BrainTurnResult,
	type UnansweredReason,
} from "@features/dero-brain/brainTurn.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import type { ActionReport } from "@features/dero-brain/executor.js";
import { addressingOf } from "./addressing.js";
import { renderCallSpeech, type CallSpeechInput, type CallSpeechResult } from "./callSpeech.js";
import { elevenLabsStt } from "./elevenLabsStt.js";
import { postVoiceNotice } from "./joinNotice.js";
import { cleanListenText, truncateAtSentence } from "./listenText.js";
import { estimateSttCents } from "./pricing.js";
import { pcm48kStereoTo16kMono } from "./resample.js";
import { refund, tryReserve, type ReserveResult, type SpendReservation } from "./spendMeter.js";
import { SttError, type SttProvider } from "./sttProvider.js";
import { turnLatencyLog, type LatencyLog, type TurnTimings } from "./turnLatency.js";
import { voiceCopy } from "./voiceCopy.js";
import type { SpeakResult, VoiceSpeaker } from "./voiceSpeaker.js";
import { wavFromPcm16kMono } from "./wavFile.js";

// ── turn loop ──────────────────────────────────────────────────────────────
// What:  everything between "a member on the task list finished a sentence in
//        the call" and "Dero answered it": transcribe, decide whether it was
//        meant for Dero, run the same brain turn as /dero tell, and speak.
// Who:   voiceListener makes one loop per call and submits each finished
//        utterance. Nothing else submits.
// When:  ONE TURN AT A TIME per call. An utterance that arrives while a turn
//        runs waits, at most two of them; a third is dropped untranscribed.
// Where: the only place a member's audio leaves the bot (to speech to text),
//        and the only place a transcript exists at all.
// How:   ① the kill switch and a voice to answer with, from a fresh config
//        read; ② downsample to 16 kHz mono and wrap as WAV; ③ reserve the
//        spend for the audio length (a refusal speaks the budget line);
//        ④ transcribe once, refunding on failure (a failure speaks the
//        hearing line); the audio is dropped right here, when the call returns
//        or fails; ⑤ drop an empty or one character transcript; ⑥ the
//        addressing rule, which drops everything not meant for Dero; ⑦ the
//        speaker re-authorized against the fresh config; ⑧ runBrainTurn with
//        source "voice", the text cut to 300 characters; ⑨ speak: the brain's
//        own `say` was already spoken by the executor, otherwise Dero speaks
//        the executor's summary or the canned line for why there is no answer;
//        ⑩ latency and one audit row.
//
// The budget and hearing lines are spoken at most once every 30 seconds per
// server and never retried; when even that line cannot be rendered, it is
// posted in text in the call's control channel instead.
//
// ⚠️ PRIVACY: audio lives only inside transcribeUtterance and is gone when it
// returns. The transcript is never logged, stored, put in an error or in the
// audit row (which carries its LENGTH as transcriptChars). Nothing here writes
// to disk.

/** One finished sentence from one member, handed over by the listener. */
export interface Utterance {
	speakerId: string;
	/** 48 kHz stereo s16le. The loop empties this field the moment it reads it. */
	pcm48kStereo: Buffer;
	durationMs: number;
	/** When the member's last non silent packet arrived. */
	speechEndedAt: number;
}

/** The call a loop answers in. A voiceSessions session fits it. */
export interface TurnTarget {
	guild: Guild;
	channelId: string;
	controlChannelId: string;
	speaker: Pick<VoiceSpeaker, "speak" | "lastOwnLineEndedAt">;
}

export interface TurnLoopDeps {
	now(): number;
	loadConfig(guildId: string): Promise<IDeroVoiceConfig | null>;
	findMember(guild: Guild, userId: string): Promise<GuildMember | null>;
	reserve(guildId: string, cents: number, options: { sttSeconds: number }): Promise<ReserveResult>;
	refund(reservation: SpendReservation): Promise<void>;
	stt: SttProvider;
	runTurn(input: BrainTurnInput): Promise<BrainTurnResult>;
	render(input: CallSpeechInput): Promise<CallSpeechResult>;
	postNotice(guild: Guild, channelId: string, line: string): Promise<void>;
	audit(guildId: string, metadata: Record<string, unknown>): void;
	latency: LatencyLog;
	/** One per process, keyed by guild id, so a rejoin does not reset it. */
	troubleCooldown: CooldownManager;
}

export type SubmitResult = "started" | "queued" | "dropped";

export interface TurnLoop {
	submit(utterance: Utterance): SubmitResult;
	/** Drop every waiting utterance and refuse new ones. A running turn finishes quietly. */
	close(): void;
	readonly waitingCount: number;
}

const MS_PER_SECOND = 1000;
const EMPTY_AUDIO = Buffer.alloc(0);
const CHANNEL_MENTION = /<#(\d+)>/g;

type TroubleKind = "capReached" | "hearingTrouble";

const UNANSWERED_SPOKEN: Record<UnansweredReason, string> = {
	offline: voiceCopy.turn.spoken.brainOffline,
	busy: voiceCopy.turn.spoken.busy,
	timeout: voiceCopy.turn.spoken.timeout,
	notUnderstood: voiceCopy.turn.spoken.notUnderstood,
};

const sharedTroubleCooldown = new CooldownManager(BOT_CONSTANTS.DERO_VOICE_TROUBLE_LINE_COOLDOWN_MS);

export const defaultTurnLoopDeps: TurnLoopDeps = {
	now: () => Date.now(),
	loadConfig: (guildId) => deroVoiceConfigStore.findByGuildId(guildId),
	findMember: async (guild, userId) => guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null)),
	reserve: (guildId, cents, options) => tryReserve(guildId, cents, options),
	refund,
	stt: elevenLabsStt,
	runTurn: (input) => runBrainTurn(input),
	render: renderCallSpeech,
	postNotice: postVoiceNotice,
	// Fire and forget: an audit row never changes what Dero says.
	audit: (guildId, metadata) => {
		botLogStore.log(guildId, BOT_LOG_EVENTS.DERO_VOICE_TURN, metadata).catch((error) => {
			console.error(`[dero-voice] turn audit write failed guild=${guildId}`, error);
		});
	},
	latency: turnLatencyLog,
	troubleCooldown: sharedTroubleCooldown,
};

/**
 * What Dero says when the brain answered and no `say` was spoken: the
 * executor's report lines, with a channel mention read as the channel's name
 * and everything speech cannot carry removed.
 */
export function speakableSummary(reports: ActionReport[], guild: Pick<Guild, "channels">): string {
	if (reports.length === 0) return deroBrainCopy.tell.nothingToDo;
	const named = reports
		.map((entry) => entry.line)
		.join(" ")
		.replace(CHANNEL_MENTION, (_mention, channelId: string) => guild.channels.cache.get(channelId)?.name ?? "that channel");
	return cleanListenText(named);
}

type TranscribeOutcome =
	| { status: "ok"; transcript: string; transcriptAt: number; wavBytes: number }
	| { status: "capReached"; code: string; wavBytes: number }
	| { status: "failed"; code: string; wavBytes: number };

/** One call's serial queue of utterances. */
export function createTurnLoop(target: TurnTarget, deps: TurnLoopDeps = defaultTurnLoopDeps): TurnLoop {
	const { guild } = target;
	const waiting: Utterance[] = [];
	let running = false;
	let closed = false;

	// ── speaking ──

	async function speakOwnLine(voiceId: string, line: string): Promise<SpeakResult | "capReached" | "failed"> {
		const text = truncateAtSentence(line, BOT_CONSTANTS.DERO_VOICE_TURN_SPEECH_MAX_CHARS).text;
		if (!text) return "dropped";
		const speech = await deps.render({ guildId: guild.id, voiceId, text });
		if (speech.status === "capReached") return "capReached";
		if (speech.status === "failed") return "failed";
		return target.speaker.speak(speech.pcm48kStereo, "brain");
	}

	// Rate limited to one per guild per window, never retried. Returns how the
	// line was delivered, for the audit row.
	async function reportTrouble(kind: TroubleKind, voiceId: string): Promise<string> {
		const now = deps.now();
		if (deps.troubleCooldown.check(guild.id, now).onCooldown) return "quiet";
		deps.troubleCooldown.record(guild.id, now);
		const spoken = await speakOwnLine(voiceId, voiceCopy.turn.spoken[kind]);
		if (spoken === "playing" || spoken === "queued") return "spoken";
		await deps.postNotice(guild, target.controlChannelId, voiceCopy.turn.text[kind]);
		return "posted";
	}

	async function postSilentAnswer(reports: ActionReport[]): Promise<string> {
		const now = deps.now();
		if (deps.troubleCooldown.check(guild.id, now).onCooldown) return "quiet";
		deps.troubleCooldown.record(guild.id, now);
		const lines = reports.length > 0 ? reports.map((entry) => entry.line) : [deroBrainCopy.tell.nothingToDo];
		await deps.postNotice(guild, target.controlChannelId, [voiceCopy.turn.text.voiceTrouble, ...lines].join("\n"));
		return "posted";
	}

	// ── ② ③ ④ the only function that ever holds the audio ──

	async function transcribeUtterance(utterance: Utterance): Promise<TranscribeOutcome> {
		const pcm = utterance.pcm48kStereo;
		utterance.pcm48kStereo = EMPTY_AUDIO;
		// ②
		const wav = wavFromPcm16kMono(pcm48kStereoTo16kMono(pcm));
		const wavBytes = wav.length;

		// ③
		const sttSeconds = Math.ceil(utterance.durationMs / MS_PER_SECOND);
		const reserved = await deps.reserve(guild.id, estimateSttCents(utterance.durationMs), { sttSeconds });
		if (reserved.status === "capReached") return { status: "capReached", code: "cap_reached", wavBytes };

		// ④ exactly one call; the WAV goes out of scope when this returns
		try {
			const { text } = await deps.stt.transcribe({ wav, durationMs: utterance.durationMs });
			return { status: "ok", transcript: text.trim(), transcriptAt: deps.now(), wavBytes };
		}
		catch (error) {
			await deps.refund(reserved.reservation);
			const kind = error instanceof SttError ? error.kind : "unexpected";
			return { status: "failed", code: `stt_failed:${kind}`, wavBytes };
		}
	}

	// ── one turn ──

	async function runOne(utterance: Utterance): Promise<void> {
		const speakerId = utterance.speakerId;
		const audit: Record<string, unknown> = { speakerId, channelId: target.channelId, audioMs: utterance.durationMs };
		const timings: TurnTimings = { speechToTranscriptMs: null, transcriptToResultMs: null, resultToAudioMs: null, totalMs: null };
		const finish = (outcome: string, extra: Record<string, unknown> = {}): void => {
			deps.audit(guild.id, { ...audit, outcome, ...extra, ...timings });
		};

		// ①
		const config = await deps.loadConfig(guild.id);
		if (!config || !config.enabled || !config.voiceId || config.guildId !== guild.id) {
			utterance.pcm48kStereo = EMPTY_AUDIO;
			finish("switched_off");
			return;
		}
		const voiceId = config.voiceId;

		// ② ③ ④
		const heard = await transcribeUtterance(utterance);
		audit.wavBytes = heard.wavBytes;
		if (heard.status === "capReached") {
			finish(heard.code, { delivery: await reportTrouble("capReached", voiceId) });
			return;
		}
		if (heard.status === "failed") {
			finish(heard.code, { delivery: await reportTrouble("hearingTrouble", voiceId) });
			return;
		}
		const transcriptChars = heard.transcript.length;
		audit.transcriptChars = transcriptChars;
		timings.speechToTranscriptMs = heard.transcriptAt - utterance.speechEndedAt;

		// ⑤
		if (transcriptChars < BOT_CONSTANTS.DERO_VOICE_MIN_TRANSCRIPT_CHARS) {
			finish("empty");
			return;
		}

		// ⑥
		const addressed = addressingOf({
			transcript: heard.transcript,
			utteranceEndedAt: utterance.speechEndedAt,
			deroLastSpokeAt: target.speaker.lastOwnLineEndedAt,
		});
		audit.addressed = addressed;
		if (addressed === "notAddressed") {
			finish("not_addressed");
			return;
		}

		// ⑦
		const member = await deps.findMember(guild, speakerId);
		if (!member || !isAuthorizedSpeaker({ member, guildOwnerId: guild.ownerId, voiceConfig: config })) {
			const spoken = await speakOwnLine(voiceId, voiceCopy.turn.spoken.notAllowed);
			finish("not_authorized", { delivery: spoken });
			return;
		}

		// ⑧
		const task = truncateAtSentence(heard.transcript, BOT_CONSTANTS.DERO_BRAIN_MAX_TASK_CHARS).text;
		const turn = await deps.runTurn({ guild, speaker: member, text: task, source: "voice", voiceConfig: config });
		const brainAsked = turn.jobId !== null;
		if (brainAsked) timings.transcriptToResultMs = turn.resultAt - heard.transcriptAt;

		// ⑨
		let firstAudioAt: number | null = null;
		let delivery: string;
		if (turn.status === "unanswered") {
			const spoken = await speakOwnLine(voiceId, UNANSWERED_SPOKEN[turn.reason]);
			delivery = String(spoken);
			if (spoken === "playing" || spoken === "queued") firstAudioAt = deps.now();
		}
		else if (turn.reports.some((entry) => entry.type === "say" && entry.outcome === "spoke")) {
			// The executor already queued the brain's own words. Measured when the
			// executor returned, a few milliseconds after that clip was queued.
			delivery = "say";
			firstAudioAt = deps.now();
		}
		else {
			const spoken = await speakOwnLine(voiceId, speakableSummary(turn.reports, guild));
			if (spoken === "playing" || spoken === "queued") {
				delivery = "summary";
				firstAudioAt = deps.now();
			}
			else {
				delivery = await postSilentAnswer(turn.reports);
			}
		}

		// ⑩ only turns that reached the brain and then spoke count toward the
		// latency history; an offline line answers at once and would flatter it
		if (firstAudioAt !== null) {
			timings.resultToAudioMs = firstAudioAt - turn.resultAt;
			timings.totalMs = firstAudioAt - utterance.speechEndedAt;
			if (brainAsked) deps.latency.record(guild.id, timings.totalMs);
		}
		const described = describeBrainTurn(turn);
		finish(described.outcome, { jobId: described.jobId, actions: described.actions, delivery });
	}

	async function runSafely(utterance: Utterance): Promise<void> {
		try {
			await runOne(utterance);
		}
		catch (error) {
			// A store or executor fault. The error comes from Mongo or Discord and
			// holds no audio or transcript; ids only beside it.
			utterance.pcm48kStereo = EMPTY_AUDIO;
			console.error(`[dero-voice] turn failed guild=${guild.id} speaker=${utterance.speakerId}`, error);
			deps.audit(guild.id, { speakerId: utterance.speakerId, channelId: target.channelId, audioMs: utterance.durationMs, outcome: "failed" });
		}
	}

	async function drain(first: Utterance): Promise<void> {
		let next: Utterance | undefined = first;
		while (next && !closed) {
			await runSafely(next);
			next = waiting.shift();
		}
		running = false;
	}

	return {
		submit(utterance) {
			if (closed) return "dropped";
			if (!running) {
				running = true;
				void drain(utterance);
				return "started";
			}
			if (waiting.length >= BOT_CONSTANTS.DERO_VOICE_MAX_WAITING_TURNS) {
				// Never transcribed, never sent anywhere.
				utterance.pcm48kStereo = EMPTY_AUDIO;
				deps.audit(guild.id, { speakerId: utterance.speakerId, channelId: target.channelId, audioMs: utterance.durationMs, outcome: "queue_full" });
				return "dropped";
			}
			waiting.push(utterance);
			return "queued";
		},
		close() {
			closed = true;
			for (const utterance of waiting) utterance.pcm48kStereo = EMPTY_AUDIO;
			waiting.length = 0;
		},
		get waitingCount() {
			return waiting.length;
		},
	};
}
