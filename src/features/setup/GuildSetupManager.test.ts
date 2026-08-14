import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel, DiscordAPIError, ChannelType, PermissionFlagsBits } from "discord.js";
import type { Client, Guild } from "discord.js";

// mock the guild config store before importing the unit under test. the
// mongoose model chain tries to open a real DB connection at import time
// otherwise and the test process hangs. matches the pattern used in
// TestReminderJob.test.ts.
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: {
		findByGuildId: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		deleteByGuildId: vi.fn(),
	},
}));

import { GuildSetupManager } from "./GuildSetupManager.js";
import { ChannelContent } from "./ChannelContent.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

const guildConfigMock = guildConfigStore as unknown as {
	findByGuildId: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
	deleteByGuildId: ReturnType<typeof vi.fn>;
};

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
		// The 7th/8th homebase channels. repairMissingChannels treats a
		// null/undefined stored id as "also missing, rebuild too", so these must
		// be present or every repair sweep rebuilds them alongside the real target.
		nextDecreeChannelId: "ch-nextdecree",
		adminCommandsChannelId: "ch-admincommands",
		// The 9th/10th channels, under 🎮 ARCADE GAMES. Present for exactly the
		// reason the two above are: a null id reads as "missing, rebuild too", so
		// leaving them out would have every unrelated repair test also provisioning
		// the arcade. The migration case (all three null) gets its OWN test rather
		// than being smuggled into every other one.
		gamesCategoryId: "games-cat-1",
		arcadeRulesChannelId: "ch-arcaderules",
		arcadeChallengesChannelId: "ch-arcadechallenges",
		scheduleMessageId: "msg-schedule",
		adminRoleId: null,
		memberRoleId: null,
		setupComplete: true,
		...overrides,
	};
}

// Object.create(TextChannel.prototype), leanest object that still passes
// `channel instanceof TextChannel` inside ensureHomebase without pulling in
// the full discord.js Guild + Client construction chain.
function makeScheduleChannel(fetchImpl: (messageId: string) => Promise<unknown>): TextChannel {
	const ch = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(ch, {
		id: "ch-schedule",
		messages: { fetch: vi.fn(fetchImpl) },
	});
	return ch;
}

// admin channel stand in for ensureHomebase's notice post step. any test that
// expects repair notices to land must route client.channels.fetch(adminChannelId)
// to one of these so the `instanceof TextChannel` check passes.
function makeAdminChannel(id = "ch-admin"): TextChannel & { send: ReturnType<typeof vi.fn> } {
	const ch = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
	Object.assign(ch, {
		id,
		send: vi.fn().mockResolvedValue({ id: "notice-msg" }),
	});
	return ch;
}

// ensureHomebase only touches client.user?.id and client.channels.fetch.
// keep the shape minimal so intent is obvious at each call site.
function makeClient(options: {
	selfId?: string | undefined;
	fetchChannel?: (id: string) => Promise<unknown>;
}): Client {
	const fetch = options.fetchChannel
		? vi.fn(async (id: string) => {
				const v = await options.fetchChannel!(id);
				return v;
		  })
		: vi.fn().mockResolvedValue(null);
	return {
		user: options.selfId === undefined ? null : { id: options.selfId },
		channels: { fetch },
	} as unknown as Client;
}

