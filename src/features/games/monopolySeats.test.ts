import { describe, it, expect } from "vitest";
import { applyForfeit, createInitialState, openAuction, type MonopolyState } from "./monopolyState.js";
import { completeAction, ensureStats, passTurn } from "./monopolySeats.js";
import { BOARD, isOwnableTile } from "./monopolyBoard.js";

// ── the match facts the engine keeps (post-launch plan item 21) ──────
// The closed challenge card reads how a Monopoly match went from `stats`: turns,
// auctions, forfeits and each seat's lowest share of the cash. Each counter is pinned
// at the one engine step that moves it.

const ALICE = "alice";
const BOB = "bob";
const NOW = 1_700_000_000_000;

const fresh = (auctionsEnabled = false): MonopolyState => createInitialState([ALICE, BOB], { auctionsEnabled }, NOW, 42);

describe("ensureStats", () => {
	it("starts absent and is created once, empty", () => {
		const state = fresh();
		expect(state.stats).toBeUndefined();
		const stats = ensureStats(state);
		expect(stats).toEqual({ turnsTaken: 0, auctionsOpened: 0, forfeits: 0, lowestCashShare: {} });
		expect(ensureStats(state)).toBe(stats);
	});
});

describe("the counters", () => {
	it("counts a turn each time the clock is handed on", () => {
		const state = fresh();
		passTurn(state, NOW);
		passTurn(state, NOW);
		expect(state.stats?.turnsTaken).toBe(2);
	});

	it("keeps each seat's lowest share of the cash after every action", () => {
		const state = fresh();
		completeAction(state, ALICE, []);
		expect(state.stats?.lowestCashShare[ALICE]).toBeCloseTo(0.5);
		state.seats[0].chips = 100;
		state.seats[1].chips = 900;
		completeAction(state, ALICE, []);
		state.seats[0].chips = 800;
		completeAction(state, ALICE, []);
		expect(state.stats?.lowestCashShare[ALICE]).toBeCloseTo(0.1);
		expect(state.stats?.lowestCashShare[BOB]).toBeCloseTo(0.5);
	});

	it("counts a forfeit, and not on the state it was handed", () => {
		const state = fresh();
		const result = applyForfeit(state, BOB, NOW);
		expect(result.ok).toBe(true);
		expect(result.ok && result.state.stats?.forfeits).toBe(1);
		expect(state.stats).toBeUndefined();
	});

	it("counts an auction when a passed lot goes up", () => {
		const state = fresh(true);
		const lot = BOARD.findIndex((tile) => isOwnableTile(tile));
		const tile = BOARD[lot];
		if (!isOwnableTile(tile)) throw new Error("the board has no ownable lot");
		state.seats[0].position = lot;
		state.phase = "awaiting-buy-or-skip";
		const result = openAuction(state, tile.id, ALICE, NOW);
		expect(result.ok).toBe(true);
		expect(result.ok && result.state.stats?.auctionsOpened).toBe(1);
	});
});
