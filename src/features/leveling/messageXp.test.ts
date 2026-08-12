import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, Message } from "discord.js";

// ── messageXp ──────────────────────────────────────────────────────────────
// The bot's first messageCreate listener, so the thing worth testing hardest is
// what it does NOT do: the overwhelming majority of messages must be discarded
// before any state is touched, and no path may ever read a message body.
//
// The real xpWriter is used rather than mocked, so the cooldown behaviour under
// test is the one that actually ships.

const mocks = vi.hoisted(() => ({
	awardXp: vi.fn(),
	getLevelingConfig: vi.fn(),
	peekLevelingConfig: vi.fn(),
}));

vi.mock("./awardXp.js", () => ({ awardXp: mocks.awardXp }));
vi.mock("./levelingConfig.js", () => ({
	getLevelingConfig: mocks.getLevelingConfig,
	peekLevelingConfig: mocks.peekLevelingConfig,
}));

import { handleMessage } from "./messageXp.js";
import { _clearXpWriter } from "./xpWriter.js";

const client = {} as Client;

interface Options {
	bot?: boolean;
	guildId?: string | null;
	system?: boolean;
	webhookId?: string | null;
	channelId?: string;
	parentId?: string | null;
	roleIds?: string[];
	userId?: string;
}

let seq = 0;

function buildMessage(options: Options = {}): Message {
	const userId = options.userId ?? `u${seq++}`;
	return {
		author: { id: userId, bot: options.bot ?? false, username: "silent", globalName: "Silent" },
		guildId: options.guildId === undefined ? "g1" : options.guildId,
		guild: options.guildId === null ? null : { id: "g1" },
		system: options.system ?? false,
		webhookId: options.webhookId ?? null,
		channelId: options.channelId ?? "c-general",
		channel: { parentId: options.parentId ?? null, isThread: () => false },
		member: { displayName: "Silent", roles: { cache: new Map((options.roleIds ?? []).map((id) => [id, {}])) } },
		client,
	} as unknown as Message;
}

const settings = (overrides: Record<string, unknown> = {}) => ({
	enabled: true,
	message: { enabled: true, min: 20, max: 20, cooldownSeconds: 60 },
	restrictionMode: "exclude",
	restrictedChannels: [],
	restrictedRoles: [],
	roleMultipliers: [],
	channelMultipliers: [],
	stackMultipliers: false,
	...overrides,
});

const context = (overrides: Record<string, unknown> = {}) => ({ settings: settings(overrides), weekStart: "sunday" });

beforeEach(() => {
	_clearXpWriter();
	seq = 0;
	mocks.awardXp.mockReset().mockResolvedValue(undefined);
	mocks.getLevelingConfig.mockReset().mockResolvedValue(context());
	// Cold cache by default, so the async fallback path is what most cases
	// exercise. The warm path gets its own case below.
	mocks.peekLevelingConfig.mockReset().mockReturnValue(undefined);
});

describe("the free rejections, which must cost ZERO I/O", () => {
	// Every case here asserts the config was never even consulted. That is the
	// property that keeps a permanently hot listener cheap: a message that cannot
	// earn must die before anything is read.
	it.each([
		["a bot", { bot: true }],
		["a DM", { guildId: null }],
		["a system notice", { system: true }],
		["a webhook", { webhookId: "wh1" }],
	])("discards %s without reading config", async (_label, options) => {
		await handleMessage(buildMessage(options as Options));
		expect(mocks.getLevelingConfig).not.toHaveBeenCalled();
		expect(mocks.peekLevelingConfig).not.toHaveBeenCalled();
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});
});

describe("the cooldown", () => {
	it("awards the first message and discards the rest of the window", async () => {
		const message = buildMessage({ userId: "u-repeat" });
		await handleMessage(message);
		await handleMessage(message);
		await handleMessage(message);

		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
	});

	it("keeps two members independent", async () => {
		await handleMessage(buildMessage({ userId: "u-a" }));
		await handleMessage(buildMessage({ userId: "u-b" }));
		expect(mocks.awardXp).toHaveBeenCalledTimes(2);
	});

	it("uses the WARM cache when it has one, so the common path never awaits config", async () => {
		mocks.peekLevelingConfig.mockReturnValue(context());
		await handleMessage(buildMessage());
		expect(mocks.getLevelingConfig).not.toHaveBeenCalled();
		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
	});

	it("falls back to the async read on a cold cache", async () => {
		await handleMessage(buildMessage());
		expect(mocks.getLevelingConfig).toHaveBeenCalledTimes(1);
	});
});

