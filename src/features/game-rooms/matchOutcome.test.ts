import { describe, it, expect } from "vitest";
import {
	OUTCOME_BUCKETS,
	battleshipOutcome,
	chipsAtHandStart,
	flavorGameOf,
	hangmanOutcome,
	holdemOutcome,
	luckOutcome,
	monopolyOutcome,
	pickFlavor,
	shareOf,
	wasBehindOnShips,
	type FlavorTable,
	type HoldemOutcomeFacts,
	type MonopolyOutcomeFacts,
} from "./matchOutcome.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── matchOutcome (post-launch plan item 21) ──────────────────────────
// The buckets are checked in a fixed priority, so every case below pins one rule
// AND the rule above it losing: a test that only proves "tactic" for a three of a
// kind passes just as happily if routing never fires.

const holdem = (facts: Partial<HoldemOutcomeFacts>): string =>
	holdemOutcome({ cause: "played", bustedInFinalHand: 1, winnerHandCategory: null, winnerShare: 0.5, ...facts });

describe("holdemOutcome", () => {
	it("names how the table ended before how it was played", () => {
		expect(holdem({ cause: "forfeit", bustedInFinalHand: 3 })).toBe("forfeit");
		expect(holdem({ cause: "timeout", winnerHandCategory: "four of a kind" })).toBe("timeout");
	});

	it("is a rout when two or more seats bust on the final hand", () => {
		expect(holdem({ bustedInFinalHand: 2, winnerHandCategory: "flush" })).toBe("routing");
		expect(holdem({ bustedInFinalHand: 1, winnerHandCategory: "flush" })).toBe("tactic");
	});

	it("is tactic from three of a kind up, and not below it", () => {
		expect(holdem({ winnerHandCategory: "three of a kind" })).toBe("tactic");
		expect(holdem({ winnerHandCategory: "two pair" })).toBe("narrow");
	});

	it("is decisive from a 70 percent chip lead, narrow below it", () => {
		expect(holdem({ winnerShare: 0.7 })).toBe("decisive");
		expect(holdem({ winnerShare: 0.69 })).toBe("narrow");
	});

	it("judges a table the host ended on the standings alone", () => {
		expect(holdem({ cause: "ended", bustedInFinalHand: 3, winnerShare: 0.8 })).toBe("decisive");
		expect(holdem({ cause: "ended", winnerHandCategory: "straight flush", winnerShare: 0.4 })).toBe("narrow");
	});
});

describe("chip shares", () => {
	it("counts what each seat has put in this hand as theirs", () => {
		const chips = chipsAtHandStart([
			{ userId: "a", stack: 100, totalCommitted: 600 },
			{ userId: "b", stack: 0, totalCommitted: 300 },
		]);
		expect(chips.get("a")).toBe(700);
		expect(shareOf(chips, "a")).toBeCloseTo(0.7);
		expect(shareOf(chips, null)).toBe(0);
		expect(shareOf(new Map(), "a")).toBe(0);
	});
});

const monopoly = (facts: Partial<MonopolyOutcomeFacts>): string =>
	monopolyOutcome({ cause: "played", turnsTaken: 200, seatCount: 2, auctionsOpened: 3, forfeits: 0, winnerLowestShare: 0.5, ...facts });

describe("monopolyOutcome", () => {
	it("names an idle day before anything else, and any seat leaving as a forfeit", () => {
		expect(monopoly({ cause: "timeout", forfeits: 2 })).toBe("timeout");
		expect(monopoly({ forfeits: 1, turnsTaken: 4 })).toBe("forfeit");
	});

	it("is a rout inside twenty rounds of the table, measured per seat", () => {
		expect(monopoly({ turnsTaken: 40, seatCount: 2 })).toBe("routing");
		expect(monopoly({ turnsTaken: 41, seatCount: 2 })).toBe("narrow");
	});

	it("is a comeback from under a fifth of the cash, then decisive with no auction", () => {
		expect(monopoly({ winnerLowestShare: 0.19 })).toBe("comeback");
		expect(monopoly({ auctionsOpened: 0 })).toBe("decisive");
		expect(monopoly({ winnerLowestShare: 0.19, auctionsOpened: 0 })).toBe("comeback");
	});
});

