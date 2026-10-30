import { describe, it, expect } from "vitest";
import { STARTING_CHIPS } from "./monopolyBoard.js";
import { settleDebts } from "./monopolyBankruptcy.js";
import {
	acceptTrade,
	applyForfeit,
	createInitialState,
	describeTradeSide,
	openTrade,
	rejectTrade,
	tradableLots,
	type MonopolyResult,
	type MonopolyState,
	type TradeProposal,
} from "./monopolyState.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const ALICE = "alice";
const BOB = "bob";
const CARA = "cara";
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

const NOTHING = { properties: [], chips: 0, gojf: 0 };

// Alice offers Reader Dock, $100 and her jail card for Bob's Vermillion Alley and
// Burnt Umber Row and his $50.
function aliceAndBob(): { state: MonopolyState; proposal: TradeProposal } {
	const state = newMatch();
	state.properties["reader-dock"].ownerId = ALICE;
	state.properties["vermillion-alley"].ownerId = BOB;
	state.properties["burnt-umber-row"].ownerId = BOB;
	state.properties["burnt-umber-row"].mortgaged = true;
	state.seats[0].gojfCards = 1;
	const proposal: TradeProposal = {
		initiatorId: ALICE,
		counterpartyId: BOB,
		offer: { properties: ["reader-dock"], chips: 100, gojf: 1 },
		request: { properties: ["vermillion-alley", "burnt-umber-row"], chips: 50, gojf: 0 },
		openedAt: NOW,
	};
	return { state, proposal };
}

const withTerms = (proposal: TradeProposal, changes: Partial<TradeProposal>): TradeProposal => ({ ...proposal, ...changes });

// ── open ────────────────────────────────────────────────────────────────────

describe("openTrade", () => {
	it("stores the proposal without moving anything or naming the terms", () => {
		const { state, proposal } = aliceAndBob();
		const { state: next, trailLines } = expectOk(openTrade(state, proposal));
		expect(next.pendingTrade).toEqual(proposal);
		expect(next.pendingTrade).not.toBe(proposal);
		expect(next.properties["reader-dock"].ownerId).toBe(ALICE);
		expect(next.seats.map((seat) => seat.chips)).toEqual([STARTING_CHIPS, STARTING_CHIPS, STARTING_CHIPS]);
		expect(next.phase).toBe("pre-roll");
		expect(trailLines).toEqual(["<@alice> offered <@bob> a trade."]);
		expect(state.pendingTrade).toBeNull();
	});

	it("refuses a second trade while one is open", () => {
		const { state, proposal } = aliceAndBob();
		const open = expectOk(openTrade(state, proposal)).state;
		expectRefusal(openTrade(open, withTerms(proposal, { initiatorId: CARA })), "A trade is already waiting for an answer.");
	});

	it("refuses a finished match, a self trade and a player who is not playing", () => {
		const { state, proposal } = aliceAndBob();
		expectRefusal(openTrade({ ...state, phase: "finished" }, proposal), "The match is already over.");
		expectRefusal(openTrade(state, withTerms(proposal, { counterpartyId: ALICE })), "You cannot trade with yourself.");
		expectRefusal(openTrade(state, withTerms(proposal, { counterpartyId: "nobody" })), "Both players in a trade must still be playing.");
		const out = expectOk(applyForfeit(state, CARA, NOW)).state;
		expectRefusal(openTrade(out, withTerms(proposal, { initiatorId: CARA })), "Both players in a trade must still be playing.");
	});

	it("refuses a trade that moves nothing", () => {
		const { state, proposal } = aliceAndBob();
		expectRefusal(openTrade(state, withTerms(proposal, { offer: NOTHING, request: NOTHING })), "A trade has to move something.");
	});

	it("refuses chips or cards that are not whole and zero or more", () => {
		const { state, proposal } = aliceAndBob();
		const reason = "Chips and cards in a trade are whole numbers, zero or more.";
		expectRefusal(openTrade(state, withTerms(proposal, { offer: { ...proposal.offer, chips: -5 } })), reason);
		expectRefusal(openTrade(state, withTerms(proposal, { offer: { ...proposal.offer, chips: 2.5 } })), reason);
		expectRefusal(openTrade(state, withTerms(proposal, { request: { ...proposal.request, gojf: -1 } })), reason);
	});

	it("refuses chips or cards a side does not have, on either side", () => {
		const { state, proposal } = aliceAndBob();
		expectRefusal(openTrade(state, withTerms(proposal, { offer: { ...proposal.offer, chips: STARTING_CHIPS + 1 } })), "<@alice> does not have $1501.");
		expectRefusal(openTrade(state, withTerms(proposal, { request: { ...proposal.request, chips: STARTING_CHIPS + 1 } })), "<@bob> does not have $1501.");
		expectRefusal(openTrade(state, withTerms(proposal, { offer: { ...proposal.offer, gojf: 2 } })), "<@alice> does not have 2 Get Out of Jail Free cards.");
		expectRefusal(openTrade(state, withTerms(proposal, { request: { ...proposal.request, gojf: 1 } })), "<@bob> does not have 1 Get Out of Jail Free card.");
	});

	it("refuses a lot listed twice, a lot not on the board and a lot the side does not own", () => {
		const { state, proposal } = aliceAndBob();
		const offer = (properties: string[]) => withTerms(proposal, { offer: { ...proposal.offer, properties } });
		expectRefusal(openTrade(state, offer(["reader-dock", "reader-dock"])), "A lot can only be listed once in a trade.");
		expectRefusal(openTrade(state, offer(["moon-base"])), "That is not a lot on this board.");
		expectRefusal(openTrade(state, offer(["vermillion-alley"])), "<@alice> does not own Vermillion Alley.");
	});

	it("refuses a lot whose color group has buildings, even a bare lot of that group", () => {
		const { state, proposal } = aliceAndBob();
		state.properties["vermillion-alley"].houses = 1;
		expectRefusal(openTrade(state, proposal), "Vermillion Alley cannot be traded while its color group has buildings.");
		state.properties["vermillion-alley"].houses = 0;
		state.properties["burnt-umber-row"].hotel = true;
		expectRefusal(openTrade(state, proposal), "Vermillion Alley cannot be traded while its color group has buildings.");
	});

	it("trades a transport, which has no color group to block it", () => {
		const state = newMatch();
		state.properties["rail-one"].ownerId = BOB;
		const proposal = { initiatorId: ALICE, counterpartyId: BOB, offer: { ...NOTHING, chips: 300 }, request: { ...NOTHING, properties: ["rail-one"] }, openedAt: NOW };
		const open = expectOk(openTrade(state, proposal)).state;
		expect(expectOk(acceptTrade(open)).state.properties["rail-one"].ownerId).toBe(ALICE);
	});
});

