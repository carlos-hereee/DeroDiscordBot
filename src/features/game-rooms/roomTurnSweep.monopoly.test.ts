import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findPlayingByGame: vi.fn(), updateSecretIf: vi.fn(), findByRoomId: vi.fn(), moveBoardMessage: vi.fn() },
}));
// A Monopoly move's lines ride its turn's board, rather than one postMove each (2026-10
// item 254, Arcade 8; the finished turn's board keeps them since item 263).
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn(), recordCarriedMoves: vi.fn() } }));
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
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── sweepMonopolyIdle ────────────────────────────────────────────────
// A seat that sits on the clock for its idle budget (72 hours since 2026-10 item 267, decision 7)
// is forfeited and the turn passes; the forfeit that leaves one seat finishes the match and pays
// it. A seat inside its budget, or one that has been acting all along, is left alone.

const storeMock = gameRoomStore as unknown as {
	findPlayingByGame: ReturnType<typeof vi.fn>;
	updateSecretIf: ReturnType<typeof vi.fn>;
	findByRoomId: ReturnType<typeof vi.fn>;
	moveBoardMessage: ReturnType<typeof vi.fn>;
};
const postMoveMock = roomTrail.postMove as unknown as ReturnType<typeof vi.fn>;
const carriedMock = roomTrail.recordCarriedMoves as unknown as ReturnType<typeof vi.fn>;
const finishMock = roomLifecycle.finish as unknown as ReturnType<typeof vi.fn>;
const awardMock = awardMultiPlayerResult as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-10-23T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
// The owner's idle budget in hours, pinned as a number so a change to the constant shows here.
const IDLE_HOURS = 72;
const PAST_IDLE_HOURS = IDLE_HOURS + 1;
const A = "player-a";
const B = "player-b";
const C = "player-c";

// The room's channel, holding a board to edit, or to keep as its turn's log once the next turn's board posts.
const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
	messages: { fetch: vi.fn().mockResolvedValue({ edit: vi.fn(), delete: vi.fn(), embeds: [{ description: "the board" }] }) },
	send: vi.fn().mockResolvedValue({ id: "board-2", edit: vi.fn(), delete: vi.fn() }),
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
// Every line the sweep recorded, in order: the finished turn's board, then the new one's.
type RecordedMove = { actorId: string; kind: string; text: string };
const recorded = (): RecordedMove[] => carriedMock.mock.calls.map((call) => call[1] as RecordedMove[]).flat();
const trailTexts = (): string[] => recorded().map((move) => move.text);

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.updateSecretIf.mockResolvedValue({} as never);
	storeMock.findByRoomId.mockResolvedValue(null);
	storeMock.moveBoardMessage.mockResolvedValue({});
	postMoveMock.mockResolvedValue(true);
	finishMock.mockResolvedValue(true);
	vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("sweepMonopolyIdle", () => {
	it("does nothing when no Monopoly match is live", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([]);
		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 0, matchesFinished: 0 });
		expect(storeMock.findPlayingByGame).toHaveBeenCalledWith("monopoly");
	});

	it("forfeits the seat on the clock after 73 idle hours and passes the turn", async () => {
		expect(BOT_CONSTANTS.GAME_ROOM_MONOPOLY_IDLE_MS).toBe(IDLE_HOURS * HOUR);
		const room = makeRoom([A, B, C], PAST_IDLE_HOURS);
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
		const room = makeRoom([A, B], PAST_IDLE_HOURS);
		storeMock.findPlayingByGame.mockResolvedValue([room]);

		const summary = await sweepMonopolyIdle(client, NOW);

		expect(summary).toEqual({ seatsForfeited: 1, matchesFinished: 1 });
		expect(persisted()).toMatchObject({ phase: "finished", winnerId: B });
		// objectContaining because the winner card (2026-10 item 243) rides along as `art` when it draws.
		expect(finishMock).toHaveBeenCalledWith(client, room, expect.objectContaining({ winnerId: B }));
		expect(awardMock).toHaveBeenCalledWith(expect.objectContaining({ game: "monopoly", winnerId: B, nonWinnerOutcome: "lost" }));
	});

	it("leaves a seat alone inside its 72 hours", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom([A, B], IDLE_HOURS - 1)]);

		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 0, matchesFinished: 0 });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
		expect(trailTexts()).toEqual([]);
	});

	it("leaves alone a seat whose turn began past its budget but which moved an hour ago", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom([A, B], PAST_IDLE_HOURS, 1)]);

		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 0, matchesFinished: 0 });
	});

	it("gives the player the tie: a move that landed after the read wins and nothing is posted", async () => {
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom([A, B], PAST_IDLE_HOURS)]);
		storeMock.updateSecretIf.mockResolvedValue(null);

		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 0, matchesFinished: 0 });
		expect(trailTexts()).toEqual([]);
		expect(finishMock).not.toHaveBeenCalled();
	});

	it("skips a row with no board and a match that already finished", async () => {
		const unseeded = { ...makeRoom([A, B], PAST_IDLE_HOURS), secret: null } as unknown as IGameRoom;
		const finished = makeRoom([A, B], PAST_IDLE_HOURS);
		(finished.secret as unknown as MonopolyState).phase = "finished";
		storeMock.findPlayingByGame.mockResolvedValue([unseeded, finished]);

		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 0, matchesFinished: 0 });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
	it("declares a debtor who left a held debt past the idle budget bankrupt to whoever they owed, rather than forfeiting the seat on the clock", async () => {
		// B owes A $100 from a card on A's turn, could cover it with Rail One, and never paid.
		const room = makeRoom([A, B], PAST_IDLE_HOURS);
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

	// 2026-10 item 276, audit P3: the host's removal gives up after its retries when moves keep
	// landing first, and the member it already took out of the room left a seat nobody could play,
	// holding the match up for the whole idle budget. The sweep finishes the job on its next tick.
	it("takes out a seat the host removed that a busy board kept, inside the idle budget", async () => {
		const room = { ...makeRoom([A, B, C], 1), kickedIds: [B] } as unknown as IGameRoom;
		storeMock.findPlayingByGame.mockResolvedValue([room]);

		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 1, matchesFinished: 0 });
		expect(storeMock.updateSecretIf).toHaveBeenCalledOnce();
		expect(persisted().seats[1].bankrupt).toBe(true);
		// The seat on the clock, inside its budget, keeps its turn.
		expect(persisted().seats[0].bankrupt).toBe(false);
	});

	it("leaves a removed member alone once their seat is already out", async () => {
		const room = { ...makeRoom([A, B, C], 1), kickedIds: [B] } as unknown as IGameRoom;
		(room.secret as unknown as MonopolyState).seats[1].bankrupt = true;
		storeMock.findPlayingByGame.mockResolvedValue([room]);

		expect(await sweepMonopolyIdle(client, NOW)).toEqual({ seatsForfeited: 0, matchesFinished: 0 });
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
});
