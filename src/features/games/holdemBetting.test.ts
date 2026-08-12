import { describe, it, expect } from "vitest";
import {
	openRound,
	postBlinds,
	nextStreet,
	legalActions,
	applyAction,
	seatOf,
	type BettingState,
	type Seat,
} from "./holdemBetting.js";

const seat = (userId: string, stack: number): Seat => ({
	userId,
	stack,
	committed: 0,
	totalCommitted: 0,
	folded: false,
	allIn: false,
});

const actionsFor = (state: BettingState, userId: string) => legalActions(state, userId).map((entry) => entry.action);
const toActId = (state: BettingState) => state.seats[state.toAct].userId;

// Apply and assert it was accepted, so a broken step fails where it happened
// rather than three assertions later.
function act(state: BettingState, userId: string, action: Parameters<typeof applyAction>[2], amount = 0): BettingState {
	const result = applyAction(state, userId, action, amount);
	expect(result.reason).toBeUndefined();
	expect(result.ok).toBe(true);
	return result.state;
}

describe("blinds", () => {
	// ⚠️ A BLIND IS NOT AN ACTION. If posting counted as acting, a table that only
	// calls would close the round without the big blind ever getting their option.
	it("commits chips without counting as having acted", () => {
		const state = postBlinds([seat("a", 100), seat("b", 100), seat("c", 100)], 0, 5, 10);
		expect(seatOf(state, "a")!.committed).toBe(5);
		expect(seatOf(state, "b")!.committed).toBe(10);
		expect(state.actedSince).toEqual([]);
	});

	it("opens on the player left of the big blind", () => {
		const state = postBlinds([seat("a", 100), seat("b", 100), seat("c", 100)], 0, 5, 10);
		expect(toActId(state)).toBe("c");
	});

	it("gives the big blind their option when everyone only calls", () => {
		let state = postBlinds([seat("a", 100), seat("b", 100), seat("c", 100)], 0, 5, 10);
		state = act(state, "c", "call");
		state = act(state, "a", "call");
		// Still open, and it is the big blind's turn.
		expect(state.closed).toBe(false);
		expect(toActId(state)).toBe("b");
		expect(actionsFor(state, "b")).toContain("check");
	});

	it("puts a short stack all in rather than letting the blind overdraw them", () => {
		const state = postBlinds([seat("a", 3), seat("b", 100)], 0, 5, 10);
		expect(seatOf(state, "a")!.stack).toBe(0);
		expect(seatOf(state, "a")!.allIn).toBe(true);
	});
});

describe("what is legal", () => {
	it("offers check and never call when there is nothing to call", () => {
		const state = openRound([seat("a", 100), seat("b", 100)], 0);
		expect(actionsFor(state, "a")).toContain("check");
		expect(actionsFor(state, "a")).not.toContain("call");
		expect(actionsFor(state, "a")).toContain("bet");
	});

	it("offers call and never check when facing a bet", () => {
		let state = openRound([seat("a", 100), seat("b", 100)], 0);
		state = act(state, "a", "bet", 20);
		expect(actionsFor(state, "b")).toContain("call");
		expect(actionsFor(state, "b")).not.toContain("check");
	});

	it("offers nothing to a player who is not on turn", () => {
		const state = openRound([seat("a", 100), seat("b", 100)], 0);
		expect(legalActions(state, "b")).toEqual([]);
	});

	it("offers nothing once the round is closed", () => {
		let state = openRound([seat("a", 100), seat("b", 100)], 0);
		state = act(state, "a", "check");
		state = act(state, "b", "check");
		expect(state.closed).toBe(true);
		expect(legalActions(state, "a")).toEqual([]);
	});

	// ⚠️ A CALL IS CAPPED BY THE STACK. Charging the full bet would take chips the
	// player does not own and drive the stack negative.
	it("caps a call at the caller's stack", () => {
		let state = openRound([seat("a", 100), seat("b", 12)], 0);
		state = act(state, "a", "bet", 50);
		const call = legalActions(state, "b").find((entry) => entry.action === "call");
		expect(call?.cost).toBe(12);
	});

	it("hides raise but still offers all in when the stack cannot make a minimum raise", () => {
		let state = openRound([seat("a", 100), seat("b", 25)], 0);
		state = act(state, "a", "bet", 20);
		// b has 25: calling costs 20, a minimum raise would need 40 total.
		expect(actionsFor(state, "b")).not.toContain("raise");
		expect(actionsFor(state, "b")).toContain("allIn");
	});

	it("reports the raise band so the UI does not re-derive it", () => {
		let state = openRound([seat("a", 100), seat("b", 100)], 0);
		state = act(state, "a", "bet", 20);
		const raise = legalActions(state, "b").find((entry) => entry.action === "raise");
		expect(raise?.min).toBe(40);
		expect(raise?.max).toBe(100);
	});
});

