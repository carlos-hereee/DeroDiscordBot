import { describe, it, expect } from "vitest";
import { BANK_HOTELS, BANK_HOUSES, STARTING_CHIPS, boardIndexOf } from "./monopolyBoard.js";
import { settleDebt, settleDebts, type MonopolyDebt } from "./monopolyBankruptcy.js";
import {
	BANK_CREDITOR,
	applyRoll,
	createInitialState,
	resolveDebt,
	type MonopolyResult,
	type MonopolyState,
} from "./monopolyState.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const ALICE = "alice";
const BOB = "bob";
const CARA = "cara";
const DANA = "dana";
const NOW = 1_000;
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

// An rng that makes resolveVersus land on the given die faces, in order (the
// midpoint of each face's band on a six sided die).
function diceRng(...faces: number[]): () => number {
	let index = 0;
	return () => (faces[Math.min(index++, faces.length - 1)] - 0.5) / 6;
}

const giveTiles = (state: MonopolyState, ownerId: string, ...ids: string[]): void => {
	for (const id of ids) state.properties[id].ownerId = ownerId;
};

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

// Brown with houses on both lots: Mudlark Lane at two, Cinder Row at three.
function builtBrown(state: MonopolyState, ownerId: string): void {
	giveTiles(state, ownerId, "mudlark-lane", "cinder-row");
	state.properties["mudlark-lane"].houses = 2;
	state.properties["cinder-row"].houses = 3;
	state.bank.houses -= 5;
}

// ── resolveDebt ─────────────────────────────────────────────────────────────

describe("resolveDebt", () => {
	it("pays from chips when they cover the debt, to a player or the bank", () => {
		const { state, trailLines } = expectOk(resolveDebt(newMatch(), ALICE, BOB, 100, NOW));
		expect(state.seats.map((seat) => seat.chips)).toEqual([STARTING_CHIPS - 100, STARTING_CHIPS + 100, STARTING_CHIPS]);
		expect(trailLines).toEqual(["<@alice> paid <@bob> $100."]);

		const bank = expectOk(resolveDebt(newMatch(), ALICE, BANK_CREDITOR, 100, NOW));
		expect(bank.state.seats.map((seat) => seat.chips)).toEqual([STARTING_CHIPS - 100, STARTING_CHIPS, STARTING_CHIPS]);
		expect(bank.trailLines).toEqual(["<@alice> paid the bank $100."]);
		expect(bank.state.log.at(-1)).toEqual({ userId: ALICE, text: "<@alice> paid the bank $100." });
	});

	it("refuses a finished match, a debtor or creditor not playing, and a self debt", () => {
		expectRefusal(resolveDebt({ ...newMatch(), phase: "finished" }, ALICE, BOB, 10), "The match is already over.");
		expectRefusal(resolveDebt(newMatch(), "nobody", BOB, 10), "That player is not playing in this match.");
		expectRefusal(resolveDebt(newMatch(), ALICE, "nobody", 10), "The creditor is not playing in this match.");
		expectRefusal(resolveDebt(newMatch(), ALICE, ALICE, 10), "A player cannot owe themselves.");
		const out = expectOk(resolveDebt({ ...newMatch(), seats: newMatch().seats.map((seat) => ({ ...seat, chips: seat.userId === CARA ? 0 : seat.chips })) }, CARA, BANK_CREDITOR, 10)).state;
		expectRefusal(resolveDebt(out, CARA, BOB, 10), "That player is not playing in this match.");
		expectRefusal(resolveDebt(out, ALICE, CARA, 10), "The creditor is not playing in this match.");
	});

	it("refuses an amount that is not a whole number above zero", () => {
		const reason = "A debt is a whole number of chips above zero.";
		expectRefusal(resolveDebt(newMatch(), ALICE, BOB, 0), reason);
		expectRefusal(resolveDebt(newMatch(), ALICE, BOB, 12.5), reason);
	});

	it("never mutates the state it is given", () => {
		const state = newMatch();
		state.seats[0].chips = 10;
		giveTiles(state, ALICE, "skyrail-station");
		expectOk(resolveDebt(state, ALICE, BOB, 50, NOW));
		expect(state.seats[0].chips).toBe(10);
		expect(state.properties["skyrail-station"].mortgaged).toBe(false);
	});
});

