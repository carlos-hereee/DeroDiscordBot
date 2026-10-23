import {
	BOARD,
	BOARD_SIZE,
	CARD_RAILROAD_RENT_MULTIPLIER,
	CARD_UTILITY_DICE_MULTIPLIER,
	COLOR_GROUPS,
	COMPLETE_GROUP_RENT_MULTIPLIER,
	DICE_SIDES,
	GO_SALARY,
	HOTEL_RENT_INDEX,
	JAIL_INDEX,
	JAIL_SENTENCE_TURNS,
	OWNABLE_TILES,
	RAILROAD_RENTS,
	UTILITY_DICE_MULTIPLIERS,
	boardIndicesOfKind,
	describeTile,
	isOwnableTile,
	type OwnableTile,
	type PropertyTile,
	type SpecialTile,
} from "./monopolyBoard.js";
import { drawCardFromState, type CardDeckKind, type MonopolyCard } from "./monopolyCards.js";
import type { MonopolySeat, MonopolyState } from "./monopolyState.js";
import { forfeitSeat } from "./monopolyForfeit.js";
import { activeSeatOf, findSeat, mentionPlayer, solventSeats } from "./monopolySeats.js";
import { resolveVersus } from "./versusResolve.js";

// ── monopolyLanding ─────────────────────────────────────────────────────────
// What:  everything that happens between the dice and the end of a move: the
//        2d6 roll, moving a token round the board (and the GO salary), sending a
//        seat to jail, what the landing tile does (including drawing and applying
//        a Chance or Community Chest card), the rent a lot charges, and settling
//        a debt.
// Who:   applyRoll in monopolyState and the roll path of applyJailChoice. The
//        rent helper is also the one the Phase 4 board embed reads, so the rent
//        a player is shown and the rent they are charged cannot disagree (rule 17).
// When:  once per roll that moves a token.
// Where: split out of monopolyState (rule 18). Mutates only the clone its caller
//        hands it. The decks and the draw live in monopolyCards; applying a card
//        lives here because most cards move a token or charge a debt.
// How:   moveAndLand moves, then resolveLanding switches on the tile kind. A debt
//        a seat cannot cover pays what it has and forfeits to the bank; Phase 3's
//        bankruptcy flow replaces that with mortgage first and creditor transfer.

/**
 * A 2d6 roll. It reuses resolveVersus's dice mode rather than a second random
 * helper (rule 17): the duel's two independent rolls are exactly two dice.
 */
export function rollDice(rng: () => number): [number, number] {
	const result = resolveVersus("dice", rng, DICE_SIDES);
	// resolveVersus("dice") always answers in dice mode; the narrowing is for the
	// compiler, and a coin here would mean the resolver itself broke.
	if (result.flip !== "dice") throw new Error("resolveVersus returned a coin result for a dice roll");
	return [result.challengerRoll, result.opponentRoll];
}

/** Moves the seat `steps` tiles forward and returns the trail lines for passing GO. */
export function moveSeat(seat: MonopolySeat, steps: number): string[] {
	const target = seat.position + steps;
	seat.position = target % BOARD_SIZE;
	// Landing exactly on GO counts as passing it, which is the standard rule.
	if (target < BOARD_SIZE) return [];
	seat.chips += GO_SALARY;
	return [`${mentionPlayer(seat.userId)} passed GO and collected $${GO_SALARY}.`];
}

/**
 * Sends the active seat to jail and closes its turn. The doubles streak is
 * zeroed because a jailed seat never gets the extra roll doubles would earn,
 * which is what applyEndTurn relies on.
 */
export function jailActiveSeat(state: MonopolyState): void {
	const seat = activeSeatOf(state);
	seat.position = JAIL_INDEX;
	seat.inJail = true;
	seat.jailTurnsRemaining = JAIL_SENTENCE_TURNS;
	state.doublesStreak = 0;
	state.rolledThisTurn = true;
	state.phase = "post-roll";
}

/** Moves the seat and resolves the tile it lands on, returning every trail line. */
export function moveAndLand(state: MonopolyState, seat: MonopolySeat, steps: number, now: number): string[] {
	return [...moveSeat(seat, steps), ...resolveLanding(state, seat, now)];
}

// ── rent ────────────────────────────────────────────────────────────────────

/**
 * The rent a lot charges right now, or 0 when it charges none. One helper for
 * the charge and the board embed alike. `boostedByCard` is the Chance card rent
 * for a seat sent to the nearest transport or utility.
 */
export function calculateRent(state: MonopolyState, tile: OwnableTile, boostedByCard: boolean = false): number {
	const property = state.properties[tile.id];
	if (property.ownerId === null || property.mortgaged) return 0;
	if (tile.kind === "railroad") return calculateRailroadRent(state, property.ownerId, boostedByCard);
	if (tile.kind === "utility") return calculateUtilityRent(state, property.ownerId, boostedByCard);
	return calculateColorRent(state, tile);
}

