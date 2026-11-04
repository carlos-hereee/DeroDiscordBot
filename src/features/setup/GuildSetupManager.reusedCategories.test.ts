import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType, Collection, DiscordAPIError, RESTJSONErrorCodes, TextChannel, VoiceChannel, type Guild } from "discord.js";

// ── a forced rebuild keeps a reused category's live channels (2026-10 item 273) ──
// What:  runAutoSetup over a row whose 🪧 NOTICE BOARD is gone while 🎮 ARCADE GAMES and
//        🏰 DERO HEADQUARTERS still stand, with each of their channels live, gone, removed
//        by an admin, or unconfirmable.
// Why:   building the reused categories' channels again put a second set beside the
//        live one and orphaned the originals. Nothing throws when that happens, so only
//        counting the creates per parent and reading the persisted row shows it.
// How:   the config store is a STATEFUL in memory row returned as a hydrated document
//        stand in (fields on the prototype, none of its own, like Mongoose), because the
//        settle step chains rows by spread and a spread hydrated document keeps no field.

vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: {
		findByGuildId: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		deleteByGuildId: vi.fn(),
	},
}));
vi.mock("@features/voice/deroVoiceRooms.js", () => ({
	allowDeroVoiceRooms: vi.fn().mockResolvedValue(undefined),
	replaceDeroVoiceRoom: vi.fn().mockResolvedValue(undefined),
	revokeDeroVoiceRooms: vi.fn().mockResolvedValue(undefined),
	DERO_VOICE_ROOM_FIELDS: ["meetingVoiceChannelId", "arcadeVoiceChannelId"],
}));
// The card syncs are counted, not run: which channels get one is what R5 is about.
vi.mock("./headquartersCards.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./headquartersCards.js")>()),
	syncAllHeadquarters: vi.fn().mockResolvedValue(undefined),
	syncHeadquartersChannel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./adminLog.js", () => ({ adminLog: { write: vi.fn(async () => ({ persisted: true, posted: true })), emit: vi.fn(), emitFor: vi.fn() } }));

import { GuildSetupManager } from "./GuildSetupManager.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { allowDeroVoiceRooms, replaceDeroVoiceRoom } from "@features/voice/deroVoiceRooms.js";
import { HEADQUARTERS_DOMAINS, syncAllHeadquarters, syncHeadquartersChannel } from "./headquartersCards.js";
import { communityOverwritesFor, overwriteKindOf } from "./communityOverwrites.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

const configMock = guildConfigStore as unknown as {
	findByGuildId: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
};

const GUILD_ID = "guild-1";
const OWNER_ID = "owner-1";
const BOT_ID = "bot-1";
const EVERYONE_ID = "everyone";
const ADMIN_ROLE = "role-admin";
const MEMBER_ROLE = "role-member";
const GAMES_CATEGORY_ID = "games-cat-1";
const HEADQUARTERS_CATEGORY_ID = "hq-cat-1";
const { channels: names, gamesCategoryName, headquartersCategoryName } = rokCommanderCopy.setup;

// The thirteen slots under the two reused categories, by stored id.
const ARCADE_SLOTS: Record<string, string> = {
	arcadeRulesChannelId: "ch-arcaderules",
	arcadeChallengesChannelId: "ch-arcadechallenges",
	arcadeGamesChannelId: "ch-arcadegames",
	partyGamesChannelId: "ch-partygames",
	arcadeRatedChallengesChannelId: "ch-ratedchallenges",
	deroMarketChannelId: "ch-deromarket",
	arcadeVoiceChannelId: "ch-arcadevoice",
};
const HEADQUARTERS_SLOTS: Record<string, string> = {
	adminChannelId: "ch-admin",
	adminLogChannelId: "ch-adminlog",
	deroConfigChannelId: "ch-deroconfig",
	onboardingConfigChannelId: "ch-onboardingconfig",
	arcadeControlChannelId: "ch-arcadecontrol",
	serverConfigChannelId: "ch-serverconfig",
};
const REUSED_SLOTS: Record<string, string> = { ...ARCADE_SLOTS, ...HEADQUARTERS_SLOTS };
const HOMEBASE_ANCHOR_FIELDS = [
	"introChannelId",
	"commandsChannelId",
	"leaderboardChannelId",
	"scheduleChannelId",
	"announcementsChannelId",
	"nextDecreeChannelId",
	"inviteCardId",
	"meetingVoiceChannelId",
	"commandOutputChannelId",
];
const STORED_ANCHORS: Record<string, string> = {
	...Object.fromEntries(Object.keys(REUSED_SLOTS).map((field) => [field, `anchor-${field}`])),
	arcadeGamesBoardId: "anchor-arcadeGamesBoardId",
	introChannelId: "anchor-old-intro",
};

