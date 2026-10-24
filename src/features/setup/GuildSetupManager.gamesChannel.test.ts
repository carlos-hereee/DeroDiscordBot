import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel, ChannelType, DiscordAPIError, PermissionFlagsBits, type Client, type Guild } from "discord.js";

// The config store is the one thing mocked: it is a STATEFUL in memory row here, so a
// second boot reads exactly what the first one wrote, which is what "a second boot
// creates nothing" has to be proven against.
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
import { boardStartRows, CHALLENGE_GAMES, openerCardRows } from "@features/game-rooms/challengeBoardEmbeds.js";
import { buildArcadeHostRow } from "@features/games/arcadeHost.js";
import { ChannelContent } from "./ChannelContent.js";

// ── 🕹️games reaches an EXISTING guild on boot (2026-10 item 245 Phase 4a) ────
// What:  a seeded guild that ran /setup before the games channel existed boots through
//        the same two calls main.ts makes, ensureHomebase then refreshIntroEmbeds, and
//        then boots again.
// Why:   risk R5. The new spec arms the repair sweep for every existing guild, so the
//        failure that matters is a duplicate channel or a duplicate post on a later
//        boot, and neither throws. Only running the sweep twice over persisted state
//        shows it. The same harness proves the opt outs create nothing and that the
//        Challenge Board moves out of ⚔️challenges without a message being deleted.

const configMock = guildConfigStore as unknown as {
	findByGuildId: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
};

const GUILD_ID = "guild-1";
const BOT_ID = "bot-1";
const OWNER_ID = "owner-1";
const GAMES_CATEGORY_ID = "games-cat-1";
const GAMES_NAME = rokCommanderCopy.setup.channels.arcadeGames;

interface FakeMessage {
	id: string;
	author: { id: string };
	embeds: unknown[];
	components: ReadonlyArray<{ toJSON(): unknown }>;
	pinned: boolean;
	edit: ReturnType<typeof vi.fn>;
	pin: ReturnType<typeof vi.fn>;
	unpin: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
}

interface SendOptions {
	embeds?: Array<{ data?: unknown }>;
	components?: ReadonlyArray<{ toJSON(): unknown }>;
}

// An embed travels as a builder on send and comes back as plain data on a fetch, so a
// posted message stores the builder's data, which is what embedsAreEquivalent reads.
function toStoredEmbeds(embeds: SendOptions["embeds"]): unknown[] {
	return (embeds ?? []).map((embed) => embed.data ?? embed);
}

function makeMessage(id: string, options: SendOptions): FakeMessage {
	const message: FakeMessage = {
		id,
		author: { id: BOT_ID },
		embeds: toStoredEmbeds(options.embeds),
		components: options.components ?? [],
		pinned: false,
		// An edit lands, so the next boot reads the edited message.
		edit: vi.fn(async (edit: SendOptions) => {
			if (edit.embeds) message.embeds = toStoredEmbeds(edit.embeds);
			if (edit.components) message.components = edit.components;
			return message;
		}),
		pin: vi.fn(async () => undefined),
		unpin: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
	};
	return message;
}

function unknownMessage(): Error {
	const error = Object.create(DiscordAPIError.prototype);
	Object.assign(error, { code: 10008, message: "Unknown Message" });
	return error as Error;
}

// A TextChannel that keeps every message it was sent, serves them by id, and answers
// the adopt scans ({ limit }) with a find over them, newest first like Discord.
function makeChannel(id: string, name: string, seed: FakeMessage[] = []) {
	const messages = new Map(seed.map((message) => [message.id, message]));
	let posted = 0;
	const send = vi.fn(async (options: SendOptions) => {
		posted += 1;
		const message = makeMessage(`${id}-msg-${posted}`, options);
		messages.set(message.id, message);
		return message;
	});
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(channel, {
		id,
		name,
		guildId: GUILD_ID,
		send,
		messages: {
			fetch: vi.fn(async (arg: unknown) => {
				if (typeof arg !== "string") {
					const newestFirst = [...messages.values()].reverse();
					return { find: (test: (message: FakeMessage) => boolean) => newestFirst.find(test), values: () => newestFirst.values() };
				}
				const message = messages.get(arg);
				if (!message) throw unknownMessage();
				return message;
			}),
		},
	});
	return { channel, send, messages };
}

