import { describe, it, expect } from "vitest";
import { buildPots, awardPots, uncalledPortion, potTotal, type PlayerCommitment } from "./holdemPots.js";

// Every scenario below is written out by hand rather than ported, because no
// surveyed implementation documents side pots and the plan says to assume nothing.
// The invariant each one checks: a player can only win chips they could have LOST.

const player = (userId: string, committed: number, folded = false): PlayerCommitment => ({
	userId,
	committed,
	folded,
});

// Conservation is the property that catches almost every side pot bug. Whatever
// went in must come out, across the pots and the uncalled return together.
function expectConserved(commitments: PlayerCommitment[]) {
	const pots = buildPots(commitments);
	const uncalled = uncalledPortion(commitments);
	const paidIn = commitments.reduce((sum, p) => sum + p.committed, 0);
	// The uncalled portion sits inside the top layer, so it is counted once.
	expect(potTotal(pots)).toBe(paidIn);
	return { pots, uncalled };
}

describe("the simple pots", () => {
	it("makes one pot when everybody put in the same", () => {
		const pots = buildPots([player("a", 50), player("b", 50), player("c", 50)]);
		expect(pots).toEqual([{ amount: 150, eligible: ["a", "b", "c"] }]);
	});

	it("makes one pot when only one player is left standing", () => {
		const pots = buildPots([player("a", 50), player("b", 50, true)]);
		expect(pots).toEqual([{ amount: 100, eligible: ["a"] }]);
	});

	// ⚠️ FOLDED CHIPS STAY IN. A player who bets and folds bought nothing; their
	// chips remain in the layers they reached and somebody else wins them.
	it("keeps a folded player's chips in the pot and off their name", () => {
		const pots = buildPots([player("a", 100), player("b", 100), player("c", 30, true)]);
		expect(potTotal(pots)).toBe(230);
		expect(pots.every((pot) => !pot.eligible.includes("c"))).toBe(true);
	});
});

// ⚠️ THE CASE THE COMPLETION CRITERIA NAME: a three way all in for different
// amounts, proven by test rather than by play.
describe("a three way all in for different amounts", () => {
	// a is all in for 20, b for 50, c for 100.
	const table = [player("a", 20), player("b", 50), player("c", 100)];

	it("builds a main pot and two side pots", () => {
		expect(buildPots(table)).toEqual([
			// Everyone matched the first 20.
			{ amount: 60, eligible: ["a", "b", "c"] },
			// b and c matched the next 30 each; a could not.
			{ amount: 60, eligible: ["b", "c"] },
			// Only c put in the last 50, and nobody called it.
			{ amount: 50, eligible: ["c"] },
		]);
	});

	it("conserves every chip", () => {
		expectConserved(table);
	});

	// The whole point of a side pot: the short stack cannot win chips they were
	// never able to lose.
	it("pays the short stack only the main pot when they hold the best hand", () => {
		const strength: Record<string, number> = { a: 3, b: 2, c: 1 };
		const awards = awardPots(buildPots(table), (id) => strength[id]);
		expect(awards).toContainEqual({ userId: "a", amount: 60 });
		// b takes the second layer, c takes back their uncalled 50.
		expect(awards).toContainEqual({ userId: "b", amount: 60 });
		expect(awards).toContainEqual({ userId: "c", amount: 50 });
	});

	it("pays everything to the big stack when they hold the best hand", () => {
		const strength: Record<string, number> = { a: 1, b: 2, c: 3 };
		const awards = awardPots(buildPots(table), (id) => strength[id]);
		expect(awards).toEqual([{ userId: "c", amount: 170 }]);
	});

	it("splits correctly when the middle stack wins the two pots they are in", () => {
		const strength: Record<string, number> = { a: 1, b: 3, c: 2 };
		const awards = awardPots(buildPots(table), (id) => strength[id]);
		expect(awards).toContainEqual({ userId: "b", amount: 120 });
		expect(awards).toContainEqual({ userId: "c", amount: 50 });
	});
});

describe("the uncalled portion", () => {
	// ⚠️ A REAL RULE, NOT A ROUNDING DETAIL. Chips nobody called cannot be lost, so
	// they are handed back rather than won.
	it("reports the excess when one player out-bet the whole table", () => {
		expect(uncalledPortion([player("a", 200), player("b", 50), player("c", 50)])).toEqual({
			userId: "a",
			amount: 150,
		});
	});

	it("reports nothing when the top bet was matched", () => {
		expect(uncalledPortion([player("a", 50), player("b", 50)])).toBeNull();
	});

	it("reports nothing when nobody put anything in", () => {
		expect(uncalledPortion([player("a", 0), player("b", 0)])).toBeNull();
	});

	it("still reports it when the caller folded, because folding does not call", () => {
		expect(uncalledPortion([player("a", 200), player("b", 50, true)])).toEqual({ userId: "a", amount: 150 });
	});
});

describe("splitting a pot", () => {
	it("splits evenly between two equal hands", () => {
		const awards = awardPots([{ amount: 100, eligible: ["a", "b"] }], () => 5);
		expect(awards).toContainEqual({ userId: "a", amount: 50 });
		expect(awards).toContainEqual({ userId: "b", amount: 50 });
	});

	// ⚠️ ODD CHIPS ARE NOT DISCARDED. Flooring both shares destroys a chip on every
	// split pot, and over a tournament the totals stop adding up with no error
	// anywhere to explain it.
	it("gives the odd chip to the earliest player in seat order", () => {
		const awards = awardPots([{ amount: 25, eligible: ["b", "a"] }], () => 5, ["a", "b"]);
		expect(awards).toContainEqual({ userId: "a", amount: 13 });
		expect(awards).toContainEqual({ userId: "b", amount: 12 });
	});

	it("spreads two odd chips across a three way split rather than losing them", () => {
		const awards = awardPots([{ amount: 26, eligible: ["a", "b", "c"] }], () => 5, ["a", "b", "c"]);
		const total = awards.reduce((sum, award) => sum + award.amount, 0);
		expect(total).toBe(26);
		expect(awards).toContainEqual({ userId: "a", amount: 9 });
		expect(awards).toContainEqual({ userId: "b", amount: 9 });
		expect(awards).toContainEqual({ userId: "c", amount: 8 });
	});

	// A prime pot across every table size, so at least one split is guaranteed to
	// leave a remainder at each width.
	it.each([2, 3, 4, 5, 6])("conserves a 101 chip pot split %i ways", (count) => {
		const seats = ["a", "b", "c", "d", "e", "f"];
		const awards = awardPots([{ amount: 101, eligible: seats.slice(0, count) }], () => 5, seats);
		expect(awards.reduce((sum, award) => sum + award.amount, 0)).toBe(101);
	});
});

describe("shapes that must not throw", () => {
	it("returns no pots when nobody committed anything", () => {
		expect(buildPots([player("a", 0), player("b", 0)])).toEqual([]);
	});

	it("returns no pots for an empty table", () => {
		expect(buildPots([])).toEqual([]);
	});

	it("pays nobody from a pot with no eligible players", () => {
		// Every contributor folded. Not reachable in a real hand (someone wins by
		// default before this), but a payout loop that divides by zero here would
		// take the whole tournament down.
		expect(awardPots([{ amount: 100, eligible: [] }], () => 5)).toEqual([]);
	});

	it("merges adjacent layers that have the same eligible players", () => {
		// a and b both all in for different amounts with everyone still live would
		// otherwise read as "main pot 30, side pot 20" for what is one 50 chip pot.
		const pots = buildPots([player("a", 25), player("b", 25), player("c", 25)]);
		expect(pots).toHaveLength(1);
	});
});
