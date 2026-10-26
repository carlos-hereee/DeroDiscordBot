import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, VoiceChannel, CategoryChannel, ChannelType, Events } from "discord.js";
import type { Client, Guild } from "discord.js";

// Mock the guild config store before importing the unit under test. Same
// pattern the GuildSetupManager suite uses, the Mongoose model chain tries
// to open a real DB connection at import time otherwise.
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: {
		findByGuildId: vi.fn(),
		update: vi.fn(),
	},
}));

// The watcher asks whether a deleted channel was a live game room BEFORE it does
// anything else (risk R14). Without these two mocks that lookup reaches the real
// Mongoose model, which never resolves with no DB behind it, and every test in this
// file times out rather than failing with a useful message.
vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByChannelId: vi.fn() },
}));
vi.mock("@features/game-rooms/roomLifecycle.js", () => ({
	finish: vi.fn(),
}));

import { registerChannelDeleteWatcher, __resetRepairCooldownsForTests } from "./ChannelDeleteWatcher.js";
import { GuildSetupManager } from "./GuildSetupManager.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { finish as finishGameRoom } from "@features/game-rooms/roomLifecycle.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

const guildConfigMock = guildConfigStore as unknown as {
	findByGuildId: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
};
const gameRoomMock = gameRoomStore as unknown as { findByChannelId: ReturnType<typeof vi.fn> };
const finishRoomMock = finishGameRoom as unknown as ReturnType<typeof vi.fn>;

// ── fixtures ──────────────────────────────────────────────────────────

function makeStoredConfig(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		guildId: "guild-1",
		categoryId: "cat-1",
		introChannelId: "ch-intro",
		commandsChannelId: "ch-commands",
		leaderboardChannelId: "ch-leaderboard",
		scheduleChannelId: "ch-schedule",
		announcementsChannelId: "ch-announcements",
		adminChannelId: "ch-admin",
		scheduleMessageId: "msg-schedule",
		adminRoleId: null,
		memberRoleId: null,
		setupComplete: true,
		// auto-heal is the realistic default for these repair tests: the
		// watcher bails at the autoHealEnabled gate before any repair when this
		// is falsy, so a guild that expects self-heal must have it on.
		autoHealEnabled: true,
		...overrides,
	};
}

// Capture the handler registered via client.on(Events.ChannelDelete, ...)
// so tests can invoke it directly with fabricated channel objects instead
// of wrestling with a full discord.js EventEmitter.
interface CapturedClient {
	client: Client;
	handler: ((channel: unknown) => Promise<void>) | null;
}

function makeClientCapturing(options: {
	selfId?: string;
	// map of channel id → returned value (or Error to simulate a fetch throw)
	channelFetchMap?: Record<string, unknown>;
}): CapturedClient {
	const map = options.channelFetchMap ?? {};
	const captured: CapturedClient = {
		client: {} as Client,
		handler: null,
	};
	captured.client = {
		user: { id: options.selfId ?? "bot-1" },
		channels: {
			fetch: vi.fn(async (id: string) => {
				if (id in map) {
					const v = map[id];
					if (v instanceof Error) throw v;
					return v;
				}
				return null;
			}),
		},
		on: vi.fn((event: string, handler: (channel: unknown) => Promise<void>) => {
			if (event === Events.ChannelDelete) captured.handler = handler;
		}),
	} as unknown as Client;
	return captured;
}

function makeGuild(options: {
	categoryFetchMap?: Record<string, unknown>;
	createHandler?: (opts: unknown) => Promise<unknown>;
}): Guild {
	const map = options.categoryFetchMap ?? {};
	const create =
		options.createHandler ??
		vi.fn(async (opts: { name: string }) => {
			const created = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
			Object.assign(created, {
				id: `new-${opts.name}`,
				send: vi.fn().mockResolvedValue({ id: `intro-${opts.name}` }),
			});
			return created;
		});
	return {
		id: "guild-1",
		ownerId: "owner-1",
		roles: { everyone: { id: "everyone" } },
		// buildSingleChannel (reached on repair) reads guild.client.user.id via
		// botSelfOverwrite; without it the repair throws before it can create.
		client: { user: { id: "bot-1" } },
		channels: {
			fetch: vi.fn(async (id: string) => {
				if (id in map) {
					const v = map[id];
					if (v instanceof Error) throw v;
					return v;
				}
				return null;
			}),
			create,
		},
	} as unknown as Guild;
}

