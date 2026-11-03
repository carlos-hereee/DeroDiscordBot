import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import type { IDeroVoiceSpend } from "@db/models/DeroVoiceSpend.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { deroVoiceSpendStore } from "@db/stores/deroVoiceSpendStore.js";
import { brainQueue } from "@features/dero-brain/brainQueue.js";
import { monthKey } from "./spendMeter.js";
import { turnLatencyLog } from "./turnLatency.js";
import { finishedTurnCount } from "./turnLoop.js";
import { voiceSessions } from "./voiceSessions.js";

// ── soak sampler ───────────────────────────────────────────────────────────
// What:  the numbers the owner's 30 minute soak test is judged on, written as
//        ONE audit row a minute: resident memory, open calls, rejoins so far,
//        brain queue depth, finished voice turns, this month's speech spend for
//        the guild in the call, and the median of its last 50 turn latencies.
// Who:   main.ts starts it on ClientReady and stops it on shutdown. It is OFF
//        unless the DERO_VOICE_SAMPLER env value is exactly 1 (config.ts), and
//        nothing else reads or writes through it.
// When:  every DERO_VOICE_SAMPLER_INTERVAL_MS, and only while a call is open; a
//        tick with no call writes nothing. With several calls open the row is
//        for the oldest one (the soak runs one call, so the guild is never in
//        doubt), and `sessions` says how many there were.
// Where: reads counters the voice modules already keep; adds no state of its
//        own beyond the interval timer, which is unref'd so it never holds a
//        shutting down process open.
// How:   ① read the call counts; no call, no row; ② read the month's spend row
//        for that guild; ③ format numbers only; ④ write fire and forget.
//
// ⚠️ PRIVACY: numbers only. The guild id is the only id in a row, and no text,
// transcript or audio is ever read here, let alone written.

const BYTES_PER_MEGABYTE = 1024 * 1024;
const MEGABYTE_DECIMALS = 10;
const MS_PER_SECOND = 1000;

/** The raw readings one tick takes, before formatting. */
export interface SoakReading {
	rssBytes: number;
	sessions: number;
	rejoinsTotal: number;
	queueDepth: number;
	turnsFinished: number;
	spend: Pick<IDeroVoiceSpend, "ttsChars" | "sttSeconds" | "estimatedCents"> | null;
	latencyMedianMs: number | null;
}

/** One soak row: every field a number, the latency median null until a turn was measured. */
export interface SoakSample {
	rssMb: number;
	sessions: number;
	reconnects: number;
	queueDepth: number;
	turnsFinished: number;
	ttsChars: number;
	sttSeconds: number;
	spendCents: number;
	latencyMedianMs: number | null;
}

export interface SoakSamplerDeps {
	now(): Date;
	rssBytes(): number;
	sessionStats(): { guildIds: string[]; rejoinsTotal: number };
	queueDepth(): number;
	turnsFinished(): number;
	findSpend(guildId: string, month: string): Promise<IDeroVoiceSpend | null>;
	latencyMedianMs(guildId: string): number | null;
	write(guildId: string, sample: SoakSample): void;
}

export const defaultSoakSamplerDeps: SoakSamplerDeps = {
	now: () => new Date(),
	rssBytes: () => process.memoryUsage().rss,
	sessionStats: () => voiceSessions.stats(),
	queueDepth: () => brainQueue.openJobCount(),
	turnsFinished: finishedTurnCount,
	findSpend: (guildId, month) => deroVoiceSpendStore.findMonth(guildId, month),
	latencyMedianMs: (guildId) => turnLatencyLog.summary(guildId)?.medianMs ?? null,
	// ④ Fire and forget: a failed sample row never touches a call.
	write: (guildId, sample) => {
		botLogStore.log(guildId, BOT_LOG_EVENTS.DERO_VOICE_SAMPLE, { ...sample }).catch((error) => {
			console.error(`[dero-voice] soak sample write failed guild=${guildId}`, error);
		});
	},
};

/** ③ A tick's readings as the row the owner reads: memory in megabytes to one decimal, a missing spend row as zero. */
export function formatSoakSample(reading: SoakReading): SoakSample {
	return {
		rssMb: Math.round((reading.rssBytes / BYTES_PER_MEGABYTE) * MEGABYTE_DECIMALS) / MEGABYTE_DECIMALS,
		sessions: reading.sessions,
		reconnects: reading.rejoinsTotal,
		queueDepth: reading.queueDepth,
		turnsFinished: reading.turnsFinished,
		ttsChars: reading.spend?.ttsChars ?? 0,
		sttSeconds: reading.spend?.sttSeconds ?? 0,
		spendCents: reading.spend?.estimatedCents ?? 0,
		latencyMedianMs: reading.latencyMedianMs,
	};
}

/** One tick: write a row for the oldest open call, or nothing when no call is open. Returns what it wrote. */
export async function takeSoakSample(deps: SoakSamplerDeps = defaultSoakSamplerDeps): Promise<{ guildId: string; sample: SoakSample } | null> {
	// ①
	const stats = deps.sessionStats();
	const guildId = stats.guildIds[0];
	if (!guildId) return null;

	// ②
	const spend = await deps.findSpend(guildId, monthKey(deps.now()));
	const sample = formatSoakSample({
		rssBytes: deps.rssBytes(),
		sessions: stats.guildIds.length,
		rejoinsTotal: stats.rejoinsTotal,
		queueDepth: deps.queueDepth(),
		turnsFinished: deps.turnsFinished(),
		spend,
		latencyMedianMs: deps.latencyMedianMs(guildId),
	});
	deps.write(guildId, sample);
	return { guildId, sample };
}

/**
 * Start the sampler when `enabled`, which main.ts passes from config.ts. Returns
 * null, with no timer armed, when it is off. Never throws: a failed tick is
 * logged and the next one runs on schedule.
 */
export function startSoakSampler(enabled: boolean, deps: SoakSamplerDeps = defaultSoakSamplerDeps): { stop(): void } | null {
	if (!enabled) return null;
	console.info(`[dero-voice] soak sampler on: one row every ${BOT_CONSTANTS.DERO_VOICE_SAMPLER_INTERVAL_MS / MS_PER_SECOND}s while a call is open`);
	const timer = setInterval(() => {
		takeSoakSample(deps).catch((error) => console.error("[dero-voice] soak sample failed", error));
	}, BOT_CONSTANTS.DERO_VOICE_SAMPLER_INTERVAL_MS);
	timer.unref?.();
	return { stop: () => clearInterval(timer) };
}
