import type { Guild, GuildMember } from "discord.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { buildJobInput } from "./brainJob.js";
import { brainQueue, type BrainQueue } from "./brainQueue.js";
import type { BrainAction, BrainJobSource, BrainOutcome } from "./brainTypes.js";
import { executeActions, type ActionReport, type ExecuteInput } from "./executor.js";

// ── brain turn ────────────────────────────────────────────────────────────
// What:  the one "ask the brain and act on its answer" step: build the job,
//        enqueue it, wait for the outcome, and either say why there is no
//        answer or execute the answer against a fresh config read.
// Who:   /dero tell (source "text") and the voice turn loop (source "voice").
//        Both call this and nothing else to reach the brain, so the two paths
//        can never disagree about what an answer means.
// When:  after the caller has checked the speaker against the authorizer. The
//        executor re-authorizes the speaker against a fresh member at action
//        time; this step does not authorize anyone.
// Where: no Discord replies and no audit writes here. Each caller shows the
//        outcome its own way (an ephemeral embed, or a spoken line) and writes
//        its own audit row, using describeBrainTurn for the shared fields.
// How:   ① the brain is offline: no job is made; ② enqueue and wait (the queue
//        times out at 20 seconds, so this never waits longer); ③ anything but
//        an "ok" result is unanswered, with a reason and an audit code;
//        ④ the kill switch and allowlists may have changed while the brain
//        thought, so the executor gets a FRESH config read, not the caller's.
//
// ⚠️ PRIVACY: the text goes to the brain and nowhere else. Nothing here logs it,
// stores it or puts it in a result.

export type UnansweredReason = "offline" | "busy" | "timeout" | "notUnderstood";

export type BrainTurnResult =
	| {
			status: "answered";
			jobId: string;
			offeredChannels: number;
			actions: BrainAction[];
			reports: ActionReport[];
			/** When the brain's result arrived, before any action ran. */
			resultAt: number;
	  }
	| {
			status: "unanswered";
			jobId: string | null;
			offeredChannels: number;
			reason: UnansweredReason;
			/** The audit outcome code: offline, busy, timeout, error or rejected:<reason>. */
			code: string;
			resultAt: number;
	  };

export interface BrainTurnInput {
	guild: Guild;
	speaker: GuildMember;
	/** Already trimmed and within DERO_BRAIN_MAX_TASK_CHARS. */
	text: string;
	source: BrainJobSource;
	/** The config the caller authorized against; supplies the channel allowlist. */
	voiceConfig: IDeroVoiceConfig;
}

export interface BrainTurnDeps {
	queue: Pick<BrainQueue, "enqueue" | "isBrainOnline">;
	loadConfig(guildId: string): Promise<IDeroVoiceConfig | null>;
	execute(input: ExecuteInput): Promise<ActionReport[]>;
	now(): number;
}

export const defaultBrainTurnDeps: BrainTurnDeps = {
	queue: brainQueue,
	loadConfig: (guildId) => deroVoiceConfigStore.findByGuildId(guildId),
	execute: executeActions,
	now: () => Date.now(),
};

// ③ How an outcome that is not an "ok" result reads, for every caller.
function unanswered(outcome: BrainOutcome): { reason: UnansweredReason; code: string } {
	if (outcome.kind === "timeout") return { reason: "timeout", code: "timeout" };
	if (outcome.kind === "rejected") return { reason: "notUnderstood", code: `rejected:${outcome.reason}` };
	if (outcome.result.status === "busy") return { reason: "busy", code: "busy" };
	return { reason: "notUnderstood", code: "error" };
}

/** Ask the brain about one task and act on its answer. Throws only what the executor or a store throws. */
export async function runBrainTurn(input: BrainTurnInput, deps: BrainTurnDeps = defaultBrainTurnDeps): Promise<BrainTurnResult> {
	const { guild, speaker, text, source, voiceConfig } = input;

	// ①
	if (!deps.queue.isBrainOnline()) {
		return { status: "unanswered", jobId: null, offeredChannels: 0, reason: "offline", code: "offline", resultAt: deps.now() };
	}

	// ②
	const job = buildJobInput({ guild, speaker, text, voiceConfig, source });
	const { jobId, outcome: pendingOutcome } = deps.queue.enqueue(job);
	const outcome = await pendingOutcome;
	const resultAt = deps.now();
	const offeredChannels = job.channels.length;

	// ③
	if (outcome.kind !== "result" || outcome.result.status !== "ok") {
		return { status: "unanswered", jobId, offeredChannels, ...unanswered(outcome), resultAt };
	}

	// ④
	const freshConfig = await deps.loadConfig(guild.id);
	const actions = outcome.result.actions;
	const reports = await deps.execute({ guild, speakerId: speaker.id, actions, voiceConfig: freshConfig });
	return { status: "answered", jobId, offeredChannels, actions, reports, resultAt };
}

/** The audit fields every caller records for a turn: ids, counts and codes, never text. */
export function describeBrainTurn(turn: BrainTurnResult): { jobId: string | null; channels: number; outcome: string; actions?: string[] } {
	if (turn.status === "unanswered") return { jobId: turn.jobId, channels: turn.offeredChannels, outcome: turn.code };
	return {
		jobId: turn.jobId,
		channels: turn.offeredChannels,
		outcome: "ok",
		actions: turn.reports.map((entry) => `${entry.type}:${entry.outcome}`),
	};
}