describe("battleshipOutcome", () => {
	it("orders forfeit, timeout, comeback, then the ships afloat", () => {
		expect(battleshipOutcome({ cause: "forfeit", winnerShipsAfloat: 5, winnerWasBehind: true })).toBe("forfeit");
		expect(battleshipOutcome({ cause: "timeout", winnerShipsAfloat: 5, winnerWasBehind: false })).toBe("timeout");
		expect(battleshipOutcome({ cause: "played", winnerShipsAfloat: 5, winnerWasBehind: true })).toBe("comeback");
		expect(battleshipOutcome({ cause: "played", winnerShipsAfloat: 4, winnerWasBehind: false })).toBe("decisive");
		expect(battleshipOutcome({ cause: "played", winnerShipsAfloat: 3, winnerWasBehind: false })).toBe("narrow");
		expect(battleshipOutcome({ cause: "played", winnerShipsAfloat: 1, winnerWasBehind: false })).toBe("narrow");
	});

	it("replays the sinkings to find a winner who was ever behind", () => {
		expect(wasBehindOnShips(["loser", "winner", "winner"], "winner", "loser", 5)).toBe(true);
		expect(wasBehindOnShips(["winner", "loser", "winner"], "winner", "loser", 5)).toBe(false);
		expect(wasBehindOnShips([], "winner", "loser", 5)).toBe(false);
	});
});

describe("hangman and the luck games", () => {
	it("is decisive only with no miss at all", () => {
		expect(hangmanOutcome(0)).toBe("decisive");
		expect(hangmanOutcome(1)).toBe("narrow");
		expect(hangmanOutcome(5)).toBe("narrow");
	});

	it("reads a tie as a draw", () => {
		expect(luckOutcome(true)).toBe("draw");
		expect(luckOutcome(false)).toBe("narrow");
	});
});

describe("the flavor line", () => {
	const table: FlavorTable = {
		byGame: { holdem: { tactic: ["own line"] } },
		shared: Object.fromEntries(OUTCOME_BUCKETS.map((bucket) => [bucket, [`shared ${bucket}`]])) as unknown as FlavorTable["shared"],
	};

	it("reads the game's own shelf first, then the shared one", () => {
		expect(pickFlavor(table, "holdem", "tactic")).toBe("own line");
		expect(pickFlavor(table, "holdem", "routing")).toBe("shared routing");
		expect(pickFlavor(table, "luck", "draw")).toBe("shared draw");
	});

	it("picks by the rng across the shelf", () => {
		const two: FlavorTable = { ...table, byGame: { luck: { narrow: ["first", "second"] } } };
		expect(pickFlavor(two, "luck", "narrow", () => 0)).toBe("first");
		expect(pickFlavor(two, "luck", "narrow", () => 0.99)).toBe("second");
	});

	it("maps the three luck games to one shelf and gives a solo game none", () => {
		expect(flavorGameOf("coinflip")).toBe("luck");
		expect(flavorGameOf("rps")).toBe("luck");
		expect(flavorGameOf("solo-blackjack")).toBeNull();
	});

	// The real table: every bucket has a shared shelf, every shelf has four to six
	// lines, and no line carries a dash (house rule 1).
	it("keeps the real table complete, sized and dash free", () => {
		const { byGame, shared } = gameRoomsCopy.postMatch.flavor;
		const shelves = [...Object.values(shared), ...Object.values(byGame).flatMap((buckets) => Object.values(buckets ?? {}))];
		for (const bucket of OUTCOME_BUCKETS) expect(shared[bucket].length).toBeGreaterThan(0);
		for (const lines of shelves) {
			expect(lines.length).toBeGreaterThanOrEqual(4);
			expect(lines.length).toBeLessThanOrEqual(6);
			for (const line of lines) expect(line).not.toMatch(/[\u2013\u2014]| - /);
		}
	});
});
