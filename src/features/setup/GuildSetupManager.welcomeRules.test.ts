import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType, Collection, TextChannel, VoiceChannel, type Client, type Guild } from "discord.js";

vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: { findByGuildId: vi.fn(), create: vi.fn(), update: vi.fn(), deleteByGuildId: vi.fn() },
}));
vi.mock("./adminLog.js", () => ({ adminLog: { emit: vi.fn(), emitFor: vi.fn(), write: vi.fn() } }));

import { GuildSetupManager } from "./GuildSetupManager.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { adminLog } from "./adminLog.js";
import { setupCopy } from "./setupCopy.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { RULES_EDIT_CUSTOM_ID } from "./rulesContent.js";

// ── 👋welcome and 📘rules through GuildSetupManager (2026-10 item 247 Phase 2) ──
// What:  every build path for the two new channels: a fresh install that builds
//        both, a fresh install and a boot that ADOPT the server's own channels
//        instead, the intro sweep that must not post over the owner's content, and
//        the drift rename that must leave an adopted channel's name alone.
// Why:   adoption is the one place setup reaches outside its own categories, so a
//        mistake moves or writes into a channel the owner made. Each case pins
//        either "no duplicate" or "no write over the owner's text". Post-launch plan
//        item 2 adds #spawn-point, Discord's system channel first (taken IN PLACE
//        when it is the server's main chat), and the boot reconcile that moves a
//        guild off Dero's own 👋welcome.

const store = guildConfigStore as unknown as Record<"findByGuildId" | "create" | "update", ReturnType<typeof vi.fn>>;
const channels = rokCommanderCopy.setup.channels;
const copy = rokCommanderCopy.channelContent;
const BOT = "bot-1";
const NOTICE_BOARD = `cat-${rokCommanderCopy.setup.categoryName}`;

type Sent = { embeds: Array<{ data: { title?: string; description?: string } }>; components?: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }> };

// A text channel fake that records sends, moves and overwrites, with the recent
// messages the adoption content gate reads.
function textChannel(id: string, name: string, options: { parentId?: string | null; messages?: Array<{ author: { id: string } }> } = {}) {
	const channel = Object.create(TextChannel.prototype) as TextChannel & Record<"send" | "setParent" | "setName", ReturnType<typeof vi.fn>>;
	const recent = new Collection((options.messages ?? []).map((message, index) => [`m${index}`, { embeds: [], components: [], ...message }]));
	Object.assign(channel, {
		id,
		name,
		guildId: "guild-1",
		parentId: options.parentId ?? null,
		rawPosition: 0,
		send: vi.fn(async () => ({ id: `post-${id}`, pin: vi.fn() })),
		setParent: vi.fn(async () => channel),
		setName: vi.fn(async () => channel),
		permissionOverwrites: { cache: new Map(), set: vi.fn(async () => channel) },
		messages: { fetch: vi.fn(async () => recent) },
	});
	return channel;
}

const sentOf = (channel: { send: ReturnType<typeof vi.fn> }): Sent => channel.send.mock.calls[0]![0] as Sent;
const buttonIds = (sent: Sent): string[] => (sent.components ?? []).flatMap((row) => row.toJSON().components.map((c) => c.custom_id ?? ""));

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	store.create.mockResolvedValue(undefined);
	store.update.mockResolvedValue(undefined);
});

// ── the fresh install ───────────────────────────────────────────────────────