// A row of a server that ran /setup and lost only its notice board.
function makeStoredRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		guildId: GUILD_ID,
		categoryId: "cat-old",
		introChannelId: "ch-old-intro",
		gamesCategoryId: GAMES_CATEGORY_ID,
		headquartersCategoryId: HEADQUARTERS_CATEGORY_ID,
		...REUSED_SLOTS,
		scheduleMessageId: "msg-old-schedule",
		introMessageIds: { ...STORED_ANCHORS },
		adminRoleId: ADMIN_ROLE,
		memberRoleId: MEMBER_ROLE,
		setupComplete: true,
		...overrides,
	};
}

// Fields on the prototype and none of its own, with toObject, like a Mongoose document.
// Twins: asHydrated in GuildSetupManager.test.ts and the stand in in ChannelDeleteWatcher.test.ts.
function asHydrated(row: Record<string, unknown>): Record<string, unknown> {
	const document = Object.create(row) as Record<string, unknown>;
	Object.defineProperty(document, "toObject", { value: () => ({ ...row }), enumerable: false });
	return document;
}

interface IChannelSpies {
	send: ReturnType<typeof vi.fn>;
	setParent: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
	edit: ReturnType<typeof vi.fn>;
	setName: ReturnType<typeof vi.fn>;
}

// A text or voice channel of the REAL class, so every instanceof check sees its kind.
function makeChannel(id: string, name: string, kind: "text" | "voice", parentId: string | null): (TextChannel | VoiceChannel) & IChannelSpies {
	const channel = Object.create(kind === "voice" ? VoiceChannel.prototype : TextChannel.prototype) as (TextChannel | VoiceChannel) & IChannelSpies;
	Object.assign(channel, {
		id,
		name,
		parentId,
		guildId: GUILD_ID,
		send: vi.fn(async () => ({ id: `msg-${id}`, pin: vi.fn().mockResolvedValue(undefined) })),
		messages: { fetch: vi.fn().mockResolvedValue(new Collection()) },
		// moveIntoCategory re-applies the spec overwrites through set (2026-10 item 275).
		permissionOverwrites: { cache: new Collection(), set: vi.fn().mockResolvedValue(undefined) },
		setParent: vi.fn(),
		delete: vi.fn(),
		edit: vi.fn(),
		setName: vi.fn(),
	});
	return channel;
}

function makeCategory(id: string, name: string, children: ReadonlyArray<{ id: string }>) {
	return { id, name, type: ChannelType.GuildCategory, children: { cache: new Collection(children.map((child) => [child.id, child])) } };
}

const unknownChannel = () => new DiscordAPIError({ code: RESTJSONErrorCodes.UnknownChannel, message: "Unknown Channel" }, RESTJSONErrorCodes.UnknownChannel, 404, "GET", "url", {});

interface ICreateCall {
	name: string;
	type: number;
	parent?: string;
	permissionOverwrites?: unknown[];
}

interface IRigOptions {
	stored: Record<string, unknown> | null;
	// Slots whose stored channel Discord says is gone.
	gone?: string[];
	// Slots whose stored channel could not be confirmed either way (a 5xx).
	unreachable?: string[];
	// Extra channels already sitting in a reused category (a Dero named orphan, a room).
	arcadeExtras?: Array<TextChannel | VoiceChannel>;
	// Categories visible only by name in the cache (a reset database).
	cachedCategories?: Array<ReturnType<typeof makeCategory>>;
	// Whether the stored categories still answer a fetch.
	categoriesLive?: boolean;
	// Further live channels a fetch by id answers (a notice board survivor, 2026-10 item 275).
	extraLive?: Array<TextChannel | VoiceChannel>;
}

