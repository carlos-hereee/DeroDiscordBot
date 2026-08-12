import { describe, it, expect } from "vitest";
import {
	evaluateHand,
	compareHands,
	freshDeck,
	shuffle,
	formatCard,
	HAND_CATEGORIES,
	type Card,
	type Suit,
} from "./holdemHand.js";

// "Ah Kd 7c" → cards. A test that spells hands out as object literals is a test
// nobody re-reads, and an unreadable poker test is one that gets deleted rather
// than fixed the first time it goes red.
const RANKS: Record<string, number> = {
	"2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
	T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function hand(notation: string): Card[] {
	return notation.split(/\s+/).map((token) => ({
		rank: RANKS[token[0].toUpperCase()],
		suit: token[1].toLowerCase() as Suit,
	}));
}

const categoryOf = (notation: string) => evaluateHand(hand(notation)).category;
const beats = (a: string, b: string) => compareHands(evaluateHand(hand(a)), evaluateHand(hand(b))) > 0;
const ties = (a: string, b: string) => compareHands(evaluateHand(hand(a)), evaluateHand(hand(b))) === 0;

describe("every hand class is recognised", () => {
	it.each([
		["straight flush", "9h 8h 7h 6h 5h 2c 3d"],
		["four of a kind", "9h 9s 9d 9c 5h 2c 3d"],
		["full house", "9h 9s 9d 5c 5h 2c 3d"],
		["flush", "Ah Jh 8h 6h 3h 2c 4d"],
		["straight", "9h 8s 7d 6c 5h 2c 3d"],
		["three of a kind", "9h 9s 9d 5c 4h 2c 3d"],
		["two pair", "9h 9s 5d 5c 4h 2c 3d"],
		["pair", "9h 9s 5d 4c Kh 2c 3d"],
		["high card", "Ah Jd 8s 6c 3h 2c 4d"],
	])("reads %s", (expected, notation) => {
		expect(categoryOf(notation)).toBe(expected);
	});

	it("orders the categories worst to best, so the index IS the comparison", () => {
		expect(HAND_CATEGORIES[0]).toBe("high card");
		expect(HAND_CATEGORIES[HAND_CATEGORIES.length - 1]).toBe("straight flush");
	});
});

// ⚠️ THE CASE EVERY NAIVE EVALUATOR GETS WRONG. A-2-3-4-5 is a straight whose high
// card is the FIVE. Treating the ace as high there makes the weakest straight in
// poker beat every other one.
describe("the wheel", () => {
	it("reads A-2-3-4-5 as a straight", () => {
		expect(categoryOf("Ah 2s 3d 4c 5h Kd 9c")).toBe("straight");
	});

	it("ranks it as FIVE high, so a six high straight beats it", () => {
		expect(beats("6h 5s 4d 3c 2h Kd 9c", "Ah 2s 3d 4c 5h Kd 9c")).toBe(true);
	});

	it("loses to every other straight, including the one it shares an ace with", () => {
		// Broadway is ace HIGH. The same ace cannot play both ways in one hand, but
		// across two hands the wheel must still be the weaker.
		expect(beats("Ah Ks Qd Jc Th 2c 3d", "Ah 2s 3d 4c 5h Kd 9c")).toBe(true);
	});

	it("recognises the steel wheel as a straight flush", () => {
		expect(categoryOf("Ah 2h 3h 4h 5h Kd 9c")).toBe("straight flush");
	});

	it("makes the steel wheel the WEAKEST straight flush", () => {
		expect(beats("6h 5h 4h 3h 2h Kd 9c", "Ah 2h 3h 4h 5h Kd 9c")).toBe(true);
	});
});

// ⚠️ A FLUSH PLUS A STRAIGHT IS NOT A STRAIGHT FLUSH. Scanning all seven cards for
// a straight after finding a flush claims one that does not exist, and it pays a
// hand that should have lost.
describe("straight flush is checked within one suit only", () => {
	it("does not claim a straight flush from a flush and a separate straight", () => {
		// Five hearts (a flush) and 5-6-7-8-9 across mixed suits (a straight).
		const value = evaluateHand(hand("2h 4h 6h 8h Th 9s 7d"));
		expect(value.category).toBe("flush");
	});

	it("finds the straight flush when the run really is suited", () => {
		expect(categoryOf("5h 6h 7h 8h 9h 2s 3d")).toBe("straight flush");
	});
});

describe("best five of seven", () => {
	it("takes the five HIGHEST cards of a flush, not the first five", () => {
		const value = evaluateHand(hand("2h 3h 4h Kh Ah 9s 8d"));
		expect(value.category).toBe("flush");
		expect(value.ranks).toEqual([14, 13, 4, 3, 2]);
	});

	it("builds a full house from two sets of trips, using the HIGHER as the set", () => {
		const value = evaluateHand(hand("9h 9s 9d 5c 5h 5d 2c"));
		expect(value.category).toBe("full house");
		expect(value.ranks).toEqual([9, 5]);
	});

	it("plays only the top two of THREE pairs, with the best remaining kicker", () => {
		// Pairs of 9, 5 and 3, plus a king. The king is the kicker, not the third pair.
		const value = evaluateHand(hand("9h 9s 5d 5c 3h 3d Kc"));
		expect(value.category).toBe("two pair");
		expect(value.ranks).toEqual([9, 5, 13]);
	});

	it("keeps one kicker with quads", () => {
		const value = evaluateHand(hand("9h 9s 9d 9c Kh 2c 3d"));
		expect(value.ranks).toEqual([9, 13]);
	});

	it("keeps three kickers with a pair and two with trips", () => {
		expect(evaluateHand(hand("9h 9s Kd Qc Jh 2c 3d")).ranks).toEqual([9, 13, 12, 11]);
		expect(evaluateHand(hand("9h 9s 9d Kc Qh 2c 3d")).ranks).toEqual([9, 13, 12]);
	});
});

describe("tie breaks", () => {
	it("separates two pairs by the pair, then by kickers in order", () => {
		expect(beats("Ah As 5d 4c 3h 2c 7d", "Kh Ks 5d 4c 3h 2c 7d")).toBe(true);
		expect(beats("9h 9s Kd 4c 3h 2c 7d", "9h 9s Qd 4c 3h 2c 7d")).toBe(true);
	});

	it("separates two pair by the HIGH pair before the low one", () => {
		expect(beats("Kh Ks 2d 2c 9h 5c 4d", "Qh Qs Jd Jc 9h 5c 4d")).toBe(true);
	});

	it("separates a full house by the TRIPS before the pair", () => {
		expect(beats("9h 9s 9d 2c 2h 5c 4d", "5h 5s 5d Ac Ah 9c 4d")).toBe(true);
	});

	it("separates flushes card by card", () => {
		expect(beats("Ah Kh 8h 6h 3h 2c 4d", "Ah Kh 8h 6h 2h 3c 4d")).toBe(true);
	});

	// ⚠️ A TIE IS A REAL RESULT. Two players can hold the same hand when the board
	// plays, and a comparator that never returns 0 hands a split pot to whichever
	// player happened to be compared first.
	it("returns exactly zero when the hands are genuinely equal", () => {
		expect(ties("Ah Ks Qd Jc Th 2c 3d", "As Kh Qc Jd Ts 4c 5d")).toBe(true);
	});

	it("ties when the BOARD plays and neither player improves it", () => {
		// Both players' hole cards are irrelevant against a board that already makes
		// the best five. This is the split pot case that matters in real play.
		expect(ties("Ah Kh Qh Jh Th 2c 3d", "Ah Kh Qh Jh Th 4s 5s")).toBe(true);
	});

	it("is antisymmetric, so swapping the arguments flips the sign", () => {
		const a = evaluateHand(hand("Ah As 5d 4c 3h 2c 7d"));
		const b = evaluateHand(hand("Kh Ks 5d 4c 3h 2c 7d"));
		expect(Math.sign(compareHands(a, b))).toBe(-Math.sign(compareHands(b, a)));
	});
});

describe("category ordering holds across the whole ladder", () => {
	// Each hand must beat the one below it. Pinning the ladder in one place catches
	// an ordering slip that a per-category test would miss.
	const ladder = [
		"9h 8h 7h 6h 5h 2c 3d", // straight flush
		"9h 9s 9d 9c 5h 2c 3d", // quads
		"9h 9s 9d 5c 5h 2c 3d", // full house
		"Ah Jh 8h 6h 3h 2c 4d", // flush
		"9h 8s 7d 6c 5h 2c 3d", // straight
		"9h 9s 9d 5c 4h 2c 3d", // trips
		"9h 9s 5d 5c 4h 2c 3d", // two pair
		"9h 9s 5d 4c Kh 2c 3d", // pair
		"Ah Jd 8s 6c 3h 2c 4d", // high card
	];

	it.each(ladder.slice(0, -1).map((better, index) => [better, ladder[index + 1]]))(
		"%s beats %s",
		(better, worse) => {
			expect(beats(better, worse)).toBe(true);
		}
	);
});

describe("guards and helpers", () => {
	it("throws on fewer than five cards rather than inventing a weak hand", () => {
		// A caller with four cards has a bug, and returning "high card" would hide it.
		expect(() => evaluateHand(hand("Ah Kd Qc Js"))).toThrow(/at least 5/);
	});

	it("evaluates exactly five cards as well as seven", () => {
		expect(categoryOf("Ah Kh Qh Jh Th")).toBe("straight flush");
	});

	it("ships a 52 card deck with no duplicates", () => {
		const deck = freshDeck();
		expect(deck).toHaveLength(52);
		expect(new Set(deck.map((card) => `${card.rank}${card.suit}`)).size).toBe(52);
	});

	it("shuffles without losing or duplicating a card, and leaves the input alone", () => {
		const deck = freshDeck();
		const rng = (() => {
			let state = 42;
			return () => {
				state = (state * 1664525 + 1013904223) % 4294967296;
				return state / 4294967296;
			};
		})();
		const shuffled = shuffle(deck, rng);

		expect(shuffled).toHaveLength(52);
		expect(new Set(shuffled.map((card) => `${card.rank}${card.suit}`)).size).toBe(52);
		expect(deck[0]).toEqual({ rank: 2, suit: "s" });
		expect(shuffled).not.toEqual(deck);
	});

	it("renders a card with a pip rather than a letter", () => {
		expect(formatCard({ rank: 14, suit: "h" })).toBe("A♥");
		expect(formatCard({ rank: 10, suit: "s" })).toBe("10♠");
	});
});
