import { MAX_HOUSES_PER_LOT, OWNABLE_TILES, type OwnableTile, type PropertyTile } from "./monopolyBoard.js";
import { buildingLevel, buildingSaleValue, groupHasBuildings, hasBuildings } from "./monopolyBuildings.js";
import { forfeitSeat, removeFromMatch } from "./monopolyForfeit.js";
import type { MonopolyResult, MonopolySeat, MonopolyState } from "./monopolyState.js";
import { cloneState, completeAction, countNoun, findSeat, mentionPlayer, rejectAction } from "./monopolySeats.js";

// ── monopolyBankruptcy ──────────────────────────────────────────────────────
// What:  paying a debt that the debtor's chips may not cover. A debtor first
//        raises cash by mortgaging and selling buildings back to the bank; one
//        who cannot cover the debt even then is bankrupt, and everything it holds
//        goes to the creditor (a player) or back to the bank.
// Who:   every charge in the engine: rent, tax and the paying cards in
//        monopolyLanding, forced bail in monopolyJail, and resolveDebt, the public
//        action re-exported from monopolyState for the room glue.
// When:  whenever a seat owes chips. A debt the chips cover is paid on the spot.
// Where: on top of monopolyForfeit, which owns taking a seat out of the match;
//        this module decides WHERE the holdings go before that happens.
// How:   settleDebts works a batch of simultaneous debts (one card can create
//        several) so money owed to a debtor reaches it before its own debt is
//        judged. That is the chain settlement case of 2026-10 item 241: A owes B
//        and B owes C, and B only survives on what A hands over.
//
// Two rulings ride on the standard rules here, both owner overridable:
//  ① Cash is raised only until the debt is covered, mortgages before buildings,
//    rather than mortgaging and selling everything the moment chips run short.
//    A seat owing $10 keeps its hotels.
//  ② A player creditor takes lots exactly as they were, mortgaged or not, and
//    pays no mortgage interest on them. The standard 10 percent fee, and the
//    choice to lift a mortgage straight away, are a prompt for the Phase 5 room
//    glue, not something the engine decides.

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

// ── public action ───────────────────────────────────────────────────────────

/**
 * Charges `amount` to `debtorId`, paid to `creditorId` (a seated player or
 * BANK_CREDITOR), raising cash or declaring bankruptcy as needed. The engine's
 * own charges go through settleDebts directly; this is the door for the room
 * glue, so it validates every input first.
 */
