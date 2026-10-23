import { JAIL_BAIL } from "./monopolyBoard.js";
import { returnJailCards } from "./monopolyCards.js";
import { BANK_CREDITOR, settleDebt } from "./monopolyBankruptcy.js";
import { moveAndLand, rollDice } from "./monopolyLanding.js";
import type { JailChoice, MonopolyResult, MonopolySeat, MonopolyState } from "./monopolyState.js";
import { activeSeatOf, cloneState, completeAction, guardActiveTurn, mentionPlayer, rejectAction } from "./monopolySeats.js";

// ── monopolyJail ────────────────────────────────────────────────────────────
// What:  the three ways out of jail: pay bail, spend a Get Out of Jail Free card,
//        or roll for doubles, with the forced bail on the last failed roll.
// Who:   the Phase 4 jail buttons, through applyJailChoice re-exported from
//        monopolyState.
// When:  on a jailed seat's turn, before it rolls. A jailed seat cannot use
//        applyRoll; this is its only way to act.
// Where: split out of monopolyState (rule 18). Entering jail lives in
//        monopolyLanding (jailActiveSeat), because both a roll and a landing send
//        a seat there.
// How:   bail and card free the seat and leave the phase on pre-roll so it rolls
//        normally. The roll choice IS the turn's roll: doubles free the seat and
//        move it, a miss spends one of the three tries, and the third miss pays
//        bail and moves, per the standard rules.

/** The jailed active seat picks its way out (or its attempt at one). */
export function applyJailChoice(
	state: MonopolyState,
	choice: JailChoice,
	rng: () => number = Math.random,
	now: number = Date.now()
): MonopolyResult {
	const turnRefusal = guardActiveTurn(state);
	if (turnRefusal) return rejectAction(turnRefusal);
	if (state.phase !== "pre-roll") return rejectAction("You have already acted this turn.");
	const seat = activeSeatOf(state);
	if (!seat.inJail) return rejectAction("You are not in Jail.");

	if (choice === "bail") return payBail(state);
	if (choice === "card") return spendJailCard(state);
	return rollFromJail(state, rng, now);
}

function payBail(state: MonopolyState): MonopolyResult {
	if (activeSeatOf(state).chips < JAIL_BAIL) return rejectAction(`You need $${JAIL_BAIL} to pay bail.`);

	const next = cloneState(state);
	const seat = activeSeatOf(next);
	seat.chips -= JAIL_BAIL;
	releaseFromJail(seat);
	return completeAction(next, seat.userId, [`${mentionPlayer(seat.userId)} paid $${JAIL_BAIL} bail and is free to roll.`]);
}

function spendJailCard(state: MonopolyState): MonopolyResult {
	if (activeSeatOf(state).gojfCards < 1) return rejectAction("You have no Get Out of Jail Free card.");

	const next = cloneState(state);
	const seat = activeSeatOf(next);
	// A spent card goes back to the bottom of its own deck, so it can be drawn again.
	returnJailCards(next, 1);
	seat.gojfCards -= 1;
	releaseFromJail(seat);
	return completeAction(next, seat.userId, [`${mentionPlayer(seat.userId)} used a Get Out of Jail Free card and is free to roll.`]);
}

function rollFromJail(state: MonopolyState, rng: () => number, now: number): MonopolyResult {
	const next = cloneState(state);
	const seat = activeSeatOf(next);
	const [firstDie, secondDie] = rollDice(rng);
	next.diceRoll = [firstDie, secondDie];
	// This roll is the whole turn whatever happens: doubles out of jail never earn
	// the extra roll that doubles normally do, so the streak is left at zero.
	next.rolledThisTurn = true;
	next.phase = "post-roll";
	const lines = [`${mentionPlayer(seat.userId)} rolled ${firstDie} and ${secondDie} in Jail.`];

	if (firstDie === secondDie) {
		releaseFromJail(seat);
		lines.push(`${mentionPlayer(seat.userId)} rolled doubles and walks out of Jail.`);
		lines.push(...moveAndLand(next, seat, firstDie + secondDie, now));
		return completeAction(next, seat.userId, lines);
	}

	seat.jailTurnsRemaining -= 1;
	if (seat.jailTurnsRemaining > 0) {
		lines.push(`${mentionPlayer(seat.userId)} stays in Jail with ${seat.jailTurnsRemaining} tries left.`);
		return completeAction(next, seat.userId, lines);
	}

	// The last try missed, so bail is no longer optional. A seat short of chips
	// raises cash for it first; one that still cannot cover it is bankrupt to the
	// bank and never moves.
	const bail = settleDebt(next, {
		debtor: seat,
		creditorId: BANK_CREDITOR,
		amount: JAIL_BAIL,
		paidLine: `${mentionPlayer(seat.userId)} used the last try, pays $${JAIL_BAIL} bail and moves.`,
	}, now);
	lines.push(...bail.lines);
	if (!bail.paid) return completeAction(next, seat.userId, lines);

	releaseFromJail(seat);
	lines.push(...moveAndLand(next, seat, firstDie + secondDie, now));
	return completeAction(next, seat.userId, lines);
}

function releaseFromJail(seat: MonopolySeat): void {
	seat.inJail = false;
	seat.jailTurnsRemaining = 0;
}