// Guild mock with pluggable channels.fetch. the fetch map drives which of the
// six stored channel ids resolve (intact) vs return null (missing) so the
// repair path can be exercised with surgical control.
function makeGuild(options: {
	categoryId?: unknown; // what guild.channels.fetch(categoryId) returns
	channelFetchMap?: Record<string, unknown>; // per id results for repair scan
	createHandler?: (opts: unknown) => Promise<unknown>;
}): Guild {
	const categoryId = options.categoryId;
	// repairOneChannel's adopt-before-build guard scans category.children.cache;
	// augment the caller's bare { id } fixture with an empty cache (find →
	// undefined) so the repair path builds fresh. null (category-gone) and Error
	// (fetch throws) pass through untouched.
	const categoryObject =
		categoryId && typeof categoryId === "object" && !(categoryId instanceof Error)
			? { children: { cache: { find: () => undefined } }, ...(categoryId as object) }
			: categoryId;
	// The 7th/8th homebase channels default to present so tests that only wire
	// up the original six do not trip repairMissingChannels' "stored id →
	// rebuild too" branch for them. A test can still override either id.
	const map: Record<string, unknown> = {
		"ch-nextdecree": { id: "ch-nextdecree" },
		"ch-admincommands": { id: "ch-admincommands" },
		// The arcade category and its two channels, present by default for the
		// same reason. A test exercising the MIGRATION overrides these to null.
		"games-cat-1": { id: "games-cat-1", type: ChannelType.GuildCategory, children: { cache: { find: () => undefined } } },
		"ch-arcaderules": { id: "ch-arcaderules" },
		"ch-arcadechallenges": { id: "ch-arcadechallenges" },
		...(options.channelFetchMap ?? {}),
	};
	const create =
		options.createHandler ??
		vi.fn(async (opts: { name: string; type?: number }) => {
			// A created CATEGORY needs a children cache, because repairOneChannel's
			// adopt-before-build guard scans parent.children.cache and a category
			// fixture without one throws inside the repair rather than failing an
			// assertion. Mirrors the augmentation the stored-category fixture above
			// already does.
			if (opts.type === ChannelType.GuildCategory) {
				return { id: `new-${opts.name}`, type: ChannelType.GuildCategory, children: { cache: { find: () => undefined } } };
			}
			// fabricate a TextChannel shape with a unique id per creation so
			// the updated config stores something distinguishable.
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
				if (id === "cat-1" && categoryId !== undefined) {
					if (categoryId instanceof Error) throw categoryId;
					return categoryObject as unknown;
				}
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

describe("GuildSetupManager.ensureHomebase", () => {
	// autoSetup does real Discord + Mongo work. every branch that triggers a
	// full (re)build spies on it instead of executing it.
	let autoSetupSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		autoSetupSpy = vi.spyOn(GuildSetupManager, "autoSetup").mockResolvedValue(undefined);
	});

	// vi.clearAllMocks() resets call history but does NOT un-spy, so without
	// this the autoSetup spy would leak into the "autoSetup persistence" block
	// below and make those tests run against the mock (resolving undefined)
	// instead of the real method.
	afterEach(() => {
		autoSetupSpy.mockRestore();
	});

	it("builds fresh when no GuildConfig exists", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(null);
		const guild = makeGuild({ categoryId: null });
		const client = makeClient({ selfId: "bot-1" });

		const result = await GuildSetupManager.ensureHomebase(client, guild);

		expect(result).toEqual({ action: "built", repairedChannels: [] });
		expect(autoSetupSpy).toHaveBeenCalledOnce();
		expect(guildConfigMock.deleteByGuildId).not.toHaveBeenCalled();
	});

	it("rebuilds and posts castle notice when the stored category is gone", async () => {
		// two findByGuildId calls happen: the opening read and the castle
		// notice helper re reading after the rebuild. the second read
		// returns the "fresh" config so the notice helper can resolve the
		// new admin channel.
		guildConfigMock.findByGuildId
			.mockResolvedValueOnce(makeStoredConfig())
			.mockResolvedValueOnce(makeStoredConfig({ adminChannelId: "ch-admin-new" }));

		const guild = makeGuild({ categoryId: null });
		const adminChannel = makeAdminChannel("ch-admin-new");
		const client = makeClient({
			selfId: "bot-1",
			fetchChannel: async (id) => (id === "ch-admin-new" ? adminChannel : null),
		});

		const result = await GuildSetupManager.ensureHomebase(client, guild);

		expect(result).toEqual({ action: "rebuilt", repairedChannels: [] });
		// CRITICAL: deleteByGuildId must NEVER be called on the rebuild path.
		// In the shared MongoDB cluster scenario that would nuke the other
		// bot's row. The rebuild path must instead run autoSetup with
		// force:true so a potentially foreign row stays intact and an
		// 11000 duplicate key is the failure mode.
		expect(guildConfigMock.deleteByGuildId).not.toHaveBeenCalled();
		// autoSetup was invoked with force:true to bypass the early return.
		expect(autoSetupSpy).toHaveBeenCalledOnce();
		expect(autoSetupSpy).toHaveBeenCalledWith(guild, { guildId: "guild-1", ownerId: "owner-1" }, { force: true });
		// castle rebuilt embed landed in the new inner sanctum.
		expect(adminChannel.send).toHaveBeenCalledOnce();
		const sent = adminChannel.send.mock.calls[0][0] as { embeds: Array<{ data: { title: string } }> };
		expect(sent.embeds[0].data.title).toBe(rokCommanderCopy.channelContent.castleRebuiltNotice.title);
	});

	it("rebuilds when the stored schedule message was authored by another bot", async () => {
		guildConfigMock.findByGuildId
			.mockResolvedValueOnce(makeStoredConfig())
			.mockResolvedValueOnce(makeStoredConfig({ adminChannelId: "ch-admin-new" }));

		const guild = makeGuild({ categoryId: { id: "cat-1" } });
		const scheduleChannel = makeScheduleChannel(async () => ({
			id: "msg-schedule",
			author: { id: "other-bot" },
		}));
		const adminChannel = makeAdminChannel("ch-admin-new");
		const client = makeClient({
			selfId: "bot-1",
			fetchChannel: async (id) => {
				if (id === "ch-schedule") return scheduleChannel;
				if (id === "ch-admin-new") return adminChannel;
				return null;
			},
		});

		const result = await GuildSetupManager.ensureHomebase(client, guild);

		expect(result).toEqual({ action: "rebuilt", repairedChannels: [] });
		// rebuild path must not delete the foreign row on a shared Mongo
		// cluster. autoSetup with force:true is the correct invocation.
		expect(guildConfigMock.deleteByGuildId).not.toHaveBeenCalled();
		expect(autoSetupSpy).toHaveBeenCalledWith(guild, { guildId: "guild-1", ownerId: "owner-1" }, { force: true });
	});

	it("does NOT rebuild when the stored schedule message is missing (10008), repairs in place", async () => {
		// Regression (auto-heal duplicate-homebase bug): a deleted/unfetchable
		// schedule message is NOT proof the homebase is foreign. The ownership
		// probe returns "unknown", so ensureHomebase keeps the category and
		// repairs in place (the schedule board reposts its message on the next
		// refresh) instead of building a duplicate homebase.
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());

		const intact = { id: "intact" };
		const guild = makeGuild({
			categoryId: { id: "cat-1" },
			channelFetchMap: {
				"ch-intro": intact,
				"ch-commands": intact,
				"ch-leaderboard": intact,
				"ch-schedule": intact,
				"ch-announcements": intact,
				"ch-admin": intact,
			},
		});
		const scheduleChannel = makeScheduleChannel(async () => {
			const err = Object.create(DiscordAPIError.prototype);
			Object.assign(err, { code: 10008, message: "Unknown Message" });
			throw err;
		});
		const client = makeClient({
			selfId: "bot-1",
			fetchChannel: async (id) => (id === "ch-schedule" ? scheduleChannel : null),
		});

		const result = await GuildSetupManager.ensureHomebase(client, guild);

		expect(result).toEqual({ action: "skipped", repairedChannels: [] });
		expect(autoSetupSpy).not.toHaveBeenCalled();
	});

	it("skips when the stored homebase exists, is ours, and every channel is intact", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());

		// every stored channel id resolves to a non null object. the actual
		// shape does not matter because the repair path only checks truthiness.
		const intact = { id: "intact" };
		const guild = makeGuild({
			categoryId: { id: "cat-1" },
			channelFetchMap: {
				"ch-intro": intact,
				"ch-commands": intact,
				"ch-leaderboard": intact,
				"ch-schedule": intact,
				"ch-announcements": intact,
				"ch-admin": intact,
			},
		});
		const scheduleChannel = makeScheduleChannel(async () => ({
			id: "msg-schedule",
			author: { id: "bot-1" },
		}));
		const client = makeClient({
			selfId: "bot-1",
			fetchChannel: async (id) => (id === "ch-schedule" ? scheduleChannel : null),
		});

		const result = await GuildSetupManager.ensureHomebase(client, guild);

		expect(result).toEqual({ action: "skipped", repairedChannels: [] });
		expect(autoSetupSpy).not.toHaveBeenCalled();
		expect(guildConfigMock.deleteByGuildId).not.toHaveBeenCalled();
		expect(guildConfigMock.update).not.toHaveBeenCalled();
	});

	// ⚠️ THE MIGRATION PATH, AND THE R2 REGRESSION GUARD AT RUNTIME.
	// A row written before 🎮 ARCADE GAMES existed carries three null ids, which
	// the sweep reads as "missing, build it". Both channels must land under the
	// ARCADE category, and the compiler cannot help here because both parents are
	// the same type. Building them under cat-1 is invisible in production until
	// somebody notices arcade-rules sitting in the notice board, and by then the
	// adopt-before-build scan is looking in the wrong parent and making duplicates.
	it("gives a legacy guild the arcade category and files both channels under it", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(
			makeStoredConfig({ gamesCategoryId: null, arcadeRulesChannelId: null, arcadeChallengesChannelId: null })
		);

		const createCalls: Array<{ name: string; type?: number; parent?: string }> = [];
		const intact = { id: "intact" };
		const guild = makeGuild({
			categoryId: { id: "cat-1" },
			channelFetchMap: {
				"ch-intro": intact,
				"ch-commands": intact,
				"ch-leaderboard": intact,
				"ch-schedule": intact,
				"ch-announcements": intact,
				"ch-admin": intact,
			},
			createHandler: async (opts) => {
				const options = opts as { name: string; type?: number; parent?: string };
				createCalls.push(options);
				if (options.type === ChannelType.GuildCategory) {
					return { id: "new-arcade", type: ChannelType.GuildCategory, children: { cache: { find: () => undefined } } };
				}
				const created = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
				Object.assign(created, { id: `new-${options.name}`, send: vi.fn().mockResolvedValue({ id: "intro-msg" }) });
				return created;
			},
		});
		const client = makeClient({ selfId: "bot-1", fetchChannel: async () => null });

		await GuildSetupManager.ensureHomebase(client, guild);

		// The category was created once, and its id persisted so the SECOND arcade
		// spec in the same sweep reuses it rather than creating a rival.
		const categoryCreates = createCalls.filter((c) => c.type === ChannelType.GuildCategory);
		expect(categoryCreates).toHaveLength(1);
		expect(guildConfigMock.update).toHaveBeenCalledWith("guild-1", { gamesCategoryId: "new-arcade" });

		// Both arcade channels went under the NEW category, never under cat-1.
		const arcadeChannels = createCalls.filter((c) => c.type !== ChannelType.GuildCategory);
		expect(arcadeChannels).toHaveLength(2);
		for (const call of arcadeChannels) {
			expect(call.parent).toBe("new-arcade");
			expect(call.parent).not.toBe("cat-1");
		}
	});

	it("repairs a single missing public channel and posts a notice in the inner sanctum", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());

		// announcements channel is the only one missing. the other five
		// including admin are intact. this exercises the "most common"
		// deletion case: a warrior or admin wipes one channel.
		const intact = { id: "intact" };
		const guild = makeGuild({
			categoryId: { id: "cat-1" },
			channelFetchMap: {
				"ch-intro": intact,
				"ch-commands": intact,
				"ch-leaderboard": intact,
				"ch-schedule": intact,
				"ch-announcements": null,
				"ch-admin": intact,
			},
		});
		const scheduleChannel = makeScheduleChannel(async () => ({
			id: "msg-schedule",
			author: { id: "bot-1" },
		}));
		const adminChannel = makeAdminChannel("ch-admin");
		const client = makeClient({
			selfId: "bot-1",
			fetchChannel: async (id) => {
				if (id === "ch-schedule") return scheduleChannel;
				if (id === "ch-admin") return adminChannel;
				return null;
			},
		});

		const result = await GuildSetupManager.ensureHomebase(client, guild);

		expect(result.action).toBe("repaired");
		expect(result.repairedChannels).toEqual([rokCommanderCopy.setup.channels.announcements]);
		// config update ran with the new announcements channel id AND the
		// new introMessageIds map (announcementsChannelId slot freshly
		// populated with the reposted intro message id, other slots
		// preserved from the prior config).
		expect(guildConfigMock.update).toHaveBeenCalledWith("guild-1", {
			announcementsChannelId: expect.stringContaining("new-"),
			introMessageIds: expect.objectContaining({
				announcementsChannelId: expect.stringContaining("intro-"),
			}),
		});
		// notice embed landed in inner sanctum. postRepairNotices now sends a
		// single channelsRestoredSummary embed (summaryTitle), not the old
		// per-channel channelRepairNotice.title.
		expect(adminChannel.send).toHaveBeenCalledOnce();
		const sent = adminChannel.send.mock.calls[0][0] as { embeds: Array<{ data: { title: string } }> };
		expect(sent.embeds[0].data.title).toBe(rokCommanderCopy.channelContent.channelRepairNotice.summaryTitle);
	});

	it("repairs the admin channel itself and posts the notice into the rebuilt admin channel", async () => {
		// the config read happens: ① initial ensureHomebase read. ② the
		// fresh read at the top of repairMissingChannels. there is no
		// third read because postRepairNotices resolves the new admin
		// channel id off the in memory `stored` object updated inside
		// the repair loop.
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());

		const intact = { id: "intact" };
		const newAdminChannel = makeAdminChannel(`new-${rokCommanderCopy.setup.channels.admin}`);
		const guild = makeGuild({
			categoryId: { id: "cat-1" },
			channelFetchMap: {
				"ch-intro": intact,
				"ch-commands": intact,
				"ch-leaderboard": intact,
				"ch-schedule": intact,
				"ch-announcements": intact,
				"ch-admin": null, // admin channel was deleted
			},
			// override the default create handler so the admin channel rebuild
			// yields the same object the client.channels.fetch below will serve
			// when posting the notice. keeps the test asserting real identity
			// rather than coincidental id overlap.
			createHandler: vi.fn(async () => newAdminChannel) as unknown as (opts: unknown) => Promise<unknown>,
		});
		const scheduleChannel = makeScheduleChannel(async () => ({
			id: "msg-schedule",
			author: { id: "bot-1" },
		}));
		const client = makeClient({
			selfId: "bot-1",
			fetchChannel: async (id) => {
				if (id === "ch-schedule") return scheduleChannel;
				// the rebuilt admin channel id matches what the create
				// handler returned. repairMissingChannels updates stored
				// with that id and passes it to postRepairNotices.
				if (id === newAdminChannel.id) return newAdminChannel;
				return null;
			},
		});

		const result = await GuildSetupManager.ensureHomebase(client, guild);

		expect(result.action).toBe("repaired");
		expect(result.repairedChannels).toEqual([rokCommanderCopy.setup.channels.admin]);
		// config update with the new admin channel id plus the refreshed
		// introMessageIds map carrying the new admin intro anchor.
		expect(guildConfigMock.update).toHaveBeenCalledWith("guild-1", {
			adminChannelId: newAdminChannel.id,
			introMessageIds: expect.objectContaining({ adminChannelId: expect.any(String) }),
		});
		// notice landed in the NEW admin channel, proving the repair path
		// does not post into a deleted channel.
		expect(newAdminChannel.send).toHaveBeenCalled();
	});

	it("repairs the schedule channel and repoints scheduleMessageId at the fresh intro anchor", async () => {
		// this case calls repairMissingChannels directly instead of going
		// through ensureHomebase. in production ensureHomebase cannot reach
		// this state (a deleted schedule channel fails the ownership probe
		// first, so the whole homebase rebuilds). the repair behavior
		// itself is still worth asserting independently because anything
		// that reuses repairMissingChannels in the future needs the
		// scheduleMessageId kept in sync with the new intro post.
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());

		const intact = { id: "intact" };
		const guild = makeGuild({
			categoryId: { id: "cat-1" },
			channelFetchMap: {
				"ch-intro": intact,
				"ch-commands": intact,
				"ch-leaderboard": intact,
				"ch-schedule": null, // schedule channel deleted
				"ch-announcements": intact,
				"ch-admin": intact,
			},
		});
		const adminChannel = makeAdminChannel("ch-admin");
		const client = makeClient({
			selfId: "bot-1",
			fetchChannel: async (id) => (id === "ch-admin" ? adminChannel : null),
		});

		// children.cache is scanned by repairOneChannel's adopt guard; empty
		// cache forces the build-fresh path this direct repair call exercises.
		const fakeCategory = { id: "cat-1", children: { cache: { find: () => undefined } } } as unknown as import("discord.js").CategoryChannel;
		const repaired = await GuildSetupManager.repairMissingChannels(client, guild, fakeCategory);

		expect(repaired).toEqual([rokCommanderCopy.setup.channels.schedule]);
		// the update call for schedule channel carries the new channel id,
		// the refreshed introMessageIds map, AND scheduleMessageId pointing
		// at the fresh intro post (which IS the new pinned board anchor).
		expect(guildConfigMock.update).toHaveBeenCalledWith("guild-1", {
			scheduleChannelId: expect.stringContaining("new-"),
			introMessageIds: expect.objectContaining({ scheduleChannelId: expect.any(String) }),
			scheduleMessageId: expect.any(String),
		});
	});

	it("repairs multiple missing channels and posts one notice per channel", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());

		const intact = { id: "intact" };
		const guild = makeGuild({
			categoryId: { id: "cat-1" },
			channelFetchMap: {
				"ch-intro": null, // missing
				"ch-commands": intact,
				"ch-leaderboard": null, // missing
				"ch-schedule": intact,
				"ch-announcements": intact,
				"ch-admin": intact,
			},
		});
		const scheduleChannel = makeScheduleChannel(async () => ({
			id: "msg-schedule",
			author: { id: "bot-1" },
		}));
		const adminChannel = makeAdminChannel("ch-admin");
		const client = makeClient({
			selfId: "bot-1",
			fetchChannel: async (id) => {
				if (id === "ch-schedule") return scheduleChannel;
				if (id === "ch-admin") return adminChannel;
				return null;
			},
		});

		const result = await GuildSetupManager.ensureHomebase(client, guild);

		expect(result.action).toBe("repaired");
		expect(result.repairedChannels).toEqual([rokCommanderCopy.setup.channels.intro, rokCommanderCopy.setup.channels.leaderboard]);
		// ONE summary notice covers all repaired channels, postRepairNotices
		// sends a single channelsRestoredSummary embed whose description lists
		// every rebuilt channel, not one message per channel.
		expect(adminChannel.send).toHaveBeenCalledOnce();
		const summary = adminChannel.send.mock.calls[0][0] as { embeds: Array<{ data: { title: string; description: string } }> };
		expect(summary.embeds[0].data.title).toBe(rokCommanderCopy.channelContent.channelRepairNotice.summaryTitle);
		expect(summary.embeds[0].data.description).toContain(rokCommanderCopy.setup.channels.intro);
		expect(summary.embeds[0].data.description).toContain(rokCommanderCopy.setup.channels.leaderboard);
	});

	it("does NOT rebuild when the stored scheduleMessageId is null, repairs in place", async () => {
		// Regression (auto-heal duplicate-homebase bug): a legacy/blank
		// scheduleMessageId is not proof of a foreign homebase either. The probe
		// returns "unknown" (no anchor to check), so we keep the category and
		// repair in place rather than building a duplicate.
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig({ scheduleMessageId: null }));

		const intact = { id: "intact" };
		const guild = makeGuild({
			categoryId: { id: "cat-1" },
			channelFetchMap: {
				"ch-intro": intact,
				"ch-commands": intact,
				"ch-leaderboard": intact,
				"ch-schedule": intact,
				"ch-announcements": intact,
				"ch-admin": intact,
			},
		});
		const client = makeClient({ selfId: "bot-1" });

		const result = await GuildSetupManager.ensureHomebase(client, guild);

		expect(result).toEqual({ action: "skipped", repairedChannels: [] });
		expect(autoSetupSpy).not.toHaveBeenCalled();
		expect(guildConfigMock.deleteByGuildId).not.toHaveBeenCalled();
	});
});

