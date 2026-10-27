import { describe, it, expect } from "vitest";
import {
	applyAction,
	applyLeave,
	buildShoe,
	cardValue,
	createTable,
	handValue,
	isNatural,
	legalActions,
	playDealer,
	resolveHand,
	settle,
	BLACKJACK_TARGET,
	DEFAULT_DECK_COUNT,
	MAX_HANDS_PER_SEAT,
	RANKS,
	SUITS,
	type BlackjackTable,
	type Card,
	type Hand,
	type Rank,
	type Seat,
} from "./blackjackState.js";

// ── helpers ─────────────────────────────────────────────────────────────────
// The state is plain objects on purpose, so a test can build an exact table
// rather than shuffling until the case it wants appears.

const stack = (ranks: Rank[]): Card[] => ranks.map((rank) => ({ rank, suit: "S" }));

function hand(ranks: Rank[], over: Partial<Hand> = {}): Hand {
	return { cards: stack(ranks), status: "playing", doubled: false, fromSplit: false, ...over };
}

function seat(userId: string, hands: Hand[], activeHand = 0): Seat {
	return { userId, username: userId, hands, activeHand };
}

function table(over: Partial<BlackjackTable> & { seats: Seat[] }): BlackjackTable {
	return { dealer: hand([]), shoe: [], phase: "playing", turn: 0, hitsSoft17: false, ...over };
}

// ── hand values, where the aces live ────────────────────────────────────────

describe("handValue", () => {
	it("scores an ace as 11 when it fits", () => {
		expect(handValue(stack(["A", "K"]))).toEqual({ total: 21, soft: true });
		expect(handValue(stack(["A", "6"]))).toEqual({ total: 17, soft: true });
	});

	it("demotes one ace at a time, which is what A A 9 needs", () => {
		// The case an implementation that demotes ALL aces at once gets wrong.
		// 11 + 11 + 9 = 31, demote ONE ace to reach 21. Demoting both gives 11.
		// It stays SOFT because the surviving ace is still counted as 11 (11 + 1 + 9),
		// which is the definition of soft and is not the same question as the total.
		expect(handValue(stack(["A", "A", "9"]))).toEqual({ total: 21, soft: true });
		expect(handValue(stack(["A", "A"]))).toEqual({ total: 12, soft: true });
		expect(handValue(stack(["A", "A", "A"]))).toEqual({ total: 13, soft: true });
	});

	it("goes hard once an ace has been demoted", () => {
		expect(handValue(stack(["A", "5", "10"]))).toEqual({ total: 16, soft: false });
	});

	it("busts without wrapping around", () => {
		expect(handValue(stack(["K", "Q", "5"]))).toEqual({ total: 25, soft: false });
	});

	it("values every face card at ten and every pip at its number", () => {
		for (const rank of ["10", "J", "Q", "K"] as Rank[]) expect(cardValue({ rank, suit: "S" })).toBe(10);
		expect(cardValue({ rank: "7", suit: "H" })).toBe(7);
	});
});

// ── what counts as a natural ────────────────────────────────────────────────

describe("isNatural", () => {
	it("is 21 on the opening two cards", () => {
		expect(isNatural(hand(["A", "K"]))).toBe(true);
	});

	it("is NOT a three card 21", () => {
		expect(isNatural(hand(["7", "7", "7"]))).toBe(false);
	});

	it("is NOT 21 on a split hand, which is the rule most implementations miss", () => {
		expect(isNatural(hand(["A", "K"], { fromSplit: true }))).toBe(false);
	});
});

// ── the shoe ────────────────────────────────────────────────────────────────

