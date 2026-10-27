import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findPlayingByGame: vi.fn(), updateSecretIf: vi.fn(), findByRoomId: vi.fn(), moveMonopolyBoard: vi.fn() },
}));
// A Monopoly move's lines ride the board, or the finished turn's log message, rather
// than one postMove each (2026-10 item 254, Arcade 8).
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn(), postMoveLog: vi.fn(), recordCarriedMoves: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardTwoPlayerResult: vi.fn(), awardMultiPlayerResult: vi.fn() }));

import { sweepMonopolyIdle } from "./roomTurnSweep.js";
import { turnFingerprint } from "./roomMonopolyHandlers.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { awardMultiPlayerResult } from "@features/games/gameXp.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── sweepMonopolyIdle ────────────────────────────────────────────────
// A seat that sits on the clock for a day is forfeited and the turn passes; the
// forfeit that leaves one seat finishes the match and pays it. A seat inside its
// day, or one that has been acting all along, is left alone.

const storeMock = gameRoomStore as unknown as {
	findPlayingByGame: ReturnType<typeof vi.fn>;
	updateSecretIf: ReturnType<typeof vi.fn>;
	findByRoomId: ReturnType<typeof vi.fn>;
	moveMonopolyBoard: ReturnType<typeof vi.fn>;
};
const postMoveMock = roomTrail.postMove as unknown as ReturnType<typeof vi.fn>;
const carriedMock = roomTrail.recordCarriedMoves as unknown as ReturnType<typeof vi.fn>;
const moveLogMock = roomTrail.postMoveLog as unknown as ReturnType<typeof vi.fn>;
const finishMock = roomLifecycle.finish as unknown as ReturnType<typeof vi.fn>;
const awardMock = awardMultiPlayerResult as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-10-23T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const A = "player-a";
const B = "player-b";
const C = "player-c";

// The room's channel, holding a board to edit or replace.
const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
	messages: { fetch: vi.fn().mockResolvedValue({ edit: vi.fn(), delete: vi.fn() }) },
	send: vi.fn().mockResolvedValue({ id: "board-2", delete: vi.fn() }),
});
const client = {
	channels: { fetch: vi.fn().mockResolvedValue(channel) },
	guilds: { cache: new Map(), fetch: vi.fn().mockResolvedValue(null) },
} as unknown as Client;

function makeRoom(players: string[], turnIdleHours: number, lastMoveHoursAgo: number | null = turnIdleHours): IGameRoom {
	const state = createInitialState(players, { auctionsEnabled: false }, NOW.getTime() - turnIdleHours * HOUR, 1);
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "monopoly",
		status: "playing",
		playerIds: players,
		channelId: "ch-1",
		startedAt: new Date(NOW.getTime() - turnIdleHours * HOUR),
		moves:
			lastMoveHoursAgo === null
				? []
				: [{ actorId: A, at: new Date(NOW.getTime() - lastMoveHoursAgo * HOUR), kind: "guess", text: "rolled" }],
		secret: state,
	} as unknown as IGameRoom;
}

const persisted = (): MonopolyState => storeMock.updateSecretIf.mock.calls[0][3] as MonopolyState;
// Every line the sweep recorded, in order: the finished turn's log, then the board's.
type RecordedMove = { actorId: string; kind: string; text: string };
const recorded = (): RecordedMove[] =>
	[...moveLogMock.mock.calls.map((call) => (call[2] as { moves: RecordedMove[] }).moves), ...carriedMock.mock.calls.map((call) => call[1] as RecordedMove[])].flat();
