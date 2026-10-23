// ── the Rematch button, end to end over an in-memory GameRoom collection ──
// What:  proves a rematch plays on IN THE SAME CHANNEL: a new row takes the channel over,
//        the finished row releases it, and the two consumers that find rows BY CHANNEL
//        (the archive sweep and ChannelDeleteWatcher) then see only the live match.
// Why:   both of those consumers act on the database, not on the rematch code, so a unit
//        test that mocks the store would prove nothing about them. The collection below
//        reproduces each store method's FILTER (including the one-live-room-per-host
//        partial unique index) and the real rematch, sweep, lifecycle and watcher run on it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType, Events, type APIEmbed, type ButtonInteraction, type Client, type Guild } from "discord.js";

type FakeRow = Record<string, unknown> & { roomId: string; guildId: string; status: string };

const fake = vi.hoisted(() => {
	// Mirrors NON_TERMINAL_ROOM_STATUSES; the first test pins the two together.
	const LIVE = ["draft", "open", "playing"];
	const rows: FakeRow[] = [];
	let nextId = 2;

	// Every read hands back a COPY, the way a Mongoose query returns a fresh document, so
	// code under test can never change the collection by mutating what it read.
	const copy = (row: FakeRow | undefined) =>
		row
			? { ...row, playerIds: [...(row.playerIds as string[])], spectatorIds: [...(row.spectatorIds as string[])], moves: [...(row.moves as unknown[])] }
			: null;
	const find = (guildId: string, roomId: string) => rows.find((row) => row.guildId === guildId && row.roomId === roomId);

	const store = {
		async create(input: Record<string, unknown>) {
			const hostTaken = rows.some((row) => row.guildId === input.guildId && row.hostId === input.hostId && LIVE.includes(row.status));
			if (hostTaken) throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
			const row: FakeRow = {
				roomId: `room-${nextId++}`,
				guildId: input.guildId as string,
				game: input.game,
				hostId: input.hostId,
				playerIds: (input.playerIds as string[] | undefined) ?? [input.hostId as string],
				spectatorIds: (input.spectatorIds as string[] | undefined) ?? [],
				visibility: input.visibility,
				channelId: input.channelId ?? null,
				openerMessageId: null,
				inviteCode: null,
				boardMessageId: input.boardMessageId ?? null,
				status: "draft",
				rematchedFromRoomId: input.rematchedFromRoomId ?? null,
				monopolyAuctions: input.monopolyAuctions ?? false,
				monopolyReferee: input.monopolyReferee ?? false,
				secret: null,
				moves: [],
				winnerId: null,
				startedAt: null,
				endedAt: null,
				archiveAt: null,
			};
			rows.push(row);
			return copy(row);
		},
		async findByRematchedFrom(guildId: string, roomId: string) {
			return copy(rows.find((row) => row.guildId === guildId && row.rematchedFromRoomId === roomId));
		},
		async findByRoomId(guildId: string, roomId: string) {
			return copy(find(guildId, roomId));
		},
		// findOne in natural (insertion) order, exactly the ambiguity two rows on one
		// channel would expose.
		async findByChannelId(guildId: string, channelId: string) {
			return copy(rows.find((row) => row.guildId === guildId && row.channelId === channelId));
		},
		async findOpenByHost(guildId: string, hostId: string) {
			return copy(rows.find((row) => row.guildId === guildId && row.hostId === hostId && LIVE.includes(row.status)));
		},
		async countOpenInGuild(guildId: string) {
			return rows.filter((row) => row.guildId === guildId && LIVE.includes(row.status)).length;
		},
		async countOpenInGuildByVisibility(guildId: string, visibilities: string[]) {
			return rows.filter((row) => row.guildId === guildId && LIVE.includes(row.status) && visibilities.includes(row.visibility as string)).length;
		},
		async update(guildId: string, roomId: string, patch: Record<string, unknown>) {
			const row = find(guildId, roomId);
			if (row) Object.assign(row, patch);
			return copy(row);
		},
		async setStatus(guildId: string, roomId: string, status: string, patch: Record<string, unknown> = {}) {
			const row = find(guildId, roomId);
			if (row) Object.assign(row, patch, { status });
			return copy(row);
		},
		async finish(guildId: string, roomId: string, outcome: Record<string, unknown>) {
			const row = find(guildId, roomId);
			if (!row || !LIVE.includes(row.status)) return null;
			Object.assign(row, outcome, { status: "finished" });
			return copy(row);
		},
		async releaseChannel(guildId: string, roomId: string, channelId: string) {
			const row = find(guildId, roomId);
			if (!row || row.status !== "finished" || row.channelId !== channelId) return null;
			Object.assign(row, { channelId: null, archiveAt: null });
			return copy(row);
		},
		async findExpiredArchives(now: Date) {
			return rows
				.filter((row) => row.status === "finished" && row.archiveAt instanceof Date && row.archiveAt.getTime() <= now.getTime())
				.map((row) => copy(row));
		},
		async markArchived(guildId: string, roomId: string) {
			const row = find(guildId, roomId);
			if (row) Object.assign(row, { status: "archived", channelId: null });
			return copy(row);
		},
		async appendMove(guildId: string, roomId: string, move: unknown) {
			const row = find(guildId, roomId);
			if (row) (row.moves as unknown[]).push(move);
			return copy(row);
		},
	};

	return {
		LIVE,
		rows,
		store,
		reset() {
			rows.length = 0;
			nextId = 2;
		},
		insert(row: FakeRow) {
			rows.push(row);
		},
		row(roomId: string) {
			return rows.find((entry) => entry.roomId === roomId);
		},
		snapshot() {
			return JSON.stringify(rows);
		},
	};
});

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: fake.store }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("./challengeCardRenderer.js", () => ({ renderChallengeCard: vi.fn(), challengeCardView: vi.fn() }));
// The tier decision, defaulted per case to "not enforcing" like production today.
vi.mock("@features/entitlements/gameRoomAccess.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/entitlements/gameRoomAccess.js")>()),
	checkGameRoomAccess: vi.fn(),
}));
// The two solo games' own starts, so each case can see what the rematch dealt into
// which channel without running a blackjack collector or a hangman round.
vi.mock("@features/games/blackjackHandler.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/games/blackjackHandler.js")>()),
	startBlackjackTable: vi.fn(),
}));
vi.mock("./roomHangman.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./roomHangman.js")>()),
	startSoloHangmanRound: vi.fn(),
}));

