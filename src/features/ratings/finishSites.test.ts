import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findPlayingByGame: vi.fn(), findNonTerminal: vi.fn(), findByRoomId: vi.fn(), update: vi.fn(), updateSecretIf: vi.fn() },
}));
vi.mock("@features/game-rooms/roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("@features/game-rooms/roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardTwoPlayerResult: vi.fn(), awardMultiPlayerResult: vi.fn() }));
vi.mock("./recordMatchRatings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./recordMatchRatings.js")>()),
	recordMatchRatings: vi.fn(),
}));
vi.mock("./luckStats.js", () => ({ recordLuckResult: vi.fn() }));

import { sweepBattleshipTurns, sweepIdleRooms } from "@features/game-rooms/roomTurnSweep.js";
import { runRoomMove } from "@features/game-rooms/roomGames.js";
import { handleEndTable } from "@features/game-rooms/roomHoldemHandlers.js";
import { startMatch, type StoredBattleship } from "@features/game-rooms/roomBattleship.js";
import { act, createTable, dealHand, handInProgress, joinTable, standings, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomLifecycle } from "@features/game-rooms/roomLifecycle.js";
import { recordMatchRatings } from "./recordMatchRatings.js";
import { recordLuckResult } from "./luckStats.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the finish sites ─────────────────────────────────────────────────────
// What:  the real game room code that ends a match, with the rating and luck
//        recorders mocked, so what is pinned is the WIRING of 2026-10 item 244: a
//        Battleship turn timeout forfeit is rated, an ended Hold'em table is rated by
//        its standings, an abandoned room is not, a recorder runs only for the call
//        that won finish's claim, and a coin flip reaches the luck tally.

const storeMock = gameRoomStore as unknown as Record<
	"findPlayingByGame" | "findNonTerminal" | "findByRoomId" | "update" | "updateSecretIf",
	ReturnType<typeof vi.fn>
>;
const finishMock = roomLifecycle.finish as unknown as ReturnType<typeof vi.fn>;
const ratingMock = recordMatchRatings as unknown as ReturnType<typeof vi.fn>;
const luckMock = recordLuckResult as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-10-23T20:00:00.000Z");
const A = "player-a";
const B = "player-b";
const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;

// A varying deterministic generator, because placeFleet cannot place a fleet with a constant one.
function seededRng(seed = 1): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function battleshipRoom(match: StoredBattleship): IGameRoom {
	const at = new Date(NOW.getTime() - BOT_CONSTANTS.GAME_ROOM_TURN_TIMEOUT_MS - 1000);
	return {
		roomId: "room-bs",
		guildId: "guild-1",
		game: "battleship",
		status: "playing",
		playerIds: [A, B],
		channelId: "ch-1",
		startedAt: at,
		moves: [{ actorId: A, at, kind: "guess", text: "fired" }],
		secret: match,
	} as unknown as IGameRoom;
}

// A's second missed turn in a row, which forfeits the match to B.
const forfeitingMatch = (): StoredBattleship => ({
	...startMatch({ playerIds: [A, B] } as IGameRoom, { [A]: "A", [B]: "B" }, seededRng()),
	// Past setup (post-launch plan item 17): the turn clock forfeits only a battle.
	status: "playing",
	ready: [true, true],
	missedTurns: [1, 0],
});

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
	// The uncontended compare and swap: the caller's read was current, so its write landed.
	storeMock.updateSecretIf.mockResolvedValue({});
	finishMock.mockResolvedValue(true);
});

