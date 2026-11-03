import { describe, it, expect } from "vitest";
import {
	createTable,
	joinTable,
	dealHand,
	act,
	whoActs,
	livePlayers,
	handInProgress,
	clockStartOf,
	placements,
	requestLateSeat,
	withdrawLateSeat,
	hasLateSeatFree,
	leaveTable,
	type HoldemTable,
} from "./holdemTable.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── late seats (2026-10 item 244 Phase 4) ─────────────────────────────────
// What:  the engine half of Open seats: a joiner claims a free seat mid tournament,
//        waits in pendingSeats, and is dealt in at the start of the next hand with
//        the table's starting stack.
// Where: the owner's hard rule for this change is that the hand state, the pots, the
//        blinds and the bust order never see a seat appear mid hand. Every case below
//        either checks that nothing about a live hand moves when a seat is claimed, or
//        that the seat appears exactly at the next deal and plays like any other.

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

// Fold round to one player, so the hand settles and the table sits between hands.
function foldToSettle(table: HoldemTable): void {
	for (let turn = 0; turn < 20 && handInProgress(table); turn++) act(table, whoActs(table)!, "fold");
}

const seatOf = (table: HoldemTable, userId: string) => table.seats.find((seat) => seat.userId === userId);
const tableChips = (table: HoldemTable) => table.seats.reduce((sum, seat) => sum + seat.stack + seat.totalCommitted, 0);
const handSnapshot = (table: HoldemTable) =>
	JSON.stringify({ seats: table.seats, betting: table.betting, board: table.board, bustOrder: table.bustOrder, handNumber: table.handNumber, buttonIndex: table.buttonIndex, blinds: [table.smallBlind, table.bigBlind] });

describe("claiming a late seat never touches the hand in progress", () => {
	it("holds the seat in pendingSeats and leaves every seat, the betting round, the board and the bust order exactly as they were", () => {
		const table = tableWith(3);
		expect(handInProgress(table)).toBe(true);
		const before = handSnapshot(table);

		expect(requestLateSeat(table, "late", "Late")).toEqual({ ok: true });

		expect(handSnapshot(table)).toBe(before);
		expect(table.pendingSeats).toEqual([{ userId: "late", username: "Late" }]);
		expect(seatOf(table, "late")).toBeUndefined();
	});

	it("plays the rest of the hand without the waiting seat: never to act, never in a pot", () => {
		const table = tableWith(3);
		requestLateSeat(table, "late", "Late");
		const chipsBefore = tableChips(table);

		for (let turn = 0; turn < 20 && handInProgress(table); turn++) {
			expect(whoActs(table)).not.toBe("late");
			act(table, whoActs(table)!, "fold");
		}

		expect(seatOf(table, "late")).toBeUndefined();
		expect(tableChips(table)).toBe(chipsBefore);
		expect(table.pendingSeats?.map((entry) => entry.userId)).toEqual(["late"]);
	});

	it("moves the action stamp so a racing write loses, but keeps the player on the clock's time", () => {
		const table = tableWith(3);
		table.turnPrompt = { stamp: table.lastActionAt, shownAt: table.lastActionAt - 5000 };
		const clockBefore = clockStartOf(table);
		const stampBefore = table.lastActionAt;

		requestLateSeat(table, "late", "Late", stampBefore + 1000);

		expect(table.lastActionAt).toBe(stampBefore + 1000);
		expect(clockStartOf(table)).toBe(clockBefore);
	});
});

