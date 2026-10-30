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
import type { Card, Suit } from "./holdemHand.js";
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

// ── regressions from the 2026-08-12 review ────────────────────────────
// Each case below is a bug that shipped, and each one looked exactly like poker on
// screen while it was wrong. That is why they are pinned rather than trusted.

describe("position after the flop", () => {
	// ⚠️ THE BUTTON ACTS LAST POST FLOP. seatOrderFrom starts AT the button, so
	// opening the street at index 0 handed the worst position to the seat that is
	// supposed to have the best, on every street of every hand, and nothing threw.
	it("opens the flop on the seat after the button, never on the button", () => {
		const table = tableWith(3);
		const order = table.betting!.seats.map((seat) => seat.userId);
		// Preflop the small blind is one seat after the button, so index 0 is the button.
		const button = order[0];

		// Close the preflop round: everyone calls, big blind checks its option.
		act(table, whoActs(table)!, "call");
		act(table, whoActs(table)!, "call");
		act(table, whoActs(table)!, "check");

		expect(table.street).toBe("flop");
		expect(whoActs(table)).not.toBe(button);
		expect(whoActs(table)).toBe(order[1]);
	});

	it("keeps the button acting last for the whole street, not just the first action", () => {
		const table = tableWith(3);
		const order = table.betting!.seats.map((seat) => seat.userId);
		const button = order[0];

		act(table, whoActs(table)!, "call");
		act(table, whoActs(table)!, "call");
		act(table, whoActs(table)!, "check");

		// Two checks from the two blinds, and the button is the one still to speak.
		act(table, whoActs(table)!, "check");
		act(table, whoActs(table)!, "check");
		expect(whoActs(table)).toBe(button);
	});
});

describe("a blind bigger than a stack", () => {
	// ⚠️ THE OPENER MAY BE ALL IN BEFORE ANYBODY CHOOSES ANYTHING. A small blind whose
	// stack was smaller than the blind is all in the moment it is posted, and pointing
	// toAct at them wedged the table for good: legalActions answered nothing, the
	// opponent was told it was not their turn, and forceFold found no action to force,
	// so the clock skipped it every ten seconds forever. The deep big blind already
	// covers that all in, so nobody has a decision at all and the deal runs the hand
	// out (2026-10 item 280).
	it("never leaves an all-in blind poster as the player to act", () => {
		const table = createTable();
		joinTable(table, "short", "Short");
		joinTable(table, "deep", "Deep");
		table.status = "playing";
		// Heads up posts the small blind ON the button, which is seat 0.
		table.seats[0].stack = 5;
		const outcome = dealHand(table, seededRng(11));

		expect(whoActs(table)).toBeNull();
		expect(outcome.handOver).toBe(true);
	});

	it("resolves the hand at the deal, handing the deep stack its uncalled blind back", () => {
		const table = createTable();
		joinTable(table, "short", "Short");
		joinTable(table, "deep", "Deep");
		table.status = "playing";
		table.seats[0].stack = 5;
		const outcome = dealHand(table, seededRng(11));

		expect(outcome.returned).toEqual({ userId: "deep", amount: 15 });
		expect(table.board).toHaveLength(5);
		expect(chipsInPlay(table)).toBe(START + 5);
	});

	// ⚠️ THE SHORT BIG BLIND (2026-10 item 280). The round opens at the full big blind,
	// but the button's small blind already covers the 5 the big blind could put in, so
	// offering fold, call or raise asked a question with no stake: the clock folded and
	// the short stack doubled without a showdown.
	it("runs a short big blind's hand out instead of asking the covering small blind to act", () => {
		const table = createTable();
		joinTable(table, "deep", "Deep");
		joinTable(table, "short", "Short");
		table.status = "playing";
		table.seats[0].stack = 1000;
		table.seats[1].stack = 5;
		const outcome = dealHand(table, seededRng(11));

		expect(whoActs(table)).toBeNull();
		expect(outcome.handOver).toBe(true);
		expect(outcome.returned).toEqual({ userId: "deep", amount: 5 });
		// A 5 against 5 showdown, so the pot is 10 and nothing else moved.
		expect(outcome.awards?.reduce((sum, award) => sum + award.amount, 0)).toBe(10);
		expect(chipsInPlay(table)).toBe(1005);
	});
});