// ── autoSetup persist paths ─────────────────────────────────────────────
// Separate describe block because these tests drive autoSetup directly and
// do NOT spy over it the way the ensureHomebase block does. They guard the
// two paths that matter after the shared-cluster hardening:
//   A. existing row + force:true → update in place (not create).
//   B. no existing row + create throws duplicate key (code 11000) → the
//      error is logged and rethrown, and no row is mutated.
describe("GuildSetupManager.autoSetup persistence", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// helper guild whose channels.create yields unique ids. populate step
	// sends embeds through the channel `send` mock and returns a message id.
	function makePersistGuild(): Guild {
		const makeCh = (name: string) => {
			const ch = Object.create(TextChannel.prototype) as TextChannel & {
				send: ReturnType<typeof vi.fn>;
				pin: ReturnType<typeof vi.fn>;
				guildId: string;
			};
			Object.assign(ch, {
				id: `new-${name}`,
				guildId: "guild-1",
				send: vi.fn().mockResolvedValue({ id: `msg-${name}`, pin: vi.fn().mockResolvedValue(undefined) }),
				pin: vi.fn().mockResolvedValue(undefined),
			});
			return ch;
		};
		return {
			id: "guild-1",
			ownerId: "owner-1",
			roles: { everyone: { id: "everyone" } },
			// createChannels reads guild.client.user.id via botSelfOverwrite; real
			// autoSetup throws without it (the ensureHomebase block spies over
			// autoSetup, so this fixture only matters once the spy is restored).
			client: { user: { id: "bot-1" } },
			channels: {
				create: vi.fn(async (opts: { name: string; type: number }) => {
					// categories come back with just an id, populateChannels
					// never touches a category object directly.
					if (opts.type === 4) return { id: "new-cat-1" };
					return makeCh(opts.name);
				}),
				// Reached only on the force:true rebuild, where runAutoSetup now hands the
				// STORED arcade category id to resolveOrCreateArcadeCategory instead of null.
				// Resolving it is what proves the reuse branch is live on this path; before the
				// fix it was dead here and every forced rebuild built a second 🎮 ARCADE GAMES
				// beside the live one, orphaning its channels and every room parented under it.
				fetch: vi.fn(async (id: string) => (id === "games-cat-1" ? { id, type: 4 } : null)),
			},
		} as unknown as Guild;
	}

	it("updates the existing row in place when force:true and a row already exists", async () => {
		// path B from the autoSetup persist branching. an existing row
		// means this bot already has a homebase record; force:true is used
		// by ensureHomebase to rebuild Discord-side channels while keeping
		// Phase 2 state (adminRoleId, setupComplete) intact.
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig({ adminRoleId: "role-1", setupComplete: true }));
		guildConfigMock.update.mockResolvedValue(undefined);

		const guild = makePersistGuild();
		await GuildSetupManager.autoSetup(guild, { guildId: "guild-1", ownerId: "owner-1" }, { force: true });

		// update was called, create was not. this is the whole point of
		// the update branch, do not try to insert when a row already
		// exists in the DB, because on a shared cluster that row might be
		// foreign.
		expect(guildConfigMock.update).toHaveBeenCalledOnce();
		expect(guildConfigMock.create).not.toHaveBeenCalled();
		// the update payload carries the new channel ids but deliberately
		// omits adminRoleId / setupComplete so Phase 2 state carries over.
		const [guildId, payload] = guildConfigMock.update.mock.calls[0] as [string, Record<string, unknown>];
		expect(guildId).toBe("guild-1");
		expect(payload.categoryId).toBe("new-cat-1");
		expect(payload).not.toHaveProperty("adminRoleId");
		expect(payload).not.toHaveProperty("setupComplete");
		// ⚠️ AND THE ARCADE CATEGORY IS REUSED, NOT REBUILT. force:true is reached by
		// rebuildFromStaleConfig and ScheduleBoard.rebuildHomebase, both of which fire when only
		// the HOMEBASE category is missing. Creating a second arcade category here would repoint
		// gamesCategoryId at it and permanently orphan the original, its channels, and every
		// in-progress room channel parented under it (selfDestruct reads the stored id, so
		// /self-destruct could not reach them either).
		expect(payload.gamesCategoryId).toBe("games-cat-1");
		const categoryCreates = (guild.channels.create as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
			([opts]) => (opts as { type: number }).type === 4
		);
		expect(categoryCreates).toHaveLength(1);
	});

	it("logs loudly and rethrows when create hits the 11000 duplicate key error", async () => {
		// path A's failure mode. no row for this guildId appears in the
		// initial find, but between the find and the create a foreign row
		// lands in the collection (or, more realistically, the collection
		// is shared with prod and the initial find used a stale cache).
		// autoSetup must surface the error rather than silently corrupt.
		guildConfigMock.findByGuildId.mockResolvedValue(null);
		const dupKey = Object.assign(new Error("E11000 duplicate key error collection"), { code: 11000 });
		guildConfigMock.create.mockRejectedValue(dupKey);

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const guild = makePersistGuild();

		await expect(
			GuildSetupManager.autoSetup(guild, { guildId: "guild-1", ownerId: "owner-1" })
		).rejects.toBe(dupKey);

		// error was logged with the dedicated duplicate-key message. the
		// string includes "duplicate key" so the operator can grep for it.
		const loggedMessages = errorSpy.mock.calls.map((call) => String(call[0]));
		expect(loggedMessages.some((msg) => msg.includes("duplicate key"))).toBe(true);
		// critically, no update or delete was attempted, we never silently
		// overwrite the foreign row.
		expect(guildConfigMock.update).not.toHaveBeenCalled();
		expect(guildConfigMock.deleteByGuildId).not.toHaveBeenCalled();

		errorSpy.mockRestore();
	});
});

