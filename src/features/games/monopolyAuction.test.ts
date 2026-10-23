import { describe, it, expect } from "vitest";
import { GO_INDEX, MIN_AUCTION_BID, STARTING_CHIPS, boardIndexOf } from "./monopolyBoard.js";
import {
	applyEndTurn,
	applyForfeit,
	applySkip,
	closeAuction,
	createInitialState,
	openAuction,
	placeBid,
	type MonopolyResult,
	type MonopolyState,
} from "./monopolyState.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const ALICE = "alice";
const BOB = "bob";
const CARA = "cara";
const NOW = 1_000;
const LATER = 2_000;
const SEED = 241;
const LOT = "burnt-umber-row";

function expectOk(result: MonopolyResult): { state: MonopolyState; trailLines: string[] } {
	if (!result.ok) throw new Error(`expected ok, got refusal: ${result.reason}`);
	return result;
}

function expectRefusal(result: MonopolyResult, reason: string | RegExp): void {
	if (result.ok) throw new Error("expected a refusal, got ok");
	expect(result.reason).toMatch(reason);
}

// Alice is standing on Burnt Umber Row, for sale, as a roll would have left her.
function offeringLot(auctionsEnabled: boolean = true, players: string[] = [ALICE, BOB, CARA]): MonopolyState {
	const state = createInitialState(players, { auctionsEnabled }, NOW, SEED);
	state.seats[0].position = boardIndexOf(LOT);
	state.rolledThisTurn = true;
	state.phase = "awaiting-buy-or-skip";
	return state;
}

const auctioning = (players?: string[]): MonopolyState => expectOk(applySkip(offeringLot(true, players), ALICE, LATER)).state;

function bidAll(state: MonopolyState, bids: Record<string, number>): MonopolyState {
	let current = state;
	for (const [bidderId, amount] of Object.entries(bids)) current = expectOk(placeBid(current, bidderId, amount)).state;
	return current;
}

// ── open ────────────────────────────────────────────────────────────────────

describe("openAuction", () => {
	it("opens when the seat on a lot passes in a match with auctions on", () => {
		const { state, trailLines } = expectOk(applySkip(offeringLot(), ALICE, LATER));
		expect(state.phase).toBe("in-auction");
		expect(state.pendingAuction).toEqual({ tileId: LOT, bids: {}, roundOpenedAt: LATER, skippedBy: ALICE });
		expect(state.properties[LOT].ownerId).toBeNull();
		expect(trailLines).toEqual(["<@alice> passed on Burnt Umber Row, and it goes up for auction."]);
	});

	it("is the same round when opened directly", () => {
		expect(expectOk(openAuction(offeringLot(), LOT, ALICE, LATER)).state.pendingAuction?.roundOpenedAt).toBe(LATER);
	});

	it("leaves a pass as a plain pass when auctions are off, and refuses to open one", () => {
		const { state } = expectOk(applySkip(offeringLot(false), ALICE));
		expect(state.phase).toBe("post-roll");
		expect(state.pendingAuction).toBeNull();
		expectRefusal(openAuction(offeringLot(false), LOT, ALICE), "Auctions are off in this match.");
	});

	it("refuses another seat, a finished match and a second auction", () => {
		expectRefusal(openAuction(offeringLot(), LOT, BOB), "It is not your turn.");
		expectRefusal(openAuction({ ...offeringLot(), phase: "finished" }, LOT, ALICE), "The match is already over.");
		expectRefusal(openAuction(auctioning(), LOT, ALICE), "An auction is already running.");
	});

	it("refuses outside a buy, and for a lot the seat is not standing on", () => {
		expectRefusal(openAuction({ ...offeringLot(), phase: "post-roll" }, LOT, ALICE), "There is nothing to auction right now.");
		expectRefusal(openAuction(offeringLot(), "vermillion-alley", ALICE), "Only the lot you are standing on can go to auction.");
	});

	it("refuses a lot that already has an owner", () => {
		const owned = offeringLot();
		owned.properties[LOT].ownerId = BOB;
		expectRefusal(openAuction(owned, LOT, ALICE), "Burnt Umber Row already has an owner.");
	});

	it("falls back to a plain pass when a hand built state awaits a buy off any lot", () => {
		const corrupt = offeringLot();
		corrupt.seats[0].position = GO_INDEX;
		expect(expectOk(applySkip(corrupt, ALICE)).state.phase).toBe("post-roll");
	});
});

// ── bid ─────────────────────────────────────────────────────────────────────