// ── raising cash ────────────────────────────────────────────────────────────

describe("raising cash before bankruptcy", () => {
	it("mortgages in board order only until the debt is covered, so mortgaging alone avoids bankruptcy", () => {
		const state = newMatch();
		state.seats[0].chips = 20;
		giveTiles(state, ALICE, "teal-ridge", "skyrail-station", "lumen-works");
		const { state: next, trailLines } = expectOk(resolveDebt(state, ALICE, BOB, 150, NOW));
		expect(next.seats[0]).toMatchObject({ bankrupt: false, chips: 20 + 100 + 50 - 150 });
		expect(next.properties["skyrail-station"].mortgaged).toBe(true);
		expect(next.properties["teal-ridge"].mortgaged).toBe(true);
		expect(next.properties["lumen-works"].mortgaged).toBe(false);
		expect(trailLines).toEqual([
			"<@alice> mortgaged Skyrail Station for $100 to cover the debt.",
			"<@alice> mortgaged Teal Ridge for $50 to cover the debt.",
			"<@alice> paid <@bob> $150.",
		]);
	});

	it("mortgages lots outside a built group before selling any building", () => {
		const state = newMatch();
		state.seats[0].chips = 0;
		builtBrown(state, ALICE);
		giveTiles(state, ALICE, "skyrail-station");
		const { state: next } = expectOk(resolveDebt(state, ALICE, BOB, 100, NOW));
		expect(next.properties["skyrail-station"].mortgaged).toBe(true);
		expect([next.properties["mudlark-lane"].houses, next.properties["cinder-row"].houses]).toEqual([2, 3]);
	});

	it("sells houses from the tallest lot first, then mortgages the group once it is bare", () => {
		const state = newMatch();
		state.seats[0].chips = 0;
		builtBrown(state, ALICE);
		// Five houses sell for $25 each ($125), then one lot mortgages for $30.
		const { state: next, trailLines } = expectOk(resolveDebt(state, ALICE, BOB, 150, NOW));
		expect(trailLines.slice(0, 2)).toEqual([
			"<@alice> sold a house on Cinder Row back to the bank for $25.",
			"<@alice> sold a house on Mudlark Lane back to the bank for $25.",
		]);
		expect(trailLines).toContain("<@alice> mortgaged Mudlark Lane for $30 to cover the debt.");
		expect(next.properties["mudlark-lane"]).toMatchObject({ houses: 0, mortgaged: true });
		expect(next.properties["cinder-row"]).toMatchObject({ houses: 0, mortgaged: false });
		expect(next.bank.houses).toBe(BANK_HOUSES);
		expect(next.seats[0]).toMatchObject({ bankrupt: false, chips: 125 + 30 - 150 });
	});

	it("sells a hotel back for the four houses it replaced when the bank has them", () => {
		const state = newMatch();
		state.seats[0].chips = 0;
		giveTiles(state, ALICE, "mudlark-lane", "cinder-row");
		state.properties["mudlark-lane"].houses = 4;
		state.properties["cinder-row"].hotel = true;
		state.bank.houses -= 4;
		state.bank.hotels -= 1;
		const { state: next, trailLines } = expectOk(resolveDebt(state, ALICE, BOB, 25, NOW));
		expect(trailLines[0]).toBe("<@alice> sold the hotel on Cinder Row back to the bank for $25.");
		expect(next.properties["cinder-row"]).toMatchObject({ hotel: false, houses: 4 });
		expect(next.bank).toEqual({ houses: BANK_HOUSES - 8, hotels: BANK_HOTELS });
	});

	it("tears a hotel down to bare ground when the bank has no houses to give back", () => {
		const state = newMatch();
		state.seats[0].chips = 0;
		giveTiles(state, ALICE, "mudlark-lane", "cinder-row");
		state.properties["mudlark-lane"].hotel = true;
		state.properties["cinder-row"].hotel = true;
		state.bank.houses = 3;
		state.bank.hotels -= 2;
		const { state: next, trailLines } = expectOk(resolveDebt(state, ALICE, BOB, 100, NOW));
		expect(trailLines[0]).toBe("<@alice> sold the hotel on Mudlark Lane and, with no houses left in the bank, every rung under it for $125.");
		expect(next.properties["mudlark-lane"]).toMatchObject({ hotel: false, houses: 0 });
		expect(next.properties["cinder-row"].hotel).toBe(true);
		expect(next.bank).toEqual({ houses: 3, hotels: BANK_HOTELS - 1 });
		expect(next.seats[0].chips).toBe(25);
	});
});