describe("a fresh install", () => {
	function installGuild(own: unknown[] = []) {
		const created = new Map<string, ReturnType<typeof textChannel>>();
		const create = vi.fn(async (opts: { name: string; type: number }) => {
			if (opts.type === ChannelType.GuildCategory) return { id: `cat-${opts.name}` };
			if (opts.type === ChannelType.GuildVoice) {
				const room = Object.create(VoiceChannel.prototype) as VoiceChannel;
				return Object.assign(room, { id: `new-${opts.name}`, send: vi.fn(async () => ({ id: `card-${opts.name}` })) });
			}
			const channel = textChannel(`new-${opts.name}`, opts.name);
			created.set(opts.name, channel);
			return channel;
		});
		const guild = {
			id: "guild-1",
			ownerId: "owner-1",
			roles: { everyone: { id: "everyone" } },
			client: { user: { id: BOT } },
			channels: { create, fetch: vi.fn(async () => null), cache: new Map(own.map((channel, index) => [`own${index}`, channel])) },
		} as unknown as Guild;
		return { guild, create, created };
	}

	async function install(own: unknown[] = []) {
		store.findByGuildId.mockResolvedValue(null);
		const rig = installGuild(own);
		await GuildSetupManager.autoSetup(rig.guild, { guildId: "guild-1", ownerId: "owner-1" });
		const payload = store.create.mock.calls[0]![0] as Record<string, unknown> & { introMessageIds: Record<string, string | null> };
		return { ...rig, payload };
	}

	it("builds 👋welcome and 📘rules under the notice board with the welcome intro and the rules post", async () => {
		const { created, payload } = await install();

		const welcome = created.get(channels.welcome)!;
		const rules = created.get(channels.rules)!;
		expect(welcome).toBeDefined();
		expect(rules).toBeDefined();
		expect(sentOf(welcome).embeds[0]!.data.title).toBe(copy.welcome.title);
		expect(sentOf(rules).embeds[0]!.data.description).toBe(copy.rules.defaultMarkdown);
		expect(buttonIds(sentOf(rules))).toEqual([RULES_EDIT_CUSTOM_ID]);

		expect(payload.welcomeChannelId).toBe(welcome.id);
		expect(payload.rulesChannelId).toBe(rules.id);
		expect(payload.adoptedChannelIds).toEqual([]);
		expect(payload.introMessageIds.welcomeChannelId).toBe(`post-${welcome.id}`);
		expect(payload.introMessageIds.rulesChannelId).toBe(`post-${rules.id}`);
	});

	it("adopts the server's own channels instead of building duplicates, and never posts over member content", async () => {
		const ownWelcome = textChannel("own-welcome", "welcome", { parentId: "cat-lobby", messages: [{ author: { id: "member-9" } }] });
		const ownRules = textChannel("own-rules", "server-rules", { parentId: "cat-lobby" });
		const { create, payload } = await install([ownWelcome, ownRules]);

		const builtNames = create.mock.calls.map((call) => (call[0] as { name: string }).name);
		expect(builtNames).not.toContain(channels.welcome);
		expect(builtNames).not.toContain(channels.rules);
		expect(ownWelcome.setParent).toHaveBeenCalledWith(NOTICE_BOARD, expect.objectContaining({ lockPermissions: false }));
		expect(ownRules.setParent).toHaveBeenCalledWith(NOTICE_BOARD, expect.objectContaining({ lockPermissions: false }));

		expect(payload.welcomeChannelId).toBe("own-welcome");
		expect(payload.rulesChannelId).toBe("own-rules");
		expect(payload.adoptedChannelIds).toEqual(["own-welcome", "own-rules"]);
		// Members already wrote in the welcome channel, so Dero posts no intro there;
		// the empty rules channel takes Dero's rules post.
		expect(ownWelcome.send).not.toHaveBeenCalled();
		expect(payload.introMessageIds.welcomeChannelId).toBeNull();
		expect(sentOf(ownRules).embeds[0]!.data.title).toBe(copy.rules.title);
	});
});

// ── post-launch plan item 2: #spawn-point and the system channel ─────────────

