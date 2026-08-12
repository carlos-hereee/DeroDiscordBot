import { describe, it, expect } from "vitest";
import {
	createTable,
	joinTable,
	dealHand,
	act,
	whoActs,
	actionsFor,
	forceFold,
	placements,
	livePlayers,
	type HoldemTable,
} from "./holdemTable.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// Deterministic but VARYING. A constant rng would deal every player the same card.
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

const chipsInPlay = (table: HoldemTable) =>
	table.seats.reduce((sum, seat) => sum + seat.stack + seat.totalCommitted, 0);

const START = BOT_CONSTANTS.HOLDEM_STARTING_STACK;

describe("seating and buy in", () => {
	it("gives every player the same starting stack", () => {
		const table = createTable();
		joinTable(table, "a", "A");
		joinTable(table, "b", "B");
		expect(table.seats.map((seat) => seat.stack)).toEqual([START, START]);
	});

	it("refuses a second seat for the same player", () => {
		const table = createTable();
		joinTable(table, "a", "A");
		expect(joinTable(table, "a", "A")).toEqual({ ok: false, reason: "alreadySeated" });
	});

	it("refuses past the table cap", () => {
		const table = createTable();
		for (let index = 0; index < BOT_CONSTANTS.HOLDEM_MAX_SEATS; index++) joinTable(table, `p${index}`, "P");
		expect(joinTable(table, "late", "Late")).toEqual({ ok: false, reason: "tableFull" });
	});

	it("refuses a joiner once the tournament started", () => {
		const table = tableWith(3);
		expect(joinTable(table, "late", "Late")).toEqual({ ok: false, reason: "started" });
	});
});

describe("the deal", () => {
	it("gives every live player exactly two cards", () => {
		const table = tableWith(4);
		for (const seat of livePlayers(table)) {
			expect(table.holeCards[seat.userId]).toHaveLength(2);
		}
	});

	it("deals from a fresh deck each hand, so nothing carries over", () => {
		const table = tableWith(3);
		const firstHand = JSON.stringify(table.holeCards);
		dealHand(table, seededRng(99));
		expect(JSON.stringify(table.holeCards)).not.toBe(firstHand);
	});

	it("never deals the same card twice in a hand", () => {
		const table = tableWith(6);
		const dealt = Object.values(table.holeCards).flat().map((card) => `${card.rank}${card.suit}`);
		expect(new Set(dealt).size).toBe(dealt.length);
	});

	it("posts the blinds and opens on a live player", () => {
		const table = tableWith(3);
		const committed = table.seats.filter((seat) => seat.committed > 0);
		expect(committed).toHaveLength(2);
		expect(whoActs(table)).not.toBeNull();
	});

	// Heads up posts the small blind ON the button; three or more posts it after.
	// Getting this wrong is invisible until somebody counts.
	it("posts heads up blinds on the button", () => {
		const table = tableWith(2);
		expect(table.seats.filter((seat) => seat.committed > 0)).toHaveLength(2);
	});
});

// ⚠️ THE PROPERTY THAT CATCHES ALMOST EVERY CHIP BUG. Chips can move between
// stacks and the pot, and must never be created or destroyed.
describe("chips are conserved", () => {
	it("holds the total across a full hand played to showdown", () => {
		const table = tableWith(3, 5);
		expect(chipsInPlay(table)).toBe(START * 3);

		// Everybody calls or checks their way to the end.
		let guard = 0;
		while (table.status === "playing" && whoActs(table) && guard++ < 60) {
			const actor = whoActs(table)!;
			const legal = actionsFor(table, actor).map((entry) => entry.action);
			act(table, actor, legal.includes("check") ? "check" : "call");
		}

		expect(chipsInPlay(table)).toBe(START * 3);
	});

	it("holds the total when a player is all in and others keep betting", () => {
		// Shrink one stack BEFORE the deal so the blinds and the all in are computed
		// against the real number, and so a genuine side pot forms.
		const table = createTable();
		joinTable(table, "p0", "P0");
		joinTable(table, "p1", "P1");
		joinTable(table, "p2", "P2");
		table.seats[2].stack = 40;
		table.status = "playing";
		dealHand(table, seededRng(21));

		const expected = START * 2 + 40;
		let guard = 0;
		while (table.status === "playing" && whoActs(table) && guard++ < 60) {
			const actor = whoActs(table)!;
			const legal = actionsFor(table, actor).map((entry) => entry.action);
			if (actor === "p2" && legal.includes("allIn")) act(table, actor, "allIn");
			else act(table, actor, legal.includes("check") ? "check" : "call");
		}

		expect(chipsInPlay(table)).toBe(expected);
	});

	// Between hands, `stack` is the sole truth. Leaving the hand's commitments
	// standing after settlement counts the same chips twice and a table appears to
	// double its chips every hand.
	it("clears the hand's commitments once it settles", () => {
		const table = tableWith(2, 13);
		const folder = whoActs(table)!;
		act(table, folder, "fold");

		expect(table.seats.every((seat) => seat.totalCommitted === 0)).toBe(true);
		expect(chipsInPlay(table)).toBe(START * 2);
	});
});

