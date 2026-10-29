import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { update: vi.fn(), findByRoomId: vi.fn(), setSecretField: vi.fn(), updateSecretIf: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardTwoPlayerResult: vi.fn() }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", () => ({ recordMatchRatings: vi.fn(), twoPlayerFinishingOrder: vi.fn() }));

import { forfeitBattleship } from "./roomBattleshipHandlers.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import { recordMatchRatings } from "@features/ratings/recordMatchRatings.js";
import { startMatch, type StoredBattleship } from "./roomBattleship.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── Battleship's forfeit (2026-10 item 276, audit P2-4) ──────────────
// Surrender and leaving the server used to finish the room and nothing else: no rating, no
// result paid, and against a Dero bot no winner at all, although the confirm says "It counts as
// a loss for you" and a timeout forfeit was rated. Now every way a captain gives the match up is
// the timeout's result: rated, paid, the other captain (a bot included) the winner.

const finish = roomLifecycle.finish as unknown as ReturnType<typeof vi.fn>;
const award = awardTwoPlayerResult as unknown as ReturnType<typeof vi.fn>;
const ratings = recordMatchRatings as unknown as ReturnType<typeof vi.fn>;

const A = "player-a";
const B = "player-b";
const BOT = "dero-bot-blue";
const client = { user: { id: "bot-1" } } as unknown as Client;

function seededRng(seed = 7): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

const matchOf = (captains: [string, string], status: StoredBattleship["status"] = "playing"): StoredBattleship => ({
	...startMatch({ playerIds: captains } as IGameRoom, { [captains[0]]: "A", [captains[1]]: "B" }, seededRng()),
	status,
});

function makeRoom(secret: StoredBattleship | null, playerIds: string[] = [A, B]): IGameRoom {
	return { roomId: "room-1", guildId: "guild-1", game: "battleship", status: "playing", playerIds, channelId: "ch-1", secret } as unknown as IGameRoom;
}

beforeEach(() => {
	vi.clearAllMocks();
	finish.mockResolvedValue(true);
});

describe("forfeitBattleship", () => {
	it("rates and pays the surrender as the forfeiter's loss", async () => {
		const room = makeRoom(matchOf([A, B]));

		expect(await forfeitBattleship(client, room, A)).toBe(true);

		expect(finish).toHaveBeenCalledWith(client, room, { winnerId: B, outcome: { bucket: "forfeit" } });
		expect(ratings).toHaveBeenCalledWith(room, [B, A]);
		expect(award).toHaveBeenCalledOnce();
		expect(award.mock.calls[0][0]).toMatchObject({ game: "battleship", winner: "opponent", resultKey: "room-1" });
	});

	it("counts a surrender during setup as a loss too", async () => {
		await forfeitBattleship(client, makeRoom(matchOf([A, B], "setup")), B);

		expect(finish.mock.calls[0][2]).toMatchObject({ winnerId: A });
		expect(award.mock.calls[0][0]).toMatchObject({ winner: "challenger" });
	});

	it("names the Dero bot the winner when its opponent gives up", async () => {
		const room = makeRoom(matchOf([A, BOT]), [A]);

		await forfeitBattleship(client, room, A);

		expect(finish.mock.calls[0][2]).toMatchObject({ winnerId: BOT });
		// recordMatchRatings leaves a match with a bot unrated itself; the order still names it.
		expect(ratings).toHaveBeenCalledWith(room, [BOT, A]);
	});

	it("rates and pays nothing when another path already finished the match", async () => {
		finish.mockResolvedValue(false);

		expect(await forfeitBattleship(client, makeRoom(matchOf([A, B])), A)).toBe(false);

		expect(ratings).not.toHaveBeenCalled();
		expect(award).not.toHaveBeenCalled();
	});

	it("ends a match with no fleets on the room's players, unrated", async () => {
		await forfeitBattleship(client, makeRoom(null), A);

		expect(finish.mock.calls[0][2]).toEqual({ winnerId: B, outcome: { bucket: "forfeit" } });
		expect(ratings).not.toHaveBeenCalled();
	});
});
