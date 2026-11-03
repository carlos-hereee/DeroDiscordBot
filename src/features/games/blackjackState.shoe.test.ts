import { describe, it, expect, vi, beforeEach } from "vitest";

// ── the shoe and late seats (2026-10 item 276, owner decisions D14 to D16) ────────────────
// What is pinned here: a shoe is six decks when the table opens and every time the cut card
// reshuffles it, the shuffle draws from secureRandom (D15) unless a test hands in its own rng,
// a late seat sits down only between hands (D14) with a stack of the buy in, and a seat counts
// its own settled hands (D16). secureRandom is replaced by a counter, so a test can see that
// the shuffle reached it and how often.

const secure = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@utils/secureRng.js", () => ({
	secureRandom: () => {
		secure.calls += 1;
		return 0.5;
	},
}));

import { buildShoe, collectPayouts, createBankrollTable, applyLeave, placeBet, playDealer, seatLatePlayers, startNextHand, DEFAULT_DECK_COUNT, RANKS, SUITS, type BlackjackTable, type Card } from "./blackjackState.js";

const ALICE = { userId: "alice", username: "Alice" };
const BOB = { userId: "bob", username: "Bob" };
const CAROL = { userId: "carol", username: "Carol" };
const SIX_DECKS = 6 * RANKS.length * SUITS.length;

const cards = (ranks: Card["rank"][]): Card[] => ranks.map((rank) => ({ rank, suit: "S" }));

// One settled, paid hand at a two seat table: both bet, Alice stands on 19, Bob stands on 17,
// the dealer stands on 18.
function settledHand(): BlackjackTable {
	const table = createBankrollTable({ players: [ALICE, BOB], buyIn: 1000, rng: () => 0.5 });
	table.shoe = [...cards(["10", "10", "10", "9", "7", "8"]), ...buildShoe(DEFAULT_DECK_COUNT, () => 0.5)];
	placeBet(table, ALICE.userId, 50);
	placeBet(table, BOB.userId, 50);
	table.seats[0].hands[0].status = "stood";
	table.seats[1].hands[0].status = "stood";
	table.phase = "dealer";
	playDealer(table);
	collectPayouts(table);
	return table;
}

beforeEach(() => {
	secure.calls = 0;
});

describe("six decks, shuffled from the secure source (D15)", () => {
	it("builds a six deck shoe from secureRandom when no rng is handed in", () => {
		expect(DEFAULT_DECK_COUNT).toBe(6);
		expect(buildShoe()).toHaveLength(SIX_DECKS);
		// Fisher Yates draws once per card but the first.
		expect(secure.calls).toBe(SIX_DECKS - 1);
	});

	it("opens a table on six decks from secureRandom, and a seeded rng still decides a test's deal", () => {
		expect(createBankrollTable({ players: [ALICE], buyIn: 1000 }).shoe).toHaveLength(SIX_DECKS);
		expect(secure.calls).toBe(SIX_DECKS - 1);
		secure.calls = 0;
		const seeded = createBankrollTable({ players: [ALICE], buyIn: 1000, rng: () => 0.25 });
		expect(seeded.shoe).toHaveLength(SIX_DECKS);
		expect(secure.calls).toBe(0);
	});

	it("reshuffles a whole six deck shoe from secureRandom when the cut card came out", () => {
		const table = settledHand();
		table.reshuffleDue = true;
		secure.calls = 0;
		expect(startNextHand(table)).toBe(true);
		expect(table.shoe).toHaveLength(SIX_DECKS);
		expect(table.deckCount).toBe(6);
		expect(secure.calls).toBe(SIX_DECKS - 1);
	});
});

describe("a late seat sits down between hands (D14)", () => {
	it("refuses to seat anybody while a hand is in play, so nobody is dealt in mid hand", () => {
		const table = createBankrollTable({ players: [ALICE, BOB], buyIn: 1000, rng: () => 0.5 });
		expect(seatLatePlayers(table, [CAROL])).toBe(0);
		placeBet(table, ALICE.userId, 50);
		placeBet(table, BOB.userId, 50);
		expect(table.phase).not.toBe("betting");
		expect(seatLatePlayers(table, [CAROL])).toBe(0);
		expect(table.seats.map((seat) => seat.userId)).toEqual([ALICE.userId, BOB.userId]);
	});

	it("seats a late player after a hand paid, at the buy in, on the next hand's bets", () => {
		const table = settledHand();
		expect(seatLatePlayers(table, [CAROL, ALICE])).toBe(1);
		const carol = table.seats.find((seat) => seat.userId === CAROL.userId);
		expect(carol).toMatchObject({ stack: 1000, bet: 0, out: null, handsSettled: 0 });
		expect(startNextHand(table)).toBe(true);
		expect(table.phase).toBe("betting");
		placeBet(table, ALICE.userId, 50);
		placeBet(table, BOB.userId, 50);
		// Carol is the last seat to bet, and her bet deals the hand to all three.
		expect(table.phase).toBe("betting");
		expect(table.seats[table.turn].userId).toBe(CAROL.userId);
		placeBet(table, CAROL.userId, 50);
		expect(table.seats.every((seat) => seat.hands.length === 1)).toBe(true);
	});

	it("opens the bets on a late seat when every seat left during them", () => {
		const table = settledHand();
		startNextHand(table);
		applyLeave(table, ALICE.userId);
		applyLeave(table, BOB.userId);
		expect(table.phase).toBe("betting");
		expect(seatLatePlayers(table, [CAROL])).toBe(1);
		expect(table.seats[table.turn].userId).toBe(CAROL.userId);
		expect(table.phase).toBe("betting");
	});
});

describe("each seat counts its own settled hands (D16)", () => {
	it("counts a hand once for every seat dealt into it, and nothing for a seat that sat down after", () => {
		const table = settledHand();
		seatLatePlayers(table, [CAROL]);
		expect(table.seats.map((seat) => seat.handsSettled)).toEqual([1, 1, 0]);
		// A second payout of the same hand is refused, so it counts nothing twice.
		expect(collectPayouts(table)).toBeNull();
		expect(table.seats.map((seat) => seat.handsSettled)).toEqual([1, 1, 0]);
	});
});