describe("a fresh install on a server with its own arrivals channel", () => {
	function installGuild(own: TextChannel[], systemChannelId: string | null) {
		const create = vi.fn(async (opts: { name: string; type: number }) => {
			if (opts.type === ChannelType.GuildCategory) return { id: `cat-${opts.name}` };
			if (opts.type === ChannelType.GuildVoice) {
				const room = Object.create(VoiceChannel.prototype) as VoiceChannel;
				return Object.assign(room, { id: `new-${opts.name}`, send: vi.fn(async () => ({ id: `card-${opts.name}` })) });
			}
			return textChannel(`new-${opts.name}`, opts.name);
		});
		const cache = new Map(own.map((channel) => [channel.id, channel]));
		return {
			guild: { id: "guild-1", ownerId: "owner-1", systemChannelId, roles: { everyone: { id: "everyone" } }, client: { user: { id: BOT } }, channels: { create, fetch: vi.fn(async () => null), cache } } as unknown as Guild,
			create,
		};
	}

	async function install(own: TextChannel[], systemChannelId: string | null = null) {
		store.findByGuildId.mockResolvedValue(null);
		const rig = installGuild(own, systemChannelId);
		await GuildSetupManager.autoSetup(rig.guild, { guildId: "guild-1", ownerId: "owner-1" });
		return { ...rig, payload: store.create.mock.calls[0]![0] as Record<string, unknown> };
	}

	it("adopts #spawn-point as the welcome log, moved into the notice board, and logs the decision", async () => {
		const spawn = textChannel("spawn", "spawn-point", { parentId: "cat-lobby" });
		const { create, payload } = await install([spawn]);

		expect(create.mock.calls.map((call) => (call[0] as { name: string }).name)).not.toContain(channels.welcome);
		expect(spawn.setParent).toHaveBeenCalledWith(NOTICE_BOARD, expect.objectContaining({ lockPermissions: false }));
		expect(payload.welcomeChannelId).toBe("spawn");
		expect(payload.adoptedChannelIds).toEqual(["spawn"]);
		expect(adminLog.emit).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "config.change", actor: { source: "dero" }, payload: { subject: setupCopy.adminLog.subjects.welcomeLog, detail: setupCopy.adminLog.adopted("spawn") } })
		);
	});

	it("takes the system channel before a name match", async () => {
		const spawn = textChannel("spawn", "spawn-point");
		const arrivals = textChannel("arrivals", "arrivals");
		const { payload } = await install([arrivals, spawn], "spawn");
		expect(payload.welcomeChannelId).toBe("spawn");
		expect(arrivals.setParent).not.toHaveBeenCalled();
	});

	it("takes a system channel that is the server's main chat IN PLACE: never moved, its permissions never touched", async () => {
		const general = textChannel("general", "general", { parentId: "cat-lobby", messages: [{ author: { id: "member-9" } }] });
		const { create, payload } = await install([general], "general");

		expect(create.mock.calls.map((call) => (call[0] as { name: string }).name)).not.toContain(channels.welcome);
		expect(general.setParent).not.toHaveBeenCalled();
		expect(general.permissionOverwrites.set).not.toHaveBeenCalled();
		expect(payload.welcomeChannelId).toBe("general");
		expect(payload.adoptedChannelIds).toEqual(["general"]);
		// Members already chat there, so no intro lands over them.
		expect(general.send).not.toHaveBeenCalled();
	});
});