function calculateColorRent(state: MonopolyState, tile: PropertyTile): number {
	const property = state.properties[tile.id];
	if (property.hotel) return tile.rents[HOTEL_RENT_INDEX];
	if (property.houses > 0) return tile.rents[property.houses];

	const ownsWholeGroup = COLOR_GROUPS[tile.group].every((tileId) => state.properties[tileId].ownerId === property.ownerId);
	return ownsWholeGroup ? tile.rents[0] * COMPLETE_GROUP_RENT_MULTIPLIER : tile.rents[0];
}

// Mortgaged transports and utilities still count toward the owner's set, which
// is the standard rule: a mortgage stops the lot charging, not its siblings.
function countOwnedOfKind(state: MonopolyState, ownerId: string, kind: "railroad" | "utility"): number {
	return OWNABLE_TILES.filter((tile) => tile.kind === kind && state.properties[tile.id].ownerId === ownerId).length;
}

function calculateRailroadRent(state: MonopolyState, ownerId: string, boostedByCard: boolean): number {
	const rent = RAILROAD_RENTS[countOwnedOfKind(state, ownerId, "railroad") - 1];
	return boostedByCard ? rent * CARD_RAILROAD_RENT_MULTIPLIER : rent;
}

// The utility rent reads the roll that brought the seat here. The printed card
// says to throw the dice again; reusing the landing roll keeps a landing a pure
// function of one roll and has the same odds. Before any roll there is no total,
// so the embed reads 0.
function calculateUtilityRent(state: MonopolyState, ownerId: string, boostedByCard: boolean): number {
	const diceTotal = state.diceRoll ? state.diceRoll[0] + state.diceRoll[1] : 0;
	const multiplier = boostedByCard ? CARD_UTILITY_DICE_MULTIPLIER : UTILITY_DICE_MULTIPLIERS[countOwnedOfKind(state, ownerId, "utility") - 1];
	return multiplier * diceTotal;
}

// ── debts ───────────────────────────────────────────────────────────────────

/**
 * Takes `amount` from the seat, paying `creditorId` when one is named and the
 * bank otherwise. Returns no lines when the seat could pay. A seat that cannot
 * pays every chip it has and forfeits, and the returned lines say so.
 */
export function chargeSeat(state: MonopolyState, seat: MonopolySeat, amount: number, creditorId: string | null, now: number): string[] {
	const creditor = creditorId === null ? undefined : findSeat(state, creditorId);
	const paid = Math.min(seat.chips, amount);
	seat.chips -= paid;
	if (creditor) creditor.chips += paid;
	if (paid === amount) return [];

	return [`${mentionPlayer(seat.userId)} could cover only $${paid} of $${amount}.`, ...forfeitSeat(state, seat, now)];
}

// A bank debt with its own success line, shared by tax and the paying cards.
function payBank(state: MonopolyState, seat: MonopolySeat, amount: number, now: number, paidLine: string): string[] {
	const debtLines = chargeSeat(state, seat, amount, null, now);
	return debtLines.length > 0 ? debtLines : [paidLine];
}

// ── landing ─────────────────────────────────────────────────────────────────

function resolveLanding(state: MonopolyState, seat: MonopolySeat, now: number, boostedByCard: boolean = false): string[] {
	const tile = BOARD[seat.position];
	const landed = `${mentionPlayer(seat.userId)} landed on ${describeTile(tile)}.`;
	const outcome = isOwnableTile(tile)
		? resolveOwnableLanding(state, seat, tile, now, boostedByCard)
		: resolveSpecialLanding(state, seat, tile, now);
	return [landed, ...outcome];
}

function resolveOwnableLanding(state: MonopolyState, seat: MonopolySeat, tile: OwnableTile, now: number, boostedByCard: boolean): string[] {
	const ownerId = state.properties[tile.id].ownerId;
	if (ownerId === null) {
		state.phase = "awaiting-buy-or-skip";
		return [`${tile.name} is for sale for $${tile.price}.`];
	}
	if (ownerId === seat.userId) return [`${mentionPlayer(seat.userId)} already owns ${tile.name}.`];
	if (state.properties[tile.id].mortgaged) return [`${tile.name} is mortgaged, so no rent is due.`];

	// An owned, unmortgaged lot always charges something here: color rent is at
	// least its base, and a utility landing always has the roll that brought the
	// seat to it.
	const rent = calculateRent(state, tile, boostedByCard);
	const debtLines = chargeSeat(state, seat, rent, ownerId, now);
	if (debtLines.length > 0) return debtLines;
	return [`${mentionPlayer(seat.userId)} paid $${rent} rent to ${mentionPlayer(ownerId)}.`];
}

function resolveSpecialLanding(state: MonopolyState, seat: MonopolySeat, tile: SpecialTile, now: number): string[] {
	switch (tile.kind) {
	case "go-to-jail":
		jailActiveSeat(state);
		return [`${mentionPlayer(seat.userId)} goes straight to Jail.`];
	case "tax": {
		const amount = tile.amount ?? 0;
		return payBank(state, seat, amount, now, `${mentionPlayer(seat.userId)} paid $${amount} in tax.`);
	}
	case "jail":
		return [`${mentionPlayer(seat.userId)} is just visiting.`];
	case "chance":
	case "chest":
		return resolveCardLanding(state, seat, tile.kind, now);
	default:
		return ["Nothing happens here."];
	}
}