function makeRig(options: IRigOptions) {
	let state: Record<string, unknown> | null = options.stored ? { ...options.stored } : null;
	configMock.findByGuildId.mockImplementation(async () => (state ? asHydrated(state) : null));
	configMock.update.mockImplementation(async (_guildId: string, data: Record<string, unknown>) => {
		state = { ...(state ?? {}), ...data };
		return asHydrated(state);
	});
	configMock.create.mockImplementation(async (data: Record<string, unknown>) => {
		state = { ...data };
		return asHydrated(state);
	});

	const gone = new Set(options.gone ?? []);
	const unreachable = new Set(options.unreachable ?? []);
	const voiceSlots = new Set(["arcadeVoiceChannelId"]);
	const nameOf = (field: string): string => {
		const specName = GuildSetupManager.CHANNEL_SPECS.find((spec) => spec.configField === field)?.displayName;
		return specName ?? field;
	};
	const liveBySlot = new Map<string, TextChannel | VoiceChannel>();
	for (const [field, id] of Object.entries(REUSED_SLOTS)) {
		if (gone.has(field) || unreachable.has(field)) continue;
		const parent = field in ARCADE_SLOTS ? GAMES_CATEGORY_ID : HEADQUARTERS_CATEGORY_ID;
		liveBySlot.set(id, makeChannel(id, nameOf(field), voiceSlots.has(field) ? "voice" : "text", parent));
	}
	const arcadeChildren = [...[...liveBySlot.values()].filter((channel) => channel.parentId === GAMES_CATEGORY_ID), ...(options.arcadeExtras ?? [])];
	const headquartersChildren = [...liveBySlot.values()].filter((channel) => channel.parentId === HEADQUARTERS_CATEGORY_ID);
	const gamesCategory = makeCategory(GAMES_CATEGORY_ID, gamesCategoryName, arcadeChildren);
	const headquartersCategory = makeCategory(HEADQUARTERS_CATEGORY_ID, headquartersCategoryName, headquartersChildren);
	const storedIdOf = (field: string) => REUSED_SLOTS[field];
	const goneIds = new Set([...gone].map(storedIdOf));
	const unreachableIds = new Set([...unreachable].map(storedIdOf));

	const created: Array<TextChannel | VoiceChannel> = [];
	const create = vi.fn(async (opts: ICreateCall) => {
		if (opts.type === ChannelType.GuildCategory) return makeCategory(`new-cat-${opts.name}`, opts.name, []);
		const channel = makeChannel(`new-${opts.name}`, opts.name, opts.type === ChannelType.GuildVoice ? "voice" : "text", opts.parent ?? null);
		created.push(channel);
		return channel;
	});
	const fetch = vi.fn(async (id: string) => {
		if (id === GAMES_CATEGORY_ID) return options.categoriesLive === false ? Promise.reject(unknownChannel()) : gamesCategory;
		if (id === HEADQUARTERS_CATEGORY_ID) return options.categoriesLive === false ? Promise.reject(unknownChannel()) : headquartersCategory;
		if (goneIds.has(id)) throw unknownChannel();
		if (unreachableIds.has(id)) throw new Error("503 Service Unavailable");
		const extra = options.extraLive?.find((channel) => channel.id === id);
		if (extra) return extra;
		const live = liveBySlot.get(id);
		if (live) return live;
		throw unknownChannel();
	});
	const cache = new Collection((options.cachedCategories ?? []).map((category) => [category.id, category]));
	const guild = {
		id: GUILD_ID,
		ownerId: OWNER_ID,
		features: [],
		roles: { everyone: { id: EVERYONE_ID } },
		client: { user: { id: BOT_ID } },
		channels: { create, fetch, cache },
	} as unknown as Guild;

	const calls = () => create.mock.calls.map((call) => call[0] as ICreateCall);
	const childCreatesUnder = (parentId: string) => calls().filter((call) => call.type !== ChannelType.GuildCategory && call.parent === parentId);
	return { guild, create, fetch, created, calls, childCreatesUnder, row: () => state, liveBySlot };
}

async function forcedRebuild(rig: ReturnType<typeof makeRig>, options: { foreignHomebase?: boolean } = {}): Promise<void> {
	await GuildSetupManager.autoSetup(rig.guild, { guildId: GUILD_ID, ownerId: OWNER_ID }, { force: true, ...options });
}

function specFor(field: string) {
	return GuildSetupManager.CHANNEL_SPECS.find((spec) => spec.configField === field)!;
}