// Every managed channel an existing guild already has, by stored id. Only the four the
// test watches are real channels; the rest only have to exist for the repair sweep.
const EXISTING_IDS = {
	introChannelId: "ch-intro",
	commandsChannelId: "ch-commands",
	leaderboardChannelId: "ch-leaderboard",
	scheduleChannelId: "ch-schedule",
	announcementsChannelId: "ch-announcements",
	adminChannelId: "ch-admin",
	nextDecreeChannelId: "ch-nextdecree",
	adminCommandsChannelId: "ch-admincommands",
	welcomeChannelId: "ch-welcome",
	rulesChannelId: "ch-rules",
	arcadeRulesChannelId: "ch-arcaderules",
	arcadeChallengesChannelId: "ch-arcadechallenges",
	meetingVoiceChannelId: "ch-meetingvoice",
	arcadeVoiceChannelId: "ch-arcadevoice",
};

// A guild set up before Phase 4a: both categories, every older channel, no games
// channel and no anchors for it.
function legacyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		guildId: GUILD_ID,
		categoryId: "cat-1",
		gamesCategoryId: GAMES_CATEGORY_ID,
		...EXISTING_IDS,
		arcadeGamesChannelId: null,
		scheduleMessageId: "msg-schedule",
		adminRoleId: null,
		memberRoleId: null,
		setupComplete: true,
		introMessageIds: {},
		...overrides,
	};
}

function makeWorld(row: Record<string, unknown>, options: { challengesSeed?: FakeMessage[]; rulesSeed?: FakeMessage[]; gamesChildren?: unknown[] } = {}) {
	// ── the stored row, read and written like the real store ──
	let stored: Record<string, unknown> = { ...row };
	configMock.findByGuildId.mockImplementation(async () => ({ ...stored, introMessageIds: { ...((stored.introMessageIds as object) ?? {}) } }));
	configMock.update.mockImplementation(async (_guildId: string, patch: Record<string, unknown>) => {
		stored = { ...stored, ...patch };
	});

	// ── the channels the test watches ──
	const schedule = makeChannel("ch-schedule", "📅event-schedule", [makeMessage("msg-schedule", {})]);
	const admin = makeChannel("ch-admin", "🔒inner-sanctum");
	const challenges = makeChannel("ch-arcadechallenges", "⚔️challenges", options.challengesSeed ?? []);
	const rules = makeChannel("ch-arcaderules", "📋arcade-rules", options.rulesSeed ?? []);
	const clientChannels = new Map<string, unknown>([
		["ch-schedule", schedule.channel],
		["ch-admin", admin.channel],
		["ch-arcadechallenges", challenges.channel],
		["ch-arcaderules", rules.channel],
	]);

	// ── the guild side: both categories, every older channel, and create ──
	const gamesChildren: unknown[] = [...(options.gamesChildren ?? [])];
	const gamesCategory = {
		id: GAMES_CATEGORY_ID,
		type: ChannelType.GuildCategory,
		children: { cache: { find: (test: (child: unknown) => boolean) => gamesChildren.find(test) } },
	};
	const guildChannels = new Map<string, unknown>([
		["cat-1", { id: "cat-1", children: { cache: { find: () => undefined } } }],
		[GAMES_CATEGORY_ID, gamesCategory],
		...Object.values(EXISTING_IDS).map((id): [string, unknown] => [id, { id }]),
	]);
	const created: Array<ReturnType<typeof makeChannel>> = [];
	const create = vi.fn(async (opts: { name: string; type: number; parent?: string }) => {
		const fake = makeChannel(`created-${created.length + 1}`, opts.name);
		created.push(fake);
		guildChannels.set(fake.channel.id, fake.channel);
		clientChannels.set(fake.channel.id, fake.channel);
		if (opts.parent === GAMES_CATEGORY_ID) gamesChildren.push(fake.channel);
		return fake.channel;
	});
	const guild = {
		id: GUILD_ID,
		ownerId: OWNER_ID,
		roles: { everyone: { id: "everyone" } },
		client: { user: { id: BOT_ID } },
		channels: { fetch: vi.fn(async (id: string) => guildChannels.get(id) ?? null), create },
	} as unknown as Guild;
	const client = {
		user: { id: BOT_ID },
		channels: { fetch: vi.fn(async (id: string) => clientChannels.get(id) ?? null) },
	} as unknown as Client;

	// One boot, as main.ts runs it per guild: the repair sweep, then the intro sweep.
	const boot = async (): Promise<void> => {
		await GuildSetupManager.ensureHomebase(client, guild);
		await GuildSetupManager.refreshIntroEmbeds(client, guild);
	};

	return { boot, create, created, admin, challenges, rules, readStored: () => stored };
}

