import {
	BOARD,
	BOARD_SIZE,
	COLOR_GROUPS,
	COMPLETE_GROUP_RENT_MULTIPLIER,
	DICE_SIDES,
	GO_SALARY,
	HOTEL_RENT_INDEX,
	JAIL_INDEX,
	JAIL_SENTENCE_TURNS,
	describeTile,
	isOwnableTile,
	type OwnableTile,
	type SpecialTile,
} from "./monopolyBoard.js";
import type { MonopolySeat, MonopolyState } from "./monopolyState.js";
import { forfeitSeat } from "./monopolyForfeit.js";
import { activeSeatOf, findSeat, mentionPlayer } from "./monopolySeats.js";
import { resolveVersus } from "./versusResolve.js";

// ── monopolyLanding ─────────────────────────────────────────────────────────
// What:  everything that happens between the dice and the end of a move: the
//        2d6 roll, moving a token round the board (and the GO salary), sending a
//        seat to jail, what the landing tile does, the rent a lot charges, and
//        settling a debt.
// Who:   applyRoll in monopolyState and the roll path of applyJailChoice. The
//        rent helper is also the one the Phase 4 board embed reads, so the rent
//        a player is shown and the rent they are charged cannot disagree (rule 17).
// When:  once per roll that moves a token.
// Where: split out of monopolyState (rule 18). Mutates only the clone its caller
//        hands it.
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

/**
 * The rent a lot charges right now, or 0 when it charges none. One helper for
 * the charge and the board embed alike. Transport and utility rent is Phase 2
 * and reads 0 until then.
 */
export function calculateRent(state: MonopolyState, tile: OwnableTile): number {
	const property = state.properties[tile.id];
	if (property.ownerId === null || property.mortgaged) return 0;
	if (tile.kind !== "property") return 0;
	if (property.hotel) return tile.rents[HOTEL_RENT_INDEX];
	if (property.houses > 0) return tile.rents[property.houses];

	const ownsWholeGroup = COLOR_GROUPS[tile.group].every((tileId) => state.properties[tileId].ownerId === property.ownerId);
	return ownsWholeGroup ? tile.rents[0] * COMPLETE_GROUP_RENT_MULTIPLIER : tile.rents[0];
}

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

// ── landing ─────────────────────────────────────────────────────────────────

function resolveLanding(state: MonopolyState, seat: MonopolySeat, now: number): string[] {
	const tile = BOARD[seat.position];
	const landed = `${mentionPlayer(seat.userId)} landed on ${describeTile(tile)}.`;
	const outcome = isOwnableTile(tile) ? resolveOwnableLanding(state, seat, tile, now) : resolveSpecialLanding(state, seat, tile, now);
	return [landed, ...outcome];
}

function resolveOwnableLanding(state: MonopolyState, seat: MonopolySeat, tile: OwnableTile, now: number): string[] {
	const ownerId = state.properties[tile.id].ownerId;
	if (ownerId === null) {
		state.phase = "awaiting-buy-or-skip";
		return [`${tile.name} is for sale for $${tile.price}.`];
	}
	if (ownerId === seat.userId) return [`${mentionPlayer(seat.userId)} already owns ${tile.name}.`];
	if (state.properties[tile.id].mortgaged) return [`${tile.name} is mortgaged, so no rent is due.`];

	const rent = calculateRent(state, tile);
	if (rent === 0) return [`No rent is charged on ${tile.name} yet.`];

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
		const debtLines = chargeSeat(state, seat, amount, null, now);
		if (debtLines.length > 0) return debtLines;
		return [`${mentionPlayer(seat.userId)} paid $${amount} in tax.`];
	}
	case "jail":
		return [`${mentionPlayer(seat.userId)} is just visiting.`];
	case "chance":
	case "chest":
		// The decks land in Phase 2; until then a card lane is a quiet tile.
		return ["The card decks are not in play yet, so nothing happens."];
	default:
		return ["Nothing happens here."];
	}
}