describe("buildShoe", () => {
	it("holds a full complement of cards", () => {
		expect(buildShoe()).toHaveLength(DEFAULT_DECK_COUNT * RANKS.length * SUITS.length);
		expect(buildShoe(1)).toHaveLength(52);
	});

	it("keeps every rank and suit in the right quantity", () => {
		const shoe = buildShoe(1);
		for (const rank of RANKS) expect(shoe.filter((card) => card.rank === rank)).toHaveLength(4);
		for (const suit of SUITS) expect(shoe.filter((card) => card.suit === suit)).toHaveLength(13);
	});

	it("is deterministic for a given rng, which is what makes a scripted deal possible", () => {
		const seeded = () => {
			let n = 0;
			return () => ((n = (n * 1103515245 + 12345) % 2147483648) / 2147483648);
		};
		expect(buildShoe(2, seeded())).toEqual(buildShoe(2, seeded()));
	});
});

// ── dealing ─────────────────────────────────────────────────────────────────

describe("createTable", () => {
	it("deals two cards to every seat and the dealer", () => {
		const built = createTable({ players: [{ userId: "a", username: "a" }, { userId: "b", username: "b" }] });
		expect(built.seats).toHaveLength(2);
		for (const s of built.seats) expect(s.hands[0].cards).toHaveLength(2);
		expect(built.dealer.cards).toHaveLength(2);
	});

	it("deals in casino order, across the table then around again", () => {
		// Same rng builds the same shoe, so the expected cards are predictable
		// without hardcoding a permutation.
		const rng = () => 0.42;
		const expected = buildShoe(DEFAULT_DECK_COUNT, rng);
		const built = createTable({
			players: [{ userId: "a", username: "a" }, { userId: "b", username: "b" }],
			rng,
		});
		expect(built.seats[0].hands[0].cards).toEqual([expected[0], expected[3]]);
		expect(built.seats[1].hands[0].cards).toEqual([expected[1], expected[4]]);
		expect(built.dealer.cards).toEqual([expected[2], expected[5]]);
	});

	it("flags a dealt natural so the seat never sees a Hit button", () => {
		const built = createTable({ players: [{ userId: "a", username: "a" }] });
		// Force the case rather than shuffling until it appears.
		built.seats[0].hands[0] = hand(["A", "K"]);
		if (isNatural(built.seats[0].hands[0])) built.seats[0].hands[0].status = "blackjack";
		expect(legalActions(built, "a")).toEqual([]);
	});
});

// ── legality ────────────────────────────────────────────────────────────────

describe("legalActions", () => {
	it("offers hit and stand on an ordinary opening hand", () => {
		const t = table({ seats: [seat("a", [hand(["9", "5"])])] });
		expect(legalActions(t, "a")).toEqual(["hit", "stand", "double"]);
	});

	it("withdraws double once a third card lands", () => {
		const t = table({ seats: [seat("a", [hand(["9", "5", "2"])])] });
		expect(legalActions(t, "a")).toEqual(["hit", "stand"]);
	});

	it("offers split on equal value, so a King and a Queen may be split", () => {
		const t = table({ seats: [seat("a", [hand(["K", "Q"])])] });
		expect(legalActions(t, "a")).toContain("split");
	});

	it("refuses split on unequal value", () => {
		const t = table({ seats: [seat("a", [hand(["K", "9"])])] });
		expect(legalActions(t, "a")).not.toContain("split");
	});

	it("gives nothing to a member who is not the one to act", () => {
		const t = table({ seats: [seat("a", [hand(["9", "5"])]), seat("b", [hand(["9", "5"])])] });
		expect(legalActions(t, "b")).toEqual([]);
	});

	it("gives nothing once the table has left the playing phase", () => {
		const t = table({ seats: [seat("a", [hand(["9", "5"])])], phase: "settled" });
		expect(legalActions(t, "a")).toEqual([]);
	});
});

// ── actions ─────────────────────────────────────────────────────────────────