describe("the boot reconcile on a guild whose welcome log is Dero's own 👋welcome", () => {
	const ALL_IDS = Object.fromEntries(
		GuildSetupManager.CHANNEL_FIELDS.filter((field) => field !== "welcomeChannelId").map((field) => [field, `ch-${field}`])
	);

	async function boot(own: TextChannel[], options: { row?: Record<string, unknown>; systemChannelId?: string | null; features?: string[] } = {}) {
		const derosWelcome = textChannel("ch-welcome", channels.welcome, { parentId: "cat-1" });
		const row = {
			guildId: "guild-1",
			categoryId: "cat-1",
			gamesCategoryId: "games-cat-1",
			...ALL_IDS,
			welcomeChannelId: "ch-welcome",
			adoptedChannelIds: [],
			introMessageIds: { welcomeChannelId: "intro-1", rulesChannelId: "intro-2" },
			scheduleMessageId: null,
			adminRoleId: null,
			memberRoleId: "role-member",
			setupComplete: true,
			...options.row,
		};
		store.findByGuildId.mockResolvedValue(row);
		const category = { id: "cat-1", type: ChannelType.GuildCategory, children: { cache: { find: () => undefined } } };
		const present = new Map<string, unknown>(Object.values(ALL_IDS).map((id) => [id, { id }]));
		present.set("cat-1", category);
		present.set("games-cat-1", { id: "games-cat-1", type: ChannelType.GuildCategory });
		present.set("ch-welcome", derosWelcome);
		for (const channel of own) present.set(channel.id, channel);
		const guild = {
			id: "guild-1",
			ownerId: "owner-1",
			systemChannelId: options.systemChannelId ?? null,
			features: options.features ?? [],
			roles: { everyone: { id: "everyone" } },
			client: { user: { id: BOT } },
			channels: {
				create: vi.fn(async (opts: { name: string }) => textChannel(`new-${opts.name}`, opts.name)),
				fetch: vi.fn(async (id: string) => present.get(id) ?? null),
				cache: new Map<string, unknown>([["ch-welcome", derosWelcome], ...own.map((channel): [string, unknown] => [channel.id, channel])]),
			},
		} as unknown as Guild;
		const client = { user: { id: BOT }, channels: { fetch: vi.fn(async () => null) } } as unknown as Client;
		await GuildSetupManager.ensureHomebase(client, guild);
		return { derosWelcome };
	}

	const welcomeWrites = () => store.update.mock.calls.filter((call) => "welcomeChannelId" in (call[1] as object)).map((call) => call[1] as Record<string, unknown>);

	it("moves the welcome log to #spawn-point and demotes 👋welcome to a plain channel, deleting and editing nothing in it", async () => {
		const spawn = textChannel("spawn", "spawn-point", { parentId: null });
		const { derosWelcome } = await boot([spawn]);

		expect(spawn.setParent).toHaveBeenCalledWith("cat-1", expect.objectContaining({ lockPermissions: false }));
		expect(welcomeWrites()).toEqual([
			{ welcomeChannelId: "spawn", adoptedChannelIds: ["spawn"], introMessageIds: { welcomeChannelId: null, rulesChannelId: "intro-2" } },
		]);
		expect(derosWelcome.send).not.toHaveBeenCalled();
		expect(derosWelcome.setParent).not.toHaveBeenCalled();
		expect(derosWelcome.setName).not.toHaveBeenCalled();
		expect(derosWelcome.permissionOverwrites.set).not.toHaveBeenCalled();
	});

	it("moves it to a system channel that is the server's main chat in place", async () => {
		const general = textChannel("general", "general", { parentId: "cat-lobby" });
		await boot([general], { systemChannelId: "general" });
		expect(general.setParent).not.toHaveBeenCalled();
		expect(welcomeWrites()[0]).toMatchObject({ welcomeChannelId: "general", adoptedChannelIds: ["general"] });
	});

	it("never gates a channel taken in place, even on a Community server whose member role gates the rest", async () => {
		const general = textChannel("general", "general", { parentId: "cat-lobby" });
		await boot([general], { row: { welcomeChannelId: "general", adoptedChannelIds: ["general"] }, features: ["COMMUNITY"] });
		expect(general.permissionOverwrites.set).not.toHaveBeenCalled();
		expect(welcomeWrites()).toEqual([]);
	});

	it("does nothing when the server has no channel of its own, when the slot is already adopted, or when auto heal is off", async () => {
		await boot([]);
		await boot([textChannel("own-welcome", "welcome"), textChannel("spawn", "spawn-point")], { row: { welcomeChannelId: "own-welcome", adoptedChannelIds: ["own-welcome"] } });
		await boot([textChannel("spawn", "spawn-point")], { row: { autoHealEnabled: false } });
		expect(welcomeWrites()).toEqual([]);
	});

	it("never adopts Dero's own renamed welcome channel as if the server had made it", async () => {
		const renamed = textChannel("ch-welcome-2", "welcome");
		await boot([renamed], { row: { channelNames: { welcomeChannelId: "welcome" } } });
		expect(welcomeWrites()).toEqual([]);
	});
});

// ── the boot sweep on an existing guild ─────────────────────────────────────