function expectedOverwrites(rig: ReturnType<typeof makeRig>, field: string, roles: { memberRoleId: string | null; adminRoleId: string | null }) {
	return communityOverwritesFor(overwriteKindOf(specFor(field)), rig.guild, { ownerId: OWNER_ID }, roles);
}

describe("GuildSetupManager.autoSetup keeps a reused category's live channels (2026-10 item 273)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("builds no channel inside a reused category whose channels are all live, and keeps their slots and anchors", async () => {
		const rig = makeRig({ stored: makeStoredRow() });

		await forcedRebuild(rig);

		expect(rig.childCreatesUnder(GAMES_CATEGORY_ID)).toEqual([]);
		expect(rig.childCreatesUnder(HEADQUARTERS_CATEGORY_ID)).toEqual([]);
		// Only the notice board is new: one category and its own channels.
		const categoryCreates = rig.calls().filter((call) => call.type === ChannelType.GuildCategory);
		expect(categoryCreates.map((call) => call.name)).toEqual([rokCommanderCopy.setup.categoryName]);

		const [, payload] = configMock.update.mock.calls[0] as [string, Record<string, unknown>];
		for (const field of Object.keys(REUSED_SLOTS)) expect(payload, field).not.toHaveProperty(field);
		expect(payload.gamesCategoryId).toBe(GAMES_CATEGORY_ID);
		expect(payload.headquartersCategoryId).toBe(HEADQUARTERS_CATEGORY_ID);

		const row = rig.row()!;
		for (const [field, id] of Object.entries(REUSED_SLOTS)) expect(row[field], field).toBe(id);
		const anchors = row.introMessageIds as Record<string, string | null>;
		for (const field of Object.keys(REUSED_SLOTS)) expect(anchors[field], field).toBe(`anchor-${field}`);
		expect(anchors.arcadeGamesBoardId).toBe("anchor-arcadeGamesBoardId");
		// The notice board's anchors are the new posts, never the old ones.
		expect(anchors.introChannelId).toBe(`msg-new-${names.intro}`);
		// Only one write: nothing was repaired.
		expect(configMock.update).toHaveBeenCalledTimes(1);
	});

	it("rebuilds exactly the gone slots, under their reused category, with the repair path's posture, and keeps every anchor (R1)", async () => {
		const rig = makeRig({ stored: makeStoredRow(), gone: ["arcadeChallengesChannelId", "deroConfigChannelId"] });

		await forcedRebuild(rig);

		const arcadeCreates = rig.childCreatesUnder(GAMES_CATEGORY_ID);
		const headquartersCreates = rig.childCreatesUnder(HEADQUARTERS_CATEGORY_ID);
		expect(arcadeCreates.map((call) => call.name)).toEqual([names.arcadeChallenges]);
		expect(headquartersCreates.map((call) => call.name)).toEqual([names.deroConfig]);
		const textRoles = { memberRoleId: MEMBER_ROLE, adminRoleId: ADMIN_ROLE };
		expect(arcadeCreates[0]?.permissionOverwrites).toEqual(expectedOverwrites(rig, "arcadeChallengesChannelId", textRoles));
		expect(headquartersCreates[0]?.permissionOverwrites).toEqual(expectedOverwrites(rig, "deroConfigChannelId", textRoles));

		const row = rig.row()!;
		expect(row.arcadeChallengesChannelId).toBe(`new-${names.arcadeChallenges}`);
		expect(row.deroConfigChannelId).toBe(`new-${names.deroConfig}`);
		const anchors = row.introMessageIds as Record<string, string | null>;
		// The repaired slots carry their fresh intros...
		expect(anchors.arcadeChallengesChannelId).toBe(`msg-new-${names.arcadeChallenges}`);
		expect(anchors.deroConfigChannelId).toBe(`msg-new-${names.deroConfig}`);
		// ...while every homebase anchor the build wrote and every kept anchor survive the
		// repairs' whole map writes, which a stale or hydrated row would have erased.
		for (const field of HOMEBASE_ANCHOR_FIELDS) expect(anchors[field], field).toMatch(/^msg-new-/);
		expect(anchors.arcadeRulesChannelId).toBe("anchor-arcadeRulesChannelId");
		expect(anchors.serverConfigChannelId).toBe("anchor-serverConfigChannelId");
		// No write ever carries a role: the per spec view is never persisted.
		for (const [, data] of configMock.update.mock.calls as Array<[string, Record<string, unknown>]>) expect(data).not.toHaveProperty("adminRoleId");
	});

	it("syncs the kept Headquarters channels once each and lets the repair sync the rebuilt one (R5)", async () => {
		const rig = makeRig({ stored: makeStoredRow(), gone: ["deroConfigChannelId"] });

		await forcedRebuild(rig);

		expect(syncAllHeadquarters).not.toHaveBeenCalled();
		const synced = (syncHeadquartersChannel as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as string);
		expect([...synced].sort()).toEqual([...HEADQUARTERS_DOMAINS].sort());
		const deroConfigSync = (syncHeadquartersChannel as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[1] === "deroConfig");
		expect(deroConfigSync?.[2]).toEqual({ forcePost: true });
	});

	it("adopts a Dero named channel already in the reused category for a slot that lost its id, instead of building one", async () => {
		const orphan = makeChannel("ch-orphan-market", names.deroMarket, "text", GAMES_CATEGORY_ID);
		const rig = makeRig({ stored: makeStoredRow({ deroMarketChannelId: null }), gone: ["deroMarketChannelId"], arcadeExtras: [orphan] });

		await forcedRebuild(rig);

		expect(rig.childCreatesUnder(GAMES_CATEGORY_ID)).toEqual([]);
		expect(rig.row()!.deroMarketChannelId).toBe("ch-orphan-market");
	});

	it("keeps item 272's split on a self destructed row: a rebuilt text channel has no admin role, a rebuilt lounge has it (R2)", async () => {
		const rig = makeRig({ stored: makeStoredRow({ setupComplete: false }), gone: ["partyGamesChannelId", "arcadeVoiceChannelId"] });

		await forcedRebuild(rig);

		const byName = (name: string) => rig.childCreatesUnder(GAMES_CATEGORY_ID).find((call) => call.name === name);
		expect(byName(names.partyGames)?.permissionOverwrites).toEqual(expectedOverwrites(rig, "partyGamesChannelId", { memberRoleId: MEMBER_ROLE, adminRoleId: null }));
		expect(byName(names.arcadeVoice)?.permissionOverwrites).toEqual(expectedOverwrites(rig, "arcadeVoiceChannelId", { memberRoleId: MEMBER_ROLE, adminRoleId: ADMIN_ROLE }));
		for (const [, data] of configMock.update.mock.calls as Array<[string, Record<string, unknown>]>) expect(data).not.toHaveProperty("adminRoleId");
		expect(rig.row()!.adminRoleId).toBe(ADMIN_ROLE);
		// The rebuilt lounge is swapped on Dero's voice allow list; the dead id is never added (R6).
		expect(replaceDeroVoiceRoom).toHaveBeenCalledWith(GUILD_ID, "ch-arcadevoice", `new-${names.arcadeVoice}`);
		const allowed = (allowDeroVoiceRooms as unknown as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[1] as unknown[]);
		expect(allowed).not.toContain("ch-arcadevoice");
		expect(allowed).toContain(`new-${names.meetingVoice}`);
	});

	it("leaves the slots an admin removed alone: an arcade switched off stays off (D3)", async () => {
		const removed = ["arcadeChallengesChannelId", "partyGamesChannelId"];
		const rig = makeRig({ stored: makeStoredRow({ userRemovedChannels: removed }), gone: removed });

		await forcedRebuild(rig);

		expect(rig.childCreatesUnder(GAMES_CATEGORY_ID)).toEqual([]);
		for (const field of removed) expect(rig.fetch).not.toHaveBeenCalledWith(REUSED_SLOTS[field]);
	});

	it("builds nothing for a slot Discord could not confirm, and leaves its id (R3)", async () => {
		const rig = makeRig({ stored: makeStoredRow(), unreachable: ["arcadeRulesChannelId"] });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		await forcedRebuild(rig);

		expect(rig.childCreatesUnder(GAMES_CATEGORY_ID)).toEqual([]);
		expect(rig.row()!.arcadeRulesChannelId).toBe("ch-arcaderules");
		warn.mockRestore();
	});

	it("never touches a live game room under the arcade (R4)", async () => {
		const room = makeChannel("ch-room-1", "solo-coinflip-1", "text", GAMES_CATEGORY_ID);
		const rig = makeRig({ stored: makeStoredRow(), gone: ["arcadeGamesChannelId"], arcadeExtras: [room] });

		await forcedRebuild(rig);

		const roomSpies = room as unknown as IChannelSpies;
		for (const spy of [roomSpies.send, roomSpies.setParent, roomSpies.delete, roomSpies.edit, roomSpies.setName]) expect(spy).not.toHaveBeenCalled();
		expect(rig.fetch).not.toHaveBeenCalledWith("ch-room-1");
		expect(Object.values(rig.row()!)).not.toContain("ch-room-1");
	});

	// 2026-11 item 289: each built channel's fresh post is queued by its own repair, so a fresh
	// sync here would post a second steps card and a second first card in every config channel.
	it("finishes Set up Dero with a plain sync, so the cards the repairs posted are not posted again", async () => {
		const rig = makeRig({ stored: makeStoredRow({ deroConfigChannelId: null, serverConfigChannelId: null }) });

		await GuildSetupManager.buildHeadquartersAwaitingSetup(rig.guild);

		expect(syncAllHeadquarters).toHaveBeenCalledTimes(1);
		expect(syncAllHeadquarters).toHaveBeenCalledWith(rig.guild);
	});

	it("builds every channel new on a foreign homebase, keeping none (D1)", async () => {
		const rig = makeRig({ stored: makeStoredRow() });

		await forcedRebuild(rig, { foreignHomebase: true });

		expect(rig.childCreatesUnder(GAMES_CATEGORY_ID)).toHaveLength(Object.keys(ARCADE_SLOTS).length);
		expect(rig.childCreatesUnder(HEADQUARTERS_CATEGORY_ID)).toHaveLength(Object.keys(HEADQUARTERS_SLOTS).length);
		const [, payload] = configMock.update.mock.calls[0] as [string, Record<string, unknown>];
		expect(payload.arcadeRulesChannelId).toBe(`new-${names.arcadeRules}`);
		expect(syncAllHeadquarters).toHaveBeenCalledTimes(1);
	});

	// A fresh install builds only 🏰 DERO HEADQUARTERS (2026-11 item 285 Phase 2) and never
	// looks for an arcade, so D4's name adoption is pinned on the full build that still
	// runs with no stored arcade id: a forced rebuild of a legacy row whose 🪧 NOTICE BOARD
	// was deleted. A self destructed row no longer qualifies, since self destruct clears
	// every stored id and its /setup builds fresh (2026-11 item 285 debug pass).
	it("adopts the Dero named channels of a category found by name on a row with no stored id, instead of building a second set (D4)", async () => {
		const arcadeChannels = Object.keys(ARCADE_SLOTS).map((field) =>
			makeChannel(`old-${field}`, specFor(field).displayName, field === "arcadeVoiceChannelId" ? "voice" : "text", "old-games-cat")
		);
		const oldArcade = makeCategory("old-games-cat", gamesCategoryName, arcadeChannels);
		const rig = makeRig({ stored: { guildId: GUILD_ID, categoryId: "deleted-notice-board", setupComplete: true }, cachedCategories: [oldArcade] });

		await GuildSetupManager.autoSetup(rig.guild, { guildId: GUILD_ID, ownerId: OWNER_ID }, { force: true });

		expect(rig.childCreatesUnder("old-games-cat")).toEqual([]);
		const row = rig.row()!;
		expect(row.gamesCategoryId).toBe("old-games-cat");
		for (const field of Object.keys(ARCADE_SLOTS)) expect(row[field], field).toBe(`old-${field}`);
		// Headquarters had no category, so it was built whole.
		expect(rig.childCreatesUnder(`new-cat-${headquartersCategoryName}`)).toHaveLength(Object.keys(HEADQUARTERS_SLOTS).length);
		expect(syncAllHeadquarters).toHaveBeenCalledTimes(1);
	});
});

