import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, PermissionFlagsBits, TextChannel, type Client, type Guild } from "discord.js";

// The config store is the one thing mocked: a STATEFUL in memory row, so a second boot
// reads exactly what the first one wrote, which is what "a second boot is a no op" has
// to be proven against.
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: {
		findByGuildId: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		deleteByGuildId: vi.fn(),
	},
}));

import { GuildSetupManager } from "./GuildSetupManager.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

// ── 🏰 DERO HEADQUARTERS reaches an EXISTING guild on boot (2026-10 item 257 Phase 2a) ──
// What:  a guild set up with the old layout (the three admin channels under 🪧 NOTICE
//        BOARD, no Headquarters, no config channels, no 💬dero-commands) boots through
//        ensureHomebase, then boots again.
// Why:   risk R1 (a move that drops overwrites or pins) and risk R2 (a spec built under
//        the wrong parent, or twice). Neither throws, so only running the sweep twice
//        over persisted state shows them.

const configMock = guildConfigStore as unknown as {
	findByGuildId: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
};

const GUILD_ID = "guild-1";
const BOT_ID = "bot-1";
const OWNER_ID = "owner-1";
const NOTICE_BOARD_ID = "cat-1";
const CUSTOM_ROLE_ID = "role-custom";
const { channels: names, headquartersCategoryName } = rokCommanderCopy.setup;

// Every channel the old layout already had, by stored id.
const EXISTING_IDS = {
	introChannelId: "ch-intro",
	commandsChannelId: "ch-commands",
	leaderboardChannelId: "ch-leaderboard",
	scheduleChannelId: "ch-schedule",
	announcementsChannelId: "ch-announcements",
	adminChannelId: "ch-admin",
	nextDecreeChannelId: "ch-nextdecree",
	adminCommandsChannelId: "ch-admincommands",
	adminLogChannelId: "ch-adminlog",
	welcomeChannelId: "ch-welcome",
	rulesChannelId: "ch-rules",
	gamesCategoryId: "games-cat-1",
	arcadeRulesChannelId: "ch-arcaderules",
	arcadeChallengesChannelId: "ch-arcadechallenges",
	arcadeGamesChannelId: "ch-arcadegames",
	partyGamesChannelId: "ch-partygames",
	arcadeRatedChallengesChannelId: "ch-ratedchallenges",
	meetingVoiceChannelId: "ch-meetingvoice",
	arcadeVoiceChannelId: "ch-arcadevoice",
};

// The three admin channels, which the old layout kept under the notice board.
const ADMIN_CHANNELS: Array<{ field: "adminChannelId" | "adminCommandsChannelId" | "adminLogChannelId"; name: string }> = [
	{ field: "adminChannelId", name: names.admin },
	{ field: "adminCommandsChannelId", name: names.adminCommands },
	{ field: "adminLogChannelId", name: names.adminLog },
];

interface IOverwriteLike {
	id: string;
	allow?: unknown;
	deny?: unknown;
}

// A real TextChannel instance whose parent and overwrites move the way discord.js
// reports them after the API answers, holding one pinned message that must survive.
function makeTextChannel(id: string, name: string, parentId: string | null) {
	const overwrites = new Map<string, IOverwriteLike>([[CUSTOM_ROLE_ID, { id: CUSTOM_ROLE_ID, allow: PermissionFlagsBits.AddReactions }]]);
	const pinnedMessage = { id: `${id}-pin`, pinned: true, delete: vi.fn(), unpin: vi.fn() };
	let posted = 0;
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	const setParent = vi.fn(async (nextParentId: string) => {
		Object.assign(channel, { parentId: nextParentId });
		return channel;
	});
	const setOverwrites = vi.fn(async (next: IOverwriteLike[]) => {
		overwrites.clear();
		for (const entry of next) overwrites.set(entry.id, entry);
		return channel;
	});
	const send = vi.fn(async () => {
		posted += 1;
		return { id: `${id}-msg-${posted}`, pin: vi.fn(async () => undefined) };
	});
	Object.assign(channel, {
		id,
		name,
		guildId: GUILD_ID,
		parentId,
		setParent,
		send,
		permissionOverwrites: { cache: overwrites, set: setOverwrites },
		messages: { fetch: vi.fn(async () => ({ find: () => undefined, values: () => [][Symbol.iterator]() })) },
	});
	return { channel, setParent, setOverwrites, send, overwrites, pinnedMessage };
}

