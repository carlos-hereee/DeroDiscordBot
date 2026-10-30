import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { STARTING_CHIPS } from "./monopolyBoard.js";
import { settleDebts, type MonopolyDebt } from "./monopolyBankruptcy.js";
import {
	BANK_CREDITOR,
	applyDebtDefault,
	applyForfeit,
	applyMortgage,
	applyPayDebt,
	createInitialState,
	waitingDebt,
	type MonopolyResult,
	type MonopolyState,
} from "./monopolyState.js";

// ── monopolyDebts ───────────────────────────────────────────────────────────
// A held debt ends one of two ways: the debtor pays once it has raised the cash,
// or never does and is bankrupt to whoever it owed. Either way the rest of the
// batch it was held in settles after it, and the turn goes back to where it paused.

const ALICE = "alice";
const BOB = "bob";
const CARA = "cara";
const NOW = 1_000;

// An open trade lapses against the clock (BOT_CONSTANTS.MONOPOLY_TRADE_EXPIRY_MS, 2026-10 item 276),
// so the engine's Date.now reads this file's fixed NOW; only Date is faked, never a timer.
beforeEach(() => {
	vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});
const SEED = 241;

const newMatch = (players: string[] = [ALICE, BOB, CARA]): MonopolyState =>
	createInitialState(players, { auctionsEnabled: false }, NOW, SEED);

function expectOk(result: MonopolyResult): { state: MonopolyState; trailLines: string[] } {
	if (!result.ok) throw new Error(`expected ok, got refusal: ${result.reason}`);
	return result;
}

function expectRefusal(result: MonopolyResult, reason: string | RegExp): void {
	if (result.ok) throw new Error("expected a refusal, got ok");
	expect(result.reason).toMatch(reason);
}

const seatOf = (state: MonopolyState, userId: string) => {
	const seat = state.seats.find((candidate) => candidate.userId === userId);
	if (!seat) throw new Error(`no seat ${userId}`);
	return seat;
};

const debt = (state: MonopolyState, debtorId: string, creditorId: string, amount: number): MonopolyDebt => ({
	debtor: seatOf(state, debtorId),
	creditorId,
	amount,
});

// Alice owes Bob $150 with $20 and Rail One (which mortgages for $100) and Reader
// Dock ($50): coverable, so held. The turn had reached post-roll.
function aliceHeld(): MonopolyState {
	const state = newMatch();
	state.phase = "post-roll";
	state.seats[0].chips = 20;
	state.properties["rail-one"].ownerId = ALICE;
	state.properties["reader-dock"].ownerId = ALICE;
	settleDebts(state, [debt(state, ALICE, BOB, 150)], NOW);
	return state;
}

// A batch of two held debts: Bob and Cara each owe Alice $100 (a collect from
// each card on Alice's turn), and each has $0 and a lot that covers it.
function twoRivalsHeld(): MonopolyState {
	const state = newMatch();
	state.phase = "post-roll";
	state.seats[1].chips = 0;
	state.seats[2].chips = 0;
	state.properties["rail-one"].ownerId = BOB;
	state.properties["rail-two"].ownerId = CARA;
	settleDebts(state, [debt(state, BOB, ALICE, 100), debt(state, CARA, ALICE, 100)], NOW);
	return state;
}

describe("waitingDebt", () => {
	it("names the debt the match waits on, and nothing otherwise", () => {
		expect(waitingDebt(aliceHeld())).toEqual({ debtorId: ALICE, creditorId: BOB, amount: 150 });
		expect(waitingDebt(newMatch())).toBeNull();
	});
});

