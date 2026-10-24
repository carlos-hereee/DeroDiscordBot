import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";

// ── /dero ──────────────────────────────────────────────────────────────────
// The command's promises: the gates run in the plan's order and a refused
// member never produces a job; busy, timeout and a rejected result each get
// their own plain answer; an "ok" result executes against a FRESH config read;
// the cooldown counts only "ok" answers; the audit row never holds the task.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	log: vi.fn(),
	enqueue: vi.fn(),
	isBrainOnline: vi.fn(),
	executeActions: vi.fn(),
	buildJobInput: vi.fn(),
}));

// The admin role read is a GuildConfig lookup; null keeps these suites on the allowlist only rule.
vi.mock("@features/dero-brain/speakerAdminRole.js", () => ({ readSpeakerAdminRoleId: vi.fn(async () => null) }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log } }));
vi.mock("@features/dero-brain/brainQueue.js", () => ({ brainQueue: { enqueue: mocks.enqueue, isBrainOnline: mocks.isBrainOnline } }));
vi.mock("@features/dero-brain/executor.js", () => ({ executeActions: mocks.executeActions }));
vi.mock("@features/dero-brain/brainJob.js", () => ({ buildJobInput: mocks.buildJobInput }));

import { execute } from "./dero.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { turnLatencyLog } from "@features/voice/turnLatency.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";

const GUILD_ID = "g1";
const OWNER_ID = "owner";
const ROLE = "role-taskers";
const TASK = "send hello world with an emoji in general";
const CONFIG = { guildId: GUILD_ID, enabled: true, allowedRoleIds: [ROLE], allowedChannelIds: ["c1"] };

let userCounter = 0;

interface RunOptions {
	sub?: "tell" | "status";
	task?: string;
	roles?: string[];
	userId?: string;
	cached?: boolean;
}

function interactionFor({ sub = "tell", task = TASK, roles = [ROLE], userId, cached = true }: RunOptions = {}) {
	// A fresh member per call unless a test pins one, so the module level
	// cooldown from one test never leaks into the next.
	const id = userId ?? `user-${++userCounter}`;
	const reply = vi.fn(async () => undefined);
	const deferReply = vi.fn(async () => undefined);
	const editReply = vi.fn(async () => undefined);
	const interaction = {
		guildId: cached ? GUILD_ID : null,
		inCachedGuild: () => cached,
		guild: { id: GUILD_ID, ownerId: OWNER_ID, name: "Guild" },
		member: { id, displayName: "Member", guild: { id: GUILD_ID }, roles: { cache: new Set(roles) } },
		options: { getSubcommand: () => sub, getString: () => task },
		replied: false,
		deferred: false,
		reply,
		deferReply,
		editReply,
	} as unknown as ChatInputCommandInteraction;
	return { interaction, reply, deferReply, editReply, id };
}

function textOf(mock: ReturnType<typeof vi.fn>): string {
	const call = mock.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[] }];
	const embed = call[0].embeds[0];
	return `${embed.data.title ?? ""}\n${embed.data.description ?? ""}`;
}

function answerWith(outcome: unknown) {
	mocks.enqueue.mockReturnValue({ jobId: "job-1", outcome: Promise.resolve(outcome) });
}

const okOutcome = { kind: "result", result: { jobId: "job-1", status: "ok", actions: [{ type: "post_message", channelId: "c1", text: "hi" }] } };

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue(CONFIG);
	mocks.log.mockReset().mockResolvedValue(undefined);
	mocks.enqueue.mockReset();
	mocks.isBrainOnline.mockReset().mockReturnValue(true);
	mocks.executeActions.mockReset().mockResolvedValue([{ type: "post_message", outcome: "posted", line: "Posted in <#c1>." }]);
	mocks.buildJobInput.mockReset().mockReturnValue({ text: TASK, channels: [{ id: "c1", name: "general" }] });
	answerWith(okOutcome);
});

describe("/dero tell gates, in order", () => {
	it.each([
		["outside a cached guild", { cached: false }, () => undefined, deroBrainCopy.tell.notInGuild],
		["with no config", {}, () => mocks.findByGuildId.mockResolvedValue(null), deroBrainCopy.tell.notSetUp],
		["when switched off", {}, () => mocks.findByGuildId.mockResolvedValue({ ...CONFIG, enabled: false }), deroBrainCopy.tell.switchedOff],
		["for a member without an allowlisted role", { roles: ["admin"] }, () => undefined, deroBrainCopy.tell.notAuthorized],
		["while the brain is offline", {}, () => mocks.isBrainOnline.mockReturnValue(false), deroBrainCopy.tell.brainOffline],
		["for a blank task", { task: "   " }, () => undefined, deroBrainCopy.tell.emptyTask],
	])("refuses %s and makes no job", async (_label, options, arrange, line) => {
		arrange();
		const { interaction, reply, deferReply } = interactionFor(options as RunOptions);
		await execute(interaction);
		expect(textOf(reply)).toContain(line);
		expect(deferReply).not.toHaveBeenCalled();
		expect(mocks.enqueue).not.toHaveBeenCalled();
		expect(mocks.executeActions).not.toHaveBeenCalled();
	});

	it("checks authorization before asking whether the brain is online", async () => {
		const { interaction } = interactionFor({ roles: [] });
		await execute(interaction);
		expect(mocks.isBrainOnline).not.toHaveBeenCalled();
	});

	it("lets the guild owner through without a role", async () => {
		const { interaction, editReply } = interactionFor({ roles: [], userId: OWNER_ID });
		await execute(interaction);
		expect(mocks.enqueue).toHaveBeenCalledTimes(1);
		expect(textOf(editReply)).toContain("Posted in <#c1>.");
	});
});