describe("refusals", () => {
	it("refuses an action from the wrong player", () => {
		const state = openRound([seat("a", 100), seat("b", 100)], 0);
		expect(applyAction(state, "b", "check")).toMatchObject({ ok: false, reason: "notYourTurn" });
	});

	it("refuses a check when facing a bet", () => {
		let state = openRound([seat("a", 100), seat("b", 100)], 0);
		state = act(state, "a", "bet", 20);
		expect(applyAction(state, "b", "check")).toMatchObject({ ok: false, reason: "illegal" });
	});

	it("refuses a raise below the minimum", () => {
		let state = openRound([seat("a", 100), seat("b", 100)], 0);
		state = act(state, "a", "bet", 20);
		expect(applyAction(state, "b", "raise", 30)).toMatchObject({ ok: false, reason: "belowMinimum" });
	});

	it("refuses a raise beyond the stack", () => {
		let state = openRound([seat("a", 100), seat("b", 100)], 0);
		state = act(state, "a", "bet", 20);
		expect(applyAction(state, "b", "raise", 500)).toMatchObject({ ok: false, reason: "insufficient" });
	});

	it("leaves the state untouched when it refuses", () => {
		let state = openRound([seat("a", 100), seat("b", 100)], 0);
		state = act(state, "a", "bet", 20);
		const before = JSON.stringify(state);
		applyAction(state, "b", "raise", 1);
		expect(JSON.stringify(state)).toBe(before);
	});
});

// ⚠️ THE RULE THAT IS ALWAYS WRITTEN WRONG. "Everyone has acted" does not close a
// round: after a raise, players who already acted must act AGAIN.
describe("closing the round", () => {
	it("closes when everyone checks", () => {
		let state = openRound([seat("a", 100), seat("b", 100), seat("c", 100)], 0);
		state = act(state, "a", "check");
		state = act(state, "b", "check");
		expect(state.closed).toBe(false);
		state = act(state, "c", "check");
		expect(state.closed).toBe(true);
	});

	it("REOPENS the round after a raise, so an earlier caller acts again", () => {
		let state = openRound([seat("a", 100), seat("b", 100), seat("c", 100)], 0);
		state = act(state, "a", "bet", 10);
		state = act(state, "b", "call");
		// c raises. a and b have both acted, and the round must NOT close.
		state = act(state, "c", "raise", 30);
		expect(state.closed).toBe(false);
		expect(toActId(state)).toBe("a");

		state = act(state, "a", "call");
		expect(state.closed).toBe(false);
		state = act(state, "b", "call");
		expect(state.closed).toBe(true);
	});

	it("closes immediately when everyone but one player folds", () => {
		let state = openRound([seat("a", 100), seat("b", 100), seat("c", 100)], 0);
		state = act(state, "a", "bet", 10);
		state = act(state, "b", "fold");
		state = act(state, "c", "fold");
		expect(state.closed).toBe(true);
	});

	it("closes when the only contesting player is square against all-in opponents", () => {
		let state = openRound([seat("a", 100), seat("b", 20), seat("c", 20)], 0);
		state = act(state, "a", "bet", 20);
		state = act(state, "b", "allIn");
		state = act(state, "c", "allIn");
		expect(state.closed).toBe(true);
	});

	it("opens already closed when every player is all in", () => {
		const seats = [
			{ ...seat("a", 0), allIn: true },
			{ ...seat("b", 0), allIn: true },
		];
		expect(openRound(seats, 0).closed).toBe(true);
	});
});

describe("all in", () => {
	it("marks the player all in and empties the stack", () => {
		let state = openRound([seat("a", 40), seat("b", 100)], 0);
		state = act(state, "a", "allIn");
		expect(seatOf(state, "a")).toMatchObject({ stack: 0, allIn: true, committed: 40 });
	});

	it("reopens the betting when it raises the current bet", () => {
		let state = openRound([seat("a", 100), seat("b", 100), seat("c", 60)], 0);
		state = act(state, "a", "bet", 20);
		state = act(state, "b", "call");
		state = act(state, "c", "allIn");
		// c's 60 is a raise over 20, so a and b must act again.
		expect(state.closed).toBe(false);
		expect(toActId(state)).toBe("a");
	});

	it("skips an all-in player when finding who acts next", () => {
		let state = openRound([seat("a", 100), seat("b", 30), seat("c", 100)], 0);
		state = act(state, "a", "bet", 40);
		state = act(state, "b", "allIn");
		expect(toActId(state)).toBe("c");
	});
});

describe("between streets", () => {
	it("clears the round commitment but keeps the hand total", () => {
		let state = openRound([seat("a", 100), seat("b", 100)], 0);
		state = act(state, "a", "bet", 20);
		state = act(state, "b", "call");

		const flop = nextStreet(state, 0);
		expect(seatOf(flop, "a")!.committed).toBe(0);
		// totalCommitted is what the pot builder reads, so it must survive.
		expect(seatOf(flop, "a")!.totalCommitted).toBe(20);
		expect(flop.currentBet).toBe(0);
		expect(flop.closed).toBe(false);
	});

	it("carries folded and all-in flags forward", () => {
		let state = openRound([seat("a", 100), seat("b", 100), seat("c", 100)], 0);
		state = act(state, "a", "bet", 10);
		state = act(state, "b", "fold");
		state = act(state, "c", "call");

		const flop = nextStreet(state, 0);
		expect(seatOf(flop, "b")!.folded).toBe(true);
	});
});

describe("chips are conserved", () => {
	it("never lets a stack go negative or chips appear", () => {
		let state = openRound([seat("a", 100), seat("b", 55), seat("c", 30)], 0);
		const startingTotal = 100 + 55 + 30;

		state = act(state, "a", "bet", 25);
		state = act(state, "b", "raise", 55);
		state = act(state, "c", "allIn");
		state = act(state, "a", "call");

		for (const player of state.seats) {
			expect(player.stack).toBeGreaterThanOrEqual(0);
			expect(player.committed).toBe(player.totalCommitted);
		}
		const inPlay = state.seats.reduce((sum, player) => sum + player.stack + player.totalCommitted, 0);
		expect(inPlay).toBe(startingTotal);
	});
});
