import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── turn latency ───────────────────────────────────────────────────────────
// What:  how long a voice turn took, as four numbers, and a short in memory
//        history of the totals so /dero status can show the median and the
//        slowest.
// Who:   turnLoop measures and records; /dero status reads the summary for
//        members on the task list; the owner reads it at Gate B.
// When:  one record per turn that ended with Dero speaking. A turn that ended
//        in silence or in a text notice has no "first audio" and is not counted.
// Where: in memory by design, per guild, the last 50 totals. A deploy resets it,
//        which is fine for a number that only describes recent turns.
// How:   speech end (the member's last non silent packet) to transcript,
//        transcript to the brain's result, result to the first audio queued on
//        the speaker, and the total from speech end to that first audio.

/** One turn's timings in milliseconds. A step that did not happen is null. */
export interface TurnTimings {
	speechToTranscriptMs: number | null;
	transcriptToResultMs: number | null;
	resultToAudioMs: number | null;
	totalMs: number | null;
}

export interface LatencySummary {
	count: number;
	medianMs: number;
	slowestMs: number;
}

export interface LatencyLog {
	record(guildId: string, totalMs: number): void;
	summary(guildId: string): LatencySummary | null;
}

function median(sorted: number[]): number {
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[middle];
	return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** A per guild ring of the most recent totals. `turnLatencyLog` below is the live one. */
export function createLatencyLog(limit: number = BOT_CONSTANTS.DERO_VOICE_LATENCY_SAMPLES): LatencyLog {
	const totalsByGuild = new Map<string, number[]>();

	return {
		record(guildId, totalMs) {
			if (!Number.isFinite(totalMs) || totalMs < 0) return;
			const totals = totalsByGuild.get(guildId) ?? [];
			totals.push(Math.round(totalMs));
			// The oldest total falls off first, so the history is always the most
			// recent `limit` turns.
			if (totals.length > limit) totals.splice(0, totals.length - limit);
			totalsByGuild.set(guildId, totals);
		},
		summary(guildId) {
			const totals = totalsByGuild.get(guildId);
			if (!totals || totals.length === 0) return null;
			const sorted = [...totals].sort((a, b) => a - b);
			return { count: sorted.length, medianMs: median(sorted), slowestMs: sorted[sorted.length - 1] };
		},
	};
}

export const turnLatencyLog: LatencyLog = createLatencyLog();
