import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findPlayingByGame: vi.fn(), findNonTerminal: vi.fn(), findByRoomId: vi.fn(), update: vi.fn() },
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
import { startMatch, type StoredBattleship } from "@features/game-rooms/roomBattleship.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomLifecycle } from "@features/game-rooms/roomLifecycle.js";
import { recordMatchRatings } from "./recordMatchRatings.js";
import { recordLuckResult } from "./luckStats.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the finish sites ─────────────────────────────────────────────────────
// What:  the real game room code that ends a match, with the rating and luck
//        recorders mocked, so what is pinned is the WIRING of 2026-10 item 244: a
//        Battleship turn timeout forfeit is rated, an abandoned room is not, a
//        recorder runs only for the call that won finish's claim, and a coin flip
//        reaches the luck tally.

const storeMock = gameRoomStore as unknown as Record<"findPlayingByGame" | "findNonTerminal" | "findByRoomId" | "update", ReturnType<typeof vi.fn>>;
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
	missedTurns: [1, 0],
});

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
	finishMock.mockResolvedValue(true);
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
