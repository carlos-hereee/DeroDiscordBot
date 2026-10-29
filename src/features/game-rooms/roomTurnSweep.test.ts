import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findPlayingByGame: vi.fn(), findByRoomId: vi.fn(), update: vi.fn(), updateSecretIf: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardTwoPlayerResult: vi.fn() }));
// The battle's board is drawn by the handlers' own suites; here only what the expiry hands the
// shared turn board. The expiry lives beside the redraw since 2026-10 item 267 (the turn clock calls
// it too), so the board is watched where the redraw posts it, with no picture drawn.
vi.mock("./turnBoard.js", () => ({ postTurnBoard: vi.fn(async () => "board-2") }));
vi.mock("./roomBattleship.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./roomBattleship.js")>()), battleshipBoardCard: vi.fn(async () => null) }));

import { sweepBattleshipTurns } from "./roomTurnSweep.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import { startMatch, type StoredBattleship } from "./roomBattleship.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { _resetDrawingPauses, roomDrawingKey, withDrawingPause } from "./drawingPause.js";
import { postTurnBoard } from "./turnBoard.js";

const storeMock = gameRoomStore as unknown as {
	findPlayingByGame: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
	updateSecretIf: ReturnType<typeof vi.fn>;
};
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };
const lifecycleMock = roomLifecycle as unknown as { finish: ReturnType<typeof vi.fn> };
const awardMock = awardTwoPlayerResult as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-08-12T12:00:00.000Z");
const TIMEOUT = BOT_CONSTANTS.GAME_ROOM_TURN_TIMEOUT_MS;
const A = "player-a";
const B = "player-b";

const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;

// A client whose room channel resolves, so the expiry's redraw reaches the turn board.
function boardClient(): Client {
	const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, { messages: { fetch: vi.fn(async () => null) } });
	return { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
}
const boardMock = postTurnBoard as unknown as ReturnType<typeof vi.fn>;

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

// Past setup by default, the state every turn case below is about; the setup clock
// cases pass `status: "setup"` back in.
function makeMatch(overrides: Partial<StoredBattleship> = {}): StoredBattleship {
	const base = startMatch({ playerIds: [A, B] } as IGameRoom, { [A]: "A", [B]: "B" }, seededRng());
	return { ...base, status: "playing", ready: [true, true], ...overrides };
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
	// The expiry is a compare and swap on the turn it read (2026-10 item 267); written unless a test says otherwise.
	storeMock.updateSecretIf.mockResolvedValue({});
	trailMock.postMove.mockResolvedValue(true);
	lifecycleMock.finish.mockResolvedValue(undefined);
});