// ── bankruptcy ──────────────────────────────────────────────────────────────

describe("bankruptcy", () => {
	it("hands a player creditor every chip, lot and card, with buildings sold to the bank first", () => {
		const state = newMatch();
		state.seats[0].chips = 40;
		state.seats[0].gojfCards = 1;
		state.chanceDeck = state.chanceDeck.filter((id) => id !== "chance-jail-free");
		builtBrown(state, ALICE);
		giveTiles(state, ALICE, "skyrail-station");
		state.properties["skyrail-station"].mortgaged = true;
		const { state: next, trailLines } = expectOk(resolveDebt(state, ALICE, BOB, 1000, NOW));

		// $40 plus five houses sold back at $25 each reaches Bob; the lots move as
		// they stood, Mudlark Lane and Cinder Row unmortgaged and the station still
		// mortgaged.
		expect(seatOf(next, BOB)).toMatchObject({ chips: STARTING_CHIPS + 40 + 125, gojfCards: 1 });
		expect(seatOf(next, ALICE)).toMatchObject({ bankrupt: true, bankruptedAt: 1, chips: 0, gojfCards: 0 });
		expect(next.properties["mudlark-lane"]).toEqual({ ownerId: BOB, houses: 0, hotel: false, mortgaged: false });
		expect(next.properties["cinder-row"]).toEqual({ ownerId: BOB, houses: 0, hotel: false, mortgaged: false });
		expect(next.properties["skyrail-station"]).toMatchObject({ ownerId: BOB, mortgaged: true });
		expect(next.bank.houses).toBe(BANK_HOUSES);
		// The jail card changed hands without rejoining a pile.
		expect(next.chanceDeck).not.toContain("chance-jail-free");
		expect(next.chanceDiscard).not.toContain("chance-jail-free");
		expect(trailLines).toEqual([
			"<@alice> cannot cover $1000, even by selling and mortgaging everything, and is bankrupt.",
			"<@bob> takes $165, 3 lots and 1 Get Out of Jail Free card from <@alice>.",
			"<@alice> is out of the match.",
			"It is now <@bob>'s turn.",
		]);
		expect(next.activeSeatIndex).toBe(1);
	});

	it("returns everything to the bank cleanly for a bank debt", () => {
		const state = newMatch();
		state.seats[0].chips = 40;
		state.seats[0].gojfCards = 1;
		state.chestDeck = state.chestDeck.filter((id) => id !== "chest-jail-free");
		builtBrown(state, ALICE);
		giveTiles(state, ALICE, "skyrail-station");
		state.properties["skyrail-station"].mortgaged = true;
		const { state: next, trailLines } = expectOk(resolveDebt(state, ALICE, BANK_CREDITOR, 1000, NOW));

		for (const id of ["mudlark-lane", "cinder-row", "skyrail-station"]) {
			expect(next.properties[id]).toEqual({ ownerId: null, houses: 0, hotel: false, mortgaged: false });
		}
		expect(seatOf(next, ALICE)).toMatchObject({ bankrupt: true, chips: 0, gojfCards: 0 });
		expect(next.bank).toEqual({ houses: BANK_HOUSES, hotels: BANK_HOTELS });
		expect(next.chestDiscard.at(-1)).toBe("chest-jail-free");
		expect(next.seats.slice(1).map((seat) => seat.chips)).toEqual([STARTING_CHIPS, STARTING_CHIPS]);
		expect(trailLines.slice(0, 2)).toEqual([
			"<@alice> cannot cover $1000, even by selling and mortgaging everything, and is bankrupt.",
			"<@alice> is out of the match, and their holdings return to the bank.",
		]);
	});

	it("leaves the clock alone when the bankrupt seat is off turn, and crowns the last seat", () => {
		const state = newMatch();
		state.seats[1].chips = 5;
		const { state: next } = expectOk(resolveDebt(state, BOB, CARA, 50, NOW));
		expect(next.activeSeatIndex).toBe(0);
		expect(next.phase).toBe("pre-roll");

		const { state: over, trailLines } = expectOk(resolveDebt({ ...next, seats: next.seats.map((seat) => ({ ...seat, chips: seat.userId === ALICE ? 0 : seat.chips })) }, ALICE, CARA, 50, NOW));
		expect(over.phase).toBe("finished");
		expect(over.winnerId).toBe(CARA);
		expect(trailLines.at(-1)).toBe("<@cara> wins the match.");
	});
});