describe("applyAction", () => {
	it("answers a click from the wrong member rather than throwing", () => {
		const t = table({ seats: [seat("a", [hand(["9", "5"])]), seat("b", [hand(["9", "5"])])] });
		expect(applyAction(t, "b", "hit")).toEqual({ status: "not-your-turn" });
	});

	it("reports an illegal action separately from a wrong turn", () => {
		const t = table({ seats: [seat("a", [hand(["K", "9"])])] });
		expect(applyAction(t, "a", "split")).toEqual({ status: "illegal", action: "split" });
	});

	it("draws one card on a hit and busts past 21", () => {
		const t = table({ seats: [seat("a", [hand(["K", "9"])])], shoe: stack(["5"]) });
		const outcome = applyAction(t, "a", "hit");
		expect(outcome.status).toBe("ok");
		expect(t.seats[0].hands[0].cards).toHaveLength(3);
		expect(t.seats[0].hands[0].status).toBe("bust");
		expect(t.phase).toBe("dealer");
	});

	it("takes exactly one card on a double, then stands", () => {
		const t = table({ seats: [seat("a", [hand(["5", "6"])])], shoe: stack(["4", "9"]) });
		applyAction(t, "a", "double");
		const played = t.seats[0].hands[0];
		expect(played.cards).toHaveLength(3);
		expect(played.doubled).toBe(true);
		expect(played.status).toBe("stood");
	});

	it("busts a double without granting another card", () => {
		const t = table({ seats: [seat("a", [hand(["K", "9"])])], shoe: stack(["5", "5"]) });
		// Double is illegal on three cards, but legal here on the opening two.
		applyAction(t, "a", "double");
		expect(t.seats[0].hands[0].status).toBe("bust");
		expect(t.seats[0].hands[0].cards).toHaveLength(3);
	});

	it("splits into two hands, each drawn back up to two cards", () => {
		const t = table({ seats: [seat("a", [hand(["8", "8"])])], shoe: stack(["3", "4"]) });
		applyAction(t, "a", "split");
		const hands = t.seats[0].hands;
		expect(hands).toHaveLength(2);
		expect(hands[0].cards.map((c) => c.rank)).toEqual(["8", "3"]);
		expect(hands[1].cards.map((c) => c.rank)).toEqual(["8", "4"]);
	});

	it("marks BOTH halves of a split, so neither can score a natural", () => {
		const t = table({ seats: [seat("a", [hand(["10", "10"])])], shoe: stack(["A", "A"]) });
		applyAction(t, "a", "split");
		const hands = t.seats[0].hands;
		expect(hands[0].fromSplit).toBe(true);
		expect(hands[1].fromSplit).toBe(true);
		// Both are 21, and neither is a blackjack.
		expect(handValue(hands[0].cards).total).toBe(BLACKJACK_TARGET);
		expect(isNatural(hands[0])).toBe(false);
		expect(isNatural(hands[1])).toBe(false);
	});

	it("gives split aces one card each and stands them", () => {
		const t = table({ seats: [seat("a", [hand(["A", "A"])])], shoe: stack(["9", "7"]) });
		applyAction(t, "a", "split");
		const hands = t.seats[0].hands;
		expect(hands[0].status).toBe("stood");
		expect(hands[1].status).toBe("stood");
		// Both hands are final, so the seat is done and the dealer is up.
		expect(t.phase).toBe("dealer");
	});

	it("stops splitting at the hand cap", () => {
		const hands = Array.from({ length: MAX_HANDS_PER_SEAT }, () => hand(["8", "8"]));
		const t = table({ seats: [seat("a", hands)], shoe: stack(["8", "8"]) });
		expect(legalActions(t, "a")).not.toContain("split");
	});

	it("walks the seat's split hands before moving to the next seat", () => {
		const t = table({
			seats: [seat("a", [hand(["9", "5"]), hand(["9", "5"], { fromSplit: true })]), seat("b", [hand(["9", "5"])])],
			shoe: stack(["2", "2", "2"]),
		});
		applyAction(t, "a", "stand");
		// Still seat a, now on its second hand.
		expect(t.turn).toBe(0);
		expect(t.seats[0].activeHand).toBe(1);
		applyAction(t, "a", "stand");
		expect(t.turn).toBe(1);
		expect(legalActions(t, "b")).toContain("hit");
	});

	it("hands the round to the dealer once the last seat is done", () => {
		const t = table({ seats: [seat("a", [hand(["9", "5"])]), seat("b", [hand(["9", "5"])])] });
		applyAction(t, "a", "stand");
		applyAction(t, "b", "stand");
		expect(t.phase).toBe("dealer");
	});
});