describe("placeBid", () => {
	it("tracks a sealed bid from every seat still playing, the last bid counting", () => {
		const { state, trailLines } = expectOk(placeBid(auctioning(), BOB, 70));
		expect(trailLines).toEqual(["<@bob> placed a bid on Burnt Umber Row."]);
		const all = bidAll(state, { [ALICE]: 40, [CARA]: 90, [BOB]: 95 });
		expect(all.pendingAuction?.bids).toEqual({ [ALICE]: 40, [BOB]: 95, [CARA]: 90 });
		expect(state.pendingAuction?.bids).toEqual({ [BOB]: 70 });
	});

	it("refuses with no auction open", () => {
		expectRefusal(placeBid(offeringLot(), BOB, 70), "There is no auction open.");
	});

	it("refuses a seat that is not playing", () => {
		expectRefusal(placeBid(auctioning(), "nobody", 70), "You are not playing in this match.");
		const out = expectOk(applyForfeit(auctioning(), CARA, LATER)).state;
		expectRefusal(placeBid(out, CARA, 70), "You are not playing in this match.");
	});

	it("refuses a bid that is not whole, below the minimum, or more than the bidder holds", () => {
		const reason = `A bid is a whole number of chips, at least $${MIN_AUCTION_BID}.`;
		expectRefusal(placeBid(auctioning(), BOB, 0), reason);
		expectRefusal(placeBid(auctioning(), BOB, 10.5), reason);
		expectRefusal(placeBid(auctioning(), BOB, STARTING_CHIPS + 1), `You only have $${STARTING_CHIPS} to bid with.`);
	});
});

// ── close ───────────────────────────────────────────────────────────────────

describe("closeAuction", () => {
	it("sells the lot to the highest bid and hands the turn back", () => {
		const bids = bidAll(auctioning(), { [ALICE]: 40, [BOB]: 95, [CARA]: 90 });
		const { state, trailLines } = expectOk(closeAuction(bids));
		expect(state.properties[LOT].ownerId).toBe(BOB);
		expect(state.seats.map((seat) => seat.chips)).toEqual([STARTING_CHIPS, STARTING_CHIPS - 95, STARTING_CHIPS]);
		expect(state.pendingAuction).toBeNull();
		expect(state.phase).toBe("post-roll");
		expect(trailLines).toEqual(["<@bob> won Burnt Umber Row at auction for $95."]);
		expect(state.log.at(-1)?.userId).toBe(ALICE);
	});

	it("leaves the lot with the bank when nobody bids", () => {
		const { state, trailLines } = expectOk(closeAuction(auctioning()));
		expect(state.properties[LOT].ownerId).toBeNull();
		expect(state.phase).toBe("post-roll");
		expect(trailLines).toEqual(["Nobody bid on Burnt Umber Row, so it stays with the bank."]);
	});

	it("breaks a tie by turn order from the seat on the clock", () => {
		const tied = bidAll(auctioning(), { [CARA]: 80, [BOB]: 80 });
		expect(expectOk(closeAuction(tied)).state.properties[LOT].ownerId).toBe(BOB);
		const withSeller = bidAll(auctioning(), { [CARA]: 80, [ALICE]: 80 });
		expect(expectOk(closeAuction(withSeller)).state.properties[LOT].ownerId).toBe(ALICE);
	});

	it("skips a bid its bidder can no longer pay", () => {
		const bids = bidAll(auctioning(), { [BOB]: 200, [CARA]: 90 });
		bids.seats[1].chips = 150;
		expect(expectOk(closeAuction(bids)).state.properties[LOT].ownerId).toBe(CARA);
	});

	it("refuses with no auction open", () => {
		expectRefusal(closeAuction(offeringLot()), "There is no auction open.");
	});

	it("lets a doubles roller roll again once the auction closes", () => {
		const doubles = offeringLot();
		doubles.rolledThisTurn = false;
		doubles.doublesStreak = 1;
		const closed = expectOk(closeAuction(expectOk(applySkip(doubles, ALICE)).state)).state;
		const { state } = expectOk(applyEndTurn(closed));
		expect(state.phase).toBe("pre-roll");
		expect(state.activeSeatIndex).toBe(0);
	});
});

// ── a seat leaving mid auction ──────────────────────────────────────────────

describe("a seat leaving mid auction", () => {
	it("drops a rival's bid and keeps the round open", () => {
		const bids = bidAll(auctioning(), { [BOB]: 95, [CARA]: 90 });
		const { state } = expectOk(applyForfeit(bids, BOB, LATER));
		expect(state.phase).toBe("in-auction");
		expect(state.pendingAuction?.bids).toEqual({ [CARA]: 90 });
		expect(expectOk(closeAuction(state)).state.properties[LOT].ownerId).toBe(CARA);
	});

	it("calls the auction off when the seller leaves, and the turn passes", () => {
		const bids = bidAll(auctioning(), { [BOB]: 95 });
		const { state, trailLines } = expectOk(applyForfeit(bids, ALICE, LATER));
		expect(state.pendingAuction).toBeNull();
		expect(state.properties[LOT].ownerId).toBeNull();
		expect(state.phase).toBe("pre-roll");
		expect(state.activeSeatIndex).toBe(1);
		expect(trailLines).toContain("The auction for Burnt Umber Row is called off, and the lot stays with the bank.");
	});

	it("clears the auction when the last rival leaves and the match ends", () => {
		const bids = bidAll(auctioning([ALICE, BOB]), { [BOB]: 95 });
		const { state } = expectOk(applyForfeit(bids, BOB, LATER));
		expect(state.phase).toBe("finished");
		expect(state.winnerId).toBe(ALICE);
		expect(state.pendingAuction).toBeNull();
	});
});