describe("applyPayDebt", () => {
	it("refuses while mortgaging or selling could still raise the rest, saying how much", () => {
		expectRefusal(applyPayDebt(aliceHeld(), ALICE, NOW), "You need $130 more. Mortgage lots or sell buildings from Inventory, then pay.");
	});

	it("pays once the seat has the chips, and puts the turn back where it paused", () => {
		// Rail One raises $100 and Reader Dock $50: with the $20 that covers $150.
		const halfway = expectOk(applyMortgage(aliceHeld(), ALICE, "rail-one")).state;
		expectRefusal(applyPayDebt(halfway, ALICE, NOW), "You need $30 more. Mortgage lots or sell buildings from Inventory, then pay.");
		const raised = expectOk(applyMortgage(halfway, ALICE, "reader-dock")).state;
		const { state, trailLines } = expectOk(applyPayDebt(raised, ALICE, NOW));
		expect(seatOf(state, ALICE).chips).toBe(20 + 100 + 50 - 150);
		expect(seatOf(state, BOB).chips).toBe(STARTING_CHIPS + 150);
		expect(state).toMatchObject({ phase: "post-roll", pendingDebt: null });
		expect(trailLines).toEqual(["<@alice> paid <@bob> $150."]);
	});

	it("refuses a seat that is not the one being waited on, and a match waiting on nothing", () => {
		expectRefusal(applyPayDebt(aliceHeld(), BOB, NOW), "Only <@alice> can pay this debt.");
		expectRefusal(applyPayDebt(newMatch(), ALICE, NOW), "There is no debt waiting to be paid.");
	});

	it("bankrupts a seat that traded away what would have covered it, since nothing can now", () => {
		// No trade can strip a held debtor any more (P2-2, and the jail card swap closed
		// by 2026-10 item 280), so the lots leave Alice by hand: a state an older offer,
		// accepted before the hold, could still leave behind.
		const traded = aliceHeld();
		traded.properties["rail-one"].ownerId = CARA;
		traded.properties["reader-dock"].ownerId = CARA;

		const { state, trailLines } = expectOk(applyPayDebt(traded, ALICE, NOW));
		expect(seatOf(state, ALICE).bankrupt).toBe(true);
		expect(seatOf(state, BOB).chips).toBe(STARTING_CHIPS + 20);
		expect(trailLines[0]).toBe("<@alice> cannot cover $150, even by selling and mortgaging everything, and is bankrupt.");
		expect(state.pendingDebt).toBeNull();
	});

	it("settles the rest of the batch after the paid debt, holding the next debtor in its turn", () => {
		const held = twoRivalsHeld();
		expect(held.pendingDebt?.debts.map((owed) => owed.debtorId)).toEqual([BOB, CARA]);

		const bobPaid = expectOk(applyPayDebt(expectOk(applyMortgage(held, BOB, "rail-one")).state, BOB, NOW)).state;
		expect(waitingDebt(bobPaid)).toEqual({ debtorId: CARA, creditorId: ALICE, amount: 100 });
		expect(bobPaid.pendingDebt?.resumePhase).toBe("post-roll");

		const allPaid = expectOk(applyPayDebt(expectOk(applyMortgage(bobPaid, CARA, "rail-two")).state, CARA, NOW)).state;
		expect(allPaid).toMatchObject({ phase: "post-roll", pendingDebt: null });
		expect(seatOf(allPaid, ALICE).chips).toBe(STARTING_CHIPS + 200);
	});
});

describe("applyDebtDefault", () => {
	it("bankrupts the debtor who never paid to whoever it owed, whatever it could have raised", () => {
		const { state, trailLines } = expectOk(applyDebtDefault(aliceHeld(), NOW));
		expect(seatOf(state, ALICE).bankrupt).toBe(true);
		expect(state.properties["rail-one"].ownerId).toBe(BOB);
		expect(seatOf(state, BOB).chips).toBe(STARTING_CHIPS + 20);
		expect(trailLines.slice(0, 2)).toEqual([
			"<@alice> never paid the $150 they owed and is bankrupt.",
			"<@bob> takes $20, 2 lots and 0 Get Out of Jail Free cards from <@alice>.",
		]);
		// Alice was on the clock, so the turn passes rather than resuming.
		expect(state).toMatchObject({ phase: "pre-roll", pendingDebt: null, activeSeatIndex: 1 });
	});

	it("goes on to the rest of the batch, so the next debtor is waited on", () => {
		const { state } = expectOk(applyDebtDefault(twoRivalsHeld(), NOW));
		expect(seatOf(state, BOB).bankrupt).toBe(true);
		expect(waitingDebt(state)).toEqual({ debtorId: CARA, creditorId: ALICE, amount: 100 });
	});

	it("hands a bank debt's holdings back to the bank", () => {
		const state = newMatch();
		state.seats[0].chips = 0;
		state.properties["rail-one"].ownerId = ALICE;
		settleDebts(state, [debt(state, ALICE, BANK_CREDITOR, 50)], NOW);
		const { state: next } = expectOk(applyDebtDefault(state, NOW));
		expect(next.properties["rail-one"].ownerId).toBeNull();
	});

	it("refuses a match waiting on nothing", () => {
		expectRefusal(applyDebtDefault(newMatch(), NOW), "There is no debt waiting to be paid.");
	});
});

