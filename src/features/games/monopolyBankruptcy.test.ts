import { describe, it, expect } from "vitest";
import { BANK_HOTELS, BANK_HOUSES, STARTING_CHIPS, boardIndexOf } from "./monopolyBoard.js";
import { settleDebt, settleDebts, type MonopolyDebt } from "./monopolyBankruptcy.js";
import {
	BANK_CREDITOR,
	applyMortgage,
	applyPayDebt,
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

// Brown with houses on both lots: Vermillion Alley at two, Burnt Umber Row at three.
function builtBrown(state: MonopolyState, ownerId: string): void {
	giveTiles(state, ownerId, "vermillion-alley", "burnt-umber-row");
	state.properties["vermillion-alley"].houses = 2;
	state.properties["burnt-umber-row"].houses = 3;
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
		giveTiles(state, ALICE, "rail-one");
		expectOk(resolveDebt(state, ALICE, BOB, 50, NOW));
		expect(state.seats[0].chips).toBe(10);
		expect(state.properties["rail-one"].mortgaged).toBe(false);
	});
});

// ── holding a debt ──────────────────────────────────────────────────────────

describe("holding a debt the seat can cover", () => {
	const owesBob150 = (): MonopolyState => {
		const state = newMatch();
		state.seats[0].chips = 20;
		giveTiles(state, ALICE, "reader-dock", "rail-one", "electric-utility");
		return state;
	};

	it("holds a debt mortgaging could cover, rather than mortgaging for it, and pauses the turn where it stood", () => {
		const { state: next, trailLines } = expectOk(resolveDebt(owesBob150(), ALICE, BOB, 150, NOW));

		expect(next.phase).toBe("awaiting-debt");
		expect(next.pendingDebt).toEqual({ debts: [{ debtorId: ALICE, creditorId: BOB, amount: 150 }], resumePhase: "pre-roll", moveAfter: null });
		// The seat chooses what to raise cash from, so nothing is mortgaged for it.
		expect(seatOf(next, ALICE)).toMatchObject({ bankrupt: false, chips: 20 });
		for (const id of ["reader-dock", "rail-one", "electric-utility"]) expect(next.properties[id].mortgaged).toBe(false);
		expect(trailLines).toEqual([
			"<@alice> owes <@bob> $150 and has $20, so they need to mortgage lots or sell buildings to raise the rest, then pay.",
		]);
	});

	it("counts the buildings a seat could sell toward what it could raise, and bankrupts only past that", () => {
		const state = newMatch();
		state.seats[0].chips = 0;
		builtBrown(state, ALICE);
		// Five houses sell back for $25 each and the two lots mortgage for $30 each: $185.
		expect(expectOk(resolveDebt(state, ALICE, BOB, 185, NOW)).state.phase).toBe("awaiting-debt");
		expect(seatOf(expectOk(resolveDebt(state, ALICE, BOB, 186, NOW)).state, ALICE).bankrupt).toBe(true);
	});

	it("refuses a new charge while a debt is held", () => {
		const held = expectOk(resolveDebt(owesBob150(), ALICE, BOB, 150, NOW)).state;
		expectRefusal(resolveDebt(held, CARA, BOB, 10), "The match is already waiting on a debt.");
	});

	it("names the bank as the payee of a debt owed to it", () => {
		const { trailLines } = expectOk(resolveDebt(owesBob150(), ALICE, BANK_CREDITOR, 150, NOW));
		expect(trailLines[0]).toMatch(/^<@alice> owes the bank \$150 and has \$20/);
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
		giveTiles(state, ALICE, "rail-one");
		state.properties["rail-one"].mortgaged = true;
		const { state: next, trailLines } = expectOk(resolveDebt(state, ALICE, BOB, 1000, NOW));

		// $40 plus five houses sold back at $25 each reaches Bob; the lots move as
		// they stood, Vermillion Alley and Burnt Umber Row unmortgaged and the station still
		// mortgaged.
		expect(seatOf(next, BOB)).toMatchObject({ chips: STARTING_CHIPS + 40 + 125, gojfCards: 1 });
		expect(seatOf(next, ALICE)).toMatchObject({ bankrupt: true, bankruptedAt: 1, chips: 0, gojfCards: 0 });
		expect(next.properties["vermillion-alley"]).toEqual({ ownerId: BOB, houses: 0, hotel: false, mortgaged: false });
		expect(next.properties["burnt-umber-row"]).toEqual({ ownerId: BOB, houses: 0, hotel: false, mortgaged: false });
		expect(next.properties["rail-one"]).toMatchObject({ ownerId: BOB, mortgaged: true });
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
		giveTiles(state, ALICE, "rail-one");
		state.properties["rail-one"].mortgaged = true;
		const { state: next, trailLines } = expectOk(resolveDebt(state, ALICE, BANK_CREDITOR, 1000, NOW));

		for (const id of ["vermillion-alley", "burnt-umber-row", "rail-one"]) {
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
	// Bob owns Reader Dock with a hotel ($550). A 2 and 4 from GO lands on it.
	function hotelRent(): MonopolyState {
		const state = newMatch();
		giveTiles(state, BOB, "reader-dock", "teal-vale", "teal-ridge");
		state.properties["reader-dock"].hotel = true;
		state.bank.hotels -= 1;
		return state;
	}

	it("holds rent the roller's lots could cover, and the turn carries on once it mortgages and pays", () => {
		const state = hotelRent();
		state.seats[0].chips = 500;
		giveTiles(state, ALICE, "rail-one");

		const { state: held, trailLines } = expectOk(applyRoll(state, diceRng(2, 4), NOW));
		expect(held.phase).toBe("awaiting-debt");
		// The roll was not doubles, so the turn resumes after the roll.
		expect(held.pendingDebt?.resumePhase).toBe("post-roll");
		expect(trailLines.at(-1)).toMatch(/^<@alice> owes <@bob> \$550 and has \$500/);

		const mortgaged = expectOk(applyMortgage(held, ALICE, "rail-one")).state;
		const { state: paid, trailLines: paidLines } = expectOk(applyPayDebt(mortgaged, ALICE, NOW));
		expect(seatOf(paid, ALICE)).toMatchObject({ bankrupt: false, chips: 500 + 100 - 550 });
		expect(seatOf(paid, BOB).chips).toBe(STARTING_CHIPS + 550);
		expect(paid).toMatchObject({ phase: "post-roll", pendingDebt: null, activeSeatIndex: 0 });
		expect(paidLines).toEqual(["<@alice> paid $550 rent to <@bob>."]);
	});

	it("bankrupts the roller to the owner when nothing covers it, and the turn passes", () => {
		const state = hotelRent();
		state.seats[0].chips = 300;
		giveTiles(state, ALICE, "vermillion-alley");
		const { state: next } = expectOk(applyRoll(state, diceRng(2, 4), NOW));
		expect(seatOf(next, ALICE).bankrupt).toBe(true);
		expect(seatOf(next, BOB).chips).toBe(STARTING_CHIPS + 300);
		expect(next.properties["vermillion-alley"]).toMatchObject({ ownerId: BOB, mortgaged: false });
		expect(next.phase).toBe("pre-roll");
		expect(next.activeSeatIndex).toBe(1);
		expect(boardIndexOf("reader-dock")).toBe(6);
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
		giveTiles(state, ALICE, "rail-one");
		state.seats[1].chips = 100;
		const lines = settleDebts(state, [debt(state, BOB, CARA, 350), debt(state, ALICE, BOB, 500)], NOW);

		// Alice could never cover $500, so she is bankrupt to Bob at once. Bob then
		// holds $300 and the station he took, which is enough once mortgaged, so his
		// debt is held for him to choose.
		expect(seatOf(state, ALICE).bankrupt).toBe(true);
		expect(state.properties["rail-one"]).toMatchObject({ ownerId: BOB, mortgaged: false });
		expect(state.pendingDebt?.debts).toEqual([{ debtorId: BOB, creditorId: CARA, amount: 350 }]);
		expect(lines.at(-1)).toMatch(/^<@bob> owes <@cara> \$350 and has \$300/);

		const paid = expectOk(applyPayDebt(expectOk(applyMortgage(state, BOB, "rail-one")).state, BOB, NOW)).state;
		expect(seatOf(paid, BOB)).toMatchObject({ bankrupt: false, chips: 100 + 200 + 100 - 350 });
		expect(seatOf(paid, CARA).chips).toBe(STARTING_CHIPS + 350);
	});

	it("pays a debt the chips cover before forcing one that needs a sale", () => {
		const state = newMatch();
		state.seats[1].chips = 0;
		giveTiles(state, BOB, "rail-one");
		const lines = settleDebts(state, [debt(state, BOB, CARA, 50), debt(state, ALICE, BOB, 60)], NOW);
		expect(lines[0]).toBe("<@alice> paid <@bob> $60.");
		expect(seatOf(state, BOB).chips).toBe(10);
		expect(state.properties["rail-one"].mortgaged).toBe(false);
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
		giveTiles(state, BOB, "vermillion-alley");
		const lines = settleDebts(state, [debt(state, ALICE, BOB, 50), debt(state, BOB, ALICE, 500)], NOW);
		expect(seatOf(state, ALICE).bankrupt).toBe(true);
		expect(seatOf(state, BOB).bankrupt).toBe(true);
		expect(state.properties["vermillion-alley"].ownerId).toBeNull();
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
	it("says whether the debt was paid, held for the debtor, or a bankruptcy", () => {
		const paid = newMatch();
		expect(settleDebt(paid, debt(paid, ALICE, BOB, 10), NOW).status).toBe("paid");

		const held = newMatch();
		held.seats[0].chips = 0;
		giveTiles(held, ALICE, "rail-one");
		expect(settleDebt(held, debt(held, ALICE, BOB, 50), NOW).status).toBe("held");

		const broke = newMatch();
		broke.seats[0].chips = 0;
		const outcome = settleDebt(broke, { ...debt(broke, ALICE, BANK_CREDITOR, 10), paidLine: "unused" }, NOW);
		expect(outcome.status).toBe("bankrupt");
		expect(outcome.lines).not.toContain("unused");
	});
});