// ── accept ──────────────────────────────────────────────────────────────────

describe("acceptTrade", () => {
	const openAliceAndBob = (): MonopolyState => {
		const { state, proposal } = aliceAndBob();
		return expectOk(openTrade(state, proposal)).state;
	};

	it("moves every item both ways in one step and clears the trade", () => {
		const open = openAliceAndBob();
		const { state, trailLines } = expectOk(acceptTrade(open, BOB));
		expect(state.properties["reader-dock"].ownerId).toBe(BOB);
		expect(state.properties["vermillion-alley"].ownerId).toBe(ALICE);
		// A mortgaged lot moves still mortgaged, with no interest charged.
		expect(state.properties["burnt-umber-row"]).toMatchObject({ ownerId: ALICE, mortgaged: true });
		expect(state.seats[0]).toMatchObject({ chips: STARTING_CHIPS - 100 + 50, gojfCards: 0 });
		expect(state.seats[1]).toMatchObject({ chips: STARTING_CHIPS + 100 - 50, gojfCards: 1 });
		expect(state.seats[2].chips).toBe(STARTING_CHIPS);
		expect(state.pendingTrade).toBeNull();
		expect(trailLines).toEqual([
			"<@bob> accepted the trade from <@alice>.",
			"<@alice> gave Reader Dock, $100 and 1 Get Out of Jail Free card.",
			"<@bob> gave Vermillion Alley, Burnt Umber Row and $50.",
		]);
		// The input state is untouched, so a failed persist can simply drop the result.
		expect(open.pendingTrade).not.toBeNull();
		expect(open.properties["reader-dock"].ownerId).toBe(ALICE);
	});

	it("names a single item, and nothing for a side that gives nothing", () => {
		const state = newMatch();
		state.properties["reader-dock"].ownerId = ALICE;
		const gift = { initiatorId: ALICE, counterpartyId: BOB, offer: { ...NOTHING, properties: ["reader-dock"] }, request: NOTHING, openedAt: NOW };
		const { trailLines } = expectOk(acceptTrade(expectOk(openTrade(state, gift)).state));
		expect(trailLines.slice(1)).toEqual(["<@alice> gave Reader Dock.", "<@bob> gave nothing."]);
	});

	it("refuses with no open trade, or from anyone but the counterparty", () => {
		expectRefusal(acceptTrade(newMatch()), "There is no trade waiting for an answer.");
		expectRefusal(acceptTrade(openAliceAndBob(), ALICE), "Only the player this trade was offered to can accept it.");
		expectRefusal(acceptTrade(openAliceAndBob(), CARA), "Only the player this trade was offered to can accept it.");
	});

	it("re-checks the terms, so a trade the state no longer supports moves nothing", () => {
		const open = openAliceAndBob();
		open.seats[0].chips = 40;
		const result = acceptTrade(open, BOB);
		expectRefusal(result, "This trade can no longer go through. <@alice> does not have $100.");
		expect(open.pendingTrade).not.toBeNull();
		expect(open.properties["reader-dock"].ownerId).toBe(ALICE);

		const built = openAliceAndBob();
		built.properties["vermillion-alley"].houses = 1;
		expectRefusal(acceptTrade(built), /Vermillion Alley cannot be traded/);
	});
});