// ── rent on a roll ──────────────────────────────────────────────────────────

describe("rent the roller cannot cover from chips", () => {
	// Bob owns Teal Ridge with a hotel ($550). A 2 and 4 from GO lands on it.
	function hotelRent(): MonopolyState {
		const state = newMatch();
		giveTiles(state, BOB, "teal-ridge", "frost-hollow", "skyglass-terrace");
		state.properties["teal-ridge"].hotel = true;
		state.bank.hotels -= 1;
		return state;
	}

	it("raises cash and keeps the roller playing when its lots cover the rent", () => {
		const state = hotelRent();
		state.seats[0].chips = 500;
		giveTiles(state, ALICE, "skyrail-station");
		const { state: next, trailLines } = expectOk(applyRoll(state, diceRng(2, 4), NOW));
		expect(seatOf(next, ALICE)).toMatchObject({ bankrupt: false, chips: 500 + 100 - 550 });
		expect(seatOf(next, BOB).chips).toBe(STARTING_CHIPS + 550);
		expect(next.phase).toBe("post-roll");
		expect(next.activeSeatIndex).toBe(0);
		expect(trailLines.slice(-2)).toEqual([
			"<@alice> mortgaged Skyrail Station for $100 to cover the debt.",
			"<@alice> paid $550 rent to <@bob>.",
		]);
	});

	it("bankrupts the roller to the owner when nothing covers it, and the turn passes", () => {
		const state = hotelRent();
		state.seats[0].chips = 300;
		giveTiles(state, ALICE, "mudlark-lane");
		const { state: next } = expectOk(applyRoll(state, diceRng(2, 4), NOW));
		expect(seatOf(next, ALICE).bankrupt).toBe(true);
		expect(seatOf(next, BOB).chips).toBe(STARTING_CHIPS + 300);
		expect(next.properties["mudlark-lane"]).toMatchObject({ ownerId: BOB, mortgaged: false });
		expect(next.phase).toBe("pre-roll");
		expect(next.activeSeatIndex).toBe(1);
		expect(boardIndexOf("teal-ridge")).toBe(6);
	});
});

// ── batches and chains ──────────────────────────────────────────────────────