// Fabricate a deleted channel object. The watcher narrows via
// `"guild" in channel` and checks `channel.id === stored.categoryId` etc.
function makeDeletedChannel(id: string, guild: Guild, name = "deleted"): unknown {
	return { id, name, guild, type: ChannelType.GuildText };
}

// Intact category fixture. The watcher narrows via
// `category.type !== ChannelType.GuildCategory` so we set the type.
function makeCategory(id = "cat-1"): CategoryChannel {
	const cat = Object.create(CategoryChannel.prototype) as CategoryChannel;
	Object.assign(cat, { id, type: ChannelType.GuildCategory });
	// children is a getter on CategoryChannel.prototype (a GuildChannelManager),
	// so it must be shadowed with defineProperty rather than Object.assign.
	// repairOneChannel's adopt-before-build guard scans children.cache; an empty
	// cache (find → undefined) forces the build-fresh path the repair tests want.
	Object.defineProperty(cat, "children", { value: { cache: { find: () => undefined } }, configurable: true });
	return cat;
}

// Schedule message fixture used by the ownership probe. The probe fetches
// the stored scheduleChannelId as a TextChannel and then calls
// channel.messages.fetch(scheduleMessageId). Returning a message with our
// bot's author id makes the probe report "owned".
function makeScheduleChannel(authorId: string): TextChannel {
	const ch = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(ch, {
		id: "ch-schedule",
		messages: {
			fetch: vi.fn(async () => ({
				id: "msg-schedule",
				author: { id: authorId },
			})),
		},
	});
	return ch;
}

// Admin channel fixture for the repair notice post step.
function makeAdminChannel(id = "ch-admin"): TextChannel & { send: ReturnType<typeof vi.fn> } {
	const ch = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
	Object.assign(ch, {
		id,
		send: vi.fn().mockResolvedValue({ id: "notice-msg" }),
	});
	return ch;
}

