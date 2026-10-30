import { describe, it, expect } from "vitest";
import { seatRangeOf, seatsFit } from "./seatRange.js";
import { GAME_SLUGS } from "./roomTypes.js";

// ── seatRange (2026-10 item 276, audit P1-5) ─────────────────────────
// The seats a rematch or a seed may open a room with, Dero bots counting. Monopoly's engine throws
// outside 2 to 6 after the row is playing, which is the stuck room this range exists to stop.

describe("seatRangeOf", () => {
	it("answers a range for every game, never an empty one", () => {
		for (const game of GAME_SLUGS) {
			const range = seatRangeOf(game);
			expect(range.min).toBeGreaterThanOrEqual(1);
			expect(range.max).toBeGreaterThanOrEqual(range.min);
		}
	});

	it("seats Monopoly two to six, the engine's own bounds", () => {
		expect(seatsFit("monopoly", 1)).toBe(false);
		expect(seatsFit("monopoly", 2)).toBe(true);
		expect(seatsFit("monopoly", 6)).toBe(true);
		expect(seatsFit("monopoly", 7)).toBe(false);
	});

	it("seats every head to head game exactly two, and every solo room one", () => {
		for (const game of ["battleship", "coinflip", "diceroll", "rps"] as const) expect(seatRangeOf(game)).toEqual({ min: 2, max: 2 });
		for (const game of ["solo-hangman", "solo-blackjack", "solo-coinflip", "solo-diceroll", "solo-rps"] as const) expect(seatRangeOf(game)).toEqual({ min: 1, max: 1 });
	});

	it("opens a Hold'em room with one player and never refuses a crowd, since its table caps its own seats", () => {
		expect(seatsFit("holdem", 1)).toBe(true);
		expect(seatsFit("holdem", 40)).toBe(true);
	});

	it("needs a guesser beside the host for hangman", () => {
		expect(seatsFit("hangman", 1)).toBe(false);
		expect(seatsFit("hangman", 2)).toBe(true);
	});
});