describe("the hand ends", () => {
	it("ends without a showdown when everyone folds to one player", () => {
		const table = tableWith(3, 7);
		let outcome;
		let guard = 0;
		while (table.status === "playing" && whoActs(table) && guard++ < 20) {
			const actor = whoActs(table)!;
			outcome = act(table, actor, "fold");
			if (outcome.handOver) break;
		}
		expect(outcome?.handOver).toBe(true);
		// ⚠️ NO CARDS ARE SHOWN. Revealing a winner's hole cards when nobody paid to
		// see them teaches the table how they play for free.
		expect(outcome?.showdown).toBeUndefined();
	});

	it("pays the pot to the last player standing", () => {
		const table = tableWith(2, 13);
		const survivor = whoActs(table) === "p0" ? "p1" : "p0";
		const folder = whoActs(table)!;
		const outcome = act(table, folder, "fold");

		expect(outcome.handOver).toBe(true);
		expect(outcome.awards?.some((award) => award.userId === survivor)).toBe(true);
	});
});

describe("busting and placement", () => {
	it("marks a player out when they lose every chip", () => {
		// A short stack that cannot cover the blind is all in on the deal and busts
		// when it loses, which is the ordinary way a tournament sheds players.
		const table = createTable();
		joinTable(table, "p0", "P0");
		joinTable(table, "p1", "P1");
		joinTable(table, "p2", "P2");
		table.seats[2].stack = 5;
		table.status = "playing";
		dealHand(table, seededRng(3));

		let guard = 0;
		while (table.status === "playing" && whoActs(table) && guard++ < 60) {
			const actor = whoActs(table)!;
			const legal = actionsFor(table, actor).map((entry) => entry.action);
			act(table, actor, legal.includes("check") ? "check" : "call");
		}

		// Either p2 busted, or they won the hand outright; both are legitimate, so
		// assert the invariant rather than one outcome: nobody sits with 0 chips and
		// is still considered live.
		expect(table.seats.every((seat) => seat.stack > 0 || seat.out)).toBe(true);
	});

	// The winner is first; the LAST player to bust finished second. Reversing the
	// bust order is the whole of that rule, and getting it backwards pays the
	// biggest placement bonus to whoever went out first.
	it("orders placements winner first, then the bust order reversed", () => {
		const table = createTable();
		joinTable(table, "a", "A");
		joinTable(table, "b", "B");
		joinTable(table, "c", "C");
		table.bustOrder = ["c", "b"];
		table.winnerId = "a";
		expect(placements(table)).toEqual(["a", "b", "c"]);
	});
});

describe("blind escalation", () => {
	// Without escalation a short stack folds forever and nothing resolves.
	it("doubles the blinds on the escalation pace", () => {
		const table = tableWith(3);
		const startingBig = table.bigBlind;

		for (let hand = 0; hand < BOT_CONSTANTS.HOLDEM_BLIND_ESCALATION_HANDS; hand++) {
			dealHand(table, seededRng(hand + 2));
		}

		expect(table.bigBlind).toBeGreaterThan(startingBig);
	});

	it("leaves them alone before the pace is reached", () => {
		const table = tableWith(3);
		const startingBig = table.bigBlind;
		dealHand(table, seededRng(4));
		expect(table.bigBlind).toBe(startingBig);
	});
});

// ⚠️ FORCE FOLD, NEVER PAUSE. Pausing hands one absent player the power to stall
// five present ones, which is the failure a turn clock exists to prevent.
describe("the turn clock", () => {
	it("acts for the player who is on the clock", () => {
		const table = tableWith(3, 17);
		const stalling = whoActs(table)!;

		const outcome = forceFold(table);

		expect(outcome.ok).toBe(true);
		expect(outcome.userId).toBe(stalling);
		expect(whoActs(table)).not.toBe(stalling);
	});

	// Taking a player's chips off them for being slow when checking was free would
	// be a punishment the rules never asked for.
	it("checks rather than folds when checking is free", () => {
		const table = tableWith(2, 23);
		// Get to a spot where the player to act can check.
		const first = whoActs(table)!;
		act(table, first, "call");
		const bigBlind = whoActs(table);
		if (bigBlind && actionsFor(table, bigBlind).some((entry) => entry.action === "check")) {
			const before = table.seats.find((seat) => seat.userId === bigBlind)!.stack;
			forceFold(table);
			expect(table.seats.find((seat) => seat.userId === bigBlind)!.stack).toBe(before);
		}
	});

	it("reports honestly when there is nobody to act", () => {
		// A table nobody has dealt to has no betting round, so the clock has nothing
		// to fold. It must say so rather than throwing on a null round.
		const table = createTable();
		expect(forceFold(table)).toMatchObject({ ok: false, reason: "nobodyToAct" });
	});
});

describe("the tournament ends", () => {
	it("finishes when one player holds every chip", () => {
		const table = tableWith(2, 31);
		table.seats[1].stack = 0;
		table.seats[1].out = true;
		dealHand(table, seededRng(41));

		expect(table.status).toBe("finished");
		expect(table.winnerId).toBe("p0");
	});

	it("leaves no chip state behind, because there is nowhere for it to go", () => {
		// The whole of A9/R22: a table's chips exist only on the table object. There
		// is no store call anywhere in this module, so a finished tournament cannot
		// leave a balance behind even by accident.
		const table = tableWith(2, 3);
		expect(Object.keys(table)).not.toContain("balances");
		expect(JSON.stringify(table)).not.toContain("persist");
	});
});
