import { OWNABLE_TILES, type OwnableTile, type PropertyTile } from "./monopolyBoard.js";
import { buildingLevel, buildingSaleValue, hasBuildings, sellBuildingRung } from "./monopolyBuildings.js";
import { forfeitSeat, removeFromMatch } from "./monopolyForfeit.js";
import type { MonopolyResult, MonopolySeat, MonopolyState, PendingDebt } from "./monopolyState.js";
import { cloneState, completeAction, countNoun, findSeat, mentionPlayer, rejectAction } from "./monopolySeats.js";

// ── monopolyBankruptcy ──────────────────────────────────────────────────────
// What:  paying a debt that the debtor's chips may not cover. A debt the chips
//        cover is paid on the spot. One that mortgaging and selling could cover
//        is HELD, and the match waits while the debtor chooses what to raise
//        cash from (monopolyDebts answers the Pay). One that even selling and
//        mortgaging everything could not cover is a bankruptcy, at once.
// Who:   every charge in the engine: rent, tax and the paying cards in
//        monopolyLanding, forced bail in monopolyJail, monopolyDebts when a held
//        debt is paid, and resolveDebt, the public action re-exported from
//        monopolyState.
// When:  whenever a seat owes chips.
// Where: on top of monopolyForfeit, which owns taking a seat out of the match;
//        this module decides WHERE the holdings go before that happens.
// How:   settleDebts works a batch of simultaneous debts (one card can create
//        several) so money owed to a debtor reaches it before its own debt is
//        judged. That is the chain settlement case of 2026-10 item 241: A owes B
//        and B owes C, and B only survives on what A hands over. A batch that
//        reaches a debt it must hold stops there, and the rest of the batch waits
//        behind it on the hold.
//
// Two rulings ride on the standard rules here, both owner decisions:
//  ① The debtor, not the engine, chooses what to mortgage and what to sell, and
//    only when that choice can save it (2026-10-23): a debt nothing could cover
//    is a bankruptcy straight away, since every choice ends the same way.
//  ② A player creditor takes lots exactly as they were, mortgaged or not, and
//    pays no mortgage interest on them.

// ── types ────────────────────────────────────────────────────────────────────

// The creditor id for a debt owed to the bank. A Discord user id is a numeric
// snowflake, so it can never collide with this word.
export const BANK_CREDITOR = "bank";

// The debtor is a seat OF the state being settled, so a debt can never name a
// player who is not seated; resolveDebt is where an id from outside is checked.
export interface MonopolyDebt {
	debtor: MonopolySeat;
	// A seat's user id, or BANK_CREDITOR.
	creditorId: string;
	amount: number;
	// The trail line for a debt paid in full. Each caller words its own (rent,
	// tax, a card), and a debt without one gets a plain payment line.
	paidLine?: string;
}

/** How one debt ended: paid in full, held for the debtor to raise cash, or a bankruptcy. */
export type DebtStatus = "paid" | "held" | "bankrupt";

// ── public action ───────────────────────────────────────────────────────────

/**
 * Charges `amount` to `debtorId`, paid to `creditorId` (a seated player or
 * BANK_CREDITOR), holding it or declaring bankruptcy as needed. The engine's own
 * charges go through settleDebts directly; this is the door for a caller outside
 * the engine, so it validates every input first.
 */
export function resolveDebt(
	state: MonopolyState,
	debtorId: string,
	creditorId: string,
	amount: number,
	now: number = Date.now()
): MonopolyResult {
	if (state.phase === "finished") return rejectAction("The match is already over.");
	if (state.pendingDebt) return rejectAction("The match is already waiting on a debt.");
	const debtor = findSeat(state, debtorId);
	if (!debtor || debtor.bankrupt) return rejectAction("That player is not playing in this match.");
	if (creditorId === debtorId) return rejectAction("A player cannot owe themselves.");
	if (creditorId !== BANK_CREDITOR) {
		const creditor = findSeat(state, creditorId);
		if (!creditor || creditor.bankrupt) return rejectAction("The creditor is not playing in this match.");
	}
	if (!Number.isInteger(amount) || amount < 1) return rejectAction("A debt is a whole number of chips above zero.");

	const next = cloneState(state);
	const lines = settleDebts(next, [{ debtor: next.seats[state.seats.indexOf(debtor)], creditorId, amount }], now);
	return completeAction(next, debtorId, lines);
}

// ── settling ────────────────────────────────────────────────────────────────