describe("ChannelDeleteWatcher", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRepairCooldownsForTests();
		// Default: the deleted channel was NOT a game room, which is the case every
		// homebase repair test below is about.
		gameRoomMock.findByChannelId.mockResolvedValue(null);
		finishRoomMock.mockResolvedValue(undefined);
	});

	it("ignores channel deletes for guilds with no GuildConfig", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(null);
		const captured = makeClientCapturing({});
		registerChannelDeleteWatcher(captured.client);

		const guild = makeGuild({});
		const deleted = makeDeletedChannel("random-channel", guild);
		await captured.handler!(deleted);

		// no repair, no update. silent bail is correct, the guild never
		// completed a homebase build so there is nothing for us to heal.
		expect(guildConfigMock.update).not.toHaveBeenCalled();
	});

	it("ignores channel deletes for ids that are not on the GuildConfig", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());
		const captured = makeClientCapturing({});
		registerChannelDeleteWatcher(captured.client);

		const guild = makeGuild({});
		const deleted = makeDeletedChannel("some-unrelated-channel", guild);
		await captured.handler!(deleted);

		// no repair. channel wasn't one of ours.
		expect(guildConfigMock.update).not.toHaveBeenCalled();
	});

	it("ignores category deletes and defers to the boot sweep", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());
		const captured = makeClientCapturing({});
		registerChannelDeleteWatcher(captured.client);

		const guild = makeGuild({});
		// the deleted channel IS the stored category. realtime path must
		// NOT try to rebuild the whole homebase, that is the boot sweep's
		// job and racing it would fight the admin who is tearing down.
		const deleted = makeDeletedChannel("cat-1", guild, "NOTICE BOARD");
		await captured.handler!(deleted);

		expect(guildConfigMock.update).not.toHaveBeenCalled();
	});

	it("repairs a deleted homebase channel and posts a notice in the inner sanctum", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());
		guildConfigMock.update.mockResolvedValue(undefined);

		const adminChannel = makeAdminChannel("ch-admin");
		const scheduleChannel = makeScheduleChannel("bot-1");
		const captured = makeClientCapturing({
			selfId: "bot-1",
			channelFetchMap: {
				"ch-admin": adminChannel,
				"ch-schedule": scheduleChannel,
			},
		});
		registerChannelDeleteWatcher(captured.client);

		const category = makeCategory();
		const guild = makeGuild({ categoryFetchMap: { "cat-1": category } });

		// announcements channel was deleted. watcher should rebuild it
		// under the intact category and post one notice in the inner sanctum.
		const deleted = makeDeletedChannel("ch-announcements", guild, "📢announcements");
		await captured.handler!(deleted);

		// config update carried the new announcements channel id AND the
		// refreshed introMessageIds map. the new map keeps the other five
		// slots null (this test's stored config has none) and sets the
		// announcements slot to the freshly posted intro message id.
		expect(guildConfigMock.update).toHaveBeenCalledWith("guild-1", {
			announcementsChannelId: expect.stringContaining("new-"),
			introMessageIds: expect.objectContaining({
				announcementsChannelId: expect.stringContaining("intro-"),
			}),
		});
		// one repair notice landed in the inner sanctum. postRepairNotices now
		// sends a single channelsRestoredSummary embed (summaryTitle), not the
		// old per-channel channelRepairNotice.title.
		expect(adminChannel.send).toHaveBeenCalledOnce();
		const sent = adminChannel.send.mock.calls[0][0] as { embeds: Array<{ data: { title: string } }> };
		expect(sent.embeds[0].data.title).toBe(rokCommanderCopy.channelContent.channelRepairNotice.summaryTitle);
	});

	// ── 🎮 ARCADE GAMES, the second category ──────────────────────────

	const arcadeConfig = () =>
		makeStoredConfig({
			gamesCategoryId: "games-cat-1",
			arcadeRulesChannelId: "ch-arcaderules",
			arcadeChallengesChannelId: "ch-arcadechallenges",
		});

	it("rebuilds a deleted arcade channel under the ARCADE category, never under the homebase", async () => {
		// ⚠️ RISK R2 IN ITS REALTIME FORM, and the more surprising half: this path
		// reads as though there were only one category. Before the spec's
		// categoryField was consulted here it fetched stored.categoryId, found the
		// homebase alive, and rebuilt ⚔️challenges under 🪧 NOTICE BOARD. Nothing
		// throws; the misplaced channel then poisons repairOneChannel's
		// adopt-before-build scan, so the next sweep builds a duplicate instead of
		// adopting what is already there.
		guildConfigMock.findByGuildId.mockResolvedValue(arcadeConfig());
		guildConfigMock.update.mockResolvedValue(undefined);

		const adminChannel = makeAdminChannel("ch-admin");
		const scheduleChannel = makeScheduleChannel("bot-1");
		const captured = makeClientCapturing({
			selfId: "bot-1",
			channelFetchMap: { "ch-admin": adminChannel, "ch-schedule": scheduleChannel },
		});
		registerChannelDeleteWatcher(captured.client);

		const createCalls: Array<{ name: string; parent?: string }> = [];
		const guild = makeGuild({
			categoryFetchMap: { "cat-1": makeCategory("cat-1"), "games-cat-1": makeCategory("games-cat-1") },
			createHandler: async (opts) => {
				const options = opts as { name: string; parent?: string };
				createCalls.push(options);
				const created = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
				Object.assign(created, { id: `new-${options.name}`, send: vi.fn().mockResolvedValue({ id: `intro-${options.name}` }) });
				return created;
			},
		});

		await captured.handler!(makeDeletedChannel("ch-arcadechallenges", guild, "⚔️challenges"));

		expect(createCalls).toHaveLength(1);
		expect(createCalls[0].parent).toBe("games-cat-1");
		expect(createCalls[0].parent).not.toBe("cat-1");
	});

	it("declines to rebuild an arcade channel when the arcade category itself is gone", async () => {
		// An admin deleting the whole category fires a delete for it AND for each
		// child. Rebuilding the children would scatter arcade channels loose in the
		// server, since Discord orphans rather than cascades. The boot sweep
		// rebuilds the category and its children together instead.
		guildConfigMock.findByGuildId.mockResolvedValue(arcadeConfig());

		const captured = makeClientCapturing({ selfId: "bot-1" });
		registerChannelDeleteWatcher(captured.client);

		// The homebase category is alive; the arcade one is absent from the map so
		// its fetch resolves null. Reading stored.categoryId here (the old
		// behaviour) would have found a live category and rebuilt anyway.
		const guild = makeGuild({ categoryFetchMap: { "cat-1": makeCategory("cat-1") } });

		await captured.handler!(makeDeletedChannel("ch-arcaderules", guild, "📋arcade-rules"));

		expect(guildConfigMock.update).not.toHaveBeenCalled();
	});

	it("recognises an arcade CATEGORY delete and defers to the boot sweep", async () => {
		// The arcade category is not a CHANNEL_SPECS entry, so without an explicit
		// check its delete falls through the spec lookup and is indistinguishable
		// from an unrelated channel. Naming it is what produces the honest
		// "category gone" log rather than silence.
		guildConfigMock.findByGuildId.mockResolvedValue(arcadeConfig());

		const captured = makeClientCapturing({ selfId: "bot-1" });
		registerChannelDeleteWatcher(captured.client);

		const guild = makeGuild({ categoryFetchMap: { "cat-1": makeCategory("cat-1") } });
		await captured.handler!(makeDeletedChannel("games-cat-1", guild, "🎮 ARCADE GAMES"));

		expect(guildConfigMock.update).not.toHaveBeenCalled();
	});

	it("throttles a second repair of the same channel within the 60s cooldown", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());
		guildConfigMock.update.mockResolvedValue(undefined);

		const adminChannel = makeAdminChannel("ch-admin");
		const scheduleChannel = makeScheduleChannel("bot-1");
		const captured = makeClientCapturing({
			selfId: "bot-1",
			channelFetchMap: {
				"ch-admin": adminChannel,
				"ch-schedule": scheduleChannel,
			},
		});
		registerChannelDeleteWatcher(captured.client);

		const category = makeCategory();
		const guild = makeGuild({ categoryFetchMap: { "cat-1": category } });

		// first delete: repair fires and records the cooldown for
		// `guild-1:announcementsChannelId`.
		await captured.handler!(makeDeletedChannel("ch-announcements", guild));
		expect(guildConfigMock.update).toHaveBeenCalledOnce();

		// second delete within 60s: cooldown gate blocks. the cooldown is
		// keyed by guildId + configField so repeated deletes against the
		// same logical slot are throttled regardless of whether the new
		// channel id differs from the old one.
		await captured.handler!(makeDeletedChannel("ch-announcements", guild));

		// still only one update, the second repair was blocked.
		expect(guildConfigMock.update).toHaveBeenCalledOnce();
	});

	it("refuses to repair when the homebase is not owned by this bot", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());

		// ownership probe returns false because the schedule message author
		// is a different bot.
		const scheduleChannel = makeScheduleChannel("other-bot");
		const captured = makeClientCapturing({
			selfId: "bot-1",
			channelFetchMap: { "ch-schedule": scheduleChannel },
		});
		registerChannelDeleteWatcher(captured.client);

		const category = makeCategory();
		const guild = makeGuild({ categoryFetchMap: { "cat-1": category } });
		await captured.handler!(makeDeletedChannel("ch-announcements", guild));

		// no update, no repair. posting into a foreign bot's homebase would
		// be a correctness violation of the ownership invariant.
		expect(guildConfigMock.update).not.toHaveBeenCalled();
	});

	it("bails out when the parent category is also gone (boot sweep will handle it)", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());
		const captured = makeClientCapturing({ selfId: "bot-1" });
		registerChannelDeleteWatcher(captured.client);

		// guild.channels.fetch("cat-1") returns null, category is gone.
		const guild = makeGuild({ categoryFetchMap: { "cat-1": null } });
		await captured.handler!(makeDeletedChannel("ch-announcements", guild));

		// no rebuild, realtime defers full category restoration to the
		// next ensureHomebase sweep.
		expect(guildConfigMock.update).not.toHaveBeenCalled();
	});

	it("does not crash the listener when the repair primitive throws", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());

		const scheduleChannel = makeScheduleChannel("bot-1");
		const captured = makeClientCapturing({
			selfId: "bot-1",
			channelFetchMap: { "ch-schedule": scheduleChannel },
		});
		registerChannelDeleteWatcher(captured.client);

		const category = makeCategory();
		// inject a failing create so repairOneChannel throws. the listener
		// must catch the error and log without propagating out to the
		// gateway connection.
		const guild = makeGuild({
			categoryFetchMap: { "cat-1": category },
			createHandler: vi.fn(async () => {
				throw new Error("simulated Discord 500");
			}),
		});

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(captured.handler!(makeDeletedChannel("ch-announcements", guild))).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});