function makeCategory(id: string, name: string) {
	const children: unknown[] = [];
	return {
		category: { id, name, type: ChannelType.GuildCategory, children: { cache: { find: (test: (child: unknown) => boolean) => children.find(test), size: 0 } } },
		children,
	};
}

function makeWorld(options: { canManageChannels: boolean }) {
	let stored: Record<string, unknown> = {
		guildId: GUILD_ID,
		categoryId: NOTICE_BOARD_ID,
		...EXISTING_IDS,
		// No schedule anchor, so the ownership probe reads "unknown" and the sweep
		// repairs in place, the path every existing guild takes.
		scheduleMessageId: null,
		adminRoleId: "role-admin",
		memberRoleId: null,
		setupComplete: true,
		introMessageIds: {},
	};
	configMock.findByGuildId.mockImplementation(async () => ({ ...stored, introMessageIds: { ...((stored.introMessageIds as object) ?? {}) } }));
	configMock.update.mockImplementation(async (_guildId: string, patch: Record<string, unknown>) => {
		stored = { ...stored, ...patch };
	});

	const noticeBoard = makeCategory(NOTICE_BOARD_ID, rokCommanderCopy.setup.categoryName);
	const admins = Object.fromEntries(ADMIN_CHANNELS.map(({ field, name }) => [field, makeTextChannel(EXISTING_IDS[field], name, NOTICE_BOARD_ID)]));
	const guildChannels = new Map<string, unknown>([
		[NOTICE_BOARD_ID, noticeBoard.category],
		["games-cat-1", makeCategory("games-cat-1", rokCommanderCopy.setup.gamesCategoryName).category],
		...Object.values(EXISTING_IDS).map((id): [string, unknown] => [id, { id }]),
		...ADMIN_CHANNELS.map(({ field }): [string, unknown] => [EXISTING_IDS[field], admins[field].channel]),
	]);
	const categories = new Map<string, ReturnType<typeof makeCategory>>();
	const created: Array<{ name: string; type: number; parent?: string }> = [];
	const create = vi.fn(async (opts: { name: string; type: number; parent?: string }) => {
		created.push(opts);
		const id = `created-${created.length}`;
		if (opts.type === ChannelType.GuildCategory) {
			const made = makeCategory(id, opts.name);
			categories.set(id, made);
			guildChannels.set(id, made.category);
			return made.category;
		}
		const made = makeTextChannel(id, opts.name, opts.parent ?? null);
		guildChannels.set(id, made.channel);
		if (opts.parent) categories.get(opts.parent)?.children.push(made.channel);
		return made.channel;
	});
	const guild = {
		id: GUILD_ID,
		ownerId: OWNER_ID,
		roles: { everyone: { id: "everyone" } },
		client: { user: { id: BOT_ID } },
		members: { me: { permissions: { has: (bit: bigint) => options.canManageChannels && bit === PermissionFlagsBits.ManageChannels } } },
		channels: { fetch: vi.fn(async (id: string) => guildChannels.get(id) ?? null), create, cache: guildChannels },
	} as unknown as Guild;
	const client = {
		user: { id: BOT_ID },
		channels: { fetch: vi.fn(async (id: string) => (id === EXISTING_IDS.adminChannelId ? admins.adminChannelId.channel : (guildChannels.get(id) ?? null))) },
	} as unknown as Client;

	return { guild, client, create, created, admins, readStored: () => stored };
}

