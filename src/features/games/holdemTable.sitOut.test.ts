import { describe, it, expect } from "vitest";
import {
	createTable,
	joinTable,
	dealHand,
	act,
	forceFold,
	whoActs,
	actionsFor,
	handInProgress,
	returnToTable,
	clockStartOf,
	presentPlayers,
	type ActionOutcome,
	type HoldemTable,
	type TableSeat,
} from "./holdemTable.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── sitting out, coming back, and the clock's start ────────────────────────
// What:  the engine half of the Hold'em clock from the owner's 1.7.0 test run
//        (test fixes plan, item 13): two timeouts in a row sit a seat out, a seat
//        that sits out posts its blinds and is folded each hand, I'm back brings it
//        back, and the clock counts from when the board showed the table.

function seededRng(seed = 11): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function tableWith(count: number): HoldemTable {
	const table = createTable();
	for (let index = 0; index < count; index++) joinTable(table, `p${index}`, `Player ${index}`);
	table.status = "playing";
	dealHand(table, seededRng());
	return table;
}

const seat = (table: HoldemTable, userId: string): TableSeat => table.seats.find((entry) => entry.userId === userId)!;

// A passive decision for whoever is on the clock: check when free, call otherwise.
function passOn(table: HoldemTable): ActionOutcome {
	const actor = whoActs(table)!;
	const legal = actionsFor(table, actor).map((entry) => entry.action);
	return act(table, actor, legal.includes("check") ? "check" : "call", 0, seededRng());
}

// Every other seat plays passively until `userId` is on the clock or the hand ends.
function playUntilTurnOf(table: HoldemTable, userId: string): void {
	for (let guard = 0; guard < 50 && handInProgress(table) && whoActs(table) !== userId; guard++) passOn(table);
}

function finishHand(table: HoldemTable): void {
	for (let guard = 0; guard < 50 && handInProgress(table); guard++) passOn(table);
}

describe("two timeouts in a row", () => {
	it(`sits the seat out on timeout number ${BOT_CONSTANTS.HOLDEM_SIT_OUT_TIMEOUTS}, and only then`, () => {
		expect(BOT_CONSTANTS.HOLDEM_SIT_OUT_TIMEOUTS).toBe(2);
		const table = tableWith(3);
		const target = whoActs(table)!;

		const first = forceFold(table, seededRng());
		expect(first.satOut).toBeUndefined();
		expect(seat(table, target).timeoutsInRow).toBe(1);
		expect(seat(table, target).sittingOut).toBeFalsy();

		finishHand(table);
		dealHand(table, seededRng(5));
		playUntilTurnOf(table, target);
		expect(whoActs(table)).toBe(target);

		const second = forceFold(table, seededRng());
		expect(second.satOut).toBe(true);
		expect(seat(table, target).sittingOut).toBe(true);
	});

	it("starts the run over when the player makes a decision of their own in between", () => {
		const table = tableWith(3);
		const target = whoActs(table)!;
		forceFold(table, seededRng());
		finishHand(table);

		dealHand(table, seededRng(5));
		playUntilTurnOf(table, target);
		passOn(table);
		expect(seat(table, target).timeoutsInRow).toBe(0);

		finishHand(table);
		dealHand(table, seededRng(7));
		playUntilTurnOf(table, target);
		const next = forceFold(table, seededRng());
		expect(next.satOut).toBeUndefined();
		expect(seat(table, target).sittingOut).toBeFalsy();
	});
});