// ── risk R14: a deleted GAME ROOM channel ───────────────────────────────
// A room channel is not a CHANNEL_SPECS entry, so before this guard the spec lookup
// found nothing and the watcher returned silently. Nothing then finished the row, and
// because the partial unique index counts non-terminal statuses, that dead row held
// its host's ONE room slot forever: that member could never start another game,
// everyone else was fine, and nothing was logged.
describe("ChannelDeleteWatcher, game rooms (R14)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRepairCooldownsForTests();
		gameRoomMock.findByChannelId.mockResolvedValue(null);
		finishRoomMock.mockResolvedValue(undefined);
	});

	function makeRoom() {
		return { roomId: "room-1", guildId: "guild-1", channelId: "ch-room", hostId: "host-1" };
	}

	// The room path bails long before any homebase machinery, so the client only has
	// to exist and be registered.
	function driveRoomDelete(config: Record<string, unknown> = {}) {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig(config));
		gameRoomMock.findByChannelId.mockResolvedValue(makeRoom());
		const captured = makeClientCapturing({ selfId: "bot-1" });
		registerChannelDeleteWatcher(captured.client);
		const guild = makeGuild({});
		return { captured, guild };
	}

	it("closes a deleted room as abandoned instead of ignoring it", async () => {
		const { captured, guild } = driveRoomDelete();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await captured.handler!(makeDeletedChannel("ch-room", guild, "hangman-qwerty"));

		expect(finishRoomMock).toHaveBeenCalledOnce();
		expect(finishRoomMock.mock.calls[0][2]).toEqual({ abandoned: true });
		logSpy.mockRestore();
	});

	// A room is a per-match channel, not a managed slot. Rebuilding one would
	// resurrect a match nobody is playing, in a channel whose overwrites name players
	// who have moved on.
	it("never rebuilds the deleted room channel", async () => {
		const { captured, guild } = driveRoomDelete();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await captured.handler!(makeDeletedChannel("ch-room", guild, "hangman-qwerty"));

		expect(guild.channels.create).not.toHaveBeenCalled();
		logSpy.mockRestore();
	});

	// ⚠️ THE PLACEMENT TEST. The room check sits ABOVE the autoHealEnabled and
	// homebaseDestroyed gates on purpose: those govern whether the bot REBUILDS a
	// channel, which is a different question from whether its own room bookkeeping
	// stays true. Moving the check below either gate would leave rooms stuck open in
	// exactly the guilds most likely to have a pile of them, and /self-destruct
	// deletes every room channel it finds.
	it.each([
		["auto-heal is off", { autoHealEnabled: false }],
		["the homebase was self-destructed", { homebaseDestroyed: true }],
	])("still closes the room when %s", async (_label, configOverride) => {
		const { captured, guild } = driveRoomDelete(configOverride);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await captured.handler!(makeDeletedChannel("ch-room", guild, "hangman-qwerty"));

		expect(finishRoomMock).toHaveBeenCalledOnce();
		logSpy.mockRestore();
	});

	it("does not crash the gateway listener when closing the room throws", async () => {
		const { captured, guild } = driveRoomDelete();
		finishRoomMock.mockRejectedValue(new Error("mongo down"));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(captured.handler!(makeDeletedChannel("ch-room", guild, "hangman-qwerty"))).resolves.toBeUndefined();

		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("leaves an ordinary homebase repair alone when the channel is not a room", async () => {
		// The regression direction: the new lookup must not swallow the deletes this
		// watcher already existed to handle.
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());
		guildConfigMock.update.mockResolvedValue(undefined);
		const captured = makeClientCapturing({
			selfId: "bot-1",
			channelFetchMap: { "ch-admin": makeAdminChannel("ch-admin"), "ch-schedule": makeScheduleChannel("bot-1") },
		});
		registerChannelDeleteWatcher(captured.client);

		const createCalls: Array<{ name: string }> = [];
		const guild = makeGuild({
			categoryFetchMap: { "cat-1": makeCategory("cat-1") },
			createHandler: async (opts) => {
				const options = opts as { name: string };
				createCalls.push(options);
				const created = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
				Object.assign(created, { id: `new-${options.name}`, send: vi.fn().mockResolvedValue({ id: "intro-1" }) });
				return created;
			},
		});

		await captured.handler!(makeDeletedChannel("ch-announcements", guild, "📢announcements"));

		expect(finishRoomMock).not.toHaveBeenCalled();
		expect(createCalls).toHaveLength(1);
	});
});