// ── the dealer ──────────────────────────────────────────────────────────────

describe("playDealer", () => {
	it("draws below 17", () => {
		const t = table({ seats: [seat("a", [hand(["10", "8"], { status: "stood" })])], dealer: hand(["9", "5"]), phase: "dealer", shoe: stack(["4"]) });
		playDealer(t);
		expect(handValue(t.dealer.cards).total).toBe(18);
		expect(t.phase).toBe("settled");
	});

	it("stands on a hard 17", () => {
		const t = table({ seats: [seat("a", [hand(["10", "8"], { status: "stood" })])], dealer: hand(["10", "7"]), phase: "dealer", shoe: stack(["4"]) });
		playDealer(t);
		expect(t.dealer.cards).toHaveLength(2);
	});

	it("stands on a SOFT 17 by default", () => {
		const t = table({ seats: [seat("a", [hand(["10", "8"], { status: "stood" })])], dealer: hand(["A", "6"]), phase: "dealer", shoe: stack(["4"]) });
		playDealer(t);
		expect(t.dealer.cards).toHaveLength(2);
	});

	it("hits a SOFT 17 when the table says to", () => {
		const t = table({
			seats: [seat("a", [hand(["10", "8"], { status: "stood" })])],
			dealer: hand(["A", "6"]),
			phase: "dealer",
			hitsSoft17: true,
			shoe: stack(["4"]),
		});
		playDealer(t);
		expect(t.dealer.cards).toHaveLength(3);
		expect(handValue(t.dealer.cards).total).toBe(21);
	});

	it("does not draw at all when every seat busted", () => {
		const t = table({ seats: [seat("a", [hand(["K", "Q", "5"], { status: "bust" })])], dealer: hand(["4", "2"]), phase: "dealer", shoe: stack(["9"]) });
		playDealer(t);
		expect(t.dealer.cards).toHaveLength(2);
		expect(t.phase).toBe("settled");
	});

	it("still plays out against a natural, because a dealer natural pushes it", () => {
		const t = table({ seats: [seat("a", [hand(["A", "K"], { status: "blackjack" })])], dealer: hand(["6", "5"]), phase: "dealer", shoe: stack(["9"]) });
		playDealer(t);
		expect(t.dealer.cards).toHaveLength(3);
	});

	it("does nothing when called out of phase", () => {
		const t = table({ seats: [seat("a", [hand(["9", "5"])])], dealer: hand(["6", "5"]), shoe: stack(["9"]) });
		playDealer(t);
		expect(t.dealer.cards).toHaveLength(2);
		expect(t.phase).toBe("playing");
	});
});

// ── settlement ──────────────────────────────────────────────────────────────

describe("resolveHand", () => {
	it("loses a bust hand even against a bust dealer, which IS the house edge", () => {
		expect(resolveHand(hand(["K", "Q", "5"], { status: "bust" }), hand(["K", "Q", "5"]))).toBe("lose");
	});

	it("pays a natural against an ordinary 21", () => {
		expect(resolveHand(hand(["A", "K"]), hand(["7", "7", "7"]))).toBe("blackjack");
	});

	it("pushes a natural against a natural", () => {
		expect(resolveHand(hand(["A", "K"]), hand(["A", "Q"]))).toBe("push");
	});

	it("loses an ordinary 21 to a dealer natural", () => {
		expect(resolveHand(hand(["7", "7", "7"]), hand(["A", "Q"]))).toBe("lose");
	});

	it("wins against a bust dealer without consulting the status field", () => {
		expect(resolveHand(hand(["10", "6"]), hand(["K", "Q", "5"]))).toBe("win");
	});

	it("compares totals when neither side is exceptional", () => {
		expect(resolveHand(hand(["10", "9"]), hand(["10", "8"]))).toBe("win");
		expect(resolveHand(hand(["10", "7"]), hand(["10", "8"]))).toBe("lose");
		expect(resolveHand(hand(["10", "8"]), hand(["10", "8"]))).toBe("push");
	});
});

