import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { update: vi.fn(), findByRoomId: vi.fn(), setSecretField: vi.fn(), updateSecretIf: vi.fn(), setSecretFieldsIf: vi.fn() },
}));
vi.mock("./roomBattleship.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./roomBattleship.js")>()), battleshipBoardCard: vi.fn(async () => null) }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardTwoPlayerResult: vi.fn() }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", () => ({ recordMatchRatings: vi.fn(), twoPlayerFinishingOrder: vi.fn((captains: string[], winnerId: string) => [winnerId, ...captains.filter((id) => id !== winnerId)]) }));

import { forfeitBattleship } from "./roomBattleshipHandlers.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
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
const claimSecret = gameRoomStore.setSecretFieldsIf as unknown as ReturnType<typeof vi.fn>;
const findRoom = gameRoomStore.findByRoomId as unknown as ReturnType<typeof vi.fn>;

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
	// The forfeit's claim on the secret (2026-10 item 280) lands unless a test says otherwise.
	claimSecret.mockResolvedValue({});
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

// ── the forfeit against the winning shot (2026-10 item 280) ───────────
// The winning shot marks the secret finished, then draws for seconds before its finish, while the
// room still says playing. A Surrender or a server leave by the beaten captain in that window used
// to win finish's claim and take the match, the rating and the pot.
describe("forfeitBattleship against a winning shot", () => {
	it("claims the match on the secret, recording the forfeit, before it finishes", async () => {
		await forfeitBattleship(client, makeRoom(matchOf([A, B])), A);

		expect(claimSecret).toHaveBeenCalledWith("guild-1", "room-1", { "secret.status": { $in: ["setup", "playing"] } }, { status: "finished", winnerId: B, forfeit: { loserId: A, bucket: "forfeit" } });
		expect(claimSecret.mock.invocationCallOrder[0]).toBeLessThan(finish.mock.invocationCallOrder[0]);
	});

	it("finishes as the shooter's played win when the shot was saved first", async () => {
		claimSecret.mockResolvedValue(null);
		findRoom.mockResolvedValue(makeRoom({ ...matchOf([A, B]), status: "finished", winnerId: A }));

		expect(await forfeitBattleship(client, makeRoom(matchOf([A, B])), B)).toBe(true);

		const input = finish.mock.calls[0][2] as { winnerId: string; outcome: { bucket: string } };
		expect(input.winnerId).toBe(A);
		expect(["forfeit", "timeout"]).not.toContain(input.outcome.bucket);
		expect(ratings).toHaveBeenCalledWith(expect.anything(), [A, B]);
		expect(award.mock.calls[0][0]).toMatchObject({ winner: "challenger" });
	});

	it("does nothing more when the room finished before the forfeit's claim", async () => {
		claimSecret.mockResolvedValue(null);
		findRoom.mockResolvedValue({ ...makeRoom({ ...matchOf([A, B]), status: "finished", winnerId: A }), status: "finished" });

		expect(await forfeitBattleship(client, makeRoom(matchOf([A, B])), B)).toBe(false);
		expect(finish).not.toHaveBeenCalled();
	});
});