import { rematchFromRoom } from "./challengeBoard.js";
import { sweepExpiredRooms } from "./roomArchiveSweep.js";
import { buildRoomOverwrites } from "./roomPermissions.js";
import { roomResultEmbed } from "./gameRoomsEmbeds.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { NON_TERMINAL_ROOM_STATUSES } from "./roomTypes.js";
import { registerChannelDeleteWatcher } from "@features/setup/ChannelDeleteWatcher.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { checkGameRoomAccess } from "@features/entitlements/gameRoomAccess.js";
import { startBlackjackTable } from "@features/games/blackjackHandler.js";
import { startSoloHangmanRound } from "./roomHangman.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const logMock = botLogStore as unknown as { log: ReturnType<typeof vi.fn> };
const accessMock = checkGameRoomAccess as unknown as ReturnType<typeof vi.fn>;
const blackjackMock = startBlackjackTable as unknown as ReturnType<typeof vi.fn>;
const soloHangmanMock = startSoloHangmanRound as unknown as ReturnType<typeof vi.fn>;

const GUILD = "guild-1";
const CHANNEL = "room-ch-1";
const FINISHED = "room-1";
const P1 = "p1";
const P2 = "p2";
const WATCHER = "watcher-3";

// ── the fake Discord side ─────────────────────────────────────────────

function makeRoomChannel() {
	let messageCount = 0;
	return {
		id: CHANNEL,
		guild: { roles: { everyone: { id: "everyone" } } },
		isTextBased: () => true,
		isDMBased: () => false,
		send: vi.fn(async () => ({ id: `msg-${++messageCount}`, pin: vi.fn().mockResolvedValue(undefined) })),
		createInvite: vi.fn().mockResolvedValue({ code: "invite-2" }),
		delete: vi.fn().mockResolvedValue(undefined),
		permissionOverwrites: { set: vi.fn().mockResolvedValue(undefined) },
		messages: { unpin: vi.fn().mockResolvedValue(undefined) },
	};
}