// ── reject ──────────────────────────────────────────────────────────────────

describe("rejectTrade", () => {
	const openAliceAndBob = (): MonopolyState => {
		const { state, proposal } = aliceAndBob();
		return expectOk(openTrade(state, proposal)).state;
	};

	it("clears the trade without moving anything when the counterparty turns it down", () => {
		const open = openAliceAndBob();
		const { state, trailLines } = expectOk(rejectTrade(open));
		expect(state.pendingTrade).toBeNull();
		expect(state.properties["reader-dock"].ownerId).toBe(ALICE);
		expect(state.seats.map((seat) => [seat.chips, seat.gojfCards])).toEqual(open.seats.map((seat) => [seat.chips, seat.gojfCards]));
		expect(trailLines).toEqual(["<@bob> turned down the trade from <@alice>."]);
		expect(expectOk(rejectTrade(open, BOB)).trailLines).toEqual(trailLines);
	});

	it("lets the initiator withdraw it", () => {
		const { state, trailLines } = expectOk(rejectTrade(openAliceAndBob(), ALICE));
		expect(state.pendingTrade).toBeNull();
		expect(trailLines).toEqual(["<@alice> withdrew the trade offered to <@bob>."]);
	});

	it("refuses with no open trade, or from a player outside it", () => {
		expectRefusal(rejectTrade(newMatch()), "There is no trade waiting for an answer.");
		expectRefusal(rejectTrade(openAliceAndBob(), CARA), "Only the two players in this trade can call it off.");
	});
});

// ── a party leaving ─────────────────────────────────────────────────────────

// Alice owes Bob $150 with $20, Rail One (mortgage $100) and Reader Dock ($50):
// coverable, so the match waits on her to raise the cash.
function aliceOwesBob(): MonopolyState {
	const state = newMatch();
	state.phase = "post-roll";
	state.seats[0].chips = 20;
	state.properties["rail-one"].ownerId = ALICE;
	state.properties["reader-dock"].ownerId = ALICE;
	settleDebts(state, [{ debtor: state.seats[0], creditorId: BOB, amount: 150 }], NOW);
	return state;
}

const giveaway: TradeProposal = {
	initiatorId: ALICE,
	counterpartyId: CARA,
	offer: { properties: ["rail-one"], chips: 10, gojf: 0 },
	request: NOTHING,
	openedAt: NOW,
};