/** Settles one debt on `state` (a clone the caller owns) and says how it ended. */
export function settleDebt(state: MonopolyState, debt: MonopolyDebt, now: number): { status: DebtStatus; lines: string[] } {
	const lines = settleDebts(state, [debt], now);
	if (debt.debtor.bankrupt) return { status: "bankrupt", lines };
	return { status: state.pendingDebt ? "held" : "paid", lines };
}

/**
 * Settles a batch of debts that fall due together, mutating `state`, and
 * returns every trail line. Each pass picks one debt (see pickNextDebt), so the
 * loop ends after at most one pass per debt. A debtor who goes bankrupt is never
 * charged again: its remaining debts are written off, because it has nothing
 * left, which is the guard against chasing the same debtor round a chain twice.
 * A debt the debtor must raise cash for stops the batch: it and every debt not
 * yet settled go on the hold, and the phase becomes "awaiting-debt".
 */
export function settleDebts(state: MonopolyState, debts: readonly MonopolyDebt[], now: number): string[] {
	const pending = [...debts];
	const lines: string[] = [];
	while (pending.length > 0 && state.phase !== "finished") {
		const [debt] = pending.splice(pickNextDebt(pending), 1);
		if (debt.debtor.bankrupt) continue;
		if (mustRaiseCash(state, debt)) {
			lines.push(holdDebts(state, [debt, ...pending]));
			break;
		}
		lines.push(...settleOneDebt(state, debt, now));
	}
	return lines;
}

/**
 * The stored debts as debts on `state`'s own seats, in order, ready for
 * settleDebts. A debt whose debtor has left the match since it was held is
 * dropped, the same write off settleDebts gives a bankrupt debtor.
 */
export function debtsFromHold(state: MonopolyState, held: readonly PendingDebt[]): MonopolyDebt[] {
	const debts: MonopolyDebt[] = [];
	for (const { debtorId, creditorId, amount, paidLine } of held) {
		const debtor = findSeat(state, debtorId);
		if (debtor && !debtor.bankrupt) debts.push({ debtor, creditorId, amount, paidLine });
	}
	return debts;
}

// The order that lets a chain settle. ① A debt the debtor can pay from chips
// goes first, since paying it can only help someone else. ② Otherwise a debtor
// nobody in the batch owes, because waiting cannot help it, while a debtor who
// is owed may be rescued by what comes in. ③ A cycle of debtors who all owe each
// other has no better choice, so it takes the first.
function pickNextDebt(pending: readonly MonopolyDebt[]): number {
	const payable = pending.findIndex((debt) => debt.debtor.chips >= debt.amount);
	if (payable !== -1) return payable;
	const owedNothing = pending.findIndex((debt) => !pending.some((other) => other.creditorId === debt.debtor.userId));
	return owedNothing === -1 ? 0 : owedNothing;
}

// Short of chips, but able to cover the debt by mortgaging and selling: the case
// the debtor gets to choose for (ruling ①).
function mustRaiseCash(state: MonopolyState, debt: MonopolyDebt): boolean {
	const { debtor, amount } = debt;
	return debtor.chips < amount && debtor.chips + liquidationValue(state, debtor.userId) >= amount;
}

// Puts `debts` (the one that needs cash first) on the hold and pauses the turn
// where it stood, returning the line that tells the table who must act.
function holdDebts(state: MonopolyState, debts: readonly MonopolyDebt[]): string {
	const [first] = debts;
	state.pendingDebt = {
		debts: debts.map(({ debtor, creditorId, amount, paidLine }) => ({ debtorId: debtor.userId, creditorId, amount, ...(paidLine ? { paidLine } : {}) })),
		resumePhase: state.phase,
		moveAfter: null,
	};
	state.phase = "awaiting-debt";
	const payee = describeCreditor(findCreditorSeat(state, first.creditorId));
	return `${mentionPlayer(first.debtor.userId)} owes ${payee} $${first.amount} and has $${first.debtor.chips}, so they need to mortgage lots or sell buildings to raise the rest, then pay.`;
}

// A debt the chips cover, paid now, or one nothing could cover, a bankruptcy.
// settleDebts has already held every debt in between.
function settleOneDebt(state: MonopolyState, debt: MonopolyDebt, now: number): string[] {
	const { debtor } = debt;
	const creditor = findCreditorSeat(state, debt.creditorId);
	if (debtor.chips < debt.amount) return declareBankruptcy(state, debtor, creditor, debt.amount, now);
	debtor.chips -= debt.amount;
	if (creditor) creditor.chips += debt.amount;
	return [debt.paidLine ?? `${mentionPlayer(debtor.userId)} paid ${describeCreditor(creditor)} $${debt.amount}.`];
}