describe("the enabled gates", () => {
	it("writes nothing when the guild has no config row", async () => {
		mocks.getLevelingConfig.mockResolvedValue(null);
		await handleMessage(buildMessage());
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("writes nothing when leveling is off", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ enabled: false }));
		await handleMessage(buildMessage());
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("writes nothing when message xp specifically is off", async () => {
		mocks.getLevelingConfig.mockResolvedValue(
			context({ message: { enabled: false, min: 20, max: 20, cooldownSeconds: 60 } })
		);
		await handleMessage(buildMessage());
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});
});

describe("restrictions", () => {
	it("exclude mode blocks the listed channel and pays everywhere else", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ restrictedChannels: ["c-bots"] }));

		await handleMessage(buildMessage({ channelId: "c-bots", userId: "u-1" }));
		expect(mocks.awardXp).not.toHaveBeenCalled();

		await handleMessage(buildMessage({ channelId: "c-general", userId: "u-2" }));
		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
	});

	it("only mode is the exact inverse", async () => {
		mocks.getLevelingConfig.mockResolvedValue(
			context({ restrictionMode: "only", restrictedChannels: ["c-general"] })
		);

		await handleMessage(buildMessage({ channelId: "c-bots", userId: "u-1" }));
		expect(mocks.awardXp).not.toHaveBeenCalled();

		await handleMessage(buildMessage({ channelId: "c-general", userId: "u-2" }));
		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
	});

	it("lets one category entry exclude every channel inside it", async () => {
		// The common admin intent, and otherwise one entry per channel.
		mocks.getLevelingConfig.mockResolvedValue(context({ restrictedChannels: ["cat-games"] }));
		await handleMessage(buildMessage({ channelId: "c-duels", parentId: "cat-games" }));
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("blocks a restricted ROLE everywhere", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ restrictedRoles: ["role-muted"] }));
		await handleMessage(buildMessage({ roleIds: ["role-muted"] }));
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("does not reject on an empty role list when no roles are restricted", async () => {
		// A cold member cache yields no role ids. Under "only" mode a naive
		// implementation would then reject every message in the guild.
		mocks.getLevelingConfig.mockResolvedValue(context({ restrictionMode: "only", restrictedChannels: ["c-general"] }));
		await handleMessage(buildMessage({ roleIds: [] }));
		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
	});
});

describe("multipliers", () => {
	const amountOf = (): number => (mocks.awardXp.mock.calls[0][0] as { amount: number }).amount;

	it("applies a role multiplier", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ roleMultipliers: [{ id: "role-vip", multiplier: 2 }] }));
		await handleMessage(buildMessage({ roleIds: ["role-vip"] }));
		expect(amountOf()).toBe(40);
	});

	it("applies a channel multiplier", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ channelMultipliers: [{ id: "c-general", multiplier: 3 }] }));
		await handleMessage(buildMessage());
		expect(amountOf()).toBe(60);
	});

	it("takes the highest when stacking is off", async () => {
		mocks.getLevelingConfig.mockResolvedValue(
			context({
				roleMultipliers: [{ id: "role-vip", multiplier: 2 }],
				channelMultipliers: [{ id: "c-general", multiplier: 3 }],
				stackMultipliers: false,
			})
		);
		await handleMessage(buildMessage({ roleIds: ["role-vip"] }));
		expect(amountOf()).toBe(60);
	});

	it("multiplies role and channel together when stacking is on", async () => {
		mocks.getLevelingConfig.mockResolvedValue(
			context({
				roleMultipliers: [{ id: "role-vip", multiplier: 2 }],
				channelMultipliers: [{ id: "c-general", multiplier: 3 }],
				stackMultipliers: true,
			})
		);
		await handleMessage(buildMessage({ roleIds: ["role-vip"] }));
		expect(amountOf()).toBe(120);
	});
});

describe("the award it hands to awardXp", () => {
	it("stages as source message with a messages counter and no content anywhere", async () => {
		await handleMessage(buildMessage());
		const call = mocks.awardXp.mock.calls[0][0] as Record<string, unknown>;

		expect(call).toMatchObject({
			guildId: "g1",
			source: "message",
			counters: { messages: 1 },
			channelId: "c-general",
		});
		// The privacy guarantee, asserted rather than trusted: nothing resembling a
		// message body may reach the award.
		expect(Object.keys(call)).not.toContain("content");
		expect(JSON.stringify(call)).not.toContain("content");
	});
});