// A client whose channel cache is a Map the test controls: deleting a channel (by the
// sweep, or by hand before firing the watcher) takes it out, so a later fetch misses.
function makeWorld() {
	const channel = makeRoomChannel();
	const live = new Map<string, unknown>([[CHANNEL, channel]]);
	channel.delete.mockImplementation(async () => {
		live.delete(CHANNEL);
	});
	let channelDeleteHandler: ((deleted: unknown) => Promise<void>) | null = null;
	const client = {
		user: { id: "bot-1" },
		channels: { fetch: vi.fn(async (id: string) => live.get(id) ?? null) },
		guilds: { fetch: vi.fn().mockResolvedValue(null) },
		on: vi.fn((event: string, handler: (deleted: unknown) => Promise<void>) => {
			if (event === Events.ChannelDelete) channelDeleteHandler = handler;
		}),
	} as unknown as Client;
	const members = new Map([
		[P1, { id: P1, displayName: "Player One" }],
		[P2, { id: P2, displayName: "Player Two" }],
	]);
	const guild = {
		id: GUILD,
		client,
		roles: { everyone: { id: "everyone" } },
		members: { cache: members, fetch: vi.fn().mockResolvedValue(null) },
		// A rematch must never build a channel; the spy is what proves it.
		channels: { create: vi.fn() },
	} as unknown as Guild;
	return {
		channel,
		client,
		guild,
		live,
		fireChannelDelete: async () => {
			live.delete(CHANNEL);
			await channelDeleteHandler?.({ id: CHANNEL, name: "rps-player-one", guild, type: ChannelType.GuildText });
		},
	};
}

type World = ReturnType<typeof makeWorld>;

// The Rematch press, carrying the posted result card it lives on.
function pressRematch(world: World, userId: string): ButtonInteraction {
	const posted = roomResultEmbed(P1).toJSON() as APIEmbed;
	return {
		guildId: GUILD,
		guild: world.guild,
		client: world.client,
		user: { id: userId, globalName: null, username: userId },
		message: { embeds: [posted] },
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

const ARCHIVE_DELAY = BOT_CONSTANTS.GAME_ROOM_ARCHIVE_DELAY_MS;

function insertFinishedRoom(overrides: Partial<FakeRow> = {}): void {
	const endedAt = new Date();
	fake.insert({
		roomId: FINISHED,
		guildId: GUILD,
		game: "rps",
		hostId: P1,
		playerIds: [P1, P2],
		spectatorIds: [WATCHER],
		visibility: "invite",
		channelId: CHANNEL,
		openerMessageId: "opener-1",
		inviteCode: "invite-1",
		boardMessageId: "card-1",
		status: "finished",
		rematchedFromRoomId: null,
		monopolyAuctions: false,
		monopolyReferee: false,
		secret: null,
		moves: [{ actorId: P1, at: endedAt, kind: "move", text: "played rock" }],
		winnerId: P1,
		startedAt: new Date(endedAt.getTime() - 60_000),
		endedAt,
		archiveAt: new Date(endedAt.getTime() + ARCHIVE_DELAY),
		...overrides,
	});
}

// The one row a rematch of the finished room created, read straight off the collection.
function rematchRow(): FakeRow | undefined {
	return fake.rows.find((row) => row.rematchedFromRoomId === FINISHED);
}

const roomOf = (roomId: string) => fake.store.findByRoomId(GUILD, roomId) as unknown as Promise<Parameters<typeof rematchFromRoom>[1]>;

beforeEach(() => {
	vi.clearAllMocks();
	fake.reset();
	configMock.findByGuildId.mockResolvedValue({ guildId: GUILD, adminRoleId: null, gamesCategoryId: "arcade-cat", autoHealEnabled: true });
	logMock.log.mockResolvedValue(undefined);
	accessMock.mockResolvedValue({ allowed: true, privateQuota: Number.POSITIVE_INFINITY });
	blackjackMock.mockResolvedValue("started");
	soloHangmanMock.mockResolvedValue(undefined);
});

describe("a rematch in the same channel", () => {
	it("fakes the same live statuses the partial unique index covers", () => {
		expect(fake.LIVE).toEqual([...NON_TERMINAL_ROOM_STATUSES]);
	});

	it("keeps the channel id, unlocks it and seats the same players with the presser hosting", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		const interaction = pressRematch(world, P2);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		const next = rematchRow();
		expect(next).toMatchObject({
			channelId: CHANNEL,
			hostId: P2,
			game: "rps",
			visibility: "invite",
			spectatorIds: [WATCHER],
			status: "playing",
			inviteCode: "invite-2",
		});
		expect([...(next?.playerIds as string[])].sort()).toEqual([P1, P2]);
		expect(next?.startedAt).toBeInstanceOf(Date);
		expect(next?.openerMessageId).toBe("msg-1");
		expect(world.guild.channels.create).not.toHaveBeenCalled();

		// The unlock is the playing matrix for the NEW room, replacing the finished
		// room's @everyone SendMessages deny wholesale.
		expect(world.channel.permissionOverwrites.set).toHaveBeenCalledWith(
			buildRoomOverwrites({
				everyoneRoleId: "everyone",
				botId: "bot-1",
				hostId: P2,
				playerIds: next?.playerIds as string[],
				spectatorIds: [WATCHER],
				visibility: "invite",
				phase: "playing",
				adminRoleId: null,
			})
		);

		// The finished row keeps its transcript and lets the channel go.
		expect(fake.row(FINISHED)).toMatchObject({ status: "finished", channelId: null, archiveAt: null, winnerId: P1 });
		expect(fake.row(FINISHED)?.moves).toHaveLength(1);

		// The result card says who pressed, drops the archive notice that is no longer
		// true, and loses its buttons; the old opener is no longer pinned.
		const edit = (interaction.editReply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			embeds: Array<{ data: { description?: string } }>;
			components: unknown[];
		};
		expect(edit.components).toEqual([]);
		expect(edit.embeds[0].data.description).toContain(gameRoomsCopy.result.rematchStarted(P2));
		expect(edit.embeds[0].data.description).toContain(gameRoomsCopy.result.winnerLine(P1));
		expect(edit.embeds[0].data.description).not.toContain(gameRoomsCopy.result.archiveNotice());
		expect(world.channel.messages.unpin).toHaveBeenCalledWith("opener-1");
		expect(interaction.followUp).not.toHaveBeenCalled();
	});

	it("carries Monopoly's settings to the rematch row, where the referee is read every move", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "monopoly", monopolyAuctions: true, monopolyReferee: true });

		await rematchFromRoom(pressRematch(world, P2), await roomOf(FINISHED));

		expect(rematchRow()).toMatchObject({ monopolyAuctions: true, monopolyReferee: true, status: "playing" });
	});
});