describe("the boot sweep on a guild set up before welcome and rules existed", () => {
	const OTHER_IDS = Object.fromEntries(
		GuildSetupManager.CHANNEL_FIELDS.filter((field) => field !== "welcomeChannelId" && field !== "rulesChannelId").map((field) => [field, `ch-${field}`])
	);

	function legacyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return { guildId: "guild-1", categoryId: "cat-1", gamesCategoryId: "games-cat-1", ...OTHER_IDS, scheduleMessageId: null, adminRoleId: null, memberRoleId: null, setupComplete: true, ...overrides };
	}

	async function boot(own: unknown[]) {
		store.findByGuildId.mockResolvedValue(legacyRow());
		const category = { id: "cat-1", type: ChannelType.GuildCategory, children: { cache: { find: () => undefined } } };
		const present = new Map<string, unknown>(Object.values(OTHER_IDS).map((id) => [id, { id }]));
		present.set("cat-1", category);
		present.set("games-cat-1", { id: "games-cat-1", type: ChannelType.GuildCategory });
		const create = vi.fn(async (opts: { name: string }) => textChannel(`new-${opts.name}`, opts.name));
		const guild = {
			id: "guild-1",
			ownerId: "owner-1",
			roles: { everyone: { id: "everyone" } },
			client: { user: { id: BOT } },
			channels: { create, fetch: vi.fn(async (id: string) => present.get(id) ?? null), cache: new Map(own.map((channel, index) => [`own${index}`, channel])) },
		} as unknown as Guild;
		const client = { user: { id: BOT }, channels: { fetch: vi.fn(async () => null) } } as unknown as Client;
		const result = await GuildSetupManager.ensureHomebase(client, guild);
		return { result, create, guild };
	}

	it("sweeps the server's #welcome into the notice board, records it as adopted, and writes nothing over member content", async () => {
		const ownWelcome = textChannel("own-welcome", "welcome", { parentId: null, messages: [{ author: { id: "member-9" } }] });
		const { result, create } = await boot([ownWelcome]);

		expect(result.action).toBe("repaired");
		expect(ownWelcome.setParent).toHaveBeenCalledWith("cat-1", expect.objectContaining({ lockPermissions: false }));
		expect(ownWelcome.send).not.toHaveBeenCalled();
		expect(store.update).toHaveBeenCalledWith("guild-1", expect.objectContaining({ welcomeChannelId: "own-welcome", adoptedChannelIds: ["own-welcome"] }));
		// No #rules of its own, so 📘rules is built, and only 📘rules.
		expect(create.mock.calls.map((call) => (call[0] as { name: string }).name)).toEqual([channels.rules]);
	});

	it("leaves an owner-written #rules untouched: the stored id points at it, it is adopted, and no Edit rules post lands there", async () => {
		const ownRules = textChannel("own-rules", "rules", { parentId: "cat-1", messages: [{ author: { id: "owner-1" } }] });
		await boot([ownRules]);

		expect(ownRules.setParent).not.toHaveBeenCalled();
		expect(ownRules.send).not.toHaveBeenCalled();
		expect(store.update).toHaveBeenCalledWith(
			"guild-1",
			expect.objectContaining({ rulesChannelId: "own-rules", adoptedChannelIds: expect.arrayContaining(["own-rules"]) })
		);
	});

	it("posts the rules into an adopted #rules that is still empty", async () => {
		const ownRules = textChannel("own-rules", "rulebook", { parentId: null });
		await boot([ownRules]);

		const post = sentOf(ownRules);
		expect(post.embeds[0]!.data.description).toBe(copy.rules.defaultMarkdown);
		expect(buttonIds(post)).toEqual([RULES_EDIT_CUSTOM_ID]);
	});
});

// ── the intro sweep and the drift rename ───────────────────────────────────

describe("every boot after", () => {
	const row = (): Record<string, unknown> => ({
		guildId: "guild-1",
		welcomeChannelId: "ch-welcome",
		rulesChannelId: "own-rules",
		adoptedChannelIds: ["own-rules"],
		introMessageIds: {},
		adminRoleId: null,
	});

	it("posts Dero's welcome intro where it is missing, and never posts over an adopted channel's owner content", async () => {
		const welcome = textChannel("ch-welcome", channels.welcome);
		const ownRules = textChannel("own-rules", "rules", { messages: [{ author: { id: "owner-1" } }] });
		store.findByGuildId.mockResolvedValue(row());
		const client = { channels: { fetch: vi.fn(async (id: string) => ({ "ch-welcome": welcome, "own-rules": ownRules })[id] ?? null) } } as unknown as Client;
		const guild = { id: "guild-1", ownerId: "owner-1", client: { user: { id: BOT } } } as unknown as Guild;

		await GuildSetupManager.refreshIntroEmbeds(client, guild);

		expect(sentOf(welcome).embeds[0]!.data.title).toBe(copy.welcome.title);
		expect(ownRules.send).not.toHaveBeenCalled();
	});

	it("renames a drifted 📘rules Dero built, and leaves the name of an adopted channel alone", async () => {
		const derosRules = textChannel("ch-rules", "old-rules");
		const ownWelcome = textChannel("own-welcome", "welcome");
		store.findByGuildId.mockResolvedValue({ guildId: "guild-1", welcomeChannelId: "own-welcome", rulesChannelId: "ch-rules", adoptedChannelIds: ["own-welcome"] });
		const client = { channels: { fetch: vi.fn(async (id: string) => ({ "ch-rules": derosRules, "own-welcome": ownWelcome })[id] ?? null) } } as unknown as Client;

		await GuildSetupManager.renameDriftedChannels(client, { id: "guild-1" } as Guild);

		expect(derosRules.setName).toHaveBeenCalledWith(channels.rules);
		expect(ownWelcome.setName).not.toHaveBeenCalled();
	});
});
