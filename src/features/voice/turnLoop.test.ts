import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Guild, GuildMember } from "discord.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import type { BrainTurnResult } from "@features/dero-brain/brainTurn.js";
import type { ActionReport } from "@features/dero-brain/executor.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { createLatencyLog, type LatencyLog } from "./turnLatency.js";
import { createTurnLoop, speakableSummary, type TurnLoopDeps, type TurnTarget, type Utterance } from "./turnLoop.js";
import { SttError } from "./sttProvider.js";
import { voiceCopy } from "./voiceCopy.js";

// ── turn loop ──────────────────────────────────────────────────────────────
// Everything after a member finished a sentence, against fakes for every
// provider, store and brain call: one turn at a time with two waiting at most,
// one transcription per utterance, a refund when it fails, the addressing rule
// before the brain, the canned lines and their 30 second limit, the latency
// numbers, and an audit row that never holds a word of the transcript.

const GUILD_ID = "g1";
const SPEAKER_ID = "member-1";
const ROLE = "taskers";
const GATE_B = "Dero, send hello world with an emoji in general";
const CONFIG = {
	guildId: GUILD_ID,
	enabled: true,
	voiceId: "voice-123",
	allowedRoleIds: [ROLE],
	allowedChannelIds: ["c1"],
} as unknown as IDeroVoiceConfig;
const RESERVATION = { guildId: GUILD_ID, month: "2026-10", cents: 1, ttsChars: 0, sttSeconds: 2 };
// Discord channel ids are numeric snowflakes, which is what the summary reads.
const GENERAL_ID = "111";
const POSTED: ActionReport = { type: "post_message", outcome: "posted", line: `Posted in <#${GENERAL_ID}>.` };

interface Rig {
	deps: TurnLoopDeps;
	target: TurnTarget;
	speak: ReturnType<typeof vi.fn>;
	transcribe: ReturnType<typeof vi.fn>;
	runTurn: ReturnType<typeof vi.fn>;
	render: ReturnType<typeof vi.fn>;
	reserve: ReturnType<typeof vi.fn>;
	refund: ReturnType<typeof vi.fn>;
	postNotice: ReturnType<typeof vi.fn>;
	audit: ReturnType<typeof vi.fn>;
	latency: LatencyLog;
	clock: { now: number };
	speakerState: { lastOwnLineEndedAt: number | null };
	member: { roles: Set<string> };
	isCovered: ReturnType<typeof vi.fn>;
}

function answered(reports: ActionReport[], resultAt: number): BrainTurnResult {
	return { status: "answered", jobId: "job-1", offeredChannels: 1, actions: [], reports, resultAt };
}

function makeRig(transcript = GATE_B): Rig {
	const clock = { now: 10_000 };
	const speakerState = { lastOwnLineEndedAt: null as number | null };
	const member = { roles: new Set([ROLE]) };
	const speak = vi.fn(() => "playing");
	const transcribe = vi.fn(async () => {
		clock.now += 900;
		return { text: transcript };
	});
	const runTurn = vi.fn(async (): Promise<BrainTurnResult> => {
		clock.now += 2000;
		return answered([POSTED], clock.now);
	});
	const render = vi.fn(async ({ text }: { text: string }) => {
		clock.now += 300;
		return { status: "ok" as const, pcm48kStereo: Buffer.from(text), cached: false };
	});
	const reserve = vi.fn(async () => ({ status: "ok" as const, reservation: RESERVATION }));
	const refund = vi.fn(async () => undefined);
	const postNotice = vi.fn(async () => undefined);
	const audit = vi.fn();
	const latency = createLatencyLog();
	const guild = {
		id: GUILD_ID,
		ownerId: "owner",
		channels: { cache: new Map([[GENERAL_ID, { name: "general" }]]) },
	} as unknown as Guild;
	const isCovered = vi.fn(async (_guildId: string) => false);
	const deps: TurnLoopDeps = {
		now: () => clock.now,
		loadConfig: vi.fn(async () => CONFIG),
		findMember: vi.fn(async () => ({ id: SPEAKER_ID, guild: { id: GUILD_ID }, roles: { cache: member.roles } }) as unknown as GuildMember),
		reserve,
		refund,
		stt: { modelId: "scribe_v2", transcribe },
		runTurn,
		render,
		postNotice,
		audit,
		latency,
		troubleCooldown: new CooldownManager(30_000),
		isCovered,
	};
	const target: TurnTarget = {
		guild,
		channelId: "vc-1",
		controlChannelId: "text-1",
		speaker: {
			speak,
			get lastOwnLineEndedAt() {
				return speakerState.lastOwnLineEndedAt;
			},
		} as unknown as TurnTarget["speaker"],
	};
	return { deps, target, speak, transcribe, runTurn, render, reserve, refund, postNotice, audit, latency, clock, speakerState, member, isCovered };
}