describe("GuildSetupManager.CHANNEL_SPECS", () => {
	// cheap structural guard, if someone adds a new homebase channel and
	// forgets to list it in CHANNEL_SPECS, the watcher will silently ignore
	// deletes on the new channel. tests below flag the regression.
	it("has one entry per homebase field", () => {
		const expectedFields = [
			"introChannelId",
			"commandsChannelId",
			"leaderboardChannelId",
			"scheduleChannelId",
			"announcementsChannelId",
			"adminChannelId",
			"nextDecreeChannelId",
			"adminCommandsChannelId",
			// 🗒️admin-log (post-launch plan item 11).
			"adminLogChannelId",
			// 👋welcome and 📘rules (2026-10 item 247 Phase 2).
			"welcomeChannelId",
			"rulesChannelId",
			// The two under 🎮 ARCADE GAMES. CHANNEL_SPECS now spans TWO categories.
			"arcadeRulesChannelId",
			"arcadeChallengesChannelId",
			// 🕹️games, the third arcade channel (2026-10 item 245 Phase 4a).
			"arcadeGamesChannelId",
			// 🎉party-games, the fourth (post-launch plan item 3).
			"partyGamesChannelId",
			// 🏆rated-challenges, the fifth (2026-10 item 254, Arcade 5).
			"arcadeRatedChallengesChannelId",
			// The two voice rooms, one per category (2026-10 item 235).
			"meetingVoiceChannelId",
			"arcadeVoiceChannelId",
		];
		const actualFields = GuildSetupManager.CHANNEL_SPECS.map((s) => s.configField);
		expect(actualFields.sort()).toEqual(expectedFields.sort());
	});

	// ⚠️ THE R2 GUARD. Every spec has to name the category it belongs under, and
	// getting one wrong builds the channel in the wrong place without throwing.
	// The compiler enforces that the field is PRESENT; only a test can enforce
	// that its VALUE is right, because both categories are the same type.
	it("files every spec under the correct category", () => {
		const byCategory = (field: string) =>
			GuildSetupManager.CHANNEL_SPECS.filter((s) => s.categoryField === field)
				.map((s) => s.configField)
				.sort();

		expect(byCategory("gamesCategoryId")).toEqual([
			"arcadeChallengesChannelId",
			"arcadeGamesChannelId",
			"arcadeRatedChallengesChannelId",
			"arcadeRulesChannelId",
			"arcadeVoiceChannelId",
			"partyGamesChannelId",
		]);
		// Eleven text channels (welcome, rules and admin-log among them) plus the 🏛️ Meeting Hall voice room.
		expect(byCategory("categoryId")).toHaveLength(12);
		expect(byCategory("categoryId")).toContain("meetingVoiceChannelId");
		// No spec may be left unfiled, which a typo in the union would otherwise
		// produce silently.
		expect(byCategory("categoryId").length + byCategory("gamesCategoryId").length).toBe(GuildSetupManager.CHANNEL_SPECS.length);
	});

	it("marks the admin channel and the admin command center as kind 'admin'", () => {
		const adminEntries = GuildSetupManager.CHANNEL_SPECS.filter((s) => s.kind === "admin");
		expect(adminEntries.map((s) => s.configField).sort()).toEqual(["adminChannelId", "adminCommandsChannelId"].sort());
	});

	it("marks exactly the two voice rooms as kind 'voice'", () => {
		const voiceEntries = GuildSetupManager.CHANNEL_SPECS.filter((s) => s.kind === "voice");
		expect(voiceEntries.map((s) => s.configField).sort()).toEqual(["arcadeVoiceChannelId", "meetingVoiceChannelId"]);
	});
});