describe("a seat leaving while a debt is held", () => {
	it("hands the waiting debtor's holdings to its creditor, not the bank, and waits on the next debtor", () => {
		const { state, trailLines } = expectOk(applyForfeit(twoRivalsHeld(), BOB, NOW));
		expect(trailLines.slice(0, 2)).toEqual([
			"<@bob> left owing $100 and is bankrupt.",
			"<@alice> takes $0, 1 lot and 0 Get Out of Jail Free cards from <@bob>.",
		]);
		expect(state.properties["rail-one"].ownerId).toBe(ALICE);
		expect(state.stats?.forfeits).toBe(1);
		expect(waitingDebt(state)).toEqual({ debtorId: CARA, creditorId: ALICE, amount: 100 });
	});

	it("gives Alice what Bob held when he surrenders during the debt he owes her (P2-1)", () => {
		const held = aliceHeld();
		const { state } = expectOk(applyForfeit(held, ALICE, NOW));
		expect(state.properties["rail-one"].ownerId).toBe(BOB);
		expect(state.properties["reader-dock"].ownerId).toBe(BOB);
		expect(seatOf(state, BOB).chips).toBe(STARTING_CHIPS + 20);
		expect(state).toMatchObject({ phase: "pre-roll", pendingDebt: null, activeSeatIndex: 1 });
	});

	it("hands a later debtor's holdings to its creditor too, and keeps waiting on the first (2026-10 item 280)", () => {
		const { state, trailLines } = expectOk(applyForfeit(twoRivalsHeld(), CARA, NOW));
		expect(trailLines[0]).toBe("<@cara> left owing $100 and is bankrupt.");
		expect(state.properties["rail-two"].ownerId).toBe(ALICE);
		expect(seatOf(state, CARA).bankrupt).toBe(true);
		expect(waitingDebt(state)).toEqual({ debtorId: BOB, creditorId: ALICE, amount: 100 });
		expect(state.pendingDebt?.debts).toHaveLength(1);
	});

	it("still returns a creditor's or a bystander's holdings to the bank", () => {
		const state = twoRivalsHeld();
		state.properties["reader-dock"].ownerId = ALICE;
		const { state: next } = expectOk(applyForfeit(state, ALICE, NOW));
		expect(next.properties["reader-dock"].ownerId).toBeNull();
		expect(waitingDebt(next)?.debtorId).toBe(BOB);
	});

	it("returns a waiting bank debtor's holdings to the bank", () => {
		const state = newMatch();
		state.seats[0].chips = 0;
		state.properties["rail-one"].ownerId = ALICE;
		settleDebts(state, [debt(state, ALICE, BANK_CREDITOR, 50)], NOW);
		const { state: next } = expectOk(applyForfeit(state, ALICE, NOW));
		expect(next.properties["rail-one"].ownerId).toBeNull();
		expect(next.pendingDebt).toBeNull();
	});

	it("puts the turn back where it paused once nothing is held", () => {
		const one = expectOk(applyForfeit(twoRivalsHeld(), BOB, NOW)).state;
		const none = expectOk(applyForfeit({ ...one, seats: [...one.seats, { ...one.seats[0], userId: "dana" }] }, CARA, NOW)).state;
		expect(none).toMatchObject({ phase: "post-roll", pendingDebt: null });
	});

	it("keeps waiting from the start of the next turn when the seat on the clock leaves", () => {
		const { state } = expectOk(applyForfeit(twoRivalsHeld(), ALICE, NOW));
		expect(state.activeSeatIndex).toBe(1);
		expect(state).toMatchObject({ phase: "awaiting-debt", pendingDebt: { resumePhase: "pre-roll" } });
	});

	it("clears the hold when the leaving seat ends the match", () => {
		const state = newMatch([ALICE, BOB]);
		state.seats[1].chips = 0;
		state.properties["rail-one"].ownerId = BOB;
		settleDebts(state, [debt(state, BOB, ALICE, 100)], NOW);
		const { state: over } = expectOk(applyForfeit(state, BOB, NOW));
		expect(over).toMatchObject({ phase: "finished", pendingDebt: null, winnerId: ALICE });
	});
});

describe("edge cases a live match should never reach", () => {
	it("reads no waiting debt from an awaiting phase with nothing held", () => {
		expect(waitingDebt({ ...newMatch(), phase: "awaiting-debt" })).toBeNull();
	});

	it("refuses to take payment from a held debtor who is somehow out of the match", () => {
		const held = aliceHeld();
		held.seats[0].bankrupt = true;
		expectRefusal(applyPayDebt(held, ALICE, NOW), "You are not playing in this match.");
	});

	it("skips straight to the rest of the batch when the defaulting debtor is already out", () => {
		const held = twoRivalsHeld();
		held.seats[1].bankrupt = true;
		const { state, trailLines } = expectOk(applyDebtDefault(held, NOW));
		expect(trailLines.some((line) => line.includes("never paid"))).toBe(false);
		expect(waitingDebt(state)?.debtorId).toBe(CARA);
	});

	it("ends the match when the default leaves one seat, settling nothing more", () => {
		const state = newMatch([ALICE, BOB]);
		state.seats[1].chips = 0;
		state.properties["rail-one"].ownerId = BOB;
		state.properties["rail-two"].ownerId = BOB;
		settleDebts(state, [debt(state, BOB, ALICE, 50), debt(state, BOB, ALICE, 60)], NOW);
		const { state: over } = expectOk(applyDebtDefault(state, NOW));
		expect(over).toMatchObject({ phase: "finished", winnerId: ALICE, pendingDebt: null });
	});

	it("never moves a jailed seat whose held bail ends in bankruptcy", () => {
		// Alice's forced bail is held with moveAfter set, then she trades away the lot
		// that covered it, so paying can only bankrupt her.
		const held = newMatch();
		Object.assign(held.seats[0], { chips: 10, inJail: true, position: 10 });
		held.properties["rail-one"].ownerId = ALICE;
		settleDebts(held, [debt(held, ALICE, BANK_CREDITOR, 50)], NOW);
		if (held.pendingDebt) held.pendingDebt.moveAfter = 3;
		held.properties["rail-one"].ownerId = CARA;

		const { state } = expectOk(applyPayDebt(held, ALICE, NOW));
		expect(seatOf(state, ALICE).bankrupt).toBe(true);
		expect(seatOf(state, ALICE).position).toBe(10);
	});
});