describe("settle", () => {
	it("reports every hand of every seat, in order", () => {
		const t = table({
			seats: [
				seat("a", [hand(["A", "K"]), hand(["K", "Q", "5"], { status: "bust", fromSplit: true })]),
				seat("b", [hand(["10", "9"], { doubled: true })]),
			],
			dealer: hand(["10", "8"]),
			phase: "settled",
		});
		expect(settle(t)).toEqual([
			{ userId: "a", username: "a", hands: ["blackjack", "lose"], doubled: [false, false] },
			{ userId: "b", username: "b", hands: ["win"], doubled: [true] },
		]);
	});

	it("writes nothing, so a re-render cannot change the result", () => {
		const t = table({ seats: [seat("a", [hand(["10", "9"])])], dealer: hand(["10", "8"]), phase: "settled" });
		expect(settle(t)).toEqual(settle(t));
		expect(t.seats[0].hands[0].status).toBe("playing");
	});
});

// ── leaving during a hand (2026-10 item 254, Arcade 12) ─────────────────────
describe("applyLeave", () => {
	it("gives up the seat on the clock as a loss and moves the turn on", () => {
		const live = table({ seats: [seat("a", [hand(["10", "9"])]), seat("b", [hand(["5", "6"])])], dealer: hand(["10", "7"]) });
		expect(applyLeave(live, "a")).toEqual({ status: "left" });
		expect(live.seats[0].hands[0].status).toBe("left");
		expect(live.turn).toBe(1);
		expect(live.phase).toBe("playing");
	});

	it("counts the hand as a loss whatever its cards, a 20 included, never a push or a refund", () => {
		const live = table({ seats: [seat("a", [hand(["10", "K"])])], dealer: hand(["10", "K"]) });
		applyLeave(live, "a");
		expect(resolveHand(live.seats[0].hands[0], live.dealer)).toBe("lose");
		expect(settle(live)[0].hands).toEqual(["lose"]);
	});

	it("gives up every hand of a split seat, and lets a seat off the clock leave too", () => {
		const live = table({ seats: [seat("a", [hand(["8", "3"])]), seat("b", [hand(["8", "2"], { fromSplit: true }), hand(["8", "9"], { fromSplit: true, status: "stood" })])] });
		expect(applyLeave(live, "b")).toEqual({ status: "left" });
		expect(live.seats[1].hands.map((each) => each.status)).toEqual(["left", "left"]);
		expect(live.turn).toBe(0);
	});

	it("hands the round to the dealer when nobody is left to act", () => {
		const live = table({ seats: [seat("a", [hand(["10", "6"])])], dealer: hand(["10", "7"]) });
		applyLeave(live, "a");
		expect(live.phase).toBe("dealer");
	});

	it("refuses a member with no seat, a seat that already left, and a table past play", () => {
		const live = table({ seats: [seat("a", [hand(["10", "6"])]), seat("b", [hand(["4", "6"])])] });
		expect(applyLeave(live, "z")).toEqual({ status: "not-seated" });
		applyLeave(live, "b");
		expect(applyLeave(live, "b")).toEqual({ status: "already-left" });
		expect(applyLeave(table({ seats: [seat("a", [hand(["10", "6"])])], phase: "dealer" }), "a")).toEqual({ status: "not-seated" });
	});
});