// ⚠️ RISK R1 OF THE 1.7.0 PLAN. Both consumers find rows BY CHANNEL, so a finished row
// still pointing at the channel would delete, or wrongly close, the live match.
describe("after a rematch, the channel belongs to the live match only", () => {
	it("control: without a rematch the same sweep deletes the finished room's channel", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		vi.spyOn(console, "log").mockImplementation(() => undefined);

		await sweepExpiredRooms(world.client, new Date(Date.now() + ARCHIVE_DELAY + 60_000));

		expect(world.channel.delete).toHaveBeenCalledOnce();
	});

	it("the archive sweep run past the old archive clock leaves the channel", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		await rematchFromRoom(pressRematch(world, P2), await roomOf(FINISHED));

		const summary = await sweepExpiredRooms(world.client, new Date(Date.now() + ARCHIVE_DELAY + 60_000));

		expect(summary).toEqual({ archived: 0, failed: 0 });
		expect(world.channel.delete).not.toHaveBeenCalled();
		expect(world.live.has(CHANNEL)).toBe(true);
		expect(rematchRow()?.status).toBe("playing");
	});

	it("ChannelDeleteWatcher on that channel finds the NEW row and closes it, leaving the finished row alone", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		await rematchFromRoom(pressRematch(world, P2), await roomOf(FINISHED));
		const finishedBefore = JSON.stringify(fake.row(FINISHED));
		registerChannelDeleteWatcher(world.client);
		vi.spyOn(console, "log").mockImplementation(() => undefined);

		await world.fireChannelDelete();

		// The new row was the one found: it is closed as abandoned, which frees the
		// presser's host slot. The finished row was not touched.
		expect(rematchRow()).toMatchObject({ status: "finished", winnerId: null });
		expect(rematchRow()?.archiveAt).toBeInstanceOf(Date);
		expect(JSON.stringify(fake.row(FINISHED))).toBe(finishedBefore);
	});
});

