import { describe, it, expect } from "vitest";
import { resolveVersus, DUEL_DIE_SIDES } from "./versusResolve.js";

// A stub rng that walks a fixed script, so a two roll dice duel gets two
// controlled values rather than one repeated one.
function scriptedRng(...values: number[]): () => number {
	let index = 0;
	return () => values[Math.min(index++, values.length - 1)];
}

describe("resolveVersus, coin", () => {
	it("gives heads to the challenger", () => {
		const result = resolveVersus("coin", () => 0.49);
		expect(result).toEqual({ flip: "coin", face: "heads", winner: "challenger" });
	});

	it("gives tails to the opponent", () => {
		const result = resolveVersus("coin", () => 0.5);
		expect(result).toEqual({ flip: "coin", face: "tails", winner: "opponent" });
	});

	it("treats exactly 0.5 as tails, so the two faces split the range evenly", () => {
		// The boundary is the only place a coin can quietly become unfair. rng is
		// [0, 1), so heads must be strictly below 0.5 and tails must own 0.5 up.
		expect(resolveVersus("coin", () => 0).face).toBe("heads");
		expect(resolveVersus("coin", () => 0.499999).face).toBe("heads");
		expect(resolveVersus("coin", () => 0.5).face).toBe("tails");
		expect(resolveVersus("coin", () => 0.999999).face).toBe("tails");
	});

	it("never ties, a single coin has no third outcome", () => {
		for (let i = 0; i < 200; i++) {
			expect(resolveVersus("coin").winner).not.toBe("tie");
		}
	});

	it("stays near an even split over many flips", () => {
		const runs = 5000;
		let heads = 0;
		for (let i = 0; i < runs; i++) {
			if (resolveVersus("coin").winner === "challenger") heads++;
		}
		const rate = heads / runs;
		// Loose band around 0.5. At n=5000 the 3-sigma spread is ~0.021, so
		// [0.45, 0.55] is a safe, non-flaky envelope.
		expect(rate).toBeGreaterThan(0.45);
		expect(rate).toBeLessThan(0.55);
	});
});

describe("resolveVersus, dice", () => {
	it("awards the higher roll to the challenger", () => {
		const result = resolveVersus("dice", scriptedRng(0.9, 0.1));
		expect(result.flip).toBe("dice");
		if (result.flip !== "dice") throw new Error("expected a dice result");
		expect(result.challengerRoll).toBeGreaterThan(result.opponentRoll);
		expect(result.winner).toBe("challenger");
	});

	it("awards the higher roll to the opponent", () => {
		const result = resolveVersus("dice", scriptedRng(0.1, 0.9));
		if (result.flip !== "dice") throw new Error("expected a dice result");
		expect(result.opponentRoll).toBeGreaterThan(result.challengerRoll);
		expect(result.winner).toBe("opponent");
	});

	it("reports a tie when both roll the same face", () => {
		const result = resolveVersus("dice", scriptedRng(0.42, 0.42));
		if (result.flip !== "dice") throw new Error("expected a dice result");
		expect(result.challengerRoll).toBe(result.opponentRoll);
		expect(result.winner).toBe("tie");
	});

	it("maps the rng boundaries onto real die faces, never 0 and never past the top", () => {
		// The classic off by one lives here: rng is [0, 1), so an rng of 0 must
		// produce face 1 and an rng approaching 1 must produce the top face.
		const low = resolveVersus("dice", scriptedRng(0, 0));
		if (low.flip !== "dice") throw new Error("expected a dice result");
		expect(low.challengerRoll).toBe(1);
		expect(low.opponentRoll).toBe(1);

		const high = resolveVersus("dice", scriptedRng(0.9999999, 0.9999999));
		if (high.flip !== "dice") throw new Error("expected a dice result");
		expect(high.challengerRoll).toBe(DUEL_DIE_SIDES);
		expect(high.opponentRoll).toBe(DUEL_DIE_SIDES);
	});

	it("only ever produces faces inside the die's range", () => {
		for (let i = 0; i < 2000; i++) {
			const result = resolveVersus("dice");
			if (result.flip !== "dice") throw new Error("expected a dice result");
			for (const roll of [result.challengerRoll, result.opponentRoll]) {
				expect(Number.isInteger(roll)).toBe(true);
				expect(roll).toBeGreaterThanOrEqual(1);
				expect(roll).toBeLessThanOrEqual(DUEL_DIE_SIDES);
			}
		}
	});

	it("ties at roughly one in the die's face count", () => {
		const runs = 20000;
		let ties = 0;
		for (let i = 0; i < runs; i++) {
			if (resolveVersus("dice").winner === "tie") ties++;
		}
		const rate = ties / runs;
		// Expected 1/20 = 0.05. Wide band so this can never flake, but tight
		// enough to catch a die that silently became a d6 (0.167) or a d100.
		expect(rate).toBeGreaterThan(0.03);
		expect(rate).toBeLessThan(0.07);
	});

	it("does not favor either player", () => {
		const runs = 20000;
		let challenger = 0;
		let opponent = 0;
		for (let i = 0; i < runs; i++) {
			const winner = resolveVersus("dice").winner;
			if (winner === "challenger") challenger++;
			if (winner === "opponent") opponent++;
		}
		// Going first must not be an advantage. Both draw from the same rng, so
		// the two win rates should sit on top of each other.
		expect(Math.abs(challenger - opponent) / runs).toBeLessThan(0.03);
	});
});

describe("resolveVersus, custom die size", () => {
	const SIX_SIDES = 6;

	it("maps the rng boundaries onto a six sided die's faces", () => {
		const low = resolveVersus("dice", scriptedRng(0, 0), SIX_SIDES);
		if (low.flip !== "dice") throw new Error("expected a dice result");
		expect(low.challengerRoll).toBe(1);
		expect(low.opponentRoll).toBe(1);

		const high = resolveVersus("dice", scriptedRng(0.9999999, 0.9999999), SIX_SIDES);
		if (high.flip !== "dice") throw new Error("expected a dice result");
		expect(high.challengerRoll).toBe(SIX_SIDES);
		expect(high.opponentRoll).toBe(SIX_SIDES);
	});

	it("never rolls past the requested face count", () => {
		for (let i = 0; i < 2000; i++) {
			const result = resolveVersus("dice", Math.random, SIX_SIDES);
			if (result.flip !== "dice") throw new Error("expected a dice result");
			for (const roll of [result.challengerRoll, result.opponentRoll]) {
				expect(roll).toBeGreaterThanOrEqual(1);
				expect(roll).toBeLessThanOrEqual(SIX_SIDES);
			}
		}
	});

	it("keeps the duel's d20 when no size is passed", () => {
		// The rng 0.5 sits mid range: face 11 on a d20, face 4 on a d6, so the
		// default cannot silently shrink without this failing.
		const result = resolveVersus("dice", scriptedRng(0.5, 0.5));
		if (result.flip !== "dice") throw new Error("expected a dice result");
		expect(result.challengerRoll).toBe(DUEL_DIE_SIDES / 2 + 1);
	});
});
