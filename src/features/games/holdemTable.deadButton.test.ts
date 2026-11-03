import { describe, it, expect } from "vitest";
import {
	createTable,
	joinTable,
	dealHand,
	act,
	whoActs,
	actionsFor,
	livePlayers,
	handInProgress,
	leaveTable,
	requestLateSeat,
	type HoldemTable,
} from "./holdemTable.js";
import type { Card, Suit } from "./holdemHand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── the dead button (2026-10 item 280) ─────────────────────────────────────
// What:  the owner's ruling that the big blind moves forward one seat every hand, so no
//        seat skips the big blind after a bust. The small blind is last hand's big blind
//        (dead when that seat is gone), and the button sits on the seat before it, live
//        or not. Every case pairs who posts with who acts and with the chips it must not
//        create or lose.

function seededRng(seed = 11): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

const START = BOT_CONSTANTS.HOLDEM_STARTING_STACK;
const SHORT_STACK = 50;

function seatedTable(count: number): HoldemTable {
	const table = createTable();
	for (let index = 0; index < count; index++) joinTable(table, `p${index}`, `Player ${index}`);
	table.status = "playing";
	return table;
}

const seatOf = (table: HoldemTable, userId: string) => table.seats.find((seat) => seat.userId === userId)!;
const tableChips = (table: HoldemTable) => table.seats.reduce((sum, seat) => sum + seat.stack + seat.totalCommitted, 0);
const buttonHolder = (table: HoldemTable): string => {
	const live = livePlayers(table);
	return live[table.buttonIndex % live.length].userId;
};

// Who posted what at the deal just made. Read before anybody acts, while each blind's
// commitment is still exactly its blind.
function blindsOf(table: HoldemTable): { small?: string; big?: string; button: string } {
	const live = livePlayers(table);
	return {
		small: live.find((seat) => seat.committed === table.smallBlind)?.userId,
		big: live.find((seat) => seat.committed === table.bigBlind)?.userId,
		button: buttonHolder(table),
	};
}

function foldOut(table: HoldemTable): void {
	for (let turn = 0; turn < 20 && handInProgress(table); turn++) act(table, whoActs(table)!, "fold");
}

function checkOrCall(table: HoldemTable, userId: string): void {
	const legal = actionsFor(table, userId).map((entry) => entry.action);
	act(table, userId, legal.includes("check") ? "check" : "call");
}

const card = (rank: number, suit: Suit): Card => ({ rank, suit });
const ACES = [card(14, "s"), card(14, "h")];
const LOSING_HANDS = [
	[card(7, "c"), card(2, "d")],
	[card(8, "c"), card(5, "d")],
];
// The deck pops from the end, so these five are the whole board, and none helps a loser.
const DRY_BOARD = [card(3, "h"), card(4, "c"), card(9, "d"), card(11, "h"), card(12, "s")];

/**
 * Deal a hand in which every victim busts: each starts it on SHORT_STACK chips and shoves,
 * the winner holds aces and checks or calls, and everyone else folds.
 */
function dealBusting(table: HoldemTable, victims: string[], winner: string, seed = 11): ReturnType<typeof blindsOf> {
	for (const victim of victims) seatOf(table, victim).stack = SHORT_STACK;
	dealHand(table, seededRng(seed));
	const posted = blindsOf(table);
	table.holeCards[winner] = ACES;
	victims.forEach((victim, index) => (table.holeCards[victim] = LOSING_HANDS[index % LOSING_HANDS.length]));
	table.deck = [...DRY_BOARD];
	for (let turn = 0; turn < 40 && handInProgress(table); turn++) {
		const actor = whoActs(table)!;
		if (victims.includes(actor)) act(table, actor, "allIn");
		else if (actor === winner) checkOrCall(table, actor);
		else act(table, actor, "fold");
	}
	for (const victim of victims) expect(seatOf(table, victim).out).toBe(true);
	return posted;
}

/** Deal `hands` hands that everyone folds out, answering who posted and held what on each. */
function dealFoldedHands(table: HoldemTable, hands: number, seed = 21): ReturnType<typeof blindsOf>[] {
	const posted: ReturnType<typeof blindsOf>[] = [];
	for (let hand = 0; hand < hands; hand++) {
		dealHand(table, seededRng(seed + hand));
		posted.push(blindsOf(table));
		foldOut(table);
	}
	return posted;
}