describe("/dero tell answers", () => {
	it("executes an ok result against a fresh config read and lists what happened", async () => {
		const fresh = { ...CONFIG, allowedChannelIds: ["c1", "c2"] };
		mocks.findByGuildId.mockResolvedValueOnce(CONFIG).mockResolvedValueOnce(fresh);
		const { interaction, deferReply, editReply, id } = interactionFor();
		await execute(interaction);

		expect(deferReply).toHaveBeenCalledTimes(1);
		expect(mocks.findByGuildId).toHaveBeenCalledTimes(2);
		expect(mocks.executeActions).toHaveBeenCalledWith(
			expect.objectContaining({ speakerId: id, actions: okOutcome.result.actions, voiceConfig: fresh }),
		);
		expect(textOf(editReply)).toContain("Posted in <#c1>.");
	});

	it.each([
		["busy", { kind: "result", result: { jobId: "job-1", status: "busy", actions: [] } }, deroBrainCopy.tell.busy],
		["error", { kind: "result", result: { jobId: "job-1", status: "error", actions: [] } }, deroBrainCopy.tell.notUnderstood],
		["a timeout", { kind: "timeout" }, deroBrainCopy.tell.timeout],
		["a rejected result", { kind: "rejected", reason: "unknown_action" }, deroBrainCopy.tell.notUnderstood],
	])("answers %s plainly and executes nothing", async (_label, outcome, line) => {
		answerWith(outcome);
		const { interaction, editReply } = interactionFor();
		await execute(interaction);
		expect(textOf(editReply)).toContain(line);
		expect(mocks.executeActions).not.toHaveBeenCalled();
	});

	it("says so when an ok result had nothing to do", async () => {
		answerWith({ kind: "result", result: { jobId: "job-1", status: "ok", actions: [] } });
		mocks.executeActions.mockResolvedValue([]);
		const { interaction, editReply } = interactionFor();
		await execute(interaction);
		expect(textOf(editReply)).toContain(deroBrainCopy.tell.nothingToDo);
	});

	it("starts the cooldown only after an ok answer", async () => {
		answerWith({ kind: "timeout" });
		await execute(interactionFor({ userId: "steady" }).interaction);
		answerWith(okOutcome);
		await execute(interactionFor({ userId: "steady" }).interaction);
		expect(mocks.enqueue).toHaveBeenCalledTimes(2);

		const third = interactionFor({ userId: "steady" });
		await execute(third.interaction);
		expect(textOf(third.reply)).toContain("Try again in");
		expect(mocks.enqueue).toHaveBeenCalledTimes(2);
	});

	it("audits ids, counts and outcome codes, never the task text", async () => {
		await execute(interactionFor().interaction);
		expect(mocks.log).toHaveBeenCalledTimes(1);
		const [guildId, event, metadata] = mocks.log.mock.calls[0];
		expect(guildId).toBe(GUILD_ID);
		expect(event).toBe("dero_brain_action");
		expect(metadata).toMatchObject({ jobId: "job-1", outcome: "ok", taskChars: TASK.length, actions: ["post_message:posted"] });
		expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(TASK);
	});

	it("still answers when the audit write fails", async () => {
		mocks.log.mockRejectedValue(new Error("mongo down"));
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { interaction, editReply } = interactionFor();
		await execute(interaction);
		expect(textOf(editReply)).toContain("Posted in <#c1>.");
		errorLog.mockRestore();
	});
});

describe("/dero status", () => {
	it("tells any member whether the brain is online, and nothing about the task list", async () => {
		mocks.isBrainOnline.mockReturnValue(false);
		const { interaction, reply } = interactionFor({ sub: "status", roles: [] });
		await execute(interaction);
		const text = textOf(reply);
		expect(text).toContain(deroBrainCopy.status.offline);
		expect(text).not.toContain(deroBrainCopy.status.canTell);
	});

	it("tells an authorized member they may give tasks, or that Dero is switched off", async () => {
		const allowed = interactionFor({ sub: "status" });
		await execute(allowed.interaction);
		expect(textOf(allowed.reply)).toContain(deroBrainCopy.status.online);
		expect(textOf(allowed.reply)).toContain(deroBrainCopy.status.canTell);

		mocks.findByGuildId.mockResolvedValue({ ...CONFIG, enabled: false });
		const paused = interactionFor({ sub: "status" });
		await execute(paused.interaction);
		expect(textOf(paused.reply)).toContain(deroBrainCopy.status.switchedOffForYou);
	});
});

describe("/dero status, voice latency", () => {
	it("shows the median and slowest voice answer only to members on the task list", async () => {
		turnLatencyLog.record(GUILD_ID, 3000);
		turnLatencyLog.record(GUILD_ID, 5000);
		turnLatencyLog.record(GUILD_ID, 9000);
		const line = voiceCopy.call.statusLatency("5.0", "9.0", 3);

		const allowed = interactionFor({ sub: "status" });
		await execute(allowed.interaction);
		expect(textOf(allowed.reply)).toContain(line);

		const stranger = interactionFor({ sub: "status", roles: [] });
		await execute(stranger.interaction);
		expect(textOf(stranger.reply)).not.toContain("Voice answers lately");
	});
});