// ── the voice rooms, realtime half (2026-10 item 235) ──────────────────────
// The watcher has no voice code of its own: it resolves the parent from the
// spec's categoryField and hands off to repairOneChannel. These pin that a
// deleted room comes back as a VOICE channel, under its own category, with its
// /dero card posted once and anchored (2026-10 item 245 Phase 4b).
describe("ChannelDeleteWatcher, voice rooms", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRepairCooldownsForTests();
		gameRoomMock.findByChannelId.mockResolvedValue(null);
		guildConfigMock.update.mockResolvedValue(undefined);
	});

	const voiceConfig = () =>
		makeStoredConfig({
			gamesCategoryId: "games-cat-1",
			meetingVoiceChannelId: "ch-meetingvoice",
			arcadeVoiceChannelId: "ch-arcadevoice",
			memberRoleId: "role-member",
		});

	async function deleteRoom(deletedId: string, name: string) {
		guildConfigMock.findByGuildId.mockResolvedValue(voiceConfig());
		const adminChannel = makeAdminChannel("ch-admin");
		const captured = makeClientCapturing({
			selfId: "bot-1",
			channelFetchMap: { "ch-admin": adminChannel, "ch-schedule": makeScheduleChannel("bot-1") },
		});
		registerChannelDeleteWatcher(captured.client);

		const createCalls: Array<{ name: string; type: number; parent?: string; permissionOverwrites?: Array<{ id: string }> }> = [];
		const created: Array<{ send: ReturnType<typeof vi.fn> }> = [];
		const guild = makeGuild({
			categoryFetchMap: { "cat-1": makeCategory("cat-1"), "games-cat-1": makeCategory("games-cat-1") },
			createHandler: async (opts) => {
				const options = opts as { name: string; type: number; parent?: string };
				createCalls.push(options);
				const room = Object.create(VoiceChannel.prototype) as VoiceChannel & { send: ReturnType<typeof vi.fn> };
				Object.assign(room, { id: `new-${options.name}`, send: vi.fn().mockResolvedValue({ id: `card-${options.name}` }) });
				created.push(room);
				return room;
			},
		});

		await captured.handler!({ id: deletedId, name, guild, type: ChannelType.GuildVoice });
		return { createCalls, created, adminChannel };
	}

	it("rebuilds a deleted Meeting Hall as a voice room under the homebase, with its /dero card", async () => {
		const { createCalls, created, adminChannel } = await deleteRoom("ch-meetingvoice", rokCommanderCopy.setup.channels.meetingVoice);

		expect(createCalls).toHaveLength(1);
		expect(createCalls[0]).toMatchObject({
			name: rokCommanderCopy.setup.channels.meetingVoice,
			type: ChannelType.GuildVoice,
			parent: "cat-1",
		});
		// The stored member role reaches the rebuilt room (owner decision D3).
		expect(createCalls[0].permissionOverwrites?.map((entry) => entry.id)).toContain("role-member");
		expect(created[0].send).toHaveBeenCalledTimes(1);
		expect(guildConfigMock.update).toHaveBeenCalledWith(
			"guild-1",
			expect.objectContaining({
				meetingVoiceChannelId: `new-${rokCommanderCopy.setup.channels.meetingVoice}`,
				introMessageIds: expect.objectContaining({ meetingVoiceChannelId: `card-${rokCommanderCopy.setup.channels.meetingVoice}` }),
			})
		);
		// The admin channel still gets the usual restored notice.
		expect(adminChannel.send).toHaveBeenCalledOnce();
	});

	it("rebuilds a deleted Arcade Lounge under the ARCADE category", async () => {
		const { createCalls } = await deleteRoom("ch-arcadevoice", rokCommanderCopy.setup.channels.arcadeVoice);

		expect(createCalls).toHaveLength(1);
		expect(createCalls[0]).toMatchObject({ type: ChannelType.GuildVoice, parent: "games-cat-1" });
	});
});