describe("sweepBattleshipTurns", () => {
	it("does nothing when no battleship match is live", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([]);
		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0, setupsTimedOut: 0 });
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});

	it("leaves a match alone while the player is still inside the turn budget", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT - 1000)]);

		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0, setupsTimedOut: 0 });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("expires the turn once the budget has passed, and passes play to the other side", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000)]);

		const summary = await sweepBattleshipTurns(client, NOW);

		expect(summary).toEqual({ turnsExpired: 1, matchesForfeited: 0, setupsTimedOut: 0 });
		// The turn moved, and the match is NOT over on a single expiry.
		const saved = storeMock.updateSecretIf.mock.calls[0][3] as StoredBattleship;
		expect(saved.turn).toBe(1);
		expect(saved.status).toBe("playing");
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
	});

	// Two paths end a turn now, the turn clock at its deadline and this sweep (2026-10 item 267), so
	// the expiry writes only over the turn it read: the same captain, missed count and shots.
	it("writes the expiry only over the turn it read, so a clock and a sweep landing together expire it once", async () => {
		const match = makeMatch({ boardMessageId: "board-1" });
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000, match)]);
		storeMock.updateSecretIf.mockResolvedValueOnce(null);

		expect(await sweepBattleshipTurns(boardClient(), NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0, setupsTimedOut: 0 });
		expect(storeMock.updateSecretIf.mock.calls[0][2]).toEqual({
			"secret.status": "playing",
			"secret.turn": match.turn,
			"secret.missedTurns": match.missedTurns,
			"secret.players.0.shots": match.players[0].shots,
			"secret.players.1.shots": match.players[1].shots,
		});
		expect(boardMock).not.toHaveBeenCalled();
	});

	// ⚠️ THE POINT OF THE WHOLE SWEEP. Without it a walked-away match never reaches
	// finish, so archiveAt is never stamped (it has exactly one writer), the archive
	// sweep never sees the room, and it holds its host's one-room slot forever.
	it("forfeits the MATCH on a second consecutive expiry and finishes the room", async () => {
		const match = makeMatch({ missedTurns: [1, 0] });
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000, match)]);

		const summary = await sweepBattleshipTurns(client, NOW);

		expect(summary).toEqual({ turnsExpired: 0, matchesForfeited: 1, setupsTimedOut: 0 });
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

	// The expired turn is a turn: its line rides that turn's board as its This turn block, which
	// records it once the board posts (2026-10 item 263 R3-29), never as a line of its own.
	it("records the expiry as a MOVE on the expired turn's board, so the transcript says why the match ended", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000, makeMatch({ boardMessageId: "board-1" }))]);

		await sweepBattleshipTurns(boardClient(), NOW);

		expect(trailMock.postMove).not.toHaveBeenCalled();
		expect(boardMock).toHaveBeenCalledOnce();
		// Attributed to the player who missed, captured BEFORE expireTurn passes the
		// turn to the other one.
		expect(boardMock.mock.calls[0][4]).toEqual({ carried: [expect.objectContaining({ actorId: A, kind: "system", meta: { expired: true } })] });
	});

	// A match with no shots yet falls back to startedAt, which gives the first
	// player a full budget rather than an instant expiry on the next tick.
	it("gives an unplayed match its full first turn", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT - 1000, makeMatch(), false)]);
		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0, setupsTimedOut: 0 });
	});

	it("ignores a room whose secret is not a battleship match", async () => {
		const room = makeRoom(TIMEOUT + 1000);
		(room as { secret: unknown }).secret = { word: "planet" };
		storeMock.findPlayingByGame.mockResolvedValue([room]);

		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0, setupsTimedOut: 0 });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("keeps sweeping when one room throws", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000), makeRoom(TIMEOUT + 1000)]);
		storeMock.updateSecretIf.mockRejectedValueOnce(new Error("mongo blip"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		// One fails, the other still expires. A throw here would be swallowed by the
		// cron wrapper while every other stalled match stayed stalled.
		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 1, matchesForfeited: 0, setupsTimedOut: 0 });
		errorSpy.mockRestore();
		logSpy.mockRestore();
	});

	it("never touches a match that already finished", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([
			makeRoom(TIMEOUT + 1000, makeMatch({ status: "finished", winnerId: A })),
		]);

		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0, setupsTimedOut: 0 });
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
	});
});

// ── the drawing pause (Dero 1.7.0 test fixes, Phase 3a) ────────────────────
describe("a board that is drawing", () => {
	it("keeps its turn, however long past the budget, until the draw is done", async () => {
		_resetDrawingPauses();
		const room = makeRoom(TIMEOUT + 60_000);
		storeMock.findPlayingByGame.mockResolvedValue([room]);
		let finish: (value: null) => void = () => undefined;
		const pending = new Promise<null>((resolve) => {
			finish = resolve;
		});
		const drawing = withDrawingPause({
			gameKey: roomDrawingKey(room),
			showStatus: async () => undefined,
			render: () => pending,
			fallback: () => null,
			swapIn: async () => undefined,
		});

		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0, setupsTimedOut: 0 });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();

		finish(null);
		await drawing;
		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 1, matchesForfeited: 0, setupsTimedOut: 0 });
	});
});

// ── the setup clock (post-launch plan item 17) ────────────────────────
describe("sweepBattleshipTurns, setup", () => {
	const inSetup = (): StoredBattleship => makeMatch({ status: "setup", ready: [true, false] });

	it("leaves setup alone inside the budget", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT - 1000, inSetup())]);

		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0, setupsTimedOut: 0 });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("starts the battle as laid when the setup clock runs out, and forfeits nobody", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000, inSetup())]);
		storeMock.updateSecretIf.mockResolvedValue({});

		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0, setupsTimedOut: 1 });
		const [, , expected, saved] = storeMock.updateSecretIf.mock.calls[0] as [string, string, Record<string, unknown>, StoredBattleship];
		expect(expected).toEqual({ "secret.status": "setup" });
		expect(saved.status).toBe("playing");
		expect(saved.ready).toEqual([true, true]);
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
		expect(trailMock.postMove.mock.calls[0][2]).toMatchObject({ text: gameRoomsCopy.battleship.setupTimedOut });
	});

	it("says nothing when a Ready started the battle first", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(TIMEOUT + 1000, inSetup())]);
		storeMock.updateSecretIf.mockResolvedValue(null);

		expect(await sweepBattleshipTurns(client, NOW)).toEqual({ turnsExpired: 0, matchesForfeited: 0, setupsTimedOut: 0 });
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});
});