describe("the big blind moves forward one seat every hand", () => {
	// ⚠️ THE OWNER'S REPRO (2026-10 item 280). Four handed with the button on p0, the small
	// blind p1 busts and p2 is the big blind. The moving button sat p3 on the small blind and
	// then the button, so p2 paid the big blind again before p3 paid it once.
	it("has every live seat post the big blind once per orbit after the small blind busts", () => {
		const table = seatedTable(4);
		const first = dealBusting(table, ["p1"], "p2");
		expect(first).toMatchObject({ small: "p1", big: "p2", button: "p0" });

		const next = dealFoldedHands(table, 3);
		expect(next.map((hand) => hand.big)).toEqual(["p3", "p0", "p2"]);
		expect(next.map((hand) => hand.small)).toEqual(["p2", "p3", "p0"]);
	});

	it("leaves the button dead on the busted small blind's seat, so the seat before it acts last", () => {
		const table = seatedTable(4);
		dealBusting(table, ["p1"], "p2");

		dealHand(table, seededRng(5));
		// The button is dead on p1's seat. p0, the live seat before it, closes every street.
		expect(blindsOf(table)).toEqual({ small: "p2", big: "p3", button: "p0" });
		expect(whoActs(table)).toBe("p0");
		checkOrCall(table, "p0");
		checkOrCall(table, "p2");
		checkOrCall(table, "p3");
		expect(table.street).toBe("flop");
		// First left of the dead button is the small blind.
		expect(whoActs(table)).toBe("p2");
	});

	it("plays a dead small blind when the big blind busts, with the button on last hand's small blind", () => {
		const table = seatedTable(4);
		dealBusting(table, ["p2"], "p1");
		const chipsBefore = tableChips(table);

		dealHand(table, seededRng(5));
		expect(blindsOf(table)).toEqual({ small: undefined, big: "p3", button: "p1" });
		// Only the big blind went in: nobody posts the small blind for a seat that is gone.
		expect(table.seats.reduce((sum, seat) => sum + seat.totalCommitted, 0)).toBe(table.bigBlind);
		// Preflop opens left of the big blind, and the big blind keeps its option.
		expect(whoActs(table)).toBe("p0");
		checkOrCall(table, "p0");
		checkOrCall(table, "p1");
		expect(whoActs(table)).toBe("p3");
		checkOrCall(table, "p3");
		// After the flop the first live seat left of the button opens.
		expect(table.street).toBe("flop");
		expect(whoActs(table)).toBe("p3");
		foldOut(table);
		expect(tableChips(table)).toBe(chipsBefore);

		const next = dealFoldedHands(table, 2);
		expect(next.map((hand) => hand.big)).toEqual(["p0", "p1"]);
		expect(next.map((hand) => hand.small)).toEqual(["p3", "p0"]);
	});

	it("moves the blinds on as usual when the button busts", () => {
		const table = seatedTable(4);
		dealBusting(table, ["p0"], "p2");

		const next = dealFoldedHands(table, 3);
		expect(next.map((hand) => hand.big)).toEqual(["p3", "p1", "p2"]);
		expect(next.map((hand) => hand.small)).toEqual(["p2", "p3", "p1"]);
		expect(next[0].button).toBe("p1");
	});

	it("handles two busts on one hand: a dead small blind and a dead button, then the orbit goes on", () => {
		const table = seatedTable(5);
		// Button p0, small blind p1, big blind p2. Both blinds bust to p3's aces.
		const first = dealBusting(table, ["p1", "p2"], "p3");
		expect(first).toMatchObject({ small: "p1", big: "p2", button: "p0" });

		const next = dealFoldedHands(table, 3);
		expect(next.map((hand) => hand.big)).toEqual(["p3", "p4", "p0"]);
		expect(next.map((hand) => hand.small)).toEqual([undefined, "p3", "p4"]);
		// Dead on p1's seat, then dead on p2's, so p0 is the live seat behind it twice.
		expect(next.map((hand) => hand.button)).toEqual(["p0", "p0", "p3"]);
	});

	it("keeps every chip on the table across a dead small blind and a dead button", () => {
		const table = seatedTable(5);
		dealBusting(table, ["p1", "p2"], "p3");
		const chipsBefore = tableChips(table);
		dealFoldedHands(table, 4);
		expect(tableChips(table)).toBe(chipsBefore);
		expect(chipsBefore).toBe(3 * START + 2 * SHORT_STACK);
	});

	// The odd chip goes first left of the button (holdemPots' house rule), which with a dead
	// button is the first live seat after the seat it is dead on.
	it("gives the odd chip of a split pot to the first live seat left of a dead button", () => {
		const table = seatedTable(4);
		dealBusting(table, ["p1"], "p2");
		dealHand(table, seededRng(5));
		// Button dead on p1, p2 small, p3 big. Every hand plays the broadway board, so p2 and p0 split.
		table.holeCards.p0 = [card(2, "d"), card(3, "h")];
		table.holeCards.p2 = [card(4, "d"), card(5, "h")];
		table.holeCards.p3 = [card(6, "d"), card(7, "h")];
		table.deck = [card(10, "c"), card(11, "d"), card(12, "h"), card(13, "s"), card(14, "c")];
		const stacksBefore = { p0: seatOf(table, "p0").stack + seatOf(table, "p0").totalCommitted, p2: seatOf(table, "p2").stack + seatOf(table, "p2").totalCommitted };

		act(table, "p0", "raise", 41);
		act(table, "p2", "call");
		act(table, "p3", "call");
		act(table, "p2", "bet", 20);
		act(table, "p3", "fold");
		act(table, "p0", "call");
		for (let turn = 0; turn < 10 && handInProgress(table); turn++) checkOrCall(table, whoActs(table)!);

		// A pot of 3 x 41 + 2 x 20 = 163 splits 82 and 81, the odd chip to p2.
		expect(handInProgress(table)).toBe(false);
		expect(seatOf(table, "p2").stack - stacksBefore.p2).toBe(82 - 61);
		expect(seatOf(table, "p0").stack - stacksBefore.p0).toBe(81 - 61);
	});
});

