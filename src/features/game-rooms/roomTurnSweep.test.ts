import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findPlayingByGame: vi.fn(), update: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardTwoPlayerResult: vi.fn() }));

import { sweepBattleshipTurns } from "./roomTurnSweep.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import { startMatch, type StoredBattleship } from "./roomBattleship.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as {
	findPlayingByGame: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
};
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };
const lifecycleMock = roomLifecycle as unknown as { finish: ReturnType<typeof vi.fn> };
const awardMock = awardTwoPlayerResult as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-08-12T12:00:00.000Z");
const TIMEOUT = BOT_CONSTANTS.GAME_ROOM_TURN_TIMEOUT_MS;
const A = "player-a";
const B = "player-b";

const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;

// ⚠️ A CONSTANT rng CANNOT PLACE A FLEET. placeFleet retries on a collision, so
// `() => 0.5` puts every ship in the same square and it throws after 500 attempts,
// correctly. A deterministic generator that actually VARIES is what a placement
// test fixture needs; this is a plain LCG so the layout is repeatable run to run.
function seededRng(seed = 1): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function makeMatch(overrides: Partial<StoredBattleship> = {}): StoredBattleship {
	const base = startMatch({ playerIds: [A, B] } as IGameRoom, { [A]: "A", [B]: "B" }, seededRng());
	return { ...base, ...overrides };
}

function makeRoom(idleMs: number, match: StoredBattleship = makeMatch(), moves = true): IGameRoom {
	const at = new Date(NOW.getTime() - idleMs);
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "battleship",
		status: "playing",
		playerIds: [A, B],
		channelId: "ch-1",
		startedAt: at,
		moves: moves ? [{ actorId: A, at, kind: "guess", text: "fired" }] : [],
		secret: match,
	} as unknown as IGameRoom;
}

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
	trailMock.postMove.mockResolvedValue(true);
	lifecycleMock.finish.mockResolvedValue(undefined);
});

describe("sweepBattleshipTurns", () => {
	it("does nothing when no battleship match is live", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([]);
		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0 });
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});

	it("leaves a match alone while the player is still inside the turn budget", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT - 1000)]);

		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0 });
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("expires the turn once the budget has passed, and passes play to the other side", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000)]);

		const summary = await sweepBattleshipTurns(client, NOW);

		expect(summary).toEqual({ turnsExpired: 1, matchesForfeited: 0 });
		// The turn moved, and the match is NOT over on a single expiry.
		const saved = storeMock.update.mock.calls[0][2].secret as StoredBattleship;
		expect(saved.turn).toBe(1);
		expect(saved.status).toBe("playing");
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
	});

	// ⚠️ THE POINT OF THE WHOLE SWEEP. Without it a walked-away match never reaches
	// finish, so archiveAt is never stamped (it has exactly one writer), the archive
	// sweep never sees the room, and it holds its host's one-room slot forever.
	it("forfeits the MATCH on a second consecutive expiry and finishes the room", async () => {
		const match = makeMatch({ missedTurns: [1, 0] });
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000, match)]);

		const summary = await sweepBattleshipTurns(client, NOW);

		expect(summary).toEqual({ turnsExpired: 0, matchesForfeited: 1 });
		expect(lifecycleMock.finish).toHaveBeenCalledOnce();
		// The player who did NOT walk away wins.
		expect(lifecycleMock.finish.mock.calls[0][2]).toMatchObject({ winnerId: B });
	});

	it("still pays the win when a match is won by forfeit", async () => {
		// Turning up when the other player did not is exactly the behaviour being
		// rewarded, so a forfeit win is a win.
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000, makeMatch({ missedTurns: [1, 0] }))]);

		await sweepBattleshipTurns(client, NOW);

		expect(awardMock).toHaveBeenCalledOnce();
		expect(awardMock.mock.calls[0][0]).toMatchObject({ game: "battleship", winner: "opponent" });
	});

	it("records the expiry as a MOVE, so the transcript says why the match ended", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000)]);

		await sweepBattleshipTurns(client, NOW);

		expect(trailMock.postMove).toHaveBeenCalledOnce();
		// Attributed to the player who missed, captured BEFORE expireTurn passes the
		// turn to the other one.
		expect(trailMock.postMove.mock.calls[0][2]).toMatchObject({ actorId: A });
	});

	// A match with no shots yet falls back to startedAt, which gives the first
	// player a full budget rather than an instant expiry on the next tick.
	it("gives an unplayed match its full first turn", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT - 1000, makeMatch(), false)]);
		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0 });
	});

	it("ignores a room whose secret is not a battleship match", async () => {
		const room = makeRoom(TIMEOUT + 1000);
		(room as { secret: unknown }).secret = { word: "planet" };
		storeMock.findPlayingByGame.mockResolvedValue([room]);

		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0 });
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("keeps sweeping when one room throws", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000), makeRoom(TIMEOUT + 1000)]);
		storeMock.update.mockRejectedValueOnce(new Error("mongo blip"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		// One fails, the other still expires. A throw here would be swallowed by the
		// cron wrapper while every other stalled match stayed stalled.
		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 1, matchesForfeited: 0 });
		errorSpy.mockRestore();
		logSpy.mockRestore();
	});

	it("never touches a match that already finished", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([
			makeRoom(TIMEOUT + 1000, makeMatch({ status: "finished", winnerId: A })),
		]);

		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0 });
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
	});
});