// ── 👋welcome and 📘rules, realtime half (2026-10 item 247 Phase 2) ─────────
// The watcher reaches both through CHANNEL_SPECS with no code of its own. A
// deleted 👋welcome comes back under the homebase with its intro, and a deleted
// ADOPTED rules channel comes back as Dero's own 📘rules with the dead id dropped
// from adoptedChannelIds, so /self-destruct never spares a channel that is gone.
describe("ChannelDeleteWatcher, welcome and rules", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRepairCooldownsForTests();
		gameRoomMock.findByChannelId.mockResolvedValue(null);
		guildConfigMock.update.mockResolvedValue(undefined);
	});

	async function deleteChannel(deletedId: string, name: string, overrides: Record<string, unknown> = {}) {
		guildConfigMock.findByGuildId.mockResolvedValue(
			makeStoredConfig({ welcomeChannelId: "ch-welcome", rulesChannelId: "ch-own-rules", adoptedChannelIds: ["ch-own-rules"], ...overrides })
		);
		const captured = makeClientCapturing({
			selfId: "bot-1",
			channelFetchMap: { "ch-admin": makeAdminChannel("ch-admin"), "ch-schedule": makeScheduleChannel("bot-1") },
		});
		registerChannelDeleteWatcher(captured.client);
		const createCalls: Array<{ name: string; parent?: string }> = [];
		const sends: Array<ReturnType<typeof vi.fn>> = [];
		const guild = makeGuild({
			categoryFetchMap: { "cat-1": makeCategory("cat-1") },
			createHandler: async (opts) => {
				const options = opts as { name: string; parent?: string };
				createCalls.push(options);
				const created = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
				Object.assign(created, { id: `new-${options.name}`, send: vi.fn().mockResolvedValue({ id: `intro-${options.name}` }) });
				sends.push(created.send);
				return created;
			},
		});
		await captured.handler!({ id: deletedId, name, guild, type: ChannelType.GuildText });
		return { createCalls, sends };
	}

	it("rebuilds a deleted 👋welcome under the homebase with its intro", async () => {
		const { createCalls, sends } = await deleteChannel("ch-welcome", rokCommanderCopy.setup.channels.welcome);

		expect(createCalls).toEqual([expect.objectContaining({ name: rokCommanderCopy.setup.channels.welcome, parent: "cat-1" })]);
		const intro = sends[0]!.mock.calls[0]![0] as { embeds: Array<{ data: { title?: string } }> };
		expect(intro.embeds[0]!.data.title).toBe(rokCommanderCopy.channelContent.welcome.title);
		// The adopted rules channel is a different slot and stays on the list.
		expect(guildConfigMock.update).toHaveBeenCalledWith("guild-1", expect.objectContaining({ adoptedChannelIds: ["ch-own-rules"] }));
	});

	it("rebuilds a deleted adopted rules channel as Dero's own 📘rules and drops the dead id", async () => {
		const { createCalls, sends } = await deleteChannel("ch-own-rules", "rules");

		expect(createCalls).toEqual([expect.objectContaining({ name: rokCommanderCopy.setup.channels.rules, parent: "cat-1" })]);
		const post = sends[0]!.mock.calls[0]![0] as { embeds: Array<{ data: { title?: string } }> };
		expect(post.embeds[0]!.data.title).toBe(rokCommanderCopy.channelContent.rules.title);
		expect(guildConfigMock.update).toHaveBeenCalledWith(
			"guild-1",
			expect.objectContaining({ rulesChannelId: `new-${rokCommanderCopy.setup.channels.rules}`, adoptedChannelIds: [] })
		);
	});
});