// Rig the cards still to come: each player's hole cards, and a board of nothing so the
// pocket pairs decide it. The deck pops from the end, so these five are the whole board.
const card = (rank: number, suit: Suit): Card => ({ rank, suit });
function rigCards(table: HoldemTable, hands: Record<string, Card[]>): void {
	Object.assign(table.holeCards, hands);
	table.deck = [card(3, "h"), card(4, "c"), card(9, "d"), card(11, "h"), card(12, "s")];
}
const ACES = [card(14, "s"), card(14, "h")];
const KINGS = [card(13, "s"), card(13, "d")];
const SEVEN_TWO = [card(7, "c"), card(2, "d")];
const EIGHT_FIVE = [card(8, "c"), card(5, "d")];

// Call or check until the hand in progress ends.
function playOut(table: HoldemTable): void {
	const hand = table.handNumber;
	let guard = 0;
	while (table.handNumber === hand && table.street !== "showdown" && whoActs(table) && guard++ < 60) {
		const actor = whoActs(table)!;
		const legal = actionsFor(table, actor).map((entry) => entry.action);
		act(table, actor, legal.includes("check") ? "check" : "call");
	}
}

function threeHanded(stacks: [number, number, number]): HoldemTable {
	const table = createTable();
	for (let index = 0; index < 3; index++) joinTable(table, `p${index}`, `P${index}`);
	stacks.forEach((stack, index) => (table.seats[index].stack = stack));
	table.status = "playing";
	// Button p0, small blind p1, big blind p2, and p0 acts first preflop.
	dealHand(table, seededRng(11));
	return table;
}

describe("two busts on one hand", () => {
	// ⚠️ THE BIGGER STARTING STACK FINISHES HIGHER (2026-10 item 280). Busts used to be
	// recorded in seat order, which placed p2 (100) above p1 (300).
	it("places the player who started the hand with more chips higher", () => {
		const table = threeHanded([5000, 300, 100]);
		rigCards(table, { p0: ACES, p1: SEVEN_TWO, p2: EIGHT_FIVE });
		act(table, "p0", "call");
		act(table, "p1", "allIn");
		act(table, "p2", "allIn");
		const outcome = act(table, "p0", "call");

		expect(outcome.busted).toEqual(["p2", "p1"]);
		expect(placements(table)).toEqual(["p0", "p1", "p2"]);
		expect(chipsInPlay(table)).toBe(5400);
	});

	it("keeps seat order when both started the hand with the same chips", () => {
		const table = threeHanded([5000, 200, 200]);
		rigCards(table, { p0: ACES, p1: SEVEN_TWO, p2: EIGHT_FIVE });
		act(table, "p0", "call");
		act(table, "p1", "allIn");
		act(table, "p2", "allIn");
		const outcome = act(table, "p0", "call");

		expect(outcome.busted).toEqual(["p1", "p2"]);
	});
});

describe("the button going heads up", () => {
	const blindsOf = (table: HoldemTable) => ({
		small: table.seats.find((seat) => !seat.out && seat.committed === table.smallBlind)?.userId,
		big: table.seats.find((seat) => !seat.out && seat.committed === table.bigBlind)?.userId,
	});

	// ⚠️ NOBODY POSTS THE BIG BLIND TWICE IN A ROW (2026-10 item 280). Passing the button
	// on as usual put p1 on it, and heads up the button posts the small blind, so p2
	// paid the big blind again.
	it("moves the button to last hand's big blind when the button busts", () => {
		const table = threeHanded([100, 5000, 5000]);
		rigCards(table, { p0: SEVEN_TWO, p1: ACES, p2: KINGS });
		act(table, "p0", "allIn");
		playOut(table);
		expect(table.seats[0].out).toBe(true);

		dealHand(table, seededRng(12));
		expect(blindsOf(table)).toEqual({ small: "p2", big: "p1" });
	});

	it("gives the big blind to the button when the small blind busts", () => {
		const table = threeHanded([5000, 100, 5000]);
		rigCards(table, { p0: KINGS, p1: SEVEN_TWO, p2: ACES });
		act(table, "p0", "call");
		act(table, "p1", "allIn");
		playOut(table);
		expect(table.seats[1].out).toBe(true);

		dealHand(table, seededRng(12));
		expect(blindsOf(table)).toEqual({ small: "p2", big: "p0" });
	});

	it("passes the button on as usual when the big blind busts", () => {
		const table = threeHanded([5000, 5000, 100]);
		rigCards(table, { p0: KINGS, p1: ACES, p2: SEVEN_TWO });
		act(table, "p0", "call");
		act(table, "p1", "call");
		act(table, "p2", "allIn");
		playOut(table);
		expect(table.seats[2].out).toBe(true);

		dealHand(table, seededRng(12));
		expect(blindsOf(table)).toEqual({ small: "p1", big: "p0" });
	});
});