export function resolveDebt(
	state: MonopolyState,
	debtorId: string,
	creditorId: string,
	amount: number,
	now: number = Date.now()
): MonopolyResult {
	if (state.phase === "finished") return rejectAction("The match is already over.");
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

/**
 * Settles one debt on `state` (a clone the caller owns). The debtor survived,
 * and so paid in full, exactly when it is still in the match afterwards.
 */
export function settleDebt(state: MonopolyState, debt: MonopolyDebt, now: number): { paid: boolean; lines: string[] } {
	const lines = settleDebts(state, [debt], now);
	return { paid: !debt.debtor.bankrupt, lines };
}

/**
 * Settles a batch of debts that fall due together, mutating `state`, and
 * returns every trail line. Each pass picks one debt (see pickNextDebt), so the
 * loop ends after at most one pass per debt. A debtor who goes bankrupt is never
 * charged again: its remaining debts are written off, because it has nothing
 * left, which is the guard against chasing the same debtor round a chain twice.
 */
export function settleDebts(state: MonopolyState, debts: readonly MonopolyDebt[], now: number): string[] {
	const pending = [...debts];
	const lines: string[] = [];
	while (pending.length > 0 && state.phase !== "finished") {
		const [debt] = pending.splice(pickNextDebt(pending), 1);
		if (debt.debtor.bankrupt) continue;
		lines.push(...settleOneDebt(state, debt, now));
	}
	return lines;
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

function settleOneDebt(state: MonopolyState, debt: MonopolyDebt, now: number): string[] {
	const { debtor } = debt;
	const creditor = findCreditorSeat(state, debt.creditorId);
	const lines: string[] = [];
	if (debtor.chips < debt.amount) {
		if (debtor.chips + liquidationValue(state, debtor.userId) < debt.amount) {
			return declareBankruptcy(state, debtor, creditor, debt.amount, now);
		}
		lines.push(...raiseCash(state, debtor, debt.amount));
	}
	debtor.chips -= debt.amount;
	if (creditor) creditor.chips += debt.amount;
	lines.push(debt.paidLine ?? describePayment(debtor.userId, creditor, debt.amount));
	return lines;
}

// A creditor who left the match earlier in the same batch cannot hold chips, so
// what it was owed goes to the bank instead.
function findCreditorSeat(state: MonopolyState, creditorId: string): MonopolySeat | undefined {
	if (creditorId === BANK_CREDITOR) return undefined;
	const creditor = findSeat(state, creditorId);
	return creditor && !creditor.bankrupt ? creditor : undefined;
}

function describePayment(debtorId: string, creditor: MonopolySeat | undefined, amount: number): string {
	const payee = creditor ? mentionPlayer(creditor.userId) : "the bank";
	return `${mentionPlayer(debtorId)} paid ${payee} $${amount}.`;
}

// ── raising cash ────────────────────────────────────────────────────────────

const ownedLots = (state: MonopolyState, userId: string): OwnableTile[] =>
	OWNABLE_TILES.filter((tile) => state.properties[tile.id].ownerId === userId);

// Every chip the seat could raise from its lots: each building sold back (a
// hotel counts as itself plus the four houses it replaced, since selling it
// down walks all five rungs), then every unmortgaged lot mortgaged.
function liquidationValue(state: MonopolyState, userId: string): number {
	let value = 0;
	for (const tile of ownedLots(state, userId)) {
		const property = state.properties[tile.id];
		if (tile.kind === "property") value += buildingLevel(property) * buildingSaleValue(tile);
		if (!property.mortgaged) value += tile.mortgage;
	}
	return value;
}

/**
 * Raises cash one step at a time until the seat holds `target` chips. The
 * caller has checked liquidationValue covers it, so the loop always gets there.
 * A mortgage comes before any building sale, because a mortgage costs the seat
 * one lot's rent while a sale tears down rent it paid to build.
 */
function raiseCash(state: MonopolyState, seat: MonopolySeat, target: number): string[] {
	const lines: string[] = [];
	// A step is null once the seat is covered, or if a future rule change ever
	// lets liquidationValue promise more than the steps can raise. The loop then
	// stops instead of spinning, and the debt drives chips negative, which the
	// whole match fixtures' invariant check fails on.
	const nextStep = (): string | null => (seat.chips < target ? (mortgageNextLot(state, seat) ?? sellNextBuilding(state, seat)) : null);
	for (let step = nextStep(); step !== null; step = nextStep()) lines.push(step);
	return lines;
}

// The first unmortgaged lot, in board order, that the rules let the seat
// mortgage: one whose color group has no buildings.
function mortgageNextLot(state: MonopolyState, seat: MonopolySeat): string | null {
	const lot = ownedLots(state, seat.userId).find((tile) => !state.properties[tile.id].mortgaged && !groupHasBuildings(state, tile));
	if (!lot) return null;
	state.properties[lot.id].mortgaged = true;
	seat.chips += lot.mortgage;
	return `${mentionPlayer(seat.userId)} mortgaged ${lot.name} for $${lot.mortgage} to cover the debt.`;
}

/**
 * Sells one rung of buildings back to the bank. The lot sold from is the one
 * with the most buildings (the first in board order on a tie), which keeps the
 * even building rule in reverse: a lot only drops while it is the tallest in
 * its group.
 */
function sellNextBuilding(state: MonopolyState, seat: MonopolySeat): string | null {
	let tallest: PropertyTile | null = null;
	for (const tile of ownedLots(state, seat.userId)) {
		if (tile.kind !== "property" || !hasBuildings(state.properties[tile.id])) continue;
		if (!tallest || buildingLevel(state.properties[tile.id]) > buildingLevel(state.properties[tallest.id])) tallest = tile;
	}
	if (!tallest) return null;

	const property = state.properties[tallest.id];
	const player = mentionPlayer(seat.userId);
	const unitPrice = buildingSaleValue(tallest);
	if (!property.hotel) {
		property.houses -= 1;
		state.bank.houses += 1;
		seat.chips += unitPrice;
		return `${player} sold a house on ${tallest.name} back to the bank for $${unitPrice}.`;
	}
	state.bank.hotels += 1;
	property.hotel = false;
	// A hotel sells back for the four houses it replaced when the bank has them.
	// When it does not, the standard house shortage rule tears the lot down to
	// bare ground and pays for all five rungs at once.
	if (state.bank.houses >= MAX_HOUSES_PER_LOT) {
		state.bank.houses -= MAX_HOUSES_PER_LOT;
		property.houses = MAX_HOUSES_PER_LOT;
		seat.chips += unitPrice;
		return `${player} sold the hotel on ${tallest.name} back to the bank for $${unitPrice}.`;
	}
	const teardown = unitPrice * (MAX_HOUSES_PER_LOT + 1);
	seat.chips += teardown;
	return `${player} sold the hotel on ${tallest.name} and, with no houses left in the bank, every rung under it for $${teardown}.`;
}

// ── bankruptcy ──────────────────────────────────────────────────────────────

/**
 * The debtor cannot cover the debt even by raising cash. Owed to the bank, its
 * holdings go back to the bank (forfeitSeat). Owed to a player, its buildings
 * are sold back first, as the standard rules require, and the player takes
 * every chip, every lot as it stands and every Get Out of Jail Free card.
 */
function declareBankruptcy(state: MonopolyState, debtor: MonopolySeat, creditor: MonopolySeat | undefined, amount: number, now: number): string[] {
	const player = mentionPlayer(debtor.userId);
	const lines = [`${player} cannot cover $${amount}, even by selling and mortgaging everything, and is bankrupt.`];
	if (!creditor) return [...lines, ...forfeitSeat(state, debtor, now)];

	// One rung per call until none is left. The per rung lines are dropped for
	// the one summary line below, since every building goes either way.
	let sale = sellNextBuilding(state, debtor);
	while (sale !== null) sale = sellNextBuilding(state, debtor);
	const lots = ownedLots(state, debtor.userId);
	for (const lot of lots) state.properties[lot.id].ownerId = creditor.userId;
	const chips = debtor.chips;
	const cards = debtor.gojfCards;
	creditor.chips += chips;
	creditor.gojfCards += cards;
	debtor.gojfCards = 0;
	const holdings = `$${chips}, ${countNoun(lots.length, "lot")} and ${countNoun(cards, "Get Out of Jail Free card")}`;
	lines.push(`${mentionPlayer(creditor.userId)} takes ${holdings} from ${player}.`);
	return [...lines, ...removeFromMatch(state, debtor, now, `${player} is out of the match.`)];
}