describe("going heads up never repeats a big blind", () => {
	// Three handed, button p0, small blind p1, big blind p2, and one of them busts.
	it.each([
		["the button", "p0", "p2"],
		["the small blind", "p1", "p2"],
		["the big blind", "p2", "p1"],
	])("alternates the big blind from the hand after %s busts", (_who, victim, winner) => {
		const table = seatedTable(3);
		dealBusting(table, [victim], winner);
		const lastBigBlind = "p2";

		const next = dealFoldedHands(table, 4);
		const bigs = [lastBigBlind, ...next.map((hand) => hand.big)];
		for (let hand = 1; hand < bigs.length; hand++) expect(bigs[hand]).not.toBe(bigs[hand - 1]);
		// Heads up the button posts the small blind.
		for (const hand of next) expect(hand.small).toBe(hand.button);
	});
});

describe("seats changing between hands", () => {
	it("plays a dead small blind when last hand's big blind leaves between hands", () => {
		const table = seatedTable(4);
		const posted = dealFoldedHands(table, 1)[0];
		expect(posted).toMatchObject({ small: "p1", big: "p2", button: "p0" });
		leaveTable(table, "p2");
		// Shown between hands the way the next deal will play it.
		expect(buttonHolder(table)).toBe("p1");

		dealHand(table, seededRng(5));
		expect(blindsOf(table)).toEqual({ small: undefined, big: "p3", button: "p1" });
	});

	it("gives a late seat the big blind when it sits down right after last hand's big blind", () => {
		const table = seatedTable(3);
		dealFoldedHands(table, 1);
		requestLateSeat(table, "late", "Late");

		const next = dealFoldedHands(table, 4);
		expect(next.map((hand) => hand.big)).toEqual(["late", "p0", "p1", "p2"]);
		expect(next[0]).toMatchObject({ small: "p2", button: "p1" });
	});
});

describe("a row stored before bigBlindUserId existed", () => {
	it("deals its next hand from the stored button the old way, then moves the big blind forward", () => {
		const table = seatedTable(4);
		dealFoldedHands(table, 1);
		// What the old engine stored between hands: the button passed to p1, no big blind.
		delete table.bigBlindUserId;
		table.buttonIndex = 1;

		const next = dealFoldedHands(table, 3);
		expect(next[0]).toEqual({ small: "p2", big: "p3", button: "p1" });
		expect(next.map((hand) => hand.big)).toEqual(["p3", "p0", "p1"]);
	});
});
