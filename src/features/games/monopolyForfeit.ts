import { returnJailCards } from "./monopolyCards.js";
import type { MonopolyResult, MonopolySeat, MonopolyState } from "./monopolyState.js";
import {
	activeSeatOf,
	cloneState,
	completeAction,
	createBankProperty,
	mentionPlayer,
	passTurn,
	rejectAction,
	solventSeats,
} from "./monopolySeats.js";

// ── monopolyForfeit ─────────────────────────────────────────────────────────
// What:  taking a seat out of the match. Its chips, lots, buildings and Get Out
//        of Jail Free cards go back to the bank, it records its elimination
//        order, and the last seat standing wins.
// Who:   applyForfeit (the public action, used by an admin forfeit and the Phase
//        4 idle sweep) and monopolyLanding's debt path, when a seat cannot cover
//        rent, tax or bail.
// When:  a seat leaves, idles out, or runs out of chips mid debt.
// Where: split out of monopolyState (rule 18). Phase 3's monopolyBankruptcy adds
//        the creditor transfer and the mortgage everything first flow on top; this
//        is the bank only version that flow ends in.
// How:   forfeitSeat mutates a clone and returns its trail lines, so the debt
//        path can fold them into the roll that caused the debt.

/** Takes a seat out of the match, whoever's turn it is. */
export function applyForfeit(state: MonopolyState, seatId: string, now: number = Date.now()): MonopolyResult {
	if (state.phase === "finished") return rejectAction("The match is already over.");
	const seatIndex = state.seats.findIndex((seat) => seat.userId === seatId);
	if (seatIndex === -1) return rejectAction("That player is not seated in this match.");
	if (state.seats[seatIndex].bankrupt) return rejectAction("That player is already out of the match.");

	const next = cloneState(state);
	return completeAction(next, seatId, forfeitSeat(next, next.seats[seatIndex], now));
}

/**
 * Mutates `state` to remove `seat` (a seat OF `state`) and returns the trail
 * lines. The caller has already confirmed the seat is still in the match.
 */
export function forfeitSeat(state: MonopolyState, seat: MonopolySeat, now: number): string[] {
	const userId = seat.userId;

	// Elimination order drives the XP placement at match end: the first seat out
	// is 1, the next 2, and so on.
	seat.bankruptedAt = state.seats.filter((candidate) => candidate.bankrupt).length + 1;
	seat.bankrupt = true;
	seat.chips = 0;
	seat.inJail = false;
	seat.jailTurnsRemaining = 0;
	// Held jail cards rejoin their own decks rather than vanishing with the seat,
	// or the two decks would each be a card short for the rest of the match.
	returnJailCards(state, seat.gojfCards);
	seat.gojfCards = 0;
	returnHoldingsToBank(state, userId);

	const lines = [`${mentionPlayer(userId)} is out of the match, and their holdings return to the bank.`];
	const remaining = solventSeats(state);
	if (remaining.length === 1) {
		state.phase = "finished";
		state.winnerId = remaining[0].userId;
		lines.push(`${mentionPlayer(remaining[0].userId)} wins the match.`);
		return lines;
	}

	// A seat that forfeits off turn leaves the clock where it is; only the seat on
	// the clock hands it on.
	if (activeSeatOf(state).userId === userId) {
		passTurn(state, now);
		lines.push(`It is now ${mentionPlayer(activeSeatOf(state).userId)}'s turn.`);
	}
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