function utterance(rig: Rig, durationMs = 2000): Utterance {
	return { speakerId: SPEAKER_ID, pcm48kStereo: Buffer.alloc(durationMs * 192), durationMs, speechEndedAt: rig.clock.now };
}

const spokenLines = (rig: Rig): string[] => rig.speak.mock.calls.map((call) => String(call[0]));
const lastAudit = (rig: Rig): Record<string, unknown> => rig.audit.mock.calls.at(-1)?.[1] as Record<string, unknown>;

async function runTurns(rig: Rig, count: number): Promise<void> {
	await vi.waitFor(() => expect(rig.audit).toHaveBeenCalledTimes(count));
}

let rig: Rig;

beforeEach(() => {
	rig = makeRig();
});

describe("a turn that reaches the brain", () => {
	it("answers the Gate B sentence: one transcription, the brain asked with source voice, the summary spoken", async () => {
		const loop = createTurnLoop(rig.target, rig.deps);
		expect(loop.submit(utterance(rig))).toBe("started");
		await runTurns(rig, 1);

		expect(rig.transcribe).toHaveBeenCalledTimes(1);
		expect(rig.reserve).toHaveBeenCalledWith(GUILD_ID, 1, { sttSeconds: 2 });
		expect(rig.runTurn).toHaveBeenCalledWith(expect.objectContaining({ text: GATE_B, source: "voice", voiceConfig: CONFIG }));
		expect(spokenLines(rig)).toEqual(["Posted in general."]);
		expect(rig.speak).toHaveBeenCalledWith(expect.any(Buffer), "brain");
		expect(lastAudit(rig)).toMatchObject({ outcome: "ok", addressed: "named", delivery: "summary", jobId: "job-1" });
	});

	it("records the four latency numbers in the audit row and the history", async () => {
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(lastAudit(rig)).toMatchObject({
			speechToTranscriptMs: 900,
			transcriptToResultMs: 2000,
			resultToAudioMs: 300,
			totalMs: 3200,
		});
		expect(rig.latency.summary(GUILD_ID)).toEqual({ count: 1, medianMs: 3200, slowestMs: 3200 });
	});

	it("adds nothing when the executor already spoke the brain's own say", async () => {
		rig.runTurn.mockImplementation(async () => answered([POSTED, { type: "say", outcome: "spoke", line: "Dero said it in the call." }], rig.clock.now));
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(rig.render).not.toHaveBeenCalled();
		expect(lastAudit(rig)).toMatchObject({ delivery: "say" });
	});

	it("acts on an unnamed answer inside the follow up window", async () => {
		rig = makeRig("yes, post it there");
		rig.speakerState.lastOwnLineEndedAt = rig.clock.now - 5_000;
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(rig.runTurn).toHaveBeenCalledTimes(1);
		expect(lastAudit(rig)).toMatchObject({ addressed: "followUp" });
	});

	it("cuts a long transcript to 300 characters before the brain sees it", async () => {
		rig = makeRig(`Dero, ${"post this please. ".repeat(40)}`);
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		const [{ text }] = rig.runTurn.mock.calls[0] as unknown as [{ text: string }];
		expect(text.length).toBeLessThanOrEqual(300);
		expect(text.endsWith(".")).toBe(true);
	});

	it("posts the answer in text when Dero cannot speak it", async () => {
		rig.render.mockResolvedValue({ status: "failed", kind: "providerDown" });
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(rig.postNotice).toHaveBeenCalledWith(rig.target.guild, "text-1", `${voiceCopy.turn.text.voiceTrouble}\nPosted in <#${GENERAL_ID}>.`);
		expect(rig.latency.summary(GUILD_ID)).toBeNull();
	});
});

