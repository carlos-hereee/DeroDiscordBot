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
	endTable,
	standings,
	type HoldemTable,
} from "./holdemTable.js";
import type { Card, Suit } from "./holdemHand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── leaving and ending a table ─────────────────────────────────────────────
// What:  the engine half of the Leave table and End table buttons.
// Where: the owner's 1.7.0 test run found a Hold'em table nobody could leave and
//        no host could end, which held the host's one room slot. Every case below
//        pairs the way out with the chips it must not create or lose.

function seededRng(seed = 11): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function tableWith(count: number, seed = 11): HoldemTable {
	const table = createTable();
	for (let index = 0; index < count; index++) joinTable(table, `p${index}`, `Player ${index}`);
	table.status = "playing";
	dealHand(table, seededRng(seed));
	return table;
}

// Fold everyone but one, so the hand settles and the table sits between hands.
function betweenHands(count: number): HoldemTable {
	const table = tableWith(count);
	while (handInProgress(table)) act(table, whoActs(table)!, "fold");
	return table;
}

// Check or call every turn to the end of the hand. Bounded, so a table that stopped
// offering either action fails the test instead of hanging it.
function playItOut(table: HoldemTable): void {
	for (let turn = 0; turn < 50 && handInProgress(table); turn++) {
		const userId = whoActs(table)!;
		const legal = actionsFor(table, userId).map((entry) => entry.action);
		act(table, userId, legal.includes("check") ? "check" : "call");
	}
}

const seatOf = (table: HoldemTable, userId: string) => table.seats.find((seat) => seat.userId === userId)!;
const liveChips = (table: HoldemTable) =>
	livePlayers(table).reduce((sum, seat) => sum + seat.stack + seat.totalCommitted, 0);
const buttonHolder = (table: HoldemTable) => {
	const live = livePlayers(table);
	return live[table.buttonIndex % live.length].userId;
};

const START = BOT_CONSTANTS.HOLDEM_STARTING_STACK;

describe("leaving before the first deal", () => {
	it("removes the seat, so the place is free for the next buyer", () => {
		const table = createTable();
		joinTable(table, "a", "A");
		joinTable(table, "b", "B");

		// stackLeft is the whole buy in: a chip table refunds it (2026-10 item 250 Phase 5).
		expect(leaveTable(table, "a")).toEqual({ ok: true, foldedHand: false, stackLeft: START });
		expect(table.seats.map((seat) => seat.userId)).toEqual(["b"]);
		expect(table.status).toBe("joining");
		expect(joinTable(table, "a", "A")).toEqual({ ok: true });
	});
});