describe("a seat that sits out", () => {
	it("still posts its blind, is folded when the action reaches it, and never holds the clock", () => {
		const table = createTable();
		joinTable(table, "p0", "Present");
		joinTable(table, "p1", "Away");
		table.status = "playing";
		seat(table, "p1").sittingOut = true;

		const outcomes: ActionOutcome[] = [dealHand(table, seededRng())];
		// Heads up, both seats post a blind, so the absent one has chips in the pot.
		const posted = seat(table, "p1").totalCommitted;
		expect(posted).toBeGreaterThan(0);
		for (let guard = 0; guard < 20 && handInProgress(table); guard++) {
			expect(whoActs(table)).not.toBe("p1");
			outcomes.push(passOn(table));
		}

		expect(handInProgress(table)).toBe(false);
		expect(outcomes.flatMap((outcome) => outcome.sittingOutFolds ?? [])).toEqual(["p1"]);
		expect(seat(table, "p1").stack).toBe(BOT_CONSTANTS.HOLDEM_STARTING_STACK - posted);
		expect(seat(table, "p1").lastAction).toEqual({ action: "fold", amount: 0 });
	});

	it("is not one of the players present at the table", () => {
		const table = tableWith(3);
		seat(table, "p2").sittingOut = true;
		expect(presentPlayers(table).map((entry) => entry.userId)).toEqual(["p0", "p1"]);
	});
});

describe("I'm back", () => {
	it("refuses a seat that is playing, and a member with no seat", () => {
		const table = tableWith(2);
		expect(returnToTable(table, "p0")).toEqual({ ok: false, reason: "notSittingOut" });
		expect(returnToTable(table, "stranger")).toEqual({ ok: false, reason: "notSeated" });
	});

	it("brings the seat back, moves the action stamp, and keeps the clock of the player on it", () => {
		const table = tableWith(3);
		const away = table.seats.find((entry) => entry.userId !== whoActs(table))!;
		away.sittingOut = true;
		away.timeoutsInRow = 2;
		table.turnPrompt = { stamp: table.lastActionAt, shownAt: table.lastActionAt + 400 };
		const clockBefore = clockStartOf(table);
		const now = table.lastActionAt + 5_000;

		expect(returnToTable(table, away.userId, now)).toEqual({ ok: true });
		expect(away.sittingOut).toBe(false);
		expect(away.timeoutsInRow).toBe(0);
		expect(table.lastActionAt).toBe(now);
		expect(clockStartOf(table)).toBe(clockBefore);
	});
});

describe("the clock's start", () => {
	it("is when the board showed the current state, and the action stamp until it has", () => {
		const table = tableWith(2);
		expect(clockStartOf(table)).toBe(table.lastActionAt);
		table.turnPrompt = { stamp: table.lastActionAt, shownAt: table.lastActionAt + 2_500 };
		expect(clockStartOf(table)).toBe(table.lastActionAt + 2_500);
	});

	it("ignores a prompt the board showed for an earlier state", () => {
		const table = tableWith(3);
		table.turnPrompt = { stamp: table.lastActionAt - 1, shownAt: table.lastActionAt + 9_000 };
		expect(clockStartOf(table)).toBe(table.lastActionAt);
	});
});

describe("the last action", () => {
	it("records each decision for the live card and clears at the next deal", () => {
		const table = tableWith(3);
		const raiser = whoActs(table)!;
		const raise = actionsFor(table, raiser).find((entry) => entry.action === "raise")!;
		act(table, raiser, "raise", raise.min!, seededRng());
		expect(seat(table, raiser).lastAction).toEqual({ action: "raise", amount: raise.min });

		const folder = whoActs(table)!;
		act(table, folder, "fold", 0, seededRng());
		expect(seat(table, folder).lastAction).toEqual({ action: "fold", amount: 0 });

		finishHand(table);
		dealHand(table, seededRng(3));
		expect(table.seats.every((entry) => entry.lastAction === null)).toBe(true);
	});

	it("records what an all in put into the hand", () => {
		const table = tableWith(2);
		const shover = whoActs(table)!;
		act(table, shover, "allIn", 0, seededRng());
		expect(seat(table, shover).lastAction).toEqual({ action: "allIn", amount: BOT_CONSTANTS.HOLDEM_STARTING_STACK });
	});
});