describe("uncalled chips come back", () => {
	// ⚠️ THIS IS A HAND HISTORY BUG, NOT A MISSING CHIP, and the distinction is worth
	// stating because the first version of this note claimed otherwise. holdemPots
	// exports `uncalledPortion` for exactly this and nothing called it, so a player
	// who shoved 1000 into a pot nobody could match was credited with winning all of
	// it. The chips did land in the right stack either way (the layers merge, so the
	// shover was eligible for their own uncalled money), which is why no total ever
	// looked wrong. What was wrong is the sentence the transcript prints, and the
	// transcript is the product.
	function shoveAndFold() {
		const table = createTable();
		joinTable(table, "shover", "Shover");
		joinTable(table, "folder", "Folder");
		table.status = "playing";
		dealHand(table, seededRng(11));
		// Heads up the button posts the small blind and acts first preflop.
		act(table, whoActs(table)!, "allIn");
		return { table, outcome: act(table, whoActs(table)!, "fold") };
	}

	it("reports the uncalled chips as returned rather than won", () => {
		const { outcome } = shoveAndFold();

		// The blinds are 10/20, so only 40 was ever contested and the rest was never
		// at risk.
		expect(outcome.returned).toEqual({ userId: "shover", amount: START - 20 });
		expect(outcome.awards).toEqual([{ userId: "shover", amount: 40 }]);
	});

	it("still leaves the shover with every chip they are owed", () => {
		const { table } = shoveAndFold();

		// The returned slice plus the contested pot, which is the blind they won.
		expect(table.seats.find((seat) => seat.userId === "shover")!.stack).toBe(START + 20);
		expect(chipsInPlay(table)).toBe(START * 2);
	});
});

describe("the minimum bet after the flop", () => {
	// ⚠️ ONE CHIP IS NOT A BET. legalActions computes minTotal as
	// `currentBet + max(lastRaiseSize, 1)`, and a street used to open with a zero last
	// raise, so at blinds of 320/640 a player could open the flop for a SINGLE chip and
	// the next minimum raise was then 2 rather than 640. Under a 30 second clock that is
	// a way to stall a table, not a bet.
	function toTheFlop() {
		const table = tableWith(3);
		act(table, whoActs(table)!, "call");
		act(table, whoActs(table)!, "call");
		act(table, whoActs(table)!, "check");
		return table;
	}

	it("floors the opening bet at the big blind", () => {
		const table = toTheFlop();
		expect(table.street).toBe("flop");

		const opener = whoActs(table)!;
		const bet = actionsFor(table, opener).find((entry) => entry.action === "bet");

		expect(bet).toBeDefined();
		expect(bet!.min).toBe(table.bigBlind);
	});

	// The other half of the same trap, and the one that made every post-flop bet
	// impossible: the engine names the aggressive action "bet" when there is no bet to
	// raise, so anything dispatching a hardcoded "raise" misses.
	it("names the aggressive action bet, not raise, on a fresh street", () => {
		const table = toTheFlop();
		const legal = actionsFor(table, whoActs(table)!).map((entry) => entry.action);

		expect(legal).toContain("bet");
		expect(legal).not.toContain("raise");
	});
});