// ── the notice board's survivors (2026-10 item 275) ──────────────────────
// Discord keeps a deleted category's channels, uncategorized (parentId null). So when
// 🪧 NOTICE BOARD is gone, its stored channels may still answer a fetch, and the rebuild
// must move them into the new category instead of building a second set beside them.
const HOMEBASE_SLOTS: Record<string, string> = {
	introChannelId: "ch-intro",
	commandsChannelId: "ch-commands",
	leaderboardChannelId: "ch-leaderboard",
	scheduleChannelId: "ch-schedule",
	announcementsChannelId: "ch-announcements",
	nextDecreeChannelId: "ch-nextdecree",
	welcomeChannelId: "ch-welcome",
	rulesChannelId: "ch-rules",
	meetingVoiceChannelId: "ch-meetingvoice",
	commandOutputChannelId: "ch-commandoutput",
};
const NEW_NOTICE_BOARD_ID = `new-cat-${rokCommanderCopy.setup.categoryName}`;

function makeNoticeBoardRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return makeStoredRow({
		categoryId: "cat-deleted",
		...HOMEBASE_SLOTS,
		scheduleMessageId: "msg-old-schedule",
		introMessageIds: {
			...STORED_ANCHORS,
			...Object.fromEntries(Object.keys(HOMEBASE_SLOTS).map((field) => [field, `anchor-${field}`])),
			inviteCardId: "anchor-inviteCardId",
		},
		...overrides,
	});
}