describe("canned lines", () => {
	it.each([
		["offline", voiceCopy.turn.spoken.brainOffline],
		["busy", voiceCopy.turn.spoken.busy],
		["timeout", voiceCopy.turn.spoken.timeout],
		["notUnderstood", voiceCopy.turn.spoken.notUnderstood],
	])("speaks the %s line when the brain did not answer", async (reason, line) => {
		rig.runTurn.mockResolvedValue({
			status: "unanswered",
			jobId: reason === "offline" ? null : "job-1",
			offeredChannels: 0,
			reason,
			code: reason,
			resultAt: rig.clock.now,
		});
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(spokenLines(rig)).toEqual([line]);
	});

	it("does not count an offline answer toward the latency history", async () => {
		rig.runTurn.mockResolvedValue({ status: "unanswered", jobId: null, offeredChannels: 0, reason: "offline", code: "offline", resultAt: rig.clock.now });
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(rig.latency.summary(GUILD_ID)).toBeNull();
	});

	it("speaks the not allowed line, and never asks the brain, when the speaker left the task list", async () => {
		rig.member.roles.clear();
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(rig.runTurn).not.toHaveBeenCalled();
		expect(spokenLines(rig)).toEqual([voiceCopy.turn.spoken.notAllowed]);
		expect(lastAudit(rig)).toMatchObject({ outcome: "not_authorized" });
	});
});

describe("what never reaches the brain", () => {
	it("drops a transcript not addressed to Dero, after one transcription and nothing else", async () => {
		rig = makeRig("did you see the game last night");
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(rig.transcribe).toHaveBeenCalledTimes(1);
		expect(rig.runTurn).not.toHaveBeenCalled();
		expect(rig.speak).not.toHaveBeenCalled();
		expect(lastAudit(rig)).toMatchObject({ outcome: "not_addressed", addressed: "notAddressed" });
	});

	it.each(["", "  ", "a"])("drops the empty or one character transcript %j", async (transcript) => {
		rig = makeRig(transcript);
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(rig.runTurn).not.toHaveBeenCalled();
		expect(lastAudit(rig)).toMatchObject({ outcome: "empty" });
	});

	it("transcribes nothing while the kill switch is off", async () => {
		(rig.deps.loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ ...CONFIG, enabled: false });
		const heard = utterance(rig);
		createTurnLoop(rig.target, rig.deps).submit(heard);
		await runTurns(rig, 1);
		expect(rig.reserve).not.toHaveBeenCalled();
		expect(rig.transcribe).not.toHaveBeenCalled();
		expect(heard.pcm48kStereo.length).toBe(0);
	});
});

describe("spend and provider trouble", () => {
	it("refunds the reservation when transcription fails, and never retries", async () => {
		rig.transcribe.mockRejectedValue(new SttError("providerDown", 503));
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(rig.transcribe).toHaveBeenCalledTimes(1);
		expect(rig.refund).toHaveBeenCalledWith(RESERVATION);
		expect(lastAudit(rig)).toMatchObject({ outcome: "stt_failed:providerDown", delivery: "spoken" });
		expect(spokenLines(rig)).toEqual([voiceCopy.turn.spoken.hearingTrouble]);
	});

	it("never transcribes when the cap refuses, and posts the budget line in text when even that cannot be spoken", async () => {
		rig.reserve.mockResolvedValue({ status: "capReached" });
		rig.render.mockResolvedValue({ status: "capReached" });
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(rig.transcribe).not.toHaveBeenCalled();
		expect(rig.postNotice).toHaveBeenCalledWith(rig.target.guild, "text-1", voiceCopy.turn.text.capReached(false));
		expect(lastAudit(rig)).toMatchObject({ outcome: "cap_reached", delivery: "posted" });
	});

	// The budget line follows coverage (2026-10 item 262), and the spoken one never carries a link.
	it("speaks the budget line for the server's coverage, with no link in it", async () => {
		rig.reserve.mockResolvedValue({ status: "capReached" });
		rig.isCovered.mockResolvedValue(true);
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		expect(rig.isCovered).toHaveBeenCalledWith(GUILD_ID);
		expect(spokenLines(rig)).toEqual([voiceCopy.turn.spoken.capReached(true)]);
		expect(voiceCopy.turn.spoken.capReached(false)).not.toContain("http");
		expect(voiceCopy.turn.spoken.capReached(true)).not.toContain("http");
	});

	it("speaks a trouble line at most once every 30 seconds per server", async () => {
		rig.transcribe.mockRejectedValue(new SttError("rateLimit", 429));
		const loop = createTurnLoop(rig.target, rig.deps);

		loop.submit(utterance(rig));
		await runTurns(rig, 1);
		rig.clock.now += 29_000;
		loop.submit(utterance(rig));
		await runTurns(rig, 2);
		expect(spokenLines(rig)).toEqual([voiceCopy.turn.spoken.hearingTrouble]);
		expect(lastAudit(rig)).toMatchObject({ delivery: "quiet" });

		rig.clock.now += 1_000;
		loop.submit(utterance(rig));
		await runTurns(rig, 3);
		expect(spokenLines(rig)).toEqual([voiceCopy.turn.spoken.hearingTrouble, voiceCopy.turn.spoken.hearingTrouble]);
		expect(rig.transcribe).toHaveBeenCalledTimes(3);
	});
});