describe("leaving a live hand", () => {
	it("folds a seat that is not on the clock and leaves the clock where it was", () => {
		const table = tableWith(3);
		const acting = whoActs(table)!;
		const leaver = table.seats.find((seat) => seat.userId !== acting)!.userId;

		const outcome = leaveTable(table, leaver);

		expect(outcome).toMatchObject({ ok: true, foldedHand: true });
		expect(outcome.narration).toBeUndefined();
		expect(seatOf(table, leaver)).toMatchObject({ out: true, folded: true, stack: 0 });
		expect(whoActs(table)).toBe(acting);
		expect(handInProgress(table)).toBe(true);
	});

	it("folds the seat on the clock through the engine, which passes the clock on", () => {
		const table = tableWith(3);
		const leaver = whoActs(table)!;

		leaveTable(table, leaver);

		expect(seatOf(table, leaver)).toMatchObject({ out: true, folded: true });
		expect(whoActs(table)).not.toBe(leaver);
		expect(whoActs(table)).not.toBeNull();
	});

	it("ends the hand and the tournament heads up, and the pot goes to the seat that stayed", () => {
		const table = tableWith(2);
		const leaver = table.seats[0].userId;
		const stayer = table.seats[1].userId;
		const potBefore = table.seats.reduce((sum, seat) => sum + seat.totalCommitted, 0);
		const stayerBefore = seatOf(table, stayer).stack;

		const outcome = leaveTable(table, leaver);

		expect(outcome).toMatchObject({ ok: true, handOver: true, tournamentOver: true });
		expect(table.status).toBe("finished");
		expect(table.winnerId).toBe(stayer);
		expect(seatOf(table, stayer).stack).toBe(stayerBefore + potBefore);
		expect(seatOf(table, leaver).stack).toBe(0);
	});

	it("never hands chips back to a seat that left, however the hand ends", () => {
		const table = tableWith(3);
		const acting = whoActs(table)!;
		const leaver = table.seats.find((seat) => seat.userId !== acting)!.userId;
		leaveTable(table, leaver);

		playItOut(table);

		expect(handInProgress(table)).toBe(false);

		expect(seatOf(table, leaver).stack).toBe(0);
		expect(livePlayers(table).map((seat) => seat.userId)).not.toContain(leaver);
	});

	// 2026-10 item 276, audit P2-9: an uncalled raise handed back at the settle used to land on
	// the out seat, whose stack was already cashed out and is never paid again, so the chips
	// left the table. A leaver's bet stays in the pot like any folded chips.
	it("gives a leaver's uncalled raise to the pot's winner, never back to the seat that left", () => {
		const table = tableWith(3);
		const raiser = whoActs(table)!;
		const raise = actionsFor(table, raiser).find((entry) => entry.action === "raise" || entry.action === "bet")!;
		act(table, raiser, raise.action, raise.min);
		const { stackLeft } = leaveTable(table, raiser);
		const raised = seatOf(table, raiser).totalCommitted;

		act(table, whoActs(table)!, "fold");

		expect(handInProgress(table)).toBe(false);
		const winner = livePlayers(table).find((seat) => !seat.folded)!;
		expect(winner.stack).toBeGreaterThan(START + raised - 1);
		expect(liveChips(table) + (stackLeft ?? 0)).toBe(3 * START);
	});
});

describe("leaving between hands", () => {
	it("marks the seat out in finishing order and keeps the button on the seat that holds it", () => {
		const table = betweenHands(4);
		const holder = buttonHolder(table);
		const live = livePlayers(table);
		const leaver = live.find((seat) => seat.userId !== holder)!.userId;

		const outcome = leaveTable(table, leaver);

		expect(outcome).toMatchObject({ ok: true, foldedHand: false });
		expect(table.bustOrder).toEqual([leaver]);
		expect(buttonHolder(table)).toBe(holder);
		expect(table.status).toBe("playing");
	});

	it("ends the tournament when only one seat is left", () => {
		const table = betweenHands(2);
		const [leaver, stayer] = table.seats.map((seat) => seat.userId);

		const outcome = leaveTable(table, leaver);

		expect(outcome).toMatchObject({ ok: true, tournamentOver: true });
		expect(table.winnerId).toBe(stayer);
	});

	it("refuses a second leave from the same player, and any leave once the table is over", () => {
		const table = betweenHands(3);
		const leaver = table.seats[0].userId;
		leaveTable(table, leaver);

		expect(leaveTable(table, leaver)).toEqual({ ok: false, reason: "notSeated" });
		expect(leaveTable(table, "stranger")).toEqual({ ok: false, reason: "notSeated" });

		endTable(table);
		expect(leaveTable(table, table.seats[1].userId)).toEqual({ ok: false, reason: "closed" });
	});
});