describe("refusals write nothing", () => {
	it("refuses a presser who already hosts another open room, with the alreadyHosting copy", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		fake.insert({
			roomId: "room-other",
			guildId: GUILD,
			hostId: P2,
			status: "playing",
			channelId: "other-ch",
			visibility: "public",
			playerIds: [P2],
			spectatorIds: [],
			moves: [],
		});
		const before = fake.snapshot();
		const interaction = pressRematch(world, P2);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			embeds: Array<{ data: { description?: string } }>;
		};
		expect(reply.embeds[0].data.description).toBe(gameRoomsCopy.errors.alreadyHosting("other-ch"));
		expect(fake.snapshot()).toBe(before);
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
		expect(world.channel.permissionOverwrites.set).not.toHaveBeenCalled();
		expect(world.channel.send).not.toHaveBeenCalled();
	});

	it("refuses a second rematch of the same finished room", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		await rematchFromRoom(pressRematch(world, P2), await roomOf(FINISHED));
		const before = fake.snapshot();
		const second = pressRematch(world, P1);

		await rematchFromRoom(second, await roomOf(FINISHED));

		expect(second.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.rematchAlreadyOffered }));
		expect(fake.snapshot()).toBe(before);
	});

	// Two players pressing in the same moment both pass the read check; the release is
	// the claim that lets exactly one take the channel.
	it("lets exactly one of two simultaneous presses take the channel, and archives the loser's row", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		const first = pressRematch(world, P1);
		const second = pressRematch(world, P2);
		const room = await roomOf(FINISHED);

		await Promise.all([rematchFromRoom(first, room), rematchFromRoom(second, { ...room })]);

		const onChannel = fake.rows.filter((row) => row.channelId === CHANNEL);
		expect(onChannel).toHaveLength(1);
		expect(onChannel[0]).toMatchObject({ status: "playing", rematchedFromRoomId: FINISHED });
		const losers = fake.rows.filter((row) => row.rematchedFromRoomId === FINISHED && row.status !== "playing");
		for (const loser of losers) expect(loser).toMatchObject({ status: "archived", channelId: null });
	});

	it("refuses a room that is not finished", async () => {
		const world = makeWorld();
		insertFinishedRoom({ status: "playing", archiveAt: null });
		const before = fake.snapshot();
		const interaction = pressRematch(world, P2);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.notFound }));
		expect(fake.snapshot()).toBe(before);
	});
});

describe("solo rooms rematch in place", () => {
	it("solo blackjack deals the new table into the same channel, with no new channel", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "solo-blackjack", visibility: "solo", playerIds: [P1], spectatorIds: [], inviteCode: null });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		const next = rematchRow();
		expect(next).toMatchObject({ channelId: CHANNEL, hostId: P1, playerIds: [P1], visibility: "solo", status: "playing" });
		expect(world.guild.channels.create).not.toHaveBeenCalled();
		expect(blackjackMock).toHaveBeenCalledWith(world.channel, GUILD, { userId: P1, username: "Player One" }, true, next?.roomId);
		// A solo room mints no invite, exactly like its first match.
		expect(world.channel.createInvite).not.toHaveBeenCalled();
	});

	it("closes the new solo blackjack room when its table cannot start, and tells the presser", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "solo-blackjack", visibility: "solo", playerIds: [P1], spectatorIds: [], inviteCode: null });
		blackjackMock.mockResolvedValue("failed");
		const interaction = pressRematch(world, P1);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		expect(rematchRow()?.status).toBe("finished");
		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.createFailed }));
	});

	it("solo hangman seeds a new round from the bank into the same channel, with no new channel", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "solo-hangman", visibility: "solo", playerIds: [P1], spectatorIds: [], inviteCode: null });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		const next = rematchRow();
		expect(next).toMatchObject({ channelId: CHANNEL, hostId: P1, visibility: "solo", status: "playing" });
		expect(world.guild.channels.create).not.toHaveBeenCalled();
		// The third argument is the shelf a 🕹️games category start picks; a rematch
		// carries none, so its word comes from the whole bank.
		expect(soloHangmanMock).toHaveBeenCalledWith(
			world.client,
			expect.objectContaining({ guildId: GUILD, roomId: next?.roomId, channelId: CHANNEL, hostId: P1 }),
			undefined
		);
	});
});