describe("🏰 DERO HEADQUARTERS on an existing guild's boot", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});
	afterEach(() => vi.restoreAllMocks());

	it("builds the category and the four new channels once, each under its own parent", async () => {
		const world = makeWorld({ canManageChannels: true });

		await GuildSetupManager.ensureHomebase(world.client, world.guild);

		const categories = world.created.filter((call) => call.type === ChannelType.GuildCategory);
		expect(categories.map((call) => call.name)).toEqual([headquartersCategoryName]);
		const headquartersId = world.readStored().headquartersCategoryId;
		expect(headquartersId).toBe("created-1");

		const parentOf = (name: string) => world.created.find((call) => call.name === name)?.parent;
		for (const name of [names.deroConfig, names.onboardingConfig, names.arcadeControl]) {
			expect(parentOf(name), `${name} belongs under 🏰 DERO HEADQUARTERS`).toBe(headquartersId);
		}
		expect(parentOf(names.commandOutput), "💬dero-commands belongs under the notice board").toBe(NOTICE_BOARD_ID);
		// One category and four channels, nothing else.
		expect(world.created).toHaveLength(5);
		for (const field of ["deroConfigChannelId", "onboardingConfigChannelId", "arcadeControlChannelId", "commandOutputChannelId"]) {
			expect(world.readStored()[field], field).toMatch(/^created-/);
		}
	});

	it("moves the three admin channels in, keeping their overwrites and their pins", async () => {
		const world = makeWorld({ canManageChannels: true });

		await GuildSetupManager.ensureHomebase(world.client, world.guild);

		const headquartersId = world.readStored().headquartersCategoryId;
		for (const { field } of ADMIN_CHANNELS) {
			const admin = world.admins[field];
			// lockPermissions false keeps the channel's own overwrites rather than syncing
			// it to the category's.
			expect(admin.setParent, field).toHaveBeenCalledExactlyOnceWith(headquartersId, { lockPermissions: false });
			expect(admin.channel.parentId).toBe(headquartersId);
			// Re-applied from the spec: @everyone stays hidden, the bot and the admin role
			// keep their entries, and the role an owner added by hand is carried over.
			expect(admin.setOverwrites, field).toHaveBeenCalledOnce();
			const everyone = admin.overwrites.get("everyone") as { deny?: bigint[] } | undefined;
			expect(everyone?.deny, field).toContain(PermissionFlagsBits.ViewChannel);
			expect(admin.overwrites.has(BOT_ID), field).toBe(true);
			expect(admin.overwrites.has("role-admin"), field).toBe(true);
			expect(admin.overwrites.has(CUSTOM_ROLE_ID), field).toBe(true);
			// A move is a parent change: no message is deleted, unpinned or reposted.
			expect(admin.pinnedMessage.delete).not.toHaveBeenCalled();
			expect(admin.pinnedMessage.unpin).not.toHaveBeenCalled();
		}
		// Moved, never rebuilt, so the stored ids are the ones the guild already had.
		expect(world.readStored().adminChannelId).toBe(EXISTING_IDS.adminChannelId);
		expect(world.readStored().adminLogChannelId).toBe(EXISTING_IDS.adminLogChannelId);
	});

	it("changes nothing on a second boot", async () => {
		const world = makeWorld({ canManageChannels: true });
		await GuildSetupManager.ensureHomebase(world.client, world.guild);
		const createdAfterFirst = world.create.mock.calls.length;

		await GuildSetupManager.ensureHomebase(world.client, world.guild);

		expect(world.create.mock.calls.length).toBe(createdAfterFirst);
		for (const { field } of ADMIN_CHANNELS) {
			expect(world.admins[field].setParent, field).toHaveBeenCalledOnce();
			expect(world.admins[field].setOverwrites, field).toHaveBeenCalledOnce();
		}
	});

	it("leaves a server where Dero lacks Manage Channels as it is, with one line", async () => {
		const world = makeWorld({ canManageChannels: false });
		const log = vi.mocked(console.log);

		await GuildSetupManager.ensureHomebase(world.client, world.guild);

		expect(world.created.filter((call) => call.type === ChannelType.GuildCategory)).toHaveLength(0);
		for (const { field } of ADMIN_CHANNELS) {
			expect(world.admins[field].setParent, field).not.toHaveBeenCalled();
			expect(world.admins[field].channel.parentId).toBe(NOTICE_BOARD_ID);
		}
		expect(world.readStored().headquartersCategoryId).toBeUndefined();
		const refusals = log.mock.calls.filter(([line]) => typeof line === "string" && line.includes("lacks Manage Channels"));
		expect(refusals).toHaveLength(1);
	});
});