describe("one turn at a time", () => {
	it("runs one turn, lets two wait, drops the third untranscribed, then drains in order", async () => {
		let release: () => void = () => undefined;
		let inFlight = 0;
		let peak = 0;
		rig.transcribe.mockImplementation(async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			if (rig.transcribe.mock.calls.length === 1) await new Promise<void>((resolve) => (release = resolve));
			inFlight -= 1;
			return { text: GATE_B };
		});
		const loop = createTurnLoop(rig.target, rig.deps);
		const dropped = utterance(rig);

		expect(loop.submit(utterance(rig))).toBe("started");
		expect(loop.submit(utterance(rig))).toBe("queued");
		expect(loop.submit(utterance(rig))).toBe("queued");
		expect(loop.submit(dropped)).toBe("dropped");
		expect(loop.waitingCount).toBe(2);
		expect(dropped.pcm48kStereo.length).toBe(0);
		expect(lastAudit(rig)).toMatchObject({ outcome: "queue_full" });

		await vi.waitFor(() => expect(rig.transcribe).toHaveBeenCalledTimes(1));
		release();
		await runTurns(rig, 4);
		expect(rig.transcribe).toHaveBeenCalledTimes(3);
		expect(peak).toBe(1);
		expect(loop.submit(utterance(rig))).toBe("started");
	});

	it("drops whatever waits when the call closes", async () => {
		let release: () => void = () => undefined;
		rig.transcribe.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => (release = resolve));
			return { text: GATE_B };
		});
		const loop = createTurnLoop(rig.target, rig.deps);
		loop.submit(utterance(rig));
		const waiting = utterance(rig);
		loop.submit(waiting);
		await vi.waitFor(() => expect(rig.transcribe).toHaveBeenCalledTimes(1));

		loop.close();
		expect(waiting.pcm48kStereo.length).toBe(0);
		expect(loop.submit(utterance(rig))).toBe("dropped");
		release();
		await runTurns(rig, 1);
		expect(rig.transcribe).toHaveBeenCalledTimes(1);
	});
});

describe("privacy", () => {
	it("empties the utterance's audio as soon as the loop reads it", async () => {
		const heard = utterance(rig);
		createTurnLoop(rig.target, rig.deps).submit(heard);
		await runTurns(rig, 1);
		expect(heard.pcm48kStereo.length).toBe(0);
	});

	it("sends the provider a 16 kHz mono WAV of the utterance", async () => {
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig, 1000));
		await runTurns(rig, 1);
		const [{ wav, durationMs }] = rig.transcribe.mock.calls[0] as unknown as [{ wav: Buffer; durationMs: number }];
		expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
		expect(wav.length).toBe(44 + 32_000);
		expect(durationMs).toBe(1000);
	});

	it("never puts a word of the transcript in an audit row", async () => {
		createTurnLoop(rig.target, rig.deps).submit(utterance(rig));
		await runTurns(rig, 1);
		const rows = JSON.stringify(rig.audit.mock.calls);
		expect(rows).not.toContain("hello");
		expect(rows).not.toContain("emoji");
		expect(lastAudit(rig)).toMatchObject({ transcriptChars: GATE_B.length, speakerId: SPEAKER_ID });
	});
});

describe("speakableSummary", () => {
	const guild = { channels: { cache: new Map([[GENERAL_ID, { name: "💬general" }]]) } } as unknown as Guild;

	it("reads a channel mention as the channel's name, without its emoji", () => {
		expect(speakableSummary([POSTED], guild)).toBe("Posted in general.");
	});

	it("says that channel when it is gone, and says when there was nothing to do", () => {
		expect(speakableSummary([{ type: "post_message", outcome: "posted", line: "Posted in <#999>." }], guild)).toBe("Posted in that channel.");
		expect(speakableSummary([], guild)).toBe("Dero had nothing to do for that task.");
	});
});