describe("a debtor the match is waiting on (P2-2)", () => {
	it("refuses a trade where the debtor gives more than it gets back, on open and on accept", () => {
		const debtorLine = /<@alice> owes a debt the match is waiting on, so they cannot give more than they get back/;
		expectRefusal(openTrade(aliceOwesBob(), giveaway), debtorLine);
		const asked = withTerms(giveaway, { initiatorId: CARA, counterpartyId: ALICE, offer: NOTHING, request: giveaway.offer });
		expectRefusal(openTrade(aliceOwesBob(), asked), debtorLine);

		const offeredBeforeTheDebt = { ...aliceOwesBob(), pendingTrade: giveaway };
		expectRefusal(acceptTrade(offeredBeforeTheDebt, CARA), debtorLine);
	});

	it("lets the debtor sell a lot for at least its mortgage, which is how it raises the cash", () => {
		const sale = withTerms(giveaway, { offer: { properties: ["rail-one"], chips: 0, gojf: 0 }, request: { properties: [], chips: 100, gojf: 0 } });
		const { state } = expectOk(acceptTrade(expectOk(openTrade(aliceOwesBob(), sale)).state, CARA));
		expect(state.seats[0].chips).toBe(120);
		expect(state.properties["rail-one"].ownerId).toBe(CARA);
	});

	it("counts a mortgaged lot at nothing more and a jail card at the bail", () => {
		const state = aliceOwesBob();
		state.properties["rail-one"].mortgaged = true;
		state.seats[0].gojfCards = 1;
		const swap = withTerms(giveaway, { offer: { properties: ["rail-one"], chips: 0, gojf: 1 }, request: { properties: [], chips: 50, gojf: 0 } });
		expectOk(openTrade(state, swap));
		expectRefusal(openTrade(state, withTerms(swap, { request: { properties: [], chips: 49, gojf: 0 } })), /cannot give more/);
	});

	it("leaves two seats who owe nothing free to trade as they like", () => {
		const gift = withTerms(giveaway, { initiatorId: CARA, counterpartyId: BOB, offer: { properties: [], chips: 10, gojf: 0 } });
		expectOk(openTrade(aliceOwesBob(), gift));
	});
});

describe("a party leaving the match", () => {
	it("calls the open trade off, and leaves one between two others alone", () => {
		const { state, proposal } = aliceAndBob();
		const open = expectOk(openTrade(state, proposal)).state;
		const { state: next, trailLines } = expectOk(applyForfeit(open, BOB, NOW));
		expect(next.pendingTrade).toBeNull();
		expect(trailLines).toContain("The trade between <@alice> and <@bob> is called off.");

		expect(expectOk(applyForfeit(open, CARA, NOW)).state.pendingTrade).toEqual(proposal);
	});

	it("clears an open trade when the match ends", () => {
		const state = newMatch([ALICE, BOB]);
		state.properties["reader-dock"].ownerId = ALICE;
		const gift = { initiatorId: ALICE, counterpartyId: BOB, offer: { ...NOTHING, properties: ["reader-dock"] }, request: NOTHING, openedAt: NOW };
		const open = expectOk(openTrade(state, gift)).state;
		const { state: over } = expectOk(applyForfeit(open, ALICE, NOW));
		expect(over.phase).toBe("finished");
		expect(over.pendingTrade).toBeNull();
	});
});

describe("tradableLots", () => {
	it("lists the lots a seat owns that a trade could move, in board order", () => {
		const { state } = aliceAndBob();
		expect(tradableLots(state, BOB).map((tile) => tile.id)).toEqual(["vermillion-alley", "burnt-umber-row"]);
		expect(tradableLots(state, ALICE).map((tile) => tile.id)).toEqual(["reader-dock"]);
	});

	it("leaves out a lot whose color group has buildings, the same rule openTrade checks", () => {
		const { state } = aliceAndBob();
		state.properties["burnt-umber-row"].mortgaged = false;
		state.properties["vermillion-alley"].houses = 1;
		expect(tradableLots(state, BOB)).toEqual([]);
	});

	it("lists nothing for a seat that is out of the match or not in it", () => {
		const { state } = aliceAndBob();
		state.seats[1].bankrupt = true;
		expect(tradableLots(state, BOB)).toEqual([]);
		expect(tradableLots(state, "stranger")).toEqual([]);
	});
});

describe("describeTradeSide", () => {
	it("names lots, chips and jail cards in one line, and says nothing for an empty side", () => {
		expect(describeTradeSide({ properties: ["reader-dock"], chips: 100, gojf: 1 })).toBe("Reader Dock, $100 and 1 Get Out of Jail Free card");
		expect(describeTradeSide({ properties: [], chips: 50, gojf: 0 })).toBe("$50");
		expect(describeTradeSide(NOTHING)).toBe("nothing");
	});
});