/**
 * The seat a debt is paid to, or undefined for the bank. A creditor who has left
 * the match cannot hold chips, so what it was owed goes to the bank instead.
 */
export function findCreditorSeat(state: MonopolyState, creditorId: string): MonopolySeat | undefined {
	if (creditorId === BANK_CREDITOR) return undefined;
	const creditor = findSeat(state, creditorId);
	return creditor && !creditor.bankrupt ? creditor : undefined;
}

const describeCreditor = (creditor: MonopolySeat | undefined): string => (creditor ? mentionPlayer(creditor.userId) : "the bank");

// ── what a seat could raise ─────────────────────────────────────────────────

const ownedLots = (state: MonopolyState, userId: string): OwnableTile[] =>
	OWNABLE_TILES.filter((tile) => state.properties[tile.id].ownerId === userId);

/**
 * Every chip the seat could raise from its lots: each building sold back (a hotel
 * counts as itself plus the four houses it replaced, since selling it down walks
 * all five rungs), then every unmortgaged lot mortgaged.
 */
export function liquidationValue(state: MonopolyState, userId: string): number {
	let value = 0;
	for (const tile of ownedLots(state, userId)) {
		const property = state.properties[tile.id];
		if (tile.kind === "property") value += buildingLevel(property) * buildingSaleValue(tile);
		if (!property.mortgaged) value += tile.mortgage;
	}
	return value;
}

// The tallest lot with buildings the seat owns (the first in board order on a
// tie), which keeps the even building rule in reverse while a bankruptcy sells
// everything down. Null once nothing is left standing.
function tallestBuiltLot(state: MonopolyState, seat: MonopolySeat): PropertyTile | null {
	let tallest: PropertyTile | null = null;
	for (const tile of ownedLots(state, seat.userId)) {
		if (tile.kind !== "property" || !hasBuildings(state.properties[tile.id])) continue;
		if (!tallest || buildingLevel(state.properties[tile.id]) > buildingLevel(state.properties[tallest.id])) tallest = tile;
	}
	return tallest;
}

// ── bankruptcy ──────────────────────────────────────────────────────────────

/**
 * The debtor cannot cover the debt. Owed to the bank, its holdings go back to
 * the bank (forfeitSeat). Owed to a player, its buildings are sold back first, as
 * the standard rules require, and the player takes every chip, every lot as it
 * stands and every Get Out of Jail Free card. Also how monopolyDebts ends a debt
 * its debtor never paid.
 */
export function declareBankruptcy(state: MonopolyState, debtor: MonopolySeat, creditor: MonopolySeat | undefined, amount: number, now: number): string[] {
	const player = mentionPlayer(debtor.userId);
	const lines = [`${player} cannot cover $${amount}, even by selling and mortgaging everything, and is bankrupt.`];
	return [...lines, ...handOverHoldings(state, debtor, creditor, now)];
}

/** Everything `debtor` holds goes to `creditor`, or to the bank when there is none, and the seat leaves the match. */
export function handOverHoldings(state: MonopolyState, debtor: MonopolySeat, creditor: MonopolySeat | undefined, now: number): string[] {
	if (!creditor) return forfeitSeat(state, debtor, now);

	// One rung per pass until none is left. The per rung lines are dropped for the
	// one summary line below, since every building goes either way.
	for (let lot = tallestBuiltLot(state, debtor); lot !== null; lot = tallestBuiltLot(state, debtor)) sellBuildingRung(state, debtor, lot);
	const player = mentionPlayer(debtor.userId);
	const lots = ownedLots(state, debtor.userId);
	for (const lot of lots) state.properties[lot.id].ownerId = creditor.userId;
	const chips = debtor.chips;
	const cards = debtor.gojfCards;
	creditor.chips += chips;
	creditor.gojfCards += cards;
	debtor.gojfCards = 0;
	const holdings = `$${chips}, ${countNoun(lots.length, "lot")} and ${countNoun(cards, "Get Out of Jail Free card")}`;
	return [`${mentionPlayer(creditor.userId)} takes ${holdings} from ${player}.`, ...removeFromMatch(state, debtor, now, `${player} is out of the match.`)];
}