// ── cards ───────────────────────────────────────────────────────────────────

// Board positions of each kind, for the "advance to the nearest" cards.
const NEAREST_TARGETS: Record<"railroad" | "utility", number[]> = {
	railroad: boardIndicesOfKind("railroad"),
	utility: boardIndicesOfKind("utility"),
};

const stepsForwardTo = (from: number, destination: number): number => (destination - from + BOARD_SIZE) % BOARD_SIZE;

function resolveCardLanding(state: MonopolyState, seat: MonopolySeat, deckKind: CardDeckKind, now: number): string[] {
	const card = drawCardFromState(state, deckKind);
	return [`${mentionPlayer(seat.userId)} drew ${card.title}. ${card.flavor}`, ...applyCard(state, seat, card, now)];
}

/**
 * Applies a drawn card to the seat that drew it (always the active seat, since
 * only the active seat lands). A card that moves the token resolves the new
 * landing once. In the standard decks the only chain is Go Back Three from the
 * last Chance lane onto a Community Chest lane, which draws there as the rules
 * say; no Chest card moves onto a card lane, so a chain never goes deeper. The
 * card test suite pins that.
 */
function applyCard(state: MonopolyState, seat: MonopolySeat, card: MonopolyCard, now: number): string[] {
	const player = mentionPlayer(seat.userId);
	switch (card.kind) {
	case "collect":
		seat.chips += card.amount;
		return [`${player} collected $${card.amount} from the bank.`];
	case "pay":
		return payBank(state, seat, card.amount, now, `${player} paid $${card.amount} to the bank.`);
	case "collect-from-each":
		return collectFromEachRival(state, seat, card.amount, now);
	case "pay-each":
		return payEachRival(state, seat, card.amount, now);
	case "advance":
		return moveAndLand(state, seat, stepsForwardTo(seat.position, card.destination), now);
	case "advance-nearest":
		return advanceToNearest(state, seat, card.target, card.boostedRent, now);
	case "go-back":
		// Moving back never passes GO, so no salary: the position wraps directly.
		seat.position = (seat.position - card.steps + BOARD_SIZE) % BOARD_SIZE;
		return resolveLanding(state, seat, now);
	case "go-to-jail":
		jailActiveSeat(state);
		return [`${player} goes straight to Jail.`];
	case "get-out-of-jail":
		seat.gojfCards += 1;
		return [`${player} keeps the card until it is needed.`];
	case "repairs":
		return payForRepairs(state, seat, card.perHouse, card.perHotel, now);
	}
}

function advanceToNearest(state: MonopolyState, seat: MonopolySeat, target: "railroad" | "utility", boostedRent: boolean, now: number): string[] {
	const targets = NEAREST_TARGETS[target];
	// The first target past the seat, or round the corner to the first on the board.
	const destination = targets.find((index) => index > seat.position) ?? targets[0];
	return [...moveSeat(seat, stepsForwardTo(seat.position, destination)), ...resolveLanding(state, seat, now, boostedRent)];
}

// Each rival still in the match pays the drawer. A rival who cannot cover it
// pays what it has and forfeits, exactly like a short rent payment.
function collectFromEachRival(state: MonopolyState, seat: MonopolySeat, amount: number, now: number): string[] {
	const lines: string[] = [];
	for (const rival of solventSeats(state).filter((candidate) => candidate.userId !== seat.userId)) {
		const debtLines = chargeSeat(state, rival, amount, seat.userId, now);
		lines.push(...(debtLines.length > 0 ? debtLines : [`${mentionPlayer(rival.userId)} paid ${mentionPlayer(seat.userId)} $${amount}.`]));
	}
	return lines;
}

// The drawer pays each rival in seat order and stops at the first payment it
// cannot cover, because by then it has forfeited and has nothing left to pay.
function payEachRival(state: MonopolyState, seat: MonopolySeat, amount: number, now: number): string[] {
	const lines: string[] = [];
	for (const rival of solventSeats(state).filter((candidate) => candidate.userId !== seat.userId)) {
		const debtLines = chargeSeat(state, seat, amount, rival.userId, now);
		if (debtLines.length > 0) return [...lines, ...debtLines];
		lines.push(`${mentionPlayer(seat.userId)} paid ${mentionPlayer(rival.userId)} $${amount}.`);
	}
	return lines;
}

function payForRepairs(state: MonopolyState, seat: MonopolySeat, perHouse: number, perHotel: number, now: number): string[] {
	let houses = 0;
	let hotels = 0;
	for (const property of Object.values(state.properties)) {
		if (property.ownerId !== seat.userId) continue;
		houses += property.houses;
		if (property.hotel) hotels += 1;
	}
	const bill = houses * perHouse + hotels * perHotel;
	const player = mentionPlayer(seat.userId);
	if (bill === 0) return [`${player} owns no buildings, so there is nothing to repair.`];
	return payBank(state, seat, bill, now, `${player} paid $${bill} in repairs.`);
}