const trailTexts = (): string[] => recorded().map((move) => move.text);

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.updateSecretIf.mockResolvedValue({} as never);
	storeMock.findByRoomId.mockResolvedValue(null);
	storeMock.moveMonopolyBoard.mockResolvedValue({});
	postMoveMock.mockResolvedValue(true);
	moveLogMock.mockResolvedValue(true);
	finishMock.mockResolvedValue(true);
	vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("sweepMonopolyIdle", () => {
	it("does nothing when no Monopoly match is live", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([]);
		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 0, matchesFinished: 0 });
		expect(storeMock.findPlayingByGame).toHaveBeenCalledWith("monopoly");
	});

	it("forfeits the seat on the clock after 25 idle hours and passes the turn", async () => {
		const room = makeRoom([A, B, C], 25);
		storeMock.findPlayingByGame.mockResolvedValue([room]);

		const summary = await sweepMonopolyIdle(client, NOW);

		expect(summary).toEqual({ seatsForfeited: 1, matchesFinished: 0 });
		expect(persisted().seats[0].bankrupt).toBe(true);
		expect(persisted().activeSeatIndex).toBe(1);
		// The compare and swap is against the turn the sweep read.
		expect(storeMock.updateSecretIf.mock.calls[0][2]).toEqual(turnFingerprint(room.secret as unknown as MonopolyState));
		expect(trailTexts()[0]).toBe(gameRoomsCopy.monopoly.idleForfeit(A));
		expect(recorded()[0]).toMatchObject({ actorId: A, kind: "system" });
		expect(finishMock).not.toHaveBeenCalled();
	});

	it("finishes a two seat match and records the result when the forfeit leaves one seat", async () => {
		const room = makeRoom([A, B], 25);
		storeMock.findPlayingByGame.mockResolvedValue([room]);

		const summary = await sweepMonopolyIdle(client, NOW);

		expect(summary).toEqual({ seatsForfeited: 1, matchesFinished: 1 });
		expect(persisted()).toMatchObject({ phase: "finished", winnerId: B });
		// objectContaining because the winner card (2026-10 item 243) rides along as `art` when it draws.
		expect(finishMock).toHaveBeenCalledWith(client, room, expect.objectContaining({ winnerId: B }));
		expect(awardMock).toHaveBeenCalledWith(expect.objectContaining({ game: "monopoly", winnerId: B, nonWinnerOutcome: "lost" }));
	});

	it("leaves a seat alone inside its 24 hours", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom([A, B], 23)]);

		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 0, matchesFinished: 0 });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
		expect(trailTexts()).toEqual([]);
	});

	it("leaves alone a seat whose turn began a day ago but which moved an hour ago", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom([A, B], 25, 1)]);

		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 0, matchesFinished: 0 });
	});

	it("gives the player the tie: a move that landed after the read wins and nothing is posted", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom([A, B], 25)]);
		storeMock.updateSecretIf.mockResolvedValue(null);

		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 0, matchesFinished: 0 });
		expect(trailTexts()).toEqual([]);
		expect(finishMock).not.toHaveBeenCalled();
	});

	it("skips a row with no board and a match that already finished", async () => {
		const unseeded = { ...makeRoom([A, B], 25), secret: null } as unknown as IGameRoom;
		const finished = makeRoom([A, B], 25);
		(finished.secret as unknown as MonopolyState).phase = "finished";
		storeMock.findPlayingByGame.mockResolvedValue([unseeded, finished]);

		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 0, matchesFinished: 0 });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
	it("declares a debtor who left a held debt for a day bankrupt to whoever they owed, rather than forfeiting the seat on the clock", async () => {
		// B owes A $100 from a card on A's turn, could cover it with Rail One, and never paid.
		const room = makeRoom([A, B], 25);
		const state = room.secret as unknown as MonopolyState;
		state.phase = "awaiting-debt";
		state.seats[1].chips = 0;
		state.properties["rail-one"].ownerId = B;
		state.pendingDebt = { debts: [{ debtorId: B, creditorId: A, amount: 100 }], resumePhase: "post-roll", moveAfter: null };
		storeMock.findPlayingByGame.mockResolvedValue([room]);

		const summary = await sweepMonopolyIdle(client, NOW);

		expect(summary).toEqual({ seatsForfeited: 1, matchesFinished: 1 });
		expect(persisted().seats[1].bankrupt).toBe(true);
		expect(persisted().properties["rail-one"].ownerId).toBe(A);
		expect(trailTexts()[0]).toBe(gameRoomsCopy.monopoly.idleDebtDefault(B));
		expect(trailTexts()[1]).toBe(`<@${B}> never paid the $100 they owed and is bankrupt.`);
		expect(recorded()[0]).toMatchObject({ actorId: B, kind: "system" });
	});
});