// ── createChannels, the fresh install create path ───────────────────────
// What:  pins what a fresh install actually BUILDS: two categories, ten
//        channels, each under the right parent and carrying the overwrite
//        array its privacy posture requires.
// Who:   runAutoSetup on guildCreate, and ensureHomebase's force rebuild.
// Why it exists: the persistence block above does reach createChannels for
//        real, but every assertion it makes is about the PERSIST branch
//        (update vs insert, duplicate key). Nothing asserted the SHAPE of
//        what was created, so the 8 to 10 channel change landed with its
//        whole surface uncovered. A wrong parent or a swapped overwrite
//        array throws nothing, fails no type check, and stays invisible
//        until a member opens Discord and finds 📋arcade-rules filed under
//        🪧 NOTICE BOARD or an admin channel readable by everyone.
// Where: this is the create-path twin of the R2 guard ChannelDeleteWatcher
//        .test.ts already keeps over the REPAIR path. Both paths build
//        channels; both can put one under the wrong category; only the
//        repair half was watched.
describe("GuildSetupManager.autoSetup channel creation", () => {
	const packChannels = rokCommanderCopy.setup.channels;
	const EVERYONE_ID = "everyone";
	const OWNER_ID = "owner-1";
	const BOT_ID = "bot-1";

	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Distinct id per created category, keyed off the name, because telling the
	// two parents apart is the entire point of this block. The persistence
	// fixture above hands back a single "new-cat-1" for every category, which
	// cannot express the R2 bug: under it, a channel built under the wrong
	// parent is indistinguishable from one built under the right parent.
	function makeCreateGuild(): Guild {
		const create = vi.fn(async (opts: { name: string; type: number }) => {
			if (opts.type === ChannelType.GuildCategory) return { id: `cat-${opts.name}` };
			const ch = Object.create(TextChannel.prototype) as TextChannel & {
				send: ReturnType<typeof vi.fn>;
				pin: ReturnType<typeof vi.fn>;
			};
			Object.assign(ch, {
				id: `new-${opts.name}`,
				guildId: "guild-1",
				send: vi.fn().mockResolvedValue({ id: `msg-${opts.name}`, pin: vi.fn().mockResolvedValue(undefined) }),
				pin: vi.fn().mockResolvedValue(undefined),
			});
			return ch;
		});
		return {
			id: "guild-1",
			ownerId: OWNER_ID,
			roles: { everyone: { id: EVERYONE_ID } },
			// createChannels reads guild.client.user.id via botSelfOverwrite.
			client: { user: { id: BOT_ID } },
			channels: { create },
		} as unknown as Guild;
	}

	interface ICreateCall {
		name: string;
		type: number;
		parent?: string;
		permissionOverwrites?: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }>;
	}

	// Path A, the true fresh install: no stored row, so autoSetup builds both
	// categories, all ten channels, then inserts. The existing persistence
	// tests deliberately never complete this path (one forces an update, the
	// other rejects the insert), so nothing until now ran it end to end.
	async function runFreshInstall(): Promise<{ categories: ICreateCall[]; textChannels: ICreateCall[] }> {
		guildConfigMock.findByGuildId.mockResolvedValue(null);
		guildConfigMock.create.mockResolvedValue(undefined);

		const guild = makeCreateGuild();
		await GuildSetupManager.autoSetup(guild, { guildId: "guild-1", ownerId: OWNER_ID });

		const createMock = guild.channels.create as unknown as ReturnType<typeof vi.fn>;
		const calls = createMock.mock.calls.map((call) => call[0] as ICreateCall);
		return {
			categories: calls.filter((call) => call.type === ChannelType.GuildCategory),
			textChannels: calls.filter((call) => call.type === ChannelType.GuildText),
		};
	}

	it("builds exactly two categories and ten channels", async () => {
		const { categories, textChannels } = await runFreshInstall();

		// Both categories, in build order, with NO dev suffix: vitest runs under
		// NODE_ENV=test, and resolveCategoryName only suffixes on "development".
		// Worth pinning, because a suffixed category name in production is a
		// visible brand mark on every server the bot joins.
		expect(categories.map((category) => category.name)).toEqual([
			rokCommanderCopy.setup.categoryName,
			rokCommanderCopy.setup.gamesCategoryName,
		]);

		expect(textChannels).toHaveLength(10);
		expect(textChannels.map((channel) => channel.name).sort()).toEqual(
			[
				packChannels.intro,
				packChannels.commands,
				packChannels.leaderboard,
				packChannels.schedule,
				packChannels.announcements,
				packChannels.admin,
				packChannels.nextDecree,
				packChannels.adminCommands,
				packChannels.arcadeRules,
				packChannels.arcadeChallenges,
			].sort()
		);
	});

	// ⚠️ THE R2 GUARD, create-path half. Both parents are CategoryChannel, so
	// the compiler cannot tell them apart and a swapped parent.id is a silent
	// misfile. CHANNEL_SPECS.categoryField protects every OTHER consumer;
	// createChannels passes the parent literally, so only a test protects it.
	it("files the eight homebase channels and the two arcade channels under their own categories", async () => {
		const { textChannels } = await runFreshInstall();

		const homebaseParent = `cat-${rokCommanderCopy.setup.categoryName}`;
		const arcadeParent = `cat-${rokCommanderCopy.setup.gamesCategoryName}`;
		const parentOf = (name: string) => textChannels.find((channel) => channel.name === name)?.parent;

		for (const name of [
			packChannels.intro,
			packChannels.commands,
			packChannels.leaderboard,
			packChannels.schedule,
			packChannels.announcements,
			packChannels.admin,
			packChannels.nextDecree,
			packChannels.adminCommands,
		]) {
			expect(parentOf(name), `${name} belongs under the homebase category`).toBe(homebaseParent);
		}

		for (const name of [packChannels.arcadeRules, packChannels.arcadeChallenges]) {
			expect(parentOf(name), `${name} belongs under the arcade category`).toBe(arcadeParent);
		}

		// No channel may land unparented or under a third parent, which a typo
		// in a parent id would otherwise produce without failing either loop.
		expect(textChannels.filter((channel) => channel.parent === homebaseParent)).toHaveLength(8);
		expect(textChannels.filter((channel) => channel.parent === arcadeParent)).toHaveLength(2);
	});

	// The three postures createChannels mints, expressed as what @everyone and
	// the guild owner get. The bot's own entry is asserted separately: it is
	// byte identical on all ten, so folding it in here would make one legitimate
	// change to botSelfOverwrite fail ten assertions instead of one.
	const POSTURES = {
		// Members read, only the bot writes.
		public: {
			everyone: { id: EVERYONE_ID, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
			owner: { id: OWNER_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
		},
		// 📜introductions, the one member-writable channel: public MINUS the
		// SendMessages deny. A member who cannot post here cannot answer the
		// greeter's icebreaker and cannot clear Discord's Onboarding gate, so
		// silently tightening this to `public` breaks onboarding, not just chat.
		intro: {
			everyone: { id: EVERYONE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
			owner: { id: OWNER_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
		},
		// Hidden from members outright.
		admin: {
			everyone: { id: EVERYONE_ID, deny: [PermissionFlagsBits.ViewChannel] },
			owner: {
				id: OWNER_ID,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
			},
		},
	} as const;

	const EXPECTED_POSTURES: Array<[string, keyof typeof POSTURES]> = [
		[packChannels.intro, "intro"],
		[packChannels.commands, "public"],
		[packChannels.leaderboard, "public"],
		[packChannels.schedule, "public"],
		[packChannels.announcements, "public"],
		[packChannels.admin, "admin"],
		[packChannels.nextDecree, "public"],
		[packChannels.adminCommands, "admin"],
		// Both arcade channels are member facing and bot written: the rules card
		// is a pinned reference and the board is a wall of bot posted cards, so
		// member SendMessages would only bury them. Challenges are issued by
		// command, never by typing here, so the lockdown costs nothing.
		[packChannels.arcadeRules, "public"],
		[packChannels.arcadeChallenges, "public"],
	];

	it("gives every channel the overwrite array its privacy posture requires", async () => {
		const { textChannels } = await runFreshInstall();

		for (const [name, posture] of EXPECTED_POSTURES) {
			const created = textChannels.find((channel) => channel.name === name);
			expect(created, `${name} was never created`).toBeDefined();

			const overwrites = created!.permissionOverwrites ?? [];
			expect(overwrites.find((entry) => entry.id === EVERYONE_ID), `${name} @everyone overwrite`).toEqual(POSTURES[posture].everyone);
			expect(overwrites.find((entry) => entry.id === OWNER_ID), `${name} owner overwrite`).toEqual(POSTURES[posture].owner);
		}
	});

	it("carries the bot self overwrite on all ten channels", async () => {
		// Not decoration. Without it the @everyone SendMessages deny suppresses
		// the bot's OWN posts on a public channel, and the @everyone ViewChannel
		// deny hides an admin channel from the bot entirely. Both fail at post
		// time, long after setup reported success, so the failure surfaces as a
		// missing intro embed rather than as a setup error.
		const { textChannels } = await runFreshInstall();
		expect(textChannels).toHaveLength(10);

		for (const created of textChannels) {
			const botEntry = (created.permissionOverwrites ?? []).find((entry) => entry.id === BOT_ID);
			expect(botEntry, `${created.name} is missing the bot self overwrite`).toBeDefined();
			expect(botEntry!.allow, `${created.name} bot ViewChannel`).toContain(PermissionFlagsBits.ViewChannel);
			expect(botEntry!.allow, `${created.name} bot SendMessages`).toContain(PermissionFlagsBits.SendMessages);
		}
	});

	it("persists every id it just created, both categories included, in ONE payload", async () => {
		// ⚠️ THE POINT OF THIS TEST IS THE ABSENCE OF AN EXCEPTION. The payload
		// used to skip nextDecreeChannelId and lean on the next boot's repair
		// sweep to adopt the orphan, which left NextUpBoard reading null and
		// posting nothing for the whole window between /setup and that reboot.
		// Closed 2026-08-12. Asserting the full set, rather than only the ids a
		// given change happened to add, is what stops a twelfth channel from
		// quietly reintroducing the same gap.
		await runFreshInstall();

		expect(guildConfigMock.create).toHaveBeenCalledOnce();
		const [payload] = guildConfigMock.create.mock.calls[0] as [Record<string, unknown>];

		expect(payload.categoryId).toBe(`cat-${rokCommanderCopy.setup.categoryName}`);
		expect(payload.gamesCategoryId).toBe(`cat-${rokCommanderCopy.setup.gamesCategoryName}`);
		expect(payload.arcadeRulesChannelId).toBe(`new-${packChannels.arcadeRules}`);
		expect(payload.arcadeChallengesChannelId).toBe(`new-${packChannels.arcadeChallenges}`);
		expect(payload.adminCommandsChannelId).toBe(`new-${packChannels.adminCommands}`);
		expect(payload.nextDecreeChannelId).toBe(`new-${packChannels.nextDecree}`);
		expect(payload.introChannelId).toBe(`new-${packChannels.intro}`);
		expect(payload.commandsChannelId).toBe(`new-${packChannels.commands}`);
		expect(payload.leaderboardChannelId).toBe(`new-${packChannels.leaderboard}`);
		expect(payload.scheduleChannelId).toBe(`new-${packChannels.schedule}`);
		expect(payload.announcementsChannelId).toBe(`new-${packChannels.announcements}`);
		expect(payload.adminChannelId).toBe(`new-${packChannels.admin}`);

		// Structural backstop for the same failure: every channel createChannels
		// built has to appear in the payload under its own configField. A new
		// spec that lands without a persist line fails HERE even if nobody thinks
		// to add an assertion for it above, which is exactly how the last one got
		// through. CHANNEL_FIELDS is the derived list, so it grows on its own.
		for (const field of GuildSetupManager.CHANNEL_FIELDS) {
			expect(payload[field], `${field} was created but never persisted`).toBeDefined();
		}
	});
});

// ── refreshIntroEmbeds (boot time copy refresh) ─────────────────────────
// What: edits the six stored intro messages in place on every boot so
//       copy-pack changes ship without forcing a rebuild. If the stored
//       anchor is missing, reposts a fresh intro and persists the new id.
//       If introMessageIds is absent entirely (legacy row), reposts all six.
// Who:  main.ts ready handler, after ensureHomebase completes per guild.
// Where: relies on resolveIntroEmbed to pick the correct embed per spec and
//        on the copy packs (@base/copy/packs) for the rendered copy.
describe("GuildSetupManager.refreshIntroEmbeds", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// refreshIntroEmbeds compares each stored intro message against a freshly
	// resolved embed + component pair (the private resolveIntroEmbed /
	// resolveIntroComponents / inviteCardComponents statics) and only edits in
	// place when the embed copy matches but the components drifted. To drive
	// that path deterministically we build the stored messages from those very
	// builders, so "copy is current" is a real, exact match rather than a mock.
	// Test files are excluded from the tsc build, so reaching the private
	// statics through a cast is compile-safe.
	const internals = GuildSetupManager as unknown as {
		resolveIntroEmbed(field: string, guild: Guild, adminRoleId: string | null, config: unknown): { data: unknown };
		resolveIntroComponents(field: string): { toJSON(): unknown }[] | null;
		inviteCardComponents(): { toJSON(): unknown }[];
	};

	// minimal guild, refreshIntroEmbeds reads guild.id, guild.ownerId, and
	// guild.client.user.id (the repost + invite-card adopt scans).
	function makeGuildFixture(): Guild {
		return {
			id: "guild-1",
			ownerId: "owner-1",
			client: { user: { id: "bot-1" } },
		} as unknown as Guild;
	}

	// Stale component row: any signature that differs from the real resolved
	// components so componentsAreEquivalent reports drift and the sweep edits in
	// place. Models the 2026-06/2026-07 button relocations on existing guilds.
	const staleComponents = [{ toJSON: () => ({ components: [{ custom_id: "stale-button", style: 2, label: "stale" }] }) }];

	// A stored intro message whose embed matches the current resolved copy for
	// `field` (embedsAreEquivalent → true) but whose components are stale
	// (componentsAreEquivalent → false), i.e. the edit-in-place case.
	function currentIntroMessage(field: string, id: string, edit: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)) {
		return {
			id,
			embeds: [internals.resolveIntroEmbed(field, makeGuildFixture(), null, makeStoredConfig()).data],
			components: staleComponents,
			pinned: true, // introductions is the only pinned channel; true skips the pin backfill
			edit,
		};
	}

	// The standalone invite card (second message on the command-center channel),
	// built current + equivalent so the post-loop card block is a clean no-op in
	// tests that only exercise the per-channel intro sweep.
	function currentInviteCardMessage(id = "msg-invite") {
		return {
			id,
			embeds: [ChannelContent.inviteCard().data],
			components: internals.inviteCardComponents(),
			edit: vi.fn().mockResolvedValue(undefined),
		};
	}

	// TextChannel stand-in that serves messages by id via messages.fetch(id) and
	// returns an empty collection ({ find }) for the {limit} adopt scans. An
	// unknown string id throws Unknown Message (10008) so the caller's catch
	// resolves it to null (the "anchor deleted" case). send is a spy.
	function makeChannel(
		id: string,
		messagesById: Record<string, unknown>,
		send: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ id: `reposted-${id}`, pin: vi.fn().mockResolvedValue(undefined) })
	): TextChannel {
		const ch = Object.create(TextChannel.prototype) as TextChannel;
		Object.assign(ch, {
			id,
			messages: {
				fetch: vi.fn(async (arg: unknown) => {
					// options fetch (adopt scan) → empty collection, nothing to adopt.
					if (typeof arg !== "string") return { find: () => undefined };
					if (arg in messagesById) return messagesById[arg];
					const err = Object.create(DiscordAPIError.prototype);
					Object.assign(err, { code: 10008, message: "Unknown Message" });
					throw err;
				}),
			},
			send,
		});
		return ch;
	}

	it("edits every stored intro in place when anchors resolve and only the button layout drifted", async () => {
		// Every stored anchor resolves and the embed copy is current, but the
		// stored component rows are stale (button relocations). refreshIntroEmbeds
		// must edit each intro IN PLACE, no reposts, no config write. The
		// schedule anchor always edits in place regardless of drift.
		const storedIntroIds = {
			introChannelId: "msg-intro",
			commandsChannelId: "msg-commands",
			leaderboardChannelId: "msg-leaderboard",
			scheduleChannelId: "msg-schedule",
			announcementsChannelId: "msg-announcements",
			adminChannelId: "msg-admin",
			inviteCardId: "msg-invite",
		};
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig({ introMessageIds: storedIntroIds }));

		const edits = {
			introChannelId: vi.fn().mockResolvedValue(undefined),
			commandsChannelId: vi.fn().mockResolvedValue(undefined),
			leaderboardChannelId: vi.fn().mockResolvedValue(undefined),
			scheduleChannelId: vi.fn().mockResolvedValue(undefined),
			announcementsChannelId: vi.fn().mockResolvedValue(undefined),
			adminChannelId: vi.fn().mockResolvedValue(undefined),
		};

		const channels: Record<string, TextChannel> = {
			"ch-intro": makeChannel("ch-intro", { "msg-intro": currentIntroMessage("introChannelId", "msg-intro", edits.introChannelId) }),
			"ch-commands": makeChannel("ch-commands", {
				"msg-commands": currentIntroMessage("commandsChannelId", "msg-commands", edits.commandsChannelId),
				"msg-invite": currentInviteCardMessage(),
			}),
			"ch-leaderboard": makeChannel("ch-leaderboard", { "msg-leaderboard": currentIntroMessage("leaderboardChannelId", "msg-leaderboard", edits.leaderboardChannelId) }),
			// the schedule branch edits its anchor directly, without the equivalence check.
			"ch-schedule": makeChannel("ch-schedule", { "msg-schedule": { id: "msg-schedule", edit: edits.scheduleChannelId } }),
			"ch-announcements": makeChannel("ch-announcements", { "msg-announcements": currentIntroMessage("announcementsChannelId", "msg-announcements", edits.announcementsChannelId) }),
			"ch-admin": makeChannel("ch-admin", { "msg-admin": currentIntroMessage("adminChannelId", "msg-admin", edits.adminChannelId) }),
		};

		const client = makeClient({ selfId: "bot-1", fetchChannel: async (id) => channels[id] ?? null });

		const summary = await GuildSetupManager.refreshIntroEmbeds(client, makeGuildFixture());

		// all six intros edited in place (5 via drift + schedule always); the
		// invite card is current so it is a no-op, and nothing reposts.
		expect(summary).toEqual({ edited: 6, reposted: 0 });
		for (const edit of Object.values(edits)) expect(edit).toHaveBeenCalledOnce();
		// no persist needed when every anchor resolves and only components moved.
		expect(guildConfigMock.update).not.toHaveBeenCalled();
	});

	// ⚠️ REGRESSION GUARD for the repost-forever bug.
	// The sweep resolves each anchor out of the nextIntroIds object, NOT out of
	// the stored row directly. A channel missing from that initializer therefore
	// reads as "nothing posted yet" on EVERY boot: it reposts its intro, persists
	// a fresh id, and then never reads that id back. Nothing errors, the write
	// succeeds, and the guild quietly accumulates a duplicate card per boot.
	// Both ARCADE GAMES cards did exactly this from the moment their specs joined
	// CHANNEL_SPECS until the initializer was derived from CHANNEL_FIELDS. If
	// anyone hand lists those keys again, this test goes red.
	it("reads back the ARCADE GAMES anchors instead of reposting them on every boot", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(
			makeStoredConfig({
				introMessageIds: {
					arcadeRulesChannelId: "msg-arcaderules",
					arcadeChallengesChannelId: "msg-arcadechallenges",
				},
			})
		);

		const sends = {
			rules: vi.fn().mockResolvedValue({ id: "reposted-rules", pin: vi.fn().mockResolvedValue(undefined) }),
			challenges: vi.fn().mockResolvedValue({ id: "reposted-challenges", pin: vi.fn().mockResolvedValue(undefined) }),
		};

		const channels: Record<string, TextChannel> = {
			"ch-arcaderules": makeChannel(
				"ch-arcaderules",
				{ "msg-arcaderules": currentIntroMessage("arcadeRulesChannelId", "msg-arcaderules") },
				sends.rules
			),
			"ch-arcadechallenges": makeChannel(
				"ch-arcadechallenges",
				{ "msg-arcadechallenges": currentIntroMessage("arcadeChallengesChannelId", "msg-arcadechallenges") },
				sends.challenges
			),
		};

		const client = makeClient({ selfId: "bot-1", fetchChannel: async (id) => channels[id] ?? null });

		const summary = await GuildSetupManager.refreshIntroEmbeds(client, makeGuildFixture());

		// The anchors resolved, so neither card was reposted and neither channel
		// was sent to at all.
		expect(summary.reposted).toBe(0);
		expect(sends.rules).not.toHaveBeenCalled();
		expect(sends.challenges).not.toHaveBeenCalled();
	});

	it("reposts a fresh intro when the stored anchor is missing (10008)", async () => {
		// stored anchors exist but the announcements fetch throws Unknown Message
		// (10008). the refresh loop must repost a fresh intro and persist the new
		// id under introMessageIds so the next boot edits in place. The other five
		// intros edit in place (copy current, components drifted).
		const storedIntroIds = {
			introChannelId: "msg-intro",
			commandsChannelId: "msg-commands",
			leaderboardChannelId: "msg-leaderboard",
			scheduleChannelId: "msg-schedule",
			announcementsChannelId: "msg-gone",
			adminChannelId: "msg-admin",
			inviteCardId: "msg-invite",
		};
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig({ introMessageIds: storedIntroIds }));
		guildConfigMock.update.mockResolvedValue(undefined);

		const channels: Record<string, TextChannel> = {
			"ch-intro": makeChannel("ch-intro", { "msg-intro": currentIntroMessage("introChannelId", "msg-intro") }),
			"ch-commands": makeChannel("ch-commands", {
				"msg-commands": currentIntroMessage("commandsChannelId", "msg-commands"),
				"msg-invite": currentInviteCardMessage(),
			}),
			"ch-leaderboard": makeChannel("ch-leaderboard", { "msg-leaderboard": currentIntroMessage("leaderboardChannelId", "msg-leaderboard") }),
			"ch-schedule": makeChannel("ch-schedule", { "msg-schedule": { id: "msg-schedule", edit: vi.fn().mockResolvedValue(undefined) } }),
			// announcements anchor "msg-gone" is not served → fetch throws 10008 →
			// repost path posts a fresh intro whose id we assert on.
			"ch-announcements": makeChannel("ch-announcements", {}, vi.fn().mockResolvedValue({ id: "msg-announcements-fresh", pin: vi.fn().mockResolvedValue(undefined) })),
			"ch-admin": makeChannel("ch-admin", { "msg-admin": currentIntroMessage("adminChannelId", "msg-admin") }),
		};

		const client = makeClient({ selfId: "bot-1", fetchChannel: async (id) => channels[id] ?? null });

		const summary = await GuildSetupManager.refreshIntroEmbeds(client, makeGuildFixture());

		expect(summary).toEqual({ edited: 5, reposted: 1 });
		// persisted the new announcements id alongside the preserved ids for the
		// other slots.
		expect(guildConfigMock.update).toHaveBeenCalledWith("guild-1", {
			introMessageIds: expect.objectContaining({ announcementsChannelId: "msg-announcements-fresh" }),
		});
	});

	it("reposts the intro channels but NOT schedule when introMessageIds is absent (legacy row)", async () => {
		// legacy row: introMessageIds never set. Every channel with a stored id
		// and no anchor reposts a fresh intro, EXCEPT the schedule channel, which
		// defers to ScheduleBoard's own recovery and never reposts here. The
		// standalone invite card also posts fresh (first time on this guild).
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig({ introMessageIds: null }));
		guildConfigMock.update.mockResolvedValue(undefined);

		// no anchors served anywhere → every eligible channel reposts via send.
		const channels: Record<string, TextChannel> = {
			"ch-intro": makeChannel("ch-intro", {}),
			"ch-commands": makeChannel("ch-commands", {}),
			"ch-leaderboard": makeChannel("ch-leaderboard", {}),
			"ch-schedule": makeChannel("ch-schedule", {}),
			"ch-announcements": makeChannel("ch-announcements", {}),
			"ch-admin": makeChannel("ch-admin", {}),
		};

		const client = makeClient({ selfId: "bot-1", fetchChannel: async (id) => channels[id] ?? null });

		const summary = await GuildSetupManager.refreshIntroEmbeds(client, makeGuildFixture());

		// intro, commands, leaderboard, announcements, admin repost (5) + the
		// invite card (1) = 6. schedule does NOT repost (deferred). Nothing edits.
		expect(summary).toEqual({ edited: 0, reposted: 6 });

		expect(guildConfigMock.update).toHaveBeenCalledOnce();
		const [, payload] = guildConfigMock.update.mock.calls[0] as [string, Record<string, unknown>];
		const ids = payload.introMessageIds as Record<string, string | null>;
		expect(ids.introChannelId).toBe("reposted-ch-intro");
		expect(ids.commandsChannelId).toBe("reposted-ch-commands");
		expect(ids.leaderboardChannelId).toBe("reposted-ch-leaderboard");
		expect(ids.announcementsChannelId).toBe("reposted-ch-announcements");
		expect(ids.adminChannelId).toBe("reposted-ch-admin");
		// schedule never reposts on a legacy row (it defers to ScheduleBoard), so
		// its intro id stays null and scheduleMessageId is not written.
		expect(ids.scheduleChannelId).toBeNull();
		expect(payload).not.toHaveProperty("scheduleMessageId");
		// the standalone invite card was posted on the command-center channel and tracked.
		expect(ids.inviteCardId).toBe("reposted-ch-commands");
	});

	it("skips the edit on 50005 (author mismatch) without reposting", async () => {
		// 50005 means our stored id points at a message authored by someone else,
		// corruption scenario. The edit is attempted (copy current, components
		// drifted) but Discord rejects it; we must NOT repost (that would
		// duplicate content) and must NOT persist. Bail so ensureHomebase can
		// detect ownership drift on its next pass.
		const storedIntroIds = {
			introChannelId: "msg-intro",
			commandsChannelId: "msg-commands",
			leaderboardChannelId: "msg-leaderboard",
			scheduleChannelId: "msg-schedule",
			announcementsChannelId: "msg-foreign",
			adminChannelId: "msg-admin",
			inviteCardId: "msg-invite",
		};
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig({ introMessageIds: storedIntroIds }));

		const badEdit = vi.fn().mockImplementation(async () => {
			const err = Object.create(DiscordAPIError.prototype);
			Object.assign(err, { code: 50005, message: "Cannot edit a message authored by another user" });
			throw err;
		});
		// announcements send must never fire, a repost would duplicate content.
		const announcementsSend = vi.fn();

		const channels: Record<string, TextChannel> = {
			"ch-intro": makeChannel("ch-intro", { "msg-intro": currentIntroMessage("introChannelId", "msg-intro") }),
			"ch-commands": makeChannel("ch-commands", {
				"msg-commands": currentIntroMessage("commandsChannelId", "msg-commands"),
				"msg-invite": currentInviteCardMessage(),
			}),
			"ch-leaderboard": makeChannel("ch-leaderboard", { "msg-leaderboard": currentIntroMessage("leaderboardChannelId", "msg-leaderboard") }),
			"ch-schedule": makeChannel("ch-schedule", { "msg-schedule": { id: "msg-schedule", edit: vi.fn().mockResolvedValue(undefined) } }),
			"ch-announcements": makeChannel("ch-announcements", { "msg-foreign": currentIntroMessage("announcementsChannelId", "msg-foreign", badEdit) }, announcementsSend),
			"ch-admin": makeChannel("ch-admin", { "msg-admin": currentIntroMessage("adminChannelId", "msg-admin") }),
		};

		const client = makeClient({ selfId: "bot-1", fetchChannel: async (id) => channels[id] ?? null });

		const summary = await GuildSetupManager.refreshIntroEmbeds(client, makeGuildFixture());

		// five edited (intro, commands, leaderboard, schedule, admin);
		// announcements attempted an edit that threw 50005 and was skipped.
		expect(summary).toEqual({ edited: 5, reposted: 0 });
		expect(announcementsSend).not.toHaveBeenCalled();
		expect(guildConfigMock.update).not.toHaveBeenCalled();
	});

	it("returns zero summary when no GuildConfig exists", async () => {
		// defensive: if ensureHomebase somehow missed this guild, the refresh
		// loop is a no op instead of crashing.
		guildConfigMock.findByGuildId.mockResolvedValue(null);
		const client = makeClient({ selfId: "bot-1" });

		const summary = await GuildSetupManager.refreshIntroEmbeds(client, makeGuildFixture());

		expect(summary).toEqual({ edited: 0, reposted: 0 });
		expect(guildConfigMock.update).not.toHaveBeenCalled();
	});
});

