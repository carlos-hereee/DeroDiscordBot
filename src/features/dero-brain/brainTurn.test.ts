import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Guild, GuildMember } from "discord.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import type { BrainOutcome } from "./brainTypes.js";

// ── brain turn ────────────────────────────────────────────────────────────
// The one step /dero tell and the voice turn share: offline makes no job, every
// answer that is not "ok" becomes a reason and an audit code with nothing
// executed, and an "ok" answer runs against a FRESH config read. Only the job
// builder is mocked; the queue, the config read and the executor are injected.

const mocks = vi.hoisted(() => ({ buildJobInput: vi.fn() }));
vi.mock("./brainJob.js", () => ({ buildJobInput: mocks.buildJobInput }));

import { describeBrainTurn, runBrainTurn, type BrainTurnDeps } from "./brainTurn.js";

const guild = { id: "g1", ownerId: "owner", name: "Guild" } as unknown as Guild;
const speaker = { id: "u1", displayName: "Member" } as unknown as GuildMember;
const CONFIG = { guildId: "g1", enabled: true, allowedRoleIds: ["r"], allowedChannelIds: ["c1"] } as unknown as IDeroVoiceConfig;
const FRESH = { ...CONFIG, allowedChannelIds: ["c1", "c2"] } as unknown as IDeroVoiceConfig;
const ACTIONS = [{ type: "post_message" as const, channelId: "c1", text: "hello world 👋" }];

function rig(outcome: BrainOutcome, online = true) {
	let clock = 1000;
	const deps: BrainTurnDeps = {
		queue: {
			isBrainOnline: vi.fn(() => online),
			enqueue: vi.fn(() => {
				clock += 2500;
				return { jobId: "job-1", outcome: Promise.resolve(outcome) };
			}),
		},
		loadConfig: vi.fn(async () => FRESH),
		execute: vi.fn(async () => [{ type: "post_message" as const, outcome: "posted" as const, line: "Posted in <#c1>." }]),
		now: () => clock,
	};
	return deps;
}

const run = (deps: BrainTurnDeps, source: "text" | "voice" = "voice") =>
	runBrainTurn({ guild, speaker, text: "send hello world in general", source, voiceConfig: CONFIG }, deps);

beforeEach(() => {
	mocks.buildJobInput.mockReset().mockReturnValue({ source: "voice", text: "x", channels: [{ id: "c1", name: "general" }] });
});

describe("runBrainTurn", () => {
	it("makes no job while the brain is offline", async () => {
		const deps = rig({ kind: "timeout" }, false);
		const turn = await run(deps);
		expect(turn).toMatchObject({ status: "unanswered", reason: "offline", code: "offline", jobId: null });
		expect(deps.queue.enqueue).not.toHaveBeenCalled();
		expect(mocks.buildJobInput).not.toHaveBeenCalled();
	});

	it("builds the job with the caller's source and the config the caller authorized against", async () => {
		const deps = rig({ kind: "timeout" });
		await run(deps, "voice");
		expect(mocks.buildJobInput).toHaveBeenCalledWith(expect.objectContaining({ source: "voice", voiceConfig: CONFIG, speaker }));
	});

	it.each([
		["a timeout", { kind: "timeout" }, "timeout", "timeout"],
		["a rejected body", { kind: "rejected", reason: "unknown_action" }, "notUnderstood", "rejected:unknown_action"],
		["busy", { kind: "result", result: { jobId: "job-1", status: "busy", actions: [] } }, "busy", "busy"],
		["error", { kind: "result", result: { jobId: "job-1", status: "error", actions: [] } }, "notUnderstood", "error"],
	])("turns %s into a reason and a code, and executes nothing", async (_label, outcome, reason, code) => {
		const deps = rig(outcome as BrainOutcome);
		const turn = await run(deps);
		expect(turn).toMatchObject({ status: "unanswered", reason, code, jobId: "job-1", offeredChannels: 1 });
		expect(deps.execute).not.toHaveBeenCalled();
		expect(deps.loadConfig).not.toHaveBeenCalled();
	});

	it("executes an ok answer against a fresh config read and stamps when the result arrived", async () => {
		const deps = rig({ kind: "result", result: { jobId: "job-1", status: "ok", actions: ACTIONS } });
		const turn = await run(deps);
		expect(deps.loadConfig).toHaveBeenCalledWith("g1");
		expect(deps.execute).toHaveBeenCalledWith({ guild, speakerId: "u1", actions: ACTIONS, voiceConfig: FRESH });
		expect(turn).toMatchObject({ status: "answered", jobId: "job-1", actions: ACTIONS, resultAt: 3500 });
	});
});

describe("describeBrainTurn", () => {
	it("gives ids, counts and codes for an answered turn, never text", async () => {
		const turn = await run(rig({ kind: "result", result: { jobId: "job-1", status: "ok", actions: ACTIONS } }));
		const described = describeBrainTurn(turn);
		expect(described).toEqual({ jobId: "job-1", channels: 1, outcome: "ok", actions: ["post_message:posted"] });
		expect(JSON.stringify(described)).not.toContain("hello");
	});

	it("gives the code for an unanswered turn", async () => {
		const turn = await run(rig({ kind: "timeout" }));
		expect(describeBrainTurn(turn)).toEqual({ jobId: "job-1", channels: 1, outcome: "timeout" });
	});
});
