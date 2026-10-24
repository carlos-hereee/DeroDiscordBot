import { BOARD, MIN_AUCTION_BID, isOwnableTile, ownableTileName, type TileId } from "./monopolyBoard.js";
import type { MonopolyResult, MonopolySeat, MonopolyState } from "./monopolyState.js";
import { activeSeatOf, cloneState, completeAction,
	ensureStats, findSeat, guardActiveTurn, mentionPlayer, rejectAction } from "./monopolySeats.js";

// ── monopolyAuction ─────────────────────────────────────────────────────────
// What:  the auction a lot goes to when the seat standing on it passes, in a
//        match opened with auctions on: it opens, every seat still in the match
//        bids, and it closes with the lot sold to the highest bid or kept by
//        the bank.
// Who:   applySkip in monopolyState opens one; the Phase 5 bid modal calls
//        placeBid; the room glue calls closeAuction when the round's timer
//        (60 seconds from roundOpenedAt, master plan Section 1) runs out. All
//        three are re-exported from monopolyState.
// When:  only in the "in-auction" phase, which nothing but closeAuction (or the
//        seller leaving the match) ends, so the seller's turn waits on it.
// Where: the round lives on MonopolyState.pendingAuction. The engine holds no
//        timer: the persisted roundOpenedAt is what lets a round survive a
//        Railway deploy.
// How:   bids are sealed. A bid's trail line never carries the amount, because
//        the room posts trail lines to the channel; the amounts are revealed
//        when the auction closes. A seat may bid again, and its new bid replaces
//        the old one.

// ── open ────────────────────────────────────────────────────────────────────

/**
 * The active seat passes on the lot it is standing on and the lot goes to
 * auction. `skipperId` is that seat, the same check applyBuy makes, since a
 * stale button must not auction a lot the player has moved off.
 */
export function openAuction(state: MonopolyState, tileId: TileId, skipperId: string, now: number = Date.now()): MonopolyResult {
	const turnRefusal = guardActiveTurn(state, skipperId);
	if (turnRefusal) return rejectAction(turnRefusal);
	if (!state.settings.auctionsEnabled) return rejectAction("Auctions are off in this match.");
	if (state.pendingAuction) return rejectAction("An auction is already running.");
	if (state.phase !== "awaiting-buy-or-skip") return rejectAction("There is nothing to auction right now.");
	const tile = BOARD[activeSeatOf(state).position];
	if (!isOwnableTile(tile) || tile.id !== tileId) return rejectAction("Only the lot you are standing on can go to auction.");
	// Unreachable through applyRoll, which only offers a lot the bank holds; the
	// check keeps a hand built state from auctioning a lot someone owns.
	if (state.properties[tile.id].ownerId !== null) return rejectAction(`${tile.name} already has an owner.`);

	const next = cloneState(state);
	next.pendingAuction = { tileId: tile.id, bids: {}, roundOpenedAt: now, skippedBy: skipperId };
	next.phase = "in-auction";
	ensureStats(next).auctionsOpened += 1;
	return completeAction(next, skipperId, [`${mentionPlayer(skipperId)} passed on ${tile.name}, and it goes up for auction.`]);
}

// ── bid ─────────────────────────────────────────────────────────────────────

/** A seat still in the match bids on the open auction. Its last bid is the one that counts. */
export function placeBid(state: MonopolyState, bidderId: string, amount: number): MonopolyResult {
	const auction = state.pendingAuction;
	if (state.phase !== "in-auction" || !auction) return rejectAction("There is no auction open.");
	const bidder = findSeat(state, bidderId);
	if (!bidder || bidder.bankrupt) return rejectAction("You are not playing in this match.");
	if (!Number.isInteger(amount) || amount < MIN_AUCTION_BID) return rejectAction(`A bid is a whole number of chips, at least $${MIN_AUCTION_BID}.`);
	if (amount > bidder.chips) return rejectAction(`You only have $${bidder.chips} to bid with.`);

	const next = cloneState(state);
	next.pendingAuction = { ...auction, bids: { ...auction.bids, [bidderId]: amount } };
	return completeAction(next, bidderId, [`${mentionPlayer(bidderId)} placed a bid on ${ownableTileName(auction.tileId)}.`]);
}

// ── close ───────────────────────────────────────────────────────────────────

/**
 * Ends the round: the highest bid its bidder can still pay buys the lot, or the
 * bank keeps it. The turn then carries on from where the pass left it.
 */
export function closeAuction(state: MonopolyState): MonopolyResult {
	const auction = state.pendingAuction;
	if (state.phase !== "in-auction" || !auction) return rejectAction("There is no auction open.");

	const next = cloneState(state);
	const lotName = ownableTileName(auction.tileId);
	const actorId = activeSeatOf(next).userId;
	const winner = findWinningBid(next, auction.bids);
	next.pendingAuction = null;
	// post-roll is where a plain pass lands too, so a doubles roller still rolls
	// again through applyEndTurn.
	next.phase = "post-roll";
	if (!winner) return completeAction(next, actorId, [`Nobody bid on ${lotName}, so it stays with the bank.`]);

	winner.seat.chips -= winner.amount;
	next.properties[auction.tileId].ownerId = winner.seat.userId;
	return completeAction(next, actorId, [`${mentionPlayer(winner.seat.userId)} won ${lotName} at auction for $${winner.amount}.`]);
}

/**
 * The bid that wins, read from seats of `state`. A bid only counts while its
 * bidder is still playing and can pay it, since chips can move between the bid
 * and the close (a trade, an unmortgage). Equal bids go to the bidder soonest
 * in turn order from the seat on the clock: bid ids are Discord snowflakes,
 * which JavaScript orders numerically as object keys, so the order bids came
 * in is not recoverable and turn order is the fair fallback everyone can see.
 */
function findWinningBid(state: MonopolyState, bids: Record<string, number>): { seat: MonopolySeat; amount: number } | null {
	let winner: { seat: MonopolySeat; amount: number } | null = null;
	for (let step = 0; step < state.seats.length; step++) {
		const seat = state.seats[(state.activeSeatIndex + step) % state.seats.length];
		const amount = bids[seat.userId];
		if (amount === undefined || seat.bankrupt || amount > seat.chips) continue;
		if (!winner || amount > winner.amount) winner = { seat, amount };
	}
	return winner;
}