// One survivor per stored slot not listed as gone, uncategorized unless told otherwise.
function makeSurvivors(options: { gone?: string[]; parentOf?: Record<string, string> } = {}) {
	const gone = new Set(options.gone ?? []);
	return Object.entries(HOMEBASE_SLOTS)
		.filter(([field]) => !gone.has(field))
		.map(([field, id]) => makeChannel(id, specFor(field).displayName, field === "meetingVoiceChannelId" ? "voice" : "text", options.parentOf?.[field] ?? null));
}

describe("GuildSetupManager.autoSetup moves the notice board's surviving channels into the rebuilt category (2026-10 item 275)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("moves every uncategorized survivor into the new notice board, builds none of them, and keeps their slots and anchors", async () => {
		const survivors = makeSurvivors();
		const rig = makeRig({ stored: makeNoticeBoardRow(), extraLive: survivors });

		await forcedRebuild(rig);

		expect(rig.childCreatesUnder(NEW_NOTICE_BOARD_ID)).toEqual([]);
		const textRoles = { memberRoleId: MEMBER_ROLE, adminRoleId: ADMIN_ROLE };
		for (const channel of survivors) {
			const field = Object.keys(HOMEBASE_SLOTS).find((key) => HOMEBASE_SLOTS[key] === channel.id)!;
			expect(channel.setParent, field).toHaveBeenCalledExactlyOnceWith(NEW_NOTICE_BOARD_ID, { lockPermissions: false });
			const written = (channel.permissionOverwrites as unknown as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0]?.[0];
			expect(written, field).toEqual(expectedOverwrites(rig, field, textRoles));
		}

		const [, payload] = configMock.update.mock.calls[0] as [string, Record<string, unknown>];
		expect(payload.categoryId).toBe(NEW_NOTICE_BOARD_ID);
		for (const field of Object.keys(HOMEBASE_SLOTS)) expect(payload, field).not.toHaveProperty(field);
		expect(payload).not.toHaveProperty("scheduleMessageId");
		expect(payload).not.toHaveProperty("adoptedChannelIds");

		const row = rig.row()!;
		for (const [field, id] of Object.entries(HOMEBASE_SLOTS)) expect(row[field], field).toBe(id);
		expect(row.scheduleMessageId).toBe("msg-old-schedule");
		const anchors = row.introMessageIds as Record<string, string | null>;
		for (const field of Object.keys(HOMEBASE_SLOTS)) expect(anchors[field], field).toBe(`anchor-${field}`);
		expect(anchors.inviteCardId).toBe("anchor-inviteCardId");
		// A moved 🏛️ Meeting Hall keeps its id, and no dead id reaches the voice allow list.
		const allowed = (allowDeroVoiceRooms as unknown as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[1] as unknown[]);
		expect(allowed.filter((id) => typeof id === "string")).toEqual([]);
	});

	it("builds only the gone slots under the new notice board, through the repair path, and moves the rest", async () => {
		const gone = ["leaderboardChannelId", "announcementsChannelId"];
		const survivors = makeSurvivors({ gone });
		const rig = makeRig({ stored: makeNoticeBoardRow(), extraLive: survivors });

		await forcedRebuild(rig);

		const creates = rig.childCreatesUnder(NEW_NOTICE_BOARD_ID);
		expect(creates.map((call) => call.name).sort()).toEqual([names.leaderboard, names.announcements].sort());
		for (const channel of survivors) expect(channel.setParent, channel.id).toHaveBeenCalledOnce();
		const row = rig.row()!;
		expect(row.leaderboardChannelId).toBe(`new-${names.leaderboard}`);
		expect((row.introMessageIds as Record<string, string>).introChannelId).toBe("anchor-introChannelId");
	});

	it("never moves the server's own adopted welcome channel (D3)", async () => {
		const ownWelcome = makeChannel("ch-own-welcome", "welcome", "text", null);
		const survivors = makeSurvivors({ gone: ["welcomeChannelId"] });
		const rig = makeRig({
			stored: makeNoticeBoardRow({ welcomeChannelId: "ch-own-welcome", adoptedChannelIds: ["ch-own-welcome"] }),
			extraLive: [...survivors, ownWelcome],
		});

		await forcedRebuild(rig);

		expect(ownWelcome.setParent).not.toHaveBeenCalled();
		expect(rig.childCreatesUnder(NEW_NOTICE_BOARD_ID)).toEqual([]);
		expect(rig.row()!.welcomeChannelId).toBe("ch-own-welcome");
	});

	it("keeps a survivor an admin placed in a category of their own where it is (D1)", async () => {
		const survivors = makeSurvivors({ parentOf: { leaderboardChannelId: "cat-admins-own" } });
		const rig = makeRig({ stored: makeNoticeBoardRow(), extraLive: survivors });

		await forcedRebuild(rig);

		const leaderboard = survivors.find((channel) => channel.id === "ch-leaderboard")!;
		expect(leaderboard.setParent).not.toHaveBeenCalled();
		expect(rig.childCreatesUnder(NEW_NOTICE_BOARD_ID)).toEqual([]);
		expect(rig.row()!.leaderboardChannelId).toBe("ch-leaderboard");
	});

	it("keeps a survivor whose move fails where it is, and builds nothing in its place (R4)", async () => {
		const survivors = makeSurvivors();
		const commands = survivors.find((channel) => channel.id === "ch-commands")!;
		commands.setParent.mockRejectedValueOnce(new Error("Missing Permissions"));
		const rig = makeRig({ stored: makeNoticeBoardRow(), extraLive: survivors });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		await forcedRebuild(rig);

		expect(warn.mock.calls.some((call) => String(call[0]).includes("could not move commandsChannelId"))).toBe(true);
		expect(rig.childCreatesUnder(NEW_NOTICE_BOARD_ID)).toEqual([]);
		expect(rig.row()!.commandsChannelId).toBe("ch-commands");
		warn.mockRestore();
	});

	it("builds the notice board in bulk, exactly as before, when none of Dero's channels survived (D2)", async () => {
		// Only the server's own adopted welcome is left, which is what a self destruct leaves.
		const ownWelcome = makeChannel("ch-own-welcome", "welcome", "text", null);
		const rig = makeRig({
			stored: makeNoticeBoardRow({ welcomeChannelId: "ch-own-welcome", adoptedChannelIds: ["ch-own-welcome"] }),
			extraLive: [ownWelcome],
		});

		await forcedRebuild(rig);

		expect(ownWelcome.setParent).not.toHaveBeenCalled();
		const [, payload] = configMock.update.mock.calls[0] as [string, Record<string, unknown>];
		expect(payload.introChannelId).toBe(`new-${names.intro}`);
		expect(payload.scheduleMessageId).toBe(`msg-new-${names.schedule}`);
		expect(rig.childCreatesUnder(NEW_NOTICE_BOARD_ID).length).toBeGreaterThanOrEqual(Object.keys(HOMEBASE_SLOTS).length - 1);
	});

	it("builds every notice board channel new on a foreign homebase, moving none (D1 of item 273)", async () => {
		const survivors = makeSurvivors();
		const rig = makeRig({ stored: makeNoticeBoardRow(), extraLive: survivors });

		await forcedRebuild(rig, { foreignHomebase: true });

		for (const channel of survivors) expect(channel.setParent).not.toHaveBeenCalled();
		const [, payload] = configMock.update.mock.calls[0] as [string, Record<string, unknown>];
		expect(payload.introChannelId).toBe(`new-${names.intro}`);
	});
});