describe("the button (2026-10 item 276, P2-7 and P2-8)", () => {
	// A table of four with the button on `button`, dealt with every seat still in.
	function fourDealtWithButtonOn(button: number): HoldemTable {
		const table = createTable();
		for (let index = 0; index < 4; index++) joinTable(table, `p${index}`, `Player ${index}`);
		table.status = "playing";
		table.buttonIndex = button;
		dealHand(table, seededRng());
		return table;
	}

	it("passes to the next seat after the old button's seat when a seat before it busts", () => {
		// Button p2, small blind p3, big blind p0 all in for its 20. p1 calls with aces on a
		// board that cannot save p0's seven two, the others fold, and p0 busts.
		const table = createTable();
		for (let index = 0; index < 4; index++) joinTable(table, `p${index}`, `Player ${index}`);
		table.status = "playing";
		table.buttonIndex = 2;
		seatOf(table, "p0").stack = 20;
		dealHand(table, seededRng());
		const card = (rank: number, suit: Suit): Card => ({ rank, suit });
		table.holeCards.p0 = [card(7, "c"), card(2, "d")];
		table.holeCards.p1 = [card(14, "s"), card(14, "h")];
		table.deck = [card(3, "h"), card(4, "c"), card(9, "d"), card(13, "h"), card(13, "s")];
		act(table, "p1", "call");
		act(table, "p2", "fold");
		act(table, "p3", "fold");
		playItOut(table);

		expect(seatOf(table, "p0").out).toBe(true);
		// p3, not p1: the old index plus one over the three seats left named p1, so p3
		// never held the button.
		expect(buttonHolder(table)).toBe("p3");
	});

	it("opens the flop left of a button that left mid hand, and passes the next button there", () => {
		const table = fourDealtWithButtonOn(1);
		// Button p1, blinds p2 and p3, p0 first to act preflop. The button leaves before acting.
		leaveTable(table, "p1");
		act(table, "p0", "call");
		act(table, "p2", "call");
		act(table, "p3", "check");

		expect(table.street).toBe("flop");
		expect(whoActs(table)).toBe("p2");
		playItOut(table);
		expect(buttonHolder(table)).toBe("p2");
	});

	// The dead button rule (2026-10 item 280): the button does not pass on to the next seat
	// when its holder leaves between hands, it stays dead on the leaver's seat, so the live
	// seat before it acts last. Button p1, blinds p2 and p3 on hand one; next hand p3 posts
	// the small blind, p0 the big blind and the button is p2's, who leaves.
	it("leaves the button dead on its seat when its holder leaves between hands", () => {
		const table = fourDealtWithButtonOn(1);
		while (handInProgress(table)) act(table, whoActs(table)!, "fold");
		expect(buttonHolder(table)).toBe("p2");
		leaveTable(table, "p2");
		expect(buttonHolder(table)).toBe("p1");

		dealHand(table, seededRng());
		expect(buttonHolder(table)).toBe("p1");
		expect(seatOf(table, "p3").committed).toBe(table.smallBlind);
		expect(seatOf(table, "p0").committed).toBe(table.bigBlind);
		expect(whoActs(table)).toBe("p1");
	});
});

describe("ending the table", () => {
	it("calls off a running hand, so every chip goes back to the seat that put it in", () => {
		const table = tableWith(3);
		const before = liveChips(table);

		const order = endTable(table);

		expect(table.status).toBe("finished");
		expect(table.betting).toBeNull();
		expect(table.seats.every((seat) => seat.totalCommitted === 0)).toBe(true);
		expect(liveChips(table)).toBe(before);
		expect(table.seats.map((seat) => seat.stack)).toEqual([START, START, START]);
		expect(order).toHaveLength(3);
		expect(table.winnerId).toBe(order[0]);
	});

	// 2026-10 item 276, audit P2-14: a seat that left mid hand forfeited what it put in, and with
	// no showdown those chips go to the seats still in rather than off the table.
	it("calls off a running hand a seat left, sharing the leaver's chips among the seats still in", () => {
		const table = tableWith(3);
		const acting = whoActs(table)!;
		const leaver = table.seats.find((seat) => seat.userId !== acting && seat.totalCommitted > 0)!.userId;
		const { stackLeft } = leaveTable(table, leaver);
		expect(seatOf(table, leaver).totalCommitted).toBeGreaterThan(0);

		endTable(table);

		expect(liveChips(table) + (stackLeft ?? 0)).toBe(3 * START);
		expect(seatOf(table, leaver).stack).toBe(0);
	});

	it("ranks the seats still in by chips, then the seats that are out, last one out first", () => {
		const table = betweenHands(4);
		const [first, second] = livePlayers(table).map((seat) => seat.userId);
		leaveTable(table, first);
		leaveTable(table, second);

		const stillIn = livePlayers(table)
			.sort((a, b) => b.stack - a.stack)
			.map((seat) => seat.userId);
		expect(standings(table)).toEqual([...stillIn, second, first]);
	});

	it("has no winner when no hand was ever dealt", () => {
		const table = createTable();
		joinTable(table, "a", "A");
		joinTable(table, "b", "B");

		endTable(table);

		expect(table.status).toBe("finished");
		expect(table.winnerId).toBeNull();
	});
});