type CreateCall = { name: string; type: number; parent?: string; permissionOverwrites?: Array<{ id: string; allow?: bigint[]; deny?: bigint[] }> };
type ComponentRow = { toJSON(): { components: Array<{ custom_id?: string }> } };
const customIdsOf = (rows: ReadonlyArray<{ toJSON(): unknown }>): Array<string | undefined> =>
	(rows as ReadonlyArray<ComponentRow>).flatMap((row) => row.toJSON().components.map((component) => component.custom_id));
const titleOf = (call: unknown[]): string | undefined => ((call[0] as SendOptions).embeds?.[0]?.data as { title?: string } | undefined)?.title;

describe("🕹️games on an existing guild's boot", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});
	afterEach(() => vi.restoreAllMocks());

	it("builds 🕹️games exactly once, under 🎮 ARCADE GAMES, with its intro and its board", async () => {
		const world = makeWorld(legacyRow());

		await world.boot();

		expect(world.create).toHaveBeenCalledOnce();
		const call = world.create.mock.calls[0][0] as CreateCall;
		expect(call).toMatchObject({ name: GAMES_NAME, type: ChannelType.GuildText, parent: GAMES_CATEGORY_ID });
		// The public posture its siblings have: members read and press, only the bot writes.
		expect(call.permissionOverwrites?.find((entry) => entry.id === "everyone")).toEqual({
			id: "everyone",
			allow: [PermissionFlagsBits.ViewChannel],
			deny: [PermissionFlagsBits.SendMessages],
		});

		// The intro, then the board beneath it, and nothing else.
		const games = world.created[0];
		expect(games.send.mock.calls.map(titleOf)).toEqual([
			rokCommanderCopy.channelContent.arcadeGames.title,
			rokCommanderCopy.channelContent.arcadeGames.boardTitle,
		]);
		const [intro, board] = [...games.messages.values()];
		expect(customIdsOf(intro.components)).toContain("solo_luck:coinflip");
		expect(customIdsOf(board.components)).toEqual(CHALLENGE_GAMES.map((game) => `gameroom:new:${game}`));

		// Both anchors and the channel id persisted, so the next boot reads them back.
		const stored = world.readStored();
		expect(stored.arcadeGamesChannelId).toBe(games.channel.id);
		expect(stored.introMessageIds).toMatchObject({ arcadeGamesChannelId: intro.id, arcadeGamesBoardId: board.id });
	});

	it("creates nothing and posts nothing on a second boot", async () => {
		const world = makeWorld(legacyRow());
		await world.boot();
		const sendsAfterFirstBoot = {
			games: world.created[0].send.mock.calls.length,
			admin: world.admin.send.mock.calls.length,
			challenges: world.challenges.send.mock.calls.length,
			rules: world.rules.send.mock.calls.length,
		};

		await world.boot();

		expect(world.create).toHaveBeenCalledOnce();
		expect(world.created[0].send.mock.calls.length).toBe(sendsAfterFirstBoot.games);
		expect(world.admin.send.mock.calls.length).toBe(sendsAfterFirstBoot.admin);
		expect(world.challenges.send.mock.calls.length).toBe(sendsAfterFirstBoot.challenges);
		expect(world.rules.send.mock.calls.length).toBe(sendsAfterFirstBoot.rules);
		for (const message of world.created[0].messages.values()) expect(message.edit).not.toHaveBeenCalled();
	});

	it("creates nothing when the admin turned auto heal off", async () => {
		const world = makeWorld(legacyRow({ autoHealEnabled: false }));

		await world.boot();

		expect(world.create).not.toHaveBeenCalled();
		expect(world.readStored().arcadeGamesChannelId).toBeNull();
	});

	it("creates nothing when the admin removed the games slot", async () => {
		const world = makeWorld(legacyRow({ userRemovedChannels: ["arcadeGamesChannelId"] }));

		await world.boot();

		expect(world.create).not.toHaveBeenCalled();
		expect(world.readStored().arcadeGamesChannelId).toBeNull();
	});

	it("adopts a 🕹️games channel that already exists by name instead of building a second one", async () => {
		// A boot that built the channel and died before persisting its id leaves exactly
		// this behind; building again would be the duplicate R5 is about.
		const orphan = makeChannel("ch-orphan-games", GAMES_NAME);
		const world = makeWorld(legacyRow(), { gamesChildren: [orphan.channel] });

		await world.boot();

		expect(world.create).not.toHaveBeenCalled();
		expect(world.readStored().arcadeGamesChannelId).toBe("ch-orphan-games");
		expect(orphan.send.mock.calls.map(titleOf)).toEqual([
			rokCommanderCopy.channelContent.arcadeGames.title,
			rokCommanderCopy.channelContent.arcadeGames.boardTitle,
		]);
	});

	it("moves the Challenge Board out of ⚔️challenges, stripping the old intro's buttons and deleting nothing", async () => {
		// The old ⚔️challenges intro carried the start buttons. The intro sweep posts the
		// new one line intro beneath it with no buttons, and the board appears in 🕹️games.
		// The old intro keeps its copy and loses only its buttons (owner decision, Phase 4a),
		// so ⚔️challenges no longer holds a second working board.
		const oldIntro = makeMessage("old-challenges", {
			embeds: [{ data: { title: "⚔️ The Challenge Board", description: "The old board copy." } }],
			components: boardStartRows(),
		});
		const world = makeWorld(legacyRow({ introMessageIds: { arcadeChallengesChannelId: "old-challenges" } }), { challengesSeed: [oldIntro] });

		await world.boot();

		expect(world.challenges.send).toHaveBeenCalledOnce();
		const posted = world.challenges.send.mock.calls[0][0] as SendOptions;
		expect(titleOf(world.challenges.send.mock.calls[0])).toBe(rokCommanderCopy.channelContent.arcadeChallenges.title);
		expect(posted.components).toEqual([]);
		expect(oldIntro.delete).not.toHaveBeenCalled();
		// Components only: no embed and no file in the edit, so the old copy stays.
		expect(oldIntro.edit).toHaveBeenCalledOnce();
		expect(oldIntro.edit).toHaveBeenCalledWith({ components: [] });
		expect(oldIntro.embeds).toEqual([{ title: "⚔️ The Challenge Board", description: "The old board copy." }]);
		expect(world.readStored().introMessageIds).toMatchObject({ arcadeChallengesChannelId: "ch-arcadechallenges-msg-1" });

		const board = [...world.created[0].messages.values()][1];
		expect(customIdsOf(board.components)).toEqual(CHALLENGE_GAMES.map((game) => `gameroom:new:${game}`));
	});

	it("strips the Host a game row from the superseded 📋arcade-rules intro and keeps its copy", async () => {
		const oldRules = makeMessage("old-rules", {
			embeds: [{ data: { title: "📋 The Rules of the Arena", description: "The old rules with a roster." } }],
			components: [buildArcadeHostRow()],
		});
		const world = makeWorld(legacyRow({ introMessageIds: { arcadeRulesChannelId: "old-rules" } }), { rulesSeed: [oldRules] });

		await world.boot();

		// The new rules card carries only the ballot button.
		const posted = world.rules.send.mock.calls[0][0] as SendOptions;
		expect(customIdsOf(posted.components ?? [])).toEqual(["game_request:open"]);
		expect(oldRules.edit).toHaveBeenCalledWith({ components: [] });
		expect(oldRules.embeds).toEqual([{ title: "📋 The Rules of the Arena", description: "The old rules with a roster." }]);
		expect(oldRules.delete).not.toHaveBeenCalled();
	});

	it("leaves a challenge card's own buttons alone, and strips an older superseded intro in the same window", async () => {
		// A live challenge card carries Join, Start and Cancel, which are not moved
		// controls, so it must come through untouched. An intro superseded on an EARLIER
		// copy change, no longer tracked, still carries the board and is stripped too.
		const olderIntro = makeMessage("older-challenges", {
			embeds: [{ data: { title: "⚔️ The Challenge Board", description: "An even older board copy." } }],
			components: boardStartRows(),
		});
		const card = makeMessage("challenge-card", {
			embeds: [{ data: { title: "Coin Flip challenge", description: "Open to all" } }],
			components: openerCardRows("room-1", { game: "coinflip", hostId: "host-1", visibility: "public", pool: [] }),
		});
		const oldIntro = makeMessage("old-challenges", {
			embeds: [{ data: { title: "⚔️ The Challenge Board", description: "The old board copy." } }],
			components: boardStartRows(),
		});
		const world = makeWorld(legacyRow({ introMessageIds: { arcadeChallengesChannelId: "old-challenges" } }), {
			challengesSeed: [olderIntro, card, oldIntro],
		});

		await world.boot();

		expect(oldIntro.edit).toHaveBeenCalledWith({ components: [] });
		expect(olderIntro.edit).toHaveBeenCalledWith({ components: [] });
		expect(card.edit).not.toHaveBeenCalled();
		expect(customIdsOf(card.components)).toContain("gameroom:join:room-1");
	});

	it("strips the tracked old intro when the sweep adopts a new intro already posted", async () => {
		// A boot that posted the new intro and died before persisting its id leaves both
		// behind; the next sweep adopts the new one and still strips the old one.
		const oldIntro = makeMessage("old-challenges", {
			embeds: [{ data: { title: "⚔️ The Challenge Board", description: "The old board copy." } }],
			components: boardStartRows(),
		});
		const newIntro = makeMessage("new-challenges", { embeds: [ChannelContent.arcadeChallengesIntro()], components: [] });
		const world = makeWorld(legacyRow({ introMessageIds: { arcadeChallengesChannelId: "old-challenges" } }), {
			challengesSeed: [oldIntro, newIntro],
		});

		await world.boot();

		expect(world.challenges.send).not.toHaveBeenCalled();
		expect(world.readStored().introMessageIds).toMatchObject({ arcadeChallengesChannelId: "new-challenges" });
		expect(oldIntro.edit).toHaveBeenCalledWith({ components: [] });
		expect(newIntro.edit).not.toHaveBeenCalled();
	});

	it("strips nothing on a second boot, once the old intros are bare", async () => {
		const oldIntro = makeMessage("old-challenges", {
			embeds: [{ data: { title: "⚔️ The Challenge Board", description: "The old board copy." } }],
			components: boardStartRows(),
		});
		const world = makeWorld(legacyRow({ introMessageIds: { arcadeChallengesChannelId: "old-challenges" } }), { challengesSeed: [oldIntro] });
		await world.boot();
		expect(oldIntro.edit).toHaveBeenCalledOnce();

		await world.boot();

		expect(oldIntro.edit).toHaveBeenCalledOnce();
		expect(world.challenges.send).toHaveBeenCalledOnce();
	});
});