// ── applyAdminRole ─────────────────────────────────────────────────────────
// ⚠️ THIS BLOCK EXISTS BECAUSE THE FUNCTION HAD NO TESTS AT ALL, and that is
// how it shipped a real gap: it fetched a HAND WRITTEN list of seven channels
// which never included nextDecreeChannelId, so the admin role was never granted
// on 🔜upcoming-events. Nothing errored, because every grant is optional
// chained; the channel simply stayed ungranted forever.
//
// So the assertion is a COMPLETENESS check against the spec list rather than a
// behavioural spot check of one grant. A spot check passes happily while the
// list is one short, which is the only failure mode this function actually has.
describe("GuildSetupManager.applyAdminRole", () => {
	function grantHarness() {
		const created: Record<string, Record<string, boolean>> = {};
		const channelFor = (id: string) => ({
			id,
			permissionOverwrites: {
				create: vi.fn(async (_roleId: string, perms: Record<string, boolean>) => {
					created[id] = perms;
				}),
			},
			isTextBased: () => false,
		});
		const guild = {
			id: "guild-1",
			channels: { fetch: vi.fn(async (id: string) => channelFor(id)) },
		} as unknown as Guild;
		return { guild, created };
	}

	beforeEach(() => {
		vi.clearAllMocks();
		guildConfigMock.findByGuildId.mockResolvedValue(makeStoredConfig());
		guildConfigMock.update.mockResolvedValue(undefined);
	});

	it("grants the admin role on EVERY managed channel, not a hand picked subset", async () => {
		const { guild, created } = grantHarness();
		await GuildSetupManager.applyAdminRole(guild, {
			guildId: "guild-1",
			adminRoleId: "role-admin",
			memberRoleId: "role-member",
			ownerId: "owner-1",
		} as never);

		const stored = makeStoredConfig() as unknown as Record<string, string>;
		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const id = stored[spec.configField];
			expect(created[id], `${spec.configField} was never granted`).toBeDefined();
			expect(created[id].ViewChannel).toBe(true);
			expect(created[id].SendMessages).toBe(true);
		}
	});

	it("grants on BOTH managed categories", async () => {
		const { guild, created } = grantHarness();
		await GuildSetupManager.applyAdminRole(guild, {
			guildId: "guild-1",
			adminRoleId: "role-admin",
			memberRoleId: "role-member",
			ownerId: "owner-1",
		} as never);

		// The arcade category is as much the bot's surface as the homebase one, and
		// an admin who cannot see it cannot manage the games inside it.
		expect(created["cat-1"]).toBeDefined();
		expect(created["games-cat-1"]).toBeDefined();
	});

	it("gives admin channels ReadMessageHistory and public ones not", async () => {
		// The difference is what makes an admin-only channel readable rather than
		// merely visible, so it is shaped by the spec's kind rather than by a
		// second hand written list of which channels are private.
		const { guild, created } = grantHarness();
		await GuildSetupManager.applyAdminRole(guild, {
			guildId: "guild-1",
			adminRoleId: "role-admin",
			memberRoleId: "role-member",
			ownerId: "owner-1",
		} as never);

		expect(created["ch-admin"].ReadMessageHistory).toBe(true);
		expect(created["ch-arcaderules"].ReadMessageHistory).toBeUndefined();
	});
});
