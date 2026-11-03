import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Dero's variant lines always pick the first, so these tests read exact words.
vi.mock("@utils/pickLine.js", () => ({ pickLine: <Line>(lines: readonly Line[]): Line => lines[0] as Line }));
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: vi.fn(), updateSecretIf: vi.fn(), update: vi.fn(), findNonTerminal: vi.fn(), moveBoardMessage: vi.fn() },
}));
vi.mock("./roomTrail.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./roomTrail.js")>()),
	roomTrail: { postTurnPrompt: vi.fn(async () => null), postMove: vi.fn(async () => true), recordCarriedMoves: vi.fn(async () => undefined) },
}));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn(async () => true) } }));
vi.mock("@features/voice/voiceSessions.js", () => ({ voiceSessions: { get: vi.fn(() => null) } }));

import { syncTurnClocks, _resetTurnClocks, type TurnClockGame } from "./turnClock.js";
import { holdemTurnClock } from "./roomHoldemHandlers.js";
import { battleshipTurnClock } from "./roomBattleshipHandlers.js";
import { monopolyAuctionTurnClock, monopolyIdleTurnClock } from "./roomMonopolyHandlers.js";
import { sweepIdleRooms } from "./roomTurnSweep.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { _resetDrawingPauses } from "./drawingPause.js";
import { startMatch, type StoredBattleship } from "./roomBattleship.js";
import { createTable, dealHand, joinTable, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── every timed turn on the turn clock (2026-10 item 267, owner decision 15) ───────────
// Each game's own clock over its real turn reading and its real timeout function: Hold'em's
// turn, Battleship's turn, a Monopoly seat's idle turn and a Monopoly auction round (Blackjack's,
// whose table lives in its handler's process, is pinned in blackjackHandler.bankroll.test.ts).
// For each, the warning fires once at the deadline minus ten seconds pinging only the member on
// the clock, the turn ends at the deadline through the function the game's sweep calls (seen as
// its compare and swap write, refused here so nothing else runs), and neither fires for a turn
// that passed first. Fake timers from a fixed clock throughout.

const findMock = gameRoomStore.findByRoomId as unknown as ReturnType<typeof vi.fn>;
const writeMock = gameRoomStore.updateSecretIf as unknown as ReturnType<typeof vi.fn>;
const nonTerminalMock = gameRoomStore.findNonTerminal as unknown as ReturnType<typeof vi.fn>;
const promptMock = roomTrail.postTurnPrompt as unknown as ReturnType<typeof vi.fn>;
const finishMock = roomLifecycle.finish as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const LEAD = BOT_CONSTANTS.TURN_WARNING_LEAD_MS;
const A = "player-a";
const B = "player-b";

const client = { channels: { fetch: vi.fn(async () => null) }, guilds: { cache: new Map() } } as unknown as Client;

function seededRng(seed = 7): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function roomOf(game: IGameRoom["game"], secret: unknown, overrides: Partial<IGameRoom> = {}): IGameRoom {
	return { roomId: "room-1", guildId: "guild-1", hostId: A, game, status: "playing", playerIds: [A, B], channelId: "ch-1", startedAt: new Date(NOW), moves: [], secret, ...overrides } as unknown as IGameRoom;
}

/** One game's clock, its room, how long its turn runs, who is on it, and the row once that turn passed. */
interface ClockCase {
	name: string;
	clock: TurnClockGame;
	room: () => IGameRoom;
	turnMs: number;
	member: (room: IGameRoom) => string;
	passed: (room: IGameRoom) => IGameRoom;
}

function holdemTable(): HoldemTable {
	const table = createTable(NOW);
	joinTable(table, A, "Ana");
	joinTable(table, B, "Ben");
	table.status = "playing";
	dealHand(table, seededRng());
	return table;
}

function monopolyState(): MonopolyState {
	return createInitialState([A, B], { auctionsEnabled: true }, NOW, 1);
}

const CASES: ClockCase[] = [
	{
		name: "Hold'em",
		clock: holdemTurnClock,
		room: () => roomOf("holdem", holdemTable()),
		turnMs: BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS,
		member: (room) => whoActs(room.secret as HoldemTable) ?? "",
		// A move moves the table's action stamp, which is the turn's fingerprint.
		passed: (room) => roomOf("holdem", { ...(room.secret as HoldemTable), lastActionAt: NOW + 1_000 }),
	},
	{
		name: "Battleship",
		clock: battleshipTurnClock,
		room: () => roomOf("battleship", { ...startMatch(roomOf("battleship", null), { [A]: "Ana", [B]: "Ben" }, seededRng()), status: "playing", ready: [true, true] }),
		turnMs: BOT_CONSTANTS.GAME_ROOM_TURN_TIMEOUT_MS,
		member: (room) => {
			const stored = room.secret as StoredBattleship;
			return stored.players[stored.turn].userId;
		},
		// A shot hands the other captain the turn.
		passed: (room) => {
			const stored = room.secret as StoredBattleship;
			return roomOf("battleship", { ...stored, turn: stored.turn === 0 ? 1 : 0, players: [{ ...stored.players[0], shots: ["A1"] }, stored.players[1]] });
		},
	},
	{
		name: "Monopoly's idle seat",
		clock: monopolyIdleTurnClock,
		room: () => roomOf("monopoly", monopolyState()),
		turnMs: BOT_CONSTANTS.GAME_ROOM_MONOPOLY_IDLE_MS,
		member: (room) => {
			const state = room.secret as MonopolyState;
			return state.seats[state.activeSeatIndex].userId;
		},
		// The seat ended its turn: the next seat holds the clock.
		passed: (room) => {
			const state = room.secret as MonopolyState;
			return roomOf("monopoly", { ...state, activeSeatIndex: (state.activeSeatIndex + 1) % state.seats.length, stats: { ...state.stats, turnsTaken: (state.stats?.turnsTaken ?? 0) + 1 } });
		},
	},
	{
		name: "a Monopoly auction round",
		clock: monopolyAuctionTurnClock,
		room: () => roomOf("monopoly", { ...monopolyState(), phase: "in-auction", pendingAuction: { tileId: "burnt-umber-row", bids: {}, roundOpenedAt: NOW, skippedBy: A } }),
		turnMs: BOT_CONSTANTS.MONOPOLY_AUCTION_ROUND_MS,
		member: (room) => {
			const state = room.secret as MonopolyState;
			return state.seats[state.activeSeatIndex].userId;
		},
		// The round closed: the seller's turn carries on with no auction.
		passed: (room) => roomOf("monopoly", { ...(room.secret as MonopolyState), phase: "post-roll", pendingAuction: null }),
	},
];

let row: IGameRoom;

beforeEach(() => {
	vi.useFakeTimers({ now: NOW });
	vi.clearAllMocks();
	_resetTurnClocks();
	_resetDrawingPauses();
	findMock.mockImplementation(async () => row);
	// The timeout function's compare and swap is refused, so the case sees it ran and nothing after.
	writeMock.mockResolvedValue(null);
});

afterEach(() => {
	_resetTurnClocks();
	vi.useRealTimers();
});

describe.each(CASES)("$name", ({ clock, room, turnMs, member, passed }) => {
	it("warns once at the deadline minus ten seconds, pinging only the member on the clock, and ends the turn at the deadline", async () => {
		row = room();
		const memberId = member(row);
		expect(memberId).not.toBe("");
		await syncTurnClocks(client, row, [clock]);

		await vi.advanceTimersByTimeAsync(turnMs - LEAD - 1);
		expect(promptMock).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(promptMock).toHaveBeenCalledOnce();
		expect(promptMock.mock.calls[0][2]).toEqual({ playerId: memberId, text: gameRoomsCopy.turnClock.warningLine[0](memberId, LEAD / 1000), components: [] });

		await vi.advanceTimersByTimeAsync(LEAD - 1);
		expect(writeMock).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		// The game's own timeout function ran at the deadline: its write is the turn's end.
		expect(writeMock).toHaveBeenCalledOnce();
		expect(promptMock).toHaveBeenCalledOnce();
	});

	it("neither warns nor ends a turn that passed first", async () => {
		row = room();
		await syncTurnClocks(client, row, [clock]);
		row = passed(row);

		await vi.advanceTimersByTimeAsync(turnMs + BOT_CONSTANTS.TURN_CLOCK_RETRY_MS * 10);
		expect(promptMock).not.toHaveBeenCalled();
		expect(writeMock).not.toHaveBeenCalled();
	});
});

// FROM 2b: Battleship's 30 minute turn EQUALS the 30 minute idle abandon window, so the turn's own
// end must land first or the idle sweep would abandon a match a captain merely let a turn pass in.
describe("Battleship's turn against the idle sweep", () => {
	it("ends the turn exactly at its deadline, before an idle sweep at that same moment could abandon the room", async () => {
		expect(BOT_CONSTANTS.GAME_ROOM_TURN_TIMEOUT_MS).toBe(BOT_CONSTANTS.GAME_ROOM_IDLE_ABANDON_MS);
		const battle = CASES[1];
		// The captain's last shot, the row's last write too: the two clocks start together.
		const lastShot = new Date(NOW);
		row = roomOf("battleship", (battle.room().secret as StoredBattleship), { moves: [{ actorId: A, at: lastShot, kind: "guess", text: "fired" }], updatedAt: lastShot } as Partial<IGameRoom>);
		writeMock.mockImplementation(async () => ({ ...row, updatedAt: new Date(Date.now()) }));
		const captainBefore = (row.secret as StoredBattleship).turn;
		await syncTurnClocks(client, row, [battle.clock]);

		// Without the clock, the idle sweep at the deadline would find the row as the shot left it.
		const deadline = NOW + BOT_CONSTANTS.GAME_ROOM_TURN_TIMEOUT_MS;
		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.GAME_ROOM_TURN_TIMEOUT_MS);
		expect(writeMock).toHaveBeenCalledOnce();
		const expired = writeMock.mock.calls[0][3] as StoredBattleship;
		// The turn passed to the other captain, as an expiry does.
		expect(expired.turn).not.toBe(captainBefore);

		// The sweep's tick at that same moment reads the row the turn's end wrote, and abandons nothing.
		nonTerminalMock.mockResolvedValue([{ ...row, secret: expired, updatedAt: new Date(deadline) }]);
		expect(await sweepIdleRooms(client, new Date(deadline))).toEqual({ roomsAbandoned: 0 });
		expect(finishMock).not.toHaveBeenCalled();

		// The race the clock wins: the row as the shot left it is already past the idle window.
		nonTerminalMock.mockResolvedValue([row]);
		expect(await sweepIdleRooms(client, new Date(deadline))).toEqual({ roomsAbandoned: 1 });
	});
});