describe("the next deal seats the waiting player", () => {
	it("deals them in at the start of the next hand with the table's starting stack", () => {
		const table = tableWith(3);
		foldToSettle(table);
		requestLateSeat(table, "late", "Late");
		const chipsBefore = tableChips(table);

		const outcome = dealHand(table, seededRng(5));

		expect(outcome.lateSeated).toEqual(["late"]);
		expect(table.pendingSeats).toEqual([]);
		const seat = seatOf(table, "late")!;
		expect(seat.out).toBe(false);
		expect(table.holeCards.late).toHaveLength(2);
		// The new seat's chips, in its stack and anything the blinds took, are exactly
		// the starting stack: the rest of the table's chips are unchanged.
		expect(seat.stack + seat.totalCommitted).toBe(BOT_CONSTANTS.HOLDEM_STARTING_STACK);
		expect(tableChips(table)).toBe(chipsBefore + BOT_CONSTANTS.HOLDEM_STARTING_STACK);
	});

	it("keeps the button on the seat it was passed to: the late seat sits at the end of the ring", () => {
		const table = tableWith(3);
		foldToSettle(table);
		const buttonBefore = livePlayers(table)[table.buttonIndex % livePlayers(table).length].userId;
		requestLateSeat(table, "late", "Late");

		dealHand(table, seededRng(5));

		const live = livePlayers(table);
		expect(live[table.buttonIndex % live.length].userId).toBe(buttonBefore);
		expect(live[live.length - 1].userId).toBe("late");
	});

	it("is refused a seat the last deal already made: a waiting seat never doubles", () => {
		const table = tableWith(3);
		foldToSettle(table);
		requestLateSeat(table, "late", "Late");
		dealHand(table, seededRng(5));

		expect(table.seats.filter((seat) => seat.userId === "late")).toHaveLength(1);
		expect(requestLateSeat(table, "late", "Late")).toEqual({ ok: false, reason: "alreadySeated" });
	});

	it("never seats anyone while a hand is still live, even when dealHand is reached", () => {
		const table = tableWith(3);
		requestLateSeat(table, "late", "Late");
		// A second deal over a live hand is refused upstream (handleDeal); this pins the
		// engine's own backstop, which keeps the waiting seat waiting.
		expect(handInProgress(table)).toBe(true);
		const outcome = dealHand(table, seededRng(5));
		expect(outcome.lateSeated).toBeUndefined();
		expect(seatOf(table, "late")).toBeUndefined();
	});
});

describe("refusals", () => {
	it("refuses a table still joining: that is a buy in", () => {
		const table = createTable();
		joinTable(table, "p0", "P0");
		expect(requestLateSeat(table, "late", "Late")).toEqual({ ok: false, reason: "notPlaying" });
	});

	it("refuses a player who already played here, even after busting: there is no rebuy", () => {
		const table = tableWith(3);
		leaveTable(table, "p2");
		expect(requestLateSeat(table, "p2", "P2")).toEqual({ ok: false, reason: "alreadySeated" });
		expect(requestLateSeat(table, "p0", "P0")).toEqual({ ok: false, reason: "alreadySeated" });
	});

	it("refuses a second claim from a player already waiting", () => {
		const table = tableWith(3);
		requestLateSeat(table, "late", "Late");
		expect(requestLateSeat(table, "late", "Late")).toEqual({ ok: false, reason: "alreadyWaiting" });
	});

	it("counts the players still in AND those waiting against the seat cap", () => {
		const table = tableWith(BOT_CONSTANTS.HOLDEM_MAX_SEATS - 1);
		expect(hasLateSeatFree(table)).toBe(true);
		expect(requestLateSeat(table, "late-1", "Late 1")).toEqual({ ok: true });
		expect(hasLateSeatFree(table)).toBe(false);
		expect(requestLateSeat(table, "late-2", "Late 2")).toEqual({ ok: false, reason: "tableFull" });
	});
});

describe("a late joiner ranks by bust order like everyone else", () => {
	// Seat a late joiner at a three seat table, then end the tournament by taking seats
	// out in a chosen order, through the same path a bust or a leave takes.
	function withLateSeat(): HoldemTable {
		const table = tableWith(3);
		foldToSettle(table);
		requestLateSeat(table, "late", "Late");
		dealHand(table, seededRng(5));
		foldToSettle(table);
		return table;
	}

	it("busting first ranks them last", () => {
		const table = withLateSeat();
		for (const userId of ["late", "p0", "p1"]) leaveTable(table, userId);

		expect(table.status).toBe("finished");
		const order = placements(table);
		expect(order[order.length - 1]).toBe("late");
		expect(order[0]).toBe("p2");
	});

	it("busting last of all wins it", () => {
		const table = withLateSeat();
		for (const userId of ["p0", "p1", "p2"]) leaveTable(table, userId);

		expect(table.status).toBe("finished");
		expect(table.winnerId).toBe("late");
		expect(placements(table)).toEqual(["late", "p2", "p1", "p0"]);
	});
});

describe("withdrawing a waiting seat (the host removing its player)", () => {
	it("drops only that entry and moves the stamp, and answers false when nobody was waiting", () => {
		const table = tableWith(3);
		requestLateSeat(table, "late-1", "Late 1");
		requestLateSeat(table, "late-2", "Late 2");
		const stamp = table.lastActionAt;

		expect(withdrawLateSeat(table, "late-1", stamp + 10)).toBe(true);
		expect(table.pendingSeats?.map((entry) => entry.userId)).toEqual(["late-2"]);
		expect(table.lastActionAt).toBe(stamp + 10);
		expect(withdrawLateSeat(table, "nobody")).toBe(false);
	});
});
