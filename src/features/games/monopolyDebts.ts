import { debtsFromHold, findCreditorSeat, handOverHoldings, liquidationValue, settleDebts } from "./monopolyBankruptcy.js";
import { releaseFromJail } from "./monopolyJail.js";
import { moveAndLand } from "./monopolyLanding.js";
import type { DebtHold, MonopolyResult, MonopolyState, PendingDebt } from "./monopolyState.js";
import { cloneState, completeAction, findSeat, mentionPlayer, rejectAction } from "./monopolySeats.js";

// ── monopolyDebts ───────────────────────────────────────────────────────────
// What:  the two ways a held debt ends: the debtor pays it once they have raised
//        the cash, or never does and is declared bankrupt to whoever they owed.
// Who:   the room's Pay button (applyPayDebt) and the idle sweep
//        (applyDebtDefault), through the re-exports in monopolyState.
// When:  only in the "awaiting-debt" phase, which monopolyBankruptcy enters when
//        a debtor is short of chips but could cover the debt by mortgaging and
//        selling. While it lasts the debtor raises cash with applyMortgage and
//        applySellBuilding (or a trade), and nothing else in the turn moves.
// Where: its own module rather than inside monopolyBankruptcy, because a paid
//        forced bail goes on to move the seat (monopolyLanding), and landing
//        already imports the bankruptcy module.
// How:   ending a hold puts the turn back on the phase it paused at, then settles
//        the held debts again from the top: the paid one now goes through, and
//        any debt behind it from the same batch is paid, held in its turn, or
//        bankrupts, exactly as if the batch had never paused.

/** The debt the match is waiting on, or null when it is not waiting on one. */
export function waitingDebt(state: MonopolyState): PendingDebt | null {
	return state.phase === "awaiting-debt" ? (state.pendingDebt?.debts[0] ?? null) : null;
}

/**
 * The debtor pays the debt the match is waiting on. Refused while mortgaging and
 * selling could still raise the rest, because then paying is only a matter of
 * doing that first. When the chips fall short and nothing left could cover it
 * (the seat sold or traded away what would have), paying settles it the only way
 * left: a bankruptcy, under the same rule that would have applied at the charge.
 */
export function applyPayDebt(state: MonopolyState, debtorId: string, now: number = Date.now()): MonopolyResult {
	const debt = waitingDebt(state);
	const hold = state.pendingDebt;
	if (!debt || !hold) return rejectAction("There is no debt waiting to be paid.");
	if (debt.debtorId !== debtorId) return rejectAction(`Only ${mentionPlayer(debt.debtorId)} can pay this debt.`);
	const debtor = findSeat(state, debtorId);
	// Unreachable in play: a seat leaving the match takes its debts off the hold
	// (removeFromMatch). The guard narrows the type and keeps a hand built state honest.
	if (!debtor || debtor.bankrupt) return rejectAction("You are not playing in this match.");

	const shortBy = debt.amount - debtor.chips;
	if (shortBy > 0 && liquidationValue(state, debtorId) >= shortBy) {
		return rejectAction(`You need $${shortBy} more. Mortgage lots or sell buildings from Inventory, then pay.`);
	}

	const next = cloneState(state);
	return completeAction(next, debtorId, resumeHold(next, hold, now));
}

/**
 * The debtor the match is waiting on never paid, so they are bankrupt to whoever
 * they owed, whatever they could have raised: the idle sweep's answer to a debt
 * left for a day. The rest of the held batch then settles as usual.
 */
export function applyDebtDefault(state: MonopolyState, now: number = Date.now()): MonopolyResult {
	const debt = waitingDebt(state);
	const hold = state.pendingDebt;
	if (!debt || !hold) return rejectAction("There is no debt waiting to be paid.");

	const next = cloneState(state);
	next.pendingDebt = null;
	next.phase = hold.resumePhase;
	const lines: string[] = [];
	const debtor = findSeat(next, debt.debtorId);
	if (debtor && !debtor.bankrupt) {
		lines.push(`${mentionPlayer(debtor.userId)} never paid the $${debt.amount} they owed and is bankrupt.`);
		lines.push(...handOverHoldings(next, debtor, findCreditorSeat(next, debt.creditorId), now));
	}
	// What the defaulter owed elsewhere in the batch is written off with them
	// (debtsFromHold drops a bankrupt debtor); everyone else's debts still settle.
	// A forced bail's move belonged to the defaulter, so it is dropped too.
	if (next.phase !== "finished") lines.push(...settleDebts(next, debtsFromHold(next, hold.debts.slice(1)), now));
	return completeAction(next, debt.debtorId, lines);
}

// Ends the hold and settles its debts again from the top, then makes the forced
// bail's move if one was waiting on this debt.
function resumeHold(state: MonopolyState, hold: DebtHold, now: number): string[] {
	state.pendingDebt = null;
	state.phase = hold.resumePhase;
	const lines = settleDebts(state, debtsFromHold(state, hold.debts), now);
	return [...lines, ...moveAfterBail(state, hold, now)];
}

// The standard rules pay the forced bail and THEN move. A forced bail is a batch
// of one debt and applyPayDebt only resumes it once it can be paid outright, so
// nothing can be held behind it; the pendingDebt check only keeps a hand built
// state from moving a seat while the match still waits. Only the bail's own
// debtor moves, and never after a bankruptcy.
function moveAfterBail(state: MonopolyState, hold: DebtHold, now: number): string[] {
	if (hold.moveAfter === null || state.phase === "finished" || state.pendingDebt) return [];
	const mover = findSeat(state, hold.debts[0].debtorId);
	if (!mover || mover.bankrupt) return [];
	releaseFromJail(mover);
	return moveAndLand(state, mover, hold.moveAfter, now);
}