describe("Hold'em End table", () => {
	// Three seats that dealt `hands` hands, each folded round to one player, so blinds
	// move chips between stacks and the standings are not seat order, and nobody busts.
	function tableAfter(hands: number): HoldemTable {
		const table = createTable(NOW.getTime());
		for (const userId of ["p0", "p1", "p2"]) joinTable(table, userId, userId.toUpperCase());
		table.status = "playing";
		const rng = seededRng(5);
		for (let hand = 0; hand < hands; hand++) {
			dealHand(table, rng);
			while (handInProgress(table)) act(table, whoActs(table)!, "fold", 0, rng);
		}
		table.boardMessageId = null;
		return table;
	}

	const holdemRoom = (table: HoldemTable): IGameRoom =>
		({
			roomId: "room-he",
			guildId: "guild-1",
			game: "holdem",
			hostId: "p0",
			status: "playing",
			playerIds: table.seats.map((seat) => seat.userId),
			channelId: "ch-he",
			secret: table,
		}) as unknown as IGameRoom;

	const hostPress = (): ButtonInteraction =>
		({
			guildId: "guild-1",
			user: { id: "p0" },
			client: { channels: { fetch: vi.fn().mockResolvedValue(null) } },
			reply: vi.fn().mockResolvedValue(undefined),
			deferUpdate: vi.fn().mockResolvedValue(undefined),
		}) as unknown as ButtonInteraction;

	const endedTable = (): HoldemTable => storeMock.updateSecretIf.mock.calls[0][3] as HoldemTable;

	it("rates a table ended after 12 hands by its standings, the chip leader first", async () => {
		await handleEndTable(hostPress(), holdemRoom(tableAfter(12)));

		expect(ratingMock).toHaveBeenCalledOnce();
		const [room, order, excluded, options] = ratingMock.mock.calls[0];
		expect(room).toMatchObject({ roomId: "room-he", game: "holdem" });
		expect(order).toEqual(standings(endedTable()));
		expect(order).toHaveLength(3);
		expect(order[0]).toBe(endedTable().winnerId);
		expect(excluded).toEqual([]);
		expect(options).toEqual({ rated: true });
	});

	it("records a table ended after 3 hands unrated, like a short finished session", async () => {
		await handleEndTable(hostPress(), holdemRoom(tableAfter(3)));

		expect(ratingMock).toHaveBeenCalledOnce();
		expect(ratingMock.mock.calls[0][3]).toEqual({ rated: false });
	});

	it("records nothing for a table ended before its first deal", async () => {
		const table = createTable(NOW.getTime());
		joinTable(table, "p0", "P0");
		joinTable(table, "p1", "P1");

		await handleEndTable(hostPress(), holdemRoom(table));

		expect(finishMock).toHaveBeenCalledOnce();
		expect(ratingMock).not.toHaveBeenCalled();
	});

	it("rates nothing when another path already finished the room", async () => {
		finishMock.mockResolvedValue(false);

		await handleEndTable(hostPress(), holdemRoom(tableAfter(12)));

		expect(ratingMock).not.toHaveBeenCalled();
	});
});

describe("Battleship turn timeout forfeit", () => {
	it("rates the forfeit: the player who kept playing first", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([battleshipRoom(forfeitingMatch())]);

		await sweepBattleshipTurns(client, NOW);

		expect(ratingMock).toHaveBeenCalledOnce();
		expect(ratingMock.mock.calls[0][0]).toMatchObject({ roomId: "room-bs", game: "battleship" });
		expect(ratingMock.mock.calls[0][1]).toEqual([B, A]);
	});

	it("rates nothing when another path already finished the room", async () => {
		finishMock.mockResolvedValue(false);
		storeMock.findPlayingByGame.mockResolvedValue([battleshipRoom(forfeitingMatch())]);

		await sweepBattleshipTurns(client, NOW);

		expect(ratingMock).not.toHaveBeenCalled();
	});
});

describe("an abandoned room", () => {
	it("is finished by the idle sweep without a rating", async () => {
		storeMock.findNonTerminal.mockResolvedValue([
			{
				roomId: "room-idle",
				guildId: "guild-1",
				game: "battleship",
				status: "playing",
				playerIds: [A, B],
				moves: [],
				updatedAt: new Date(NOW.getTime() - 60 * 60_000),
			},
		]);

		await sweepIdleRooms(client, NOW);

		expect(finishMock).toHaveBeenCalledOnce();
		expect(finishMock.mock.calls[0][2]).toMatchObject({ abandoned: true });
		expect(ratingMock).not.toHaveBeenCalled();
	});
});

describe("coin flip", () => {
	function coinflipRoom(): IGameRoom {
		return {
			roomId: "room-cf",
			guildId: "guild-1",
			game: "coinflip",
			hostId: A,
			playerIds: [A, B],
			status: "playing",
			channelId: "ch-cf",
			moves: [],
			secret: null,
		} as unknown as IGameRoom;
	}

	const press = (): ButtonInteraction =>
		({
			customId: "gameroom:move:room-cf",
			guildId: "guild-1",
			user: { id: A },
			client: {},
			reply: vi.fn().mockResolvedValue(undefined),
			deferUpdate: vi.fn().mockResolvedValue(undefined),
		}) as unknown as ButtonInteraction;

	it("hands the luck tally both players and the winner, and never rates", async () => {
		storeMock.findByRoomId.mockResolvedValue(coinflipRoom());

		await runRoomMove(press(), coinflipRoom());

		expect(luckMock).toHaveBeenCalledOnce();
		const tally = luckMock.mock.calls[0][0] as { game: string; playerIds: string[]; winnerId: string | null };
		expect(tally.game).toBe("coinflip");
		expect(tally.playerIds).toEqual([A, B]);
		// A coin cannot tie, so a winner is always named.
		expect([A, B]).toContain(tally.winnerId);
		expect(ratingMock).not.toHaveBeenCalled();
	});

	it("tallies nothing for the press that lost finish's claim", async () => {
		storeMock.findByRoomId.mockResolvedValue(coinflipRoom());
		finishMock.mockResolvedValue(false);

		await runRoomMove(press(), coinflipRoom());

		expect(luckMock).not.toHaveBeenCalled();
	});
});
