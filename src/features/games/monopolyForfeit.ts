import { ownableTileName } from "./monopolyBoard.js";
import { returnJailCards } from "./monopolyCards.js";
import type { MonopolySeat, MonopolyState } from "./monopolyState.js";
import { activeSeatOf, createBankProperty, mentionPlayer, passTurn, solventSeats } from "./monopolySeats.js";

// ── monopolyForfeit ─────────────────────────────────────────────────────────
// What:  taking a seat out of the match. removeFromMatch is the shared tail
//        every exit ends in (elimination order, open deals, the winner or the
//        next turn); forfeitSeat is the bank version on top of it, where chips,
//        lots, buildings and Get Out of Jail Free cards go back to the bank.
// Who:   applyForfeit (the public action in monopolyDebts, since a seat the
//        match waits on for a debt goes to its creditor instead of the bank) and
//        monopolyBankruptcy, which forfeits to the bank for a bank debt and calls
//        removeFromMatch after handing a player creditor everything.
// When:  a seat leaves, idles out, or cannot cover a debt.
// Where: split out of monopolyState (rule 18).
// How:   both functions mutate a clone and return trail lines, so the debt path
//        can fold them into the roll that caused the debt.

/**
 * Mutates `state` to hand everything `seat` (a seat OF `state`) holds back to
 * the bank and remove it, returning the trail lines. The caller has already
 * confirmed the seat is still in the match.
 */
export function forfeitSeat(state: MonopolyState, seat: MonopolySeat, now: number): string[] {
	// Held jail cards rejoin their own decks rather than vanishing with the seat,
	// or the two decks would each be a card short for the rest of the match.
	returnJailCards(state, seat.gojfCards);
	seat.gojfCards = 0;
	returnHoldingsToBank(state, seat.userId);
	return removeFromMatch(state, seat, now, `${mentionPlayer(seat.userId)} is out of the match, and their holdings return to the bank.`);
}

/**
 * Marks `seat` out of the match once its holdings have gone wherever they are
 * going, and returns `exitLine` plus the lines for what that changes: a deal it
 * was part of is called off, and either the last seat standing wins or, when
 * the seat was on the clock, the turn passes.
 */
export function removeFromMatch(state: MonopolyState, seat: MonopolySeat, now: number, exitLine: string): string[] {
	const userId = seat.userId;

	// Elimination order drives the XP placement at match end: the first seat out
	// is 1, the next 2, and so on.
	seat.bankruptedAt = state.seats.filter((candidate) => candidate.bankrupt).length + 1;
	seat.bankrupt = true;
	seat.chips = 0;
	seat.inJail = false;
	seat.jailTurnsRemaining = 0;

	const lines = [exitLine, ...callOffDealsOf(state, userId), ...writeOffHeldDebtsOf(state, userId)];
	const remaining = solventSeats(state);
	if (remaining.length === 1) {
		state.phase = "finished";
		state.winnerId = remaining[0].userId;
		// An auction on the winner's own turn has no rival left to outbid, and a
		// finished match takes no more actions to close it. (A trade never needs
		// this: one of its two parties is always the seat that just left.) A held
		// debt is the same: nobody is left to collect it.
		state.pendingAuction = null;
		state.pendingDebt = null;
		lines.push(`${mentionPlayer(remaining[0].userId)} wins the match.`);
		return lines;
	}

	// A seat that leaves off turn leaves the clock where it is; only the seat on
	// the clock hands it on.
	if (activeSeatOf(state).userId === userId) {
		passTurn(state, now);
		lines.push(`It is now ${mentionPlayer(activeSeatOf(state).userId)}'s turn.`);
		// A debt still held for another seat keeps the match waiting, now from the
		// start of the new seat's turn.
		if (state.pendingDebt) {
			state.pendingDebt.resumePhase = state.phase;
			state.phase = "awaiting-debt";
		}
	}
	return lines;
}

// A seat that leaves while the match waits on a debt owes nothing more from then
// on: its debts further down the held batch come off the hold, the same write off
// a bankrupt debtor gets. With nothing left held, the turn goes back to where it
// paused. The debtor being waited on never reaches here through applyForfeit,
// which defaults it to its creditor first (2026-10 item 276, P2-1); the first
// debt branch only keeps a forced bail's move from outliving its debtor if some
// other exit ever does.
function writeOffHeldDebtsOf(state: MonopolyState, userId: string): string[] {
	const hold = state.pendingDebt;
	if (!hold || !hold.debts.some((debt) => debt.debtorId === userId)) return [];
	if (hold.debts[0].debtorId === userId) hold.moveAfter = null;
	hold.debts = hold.debts.filter((debt) => debt.debtorId !== userId);
	if (hold.debts.length === 0) {
		state.pendingDebt = null;
		state.phase = hold.resumePhase;
	}
	return [`What ${mentionPlayer(userId)} still owed is written off.`];
}

// A trade names lots and chips the leaving seat no longer has, so it cannot be
// accepted and is called off. An auction runs on its seller's turn: when that
// seat leaves the auction ends with the lot still the bank's, because passTurn
// is about to move the phase off "in-auction". A rival who leaves mid auction
// only loses its bid.
function callOffDealsOf(state: MonopolyState, userId: string): string[] {
	const lines: string[] = [];
	const trade = state.pendingTrade;
	if (trade && (trade.initiatorId === userId || trade.counterpartyId === userId)) {
		state.pendingTrade = null;
		lines.push(`The trade between ${mentionPlayer(trade.initiatorId)} and ${mentionPlayer(trade.counterpartyId)} is called off.`);
	}
	const auction = state.pendingAuction;
	if (!auction) return lines;
	if (activeSeatOf(state).userId === userId) {
		state.pendingAuction = null;
		lines.push(`The auction for ${ownableTileName(auction.tileId)} is called off, and the lot stays with the bank.`);
		return lines;
	}
	delete auction.bids[userId];
	return lines;
}

// Buildings go back into the bank's stock rather than vanishing, because the
// 32 houses and 12 hotels are a shared supply the build rule draws on.
function returnHoldingsToBank(state: MonopolyState, userId: string): void {
	for (const [tileId, property] of Object.entries(state.properties)) {
		if (property.ownerId !== userId) continue;
		state.bank.houses += property.houses;
		if (property.hotel) state.bank.hotels += 1;
		state.properties[tileId] = createBankProperty();
	}
}