describe("settleDebts", () => {
	it("settles a chain: A goes bankrupt to B, and B survives on it to pay C", () => {
		// B owes C $350 and holds only $100; A owes B $500 and holds $200 plus a
		// station that mortgages for $100. B is listed first, so the batch has to
		// see that B is owed money and settle A before judging B.
		const state = newMatch();
		state.seats[0].chips = 200;
		giveTiles(state, ALICE, "skyrail-station");
		state.seats[1].chips = 100;
		const lines = settleDebts(state, [debt(state, BOB, CARA, 350), debt(state, ALICE, BOB, 500)], NOW);

		expect(seatOf(state, ALICE).bankrupt).toBe(true);
		expect(seatOf(state, BOB)).toMatchObject({ bankrupt: false, chips: 100 + 200 + 100 - 350 });
		expect(seatOf(state, CARA).chips).toBe(STARTING_CHIPS + 350);
		// Bob covered the last $100 by mortgaging the station he took from Alice.
		expect(state.properties["skyrail-station"]).toMatchObject({ ownerId: BOB, mortgaged: true });
		expect(lines.at(-1)).toBe("<@bob> paid <@cara> $350.");
	});

	it("pays a debt the chips cover before forcing one that needs a sale", () => {
		const state = newMatch();
		state.seats[1].chips = 0;
		giveTiles(state, BOB, "skyrail-station");
		const lines = settleDebts(state, [debt(state, BOB, CARA, 50), debt(state, ALICE, BOB, 60)], NOW);
		expect(lines[0]).toBe("<@alice> paid <@bob> $60.");
		expect(seatOf(state, BOB).chips).toBe(10);
		expect(state.properties["skyrail-station"].mortgaged).toBe(false);
	});

	it("writes off what a bankrupt debtor still owes instead of charging it twice", () => {
		const state = newMatch([ALICE, BOB, CARA, DANA]);
		state.seats[0].chips = 60;
		const lines = settleDebts(state, [debt(state, ALICE, BOB, 50), debt(state, ALICE, CARA, 50), debt(state, ALICE, DANA, 50)], NOW);
		expect(state.seats.map((seat) => seat.chips)).toEqual([0, STARTING_CHIPS + 50, STARTING_CHIPS + 10, STARTING_CHIPS]);
		expect(lines.filter((line) => line.includes("is bankrupt"))).toHaveLength(1);
	});

	it("sends a payment to the bank when its creditor went bankrupt earlier in the batch", () => {
		// Alice and Bob owe each other, neither can pay, and each is owed by the
		// other, so the first debt goes first: Alice is bankrupt to Bob, and Bob's
		// debt to Alice then falls to the bank.
		const state = newMatch();
		state.seats[0].chips = 40;
		state.seats[1].chips = 100;
		giveTiles(state, BOB, "mudlark-lane");
		const lines = settleDebts(state, [debt(state, ALICE, BOB, 50), debt(state, BOB, ALICE, 500)], NOW);
		expect(seatOf(state, ALICE).bankrupt).toBe(true);
		expect(seatOf(state, BOB).bankrupt).toBe(true);
		expect(state.properties["mudlark-lane"].ownerId).toBeNull();
		expect(lines).toContain("<@bob> is out of the match, and their holdings return to the bank.");
		expect(state.winnerId).toBe(CARA);
	});

	it("stops once the match is over, with debts left unsettled", () => {
		const state = newMatch([ALICE, BOB]);
		state.seats[0].chips = 0;
		state.seats[1].chips = 0;
		const lines = settleDebts(state, [debt(state, ALICE, BOB, 50), debt(state, BOB, ALICE, 50)], NOW);
		expect(state.phase).toBe("finished");
		expect(state.winnerId).toBe(BOB);
		expect(lines.at(-1)).toBe("<@bob> wins the match.");
	});
});

describe("settleDebt", () => {
	it("says whether the debtor paid in full", () => {
		const paid = newMatch();
		expect(settleDebt(paid, debt(paid, ALICE, BOB, 10), NOW).paid).toBe(true);
		const broke = newMatch();
		broke.seats[0].chips = 0;
		const outcome = settleDebt(broke, { ...debt(broke, ALICE, BANK_CREDITOR, 10), paidLine: "unused" }, NOW);
		expect(outcome.paid).toBe(false);
		expect(outcome.lines).not.toContain("unused");
	});
});
