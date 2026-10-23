import {
	BANK_HOTELS,
	BANK_HOUSES,
	BOARD,
	DOUBLES_TO_JAIL,
	GO_INDEX,
	MAX_SEATS,
	MIN_SEATS,
	OWNABLE_TILES,
	STARTING_CHIPS,
	describeTile,
	isOwnableTile,
	type TileId,
} from "./monopolyBoard.js";
import { jailActiveSeat, moveAndLand, rollDice } from "./monopolyLanding.js";
import {
	activeSeatOf,
	cloneState,
	completeAction,
	createBankProperty,
	guardActiveTurn,
	mentionPlayer,
	passTurn,
	rejectAction,
} from "./monopolySeats.js";

// ── monopolyState ───────────────────────────────────────────────────────────
// What:  the Dero Arcade Monopoly match as a pure state machine, and the public
//        door to it. The persisted types, the initial state, and the turn
//        actions: roll, buy, skip and end turn. Jail and forfeit live in their own
//        modules (rule 18 split) and are re-exported here, so callers import one
//        file.
// Who:   the Phase 4 room handlers (roomMonopolyHandlers), the idle sweep, and the
//        Vitest suite. Nothing here imports discord.js or touches the GameRoom row.
// When:  once per button press. Every apply function takes a state and returns a
//        NEW state plus the trail lines to post, or a readable refusal; the input
//        is never mutated, so a handler can persist the result or drop it.
// Where: the returned state is what GameRoom.secret stores verbatim. Everything a
//        match needs to resume after a Railway deploy is on it, and no module here
//        keeps a Map of live matches.
// How:   each action clones, mutates the clone through the small helpers in
//        monopolySeats and monopolyLanding, and finishes through completeAction,
//        which is the one place trail lines reach the log.
//
// Phase 1 scope (2026-10 item 241): color rent, taxes, jail, passing GO and
// forfeit. Cards, transport and utility rent, buildings and mortgages are Phase
// 2; auctions, trades and bankruptcy that pays a creditor everything are Phase 3.

// ── persisted types (master plan Section 5, plus winnerId) ──────────────────

export type { TileId, ColorGroup } from "./monopolyBoard.js";

// Card ids arrive with the decks in Phase 2; the decks are empty until then.
export type CardId = string;

export type MonopolyPhase = "pre-roll" | "post-roll" | "awaiting-buy-or-skip" | "in-auction" | "in-trade" | "finished";

export type JailChoice = "bail" | "card" | "roll";

export interface MonopolySettings {
	auctionsEnabled: boolean;
}

// One trail line and who caused it. The board embed shows the recent tail.
export interface MonopolyLogEntry {
	userId: string;
	text: string;
}

export interface MonopolyState {
	version: 1; // for future state migrations
	seats: MonopolySeat[]; // seat order = turn order
	activeSeatIndex: number; // who is on the clock
	diceRoll: [number, number] | null; // last roll, null before first roll
	doublesStreak: number; // 0, 1, 2; 3 sends to jail
	rolledThisTurn: boolean; // guards double-roll
	bank: {
		houses: number; // 32 at start
		hotels: number; // 12 at start
	};
	properties: Record<TileId, PropertyState>; // ownership + buildings + mortgage
	chanceDeck: CardId[];
	chestDeck: CardId[];
	chanceDiscard: CardId[];
	chestDiscard: CardId[];
	pendingTrade: TradeProposal | null; // one at a time
	pendingAuction: AuctionState | null; // one at a time
	phase: MonopolyPhase;
	settings: MonopolySettings;
	turnStartedAt: number; // ms epoch, for the idle sweep
	log: MonopolyLogEntry[]; // compact per-turn log for the embed
	boardMessageId: string | null; // for RoomProvisioner's board edit
	// Not in the plan's Section 5 block; added on the owner's ruling so a finished
	// match records who won without re-deriving it from the seats.
	winnerId: string | null;
}

export interface MonopolySeat {
	userId: string;
	position: number; // 0 to 39
	chips: number;
	inJail: boolean;
	jailTurnsRemaining: number; // 0 when not in jail; 3 when just entered
	gojfCards: number; // Get out of jail free; max 2 in deck
	bankrupt: boolean;
	bankruptedAt: number | null; // seat order of elimination, for XP
}

export interface PropertyState {
	ownerId: string | null; // null = bank
	houses: number; // 0 to 4
	hotel: boolean;
	mortgaged: boolean;
}

export interface TradeProposal {
	initiatorId: string;
	counterpartyId: string;
	offer: { properties: TileId[]; chips: number; gojf: number };
	request: { properties: TileId[]; chips: number; gojf: number };
	openedAt: number;
}

export interface AuctionState {
	tileId: TileId;
	bids: Record<string, number>; // userId -> last bid
	roundOpenedAt: number;
	skippedBy: string; // who passed on the buy
}

export type MonopolyResult = { ok: true; state: MonopolyState; trailLines: string[] } | { ok: false; reason: string };

export { applyJailChoice } from "./monopolyJail.js";
export { applyForfeit } from "./monopolyForfeit.js";
export { calculateRent } from "./monopolyLanding.js";

// ── initial state ───────────────────────────────────────────────────────────

/**
 * A fresh match: every seat on GO with the starting chips, every ownable tile
 * with the bank, the first seat on the clock. Throws on a seat list the room
 * layer should never have produced (wrong size or a repeated player), because
 * that is a caller bug, not a move a player can make.
 */
export function createInitialState(playerIds: string[], settings: MonopolySettings, now: number = Date.now()): MonopolyState {
	if (playerIds.length < MIN_SEATS || playerIds.length > MAX_SEATS) {
		throw new Error(`Monopoly needs ${MIN_SEATS} to ${MAX_SEATS} players, got ${playerIds.length}`);
	}
	if (new Set(playerIds).size !== playerIds.length) {
		throw new Error("Monopoly cannot seat the same player twice");
	}

	return {
		version: 1,
		seats: playerIds.map(createSeat),
		activeSeatIndex: 0,
		diceRoll: null,
		doublesStreak: 0,
		rolledThisTurn: false,
		bank: { houses: BANK_HOUSES, hotels: BANK_HOTELS },
		properties: Object.fromEntries(OWNABLE_TILES.map((tile) => [tile.id, createBankProperty()])),
		chanceDeck: [],
		chestDeck: [],
		chanceDiscard: [],
		chestDiscard: [],
		pendingTrade: null,
		pendingAuction: null,
		phase: "pre-roll",
		settings: { auctionsEnabled: settings.auctionsEnabled },
		turnStartedAt: now,
		log: [],
		boardMessageId: null,
		winnerId: null,
	};
}

function createSeat(userId: string): MonopolySeat {
	return {
		userId,
		position: GO_INDEX,
		chips: STARTING_CHIPS,
		inJail: false,
		jailTurnsRemaining: 0,
		gojfCards: 0,
		bankrupt: false,
		bankruptedAt: null,
	};
}

// ── roll ────────────────────────────────────────────────────────────────────

/**
 * The active seat rolls 2d6, moves, and the landing resolves. Doubles keep the
 * phase on pre-roll so the same seat rolls again, and the third doubles in one
 * turn goes to jail without moving, per the standard rules.
 */
export function applyRoll(state: MonopolyState, rng: () => number = Math.random, now: number = Date.now()): MonopolyResult {
	const turnRefusal = guardActiveTurn(state);
	if (turnRefusal) return rejectAction(turnRefusal);
	if (state.phase !== "pre-roll" || state.rolledThisTurn) return rejectAction("You cannot roll right now.");
	if (activeSeatOf(state).inJail) {
		return rejectAction("You are in Jail. Pay bail, use a card, or roll for doubles.");
	}

	const next = cloneState(state);
	const seat = activeSeatOf(next);
	const [firstDie, secondDie] = rollDice(rng);
	next.diceRoll = [firstDie, secondDie];
	const lines = [`${mentionPlayer(seat.userId)} rolled ${firstDie} and ${secondDie}.`];

	if (firstDie === secondDie) {
		next.doublesStreak += 1;
		if (next.doublesStreak >= DOUBLES_TO_JAIL) {
			jailActiveSeat(next);
			lines.push(`${mentionPlayer(seat.userId)} rolled doubles ${DOUBLES_TO_JAIL} times in a row and goes to Jail.`);
			return completeAction(next, seat.userId, lines);
		}
		// Doubles earn another roll, so the turn stays open. The landing below may
		// still move the phase on (a lot for sale, a trip to jail).
		next.rolledThisTurn = false;
		next.phase = "pre-roll";
	}
	else {
		next.rolledThisTurn = true;
		next.phase = "post-roll";
	}

	lines.push(...moveAndLand(next, seat, firstDie + secondDie, now));
	return completeAction(next, seat.userId, lines);
}

// ── buy and skip ────────────────────────────────────────────────────────────

/** The active seat buys the unowned tile it is standing on at list price. */
export function applyBuy(state: MonopolyState, buyerId: string, tileId: TileId): MonopolyResult {
	const turnRefusal = guardActiveTurn(state, buyerId);
	if (turnRefusal) return rejectAction(turnRefusal);
	if (state.phase !== "awaiting-buy-or-skip") return rejectAction("There is nothing to buy right now.");

	const tile = BOARD[activeSeatOf(state).position];
	// The tileId is checked against the seat's position because a stale button
	// from an earlier landing must not buy a tile the player is no longer on.
	if (!isOwnableTile(tile) || tile.id !== tileId) return rejectAction("You can only buy the tile you are standing on.");
	if (activeSeatOf(state).chips < tile.price) return rejectAction(`You need $${tile.price} to buy ${tile.name}.`);

	const next = cloneState(state);
	const seat = activeSeatOf(next);
	next.properties[tile.id].ownerId = seat.userId;
	seat.chips -= tile.price;
	next.phase = "post-roll";
	return completeAction(next, seat.userId, [`${mentionPlayer(seat.userId)} bought ${tile.name} for $${tile.price}.`]);
}

/**
 * The active seat passes on the tile for sale. The tile stays with the bank.
 * Auctions on a skip are Phase 3, and until then this holds even when the match
 * was opened with auctions enabled.
 */
export function applySkip(state: MonopolyState, skipperId: string): MonopolyResult {
	const turnRefusal = guardActiveTurn(state, skipperId);
	if (turnRefusal) return rejectAction(turnRefusal);
	if (state.phase !== "awaiting-buy-or-skip") return rejectAction("There is nothing to pass on right now.");

	const next = cloneState(state);
	const seat = activeSeatOf(next);
	next.phase = "post-roll";
	const tileName = describeTile(BOARD[seat.position]);
	return completeAction(next, seat.userId, [`${mentionPlayer(seat.userId)} passed on ${tileName}.`]);
}

// ── end turn ────────────────────────────────────────────────────────────────

/**
 * Closes the active seat's turn. A seat whose last roll was doubles goes again
 * instead; that only reaches here when the doubles landed on a lot for sale,
 * because any other doubles landing leaves the phase on pre-roll. A trip to jail
 * zeroes the streak (jailActiveSeat), which is what stops a jailed seat from
 * getting the extra turn.
 */
export function applyEndTurn(state: MonopolyState, now: number = Date.now()): MonopolyResult {
	const turnRefusal = guardActiveTurn(state);
	if (turnRefusal) return rejectAction(turnRefusal);
	if (state.phase !== "post-roll") return rejectAction("Finish your roll before ending the turn.");

	const next = cloneState(state);
	const seat = activeSeatOf(next);

	if (next.doublesStreak > 0) {
		next.rolledThisTurn = false;
		next.phase = "pre-roll";
		return completeAction(next, seat.userId, [`${mentionPlayer(seat.userId)} rolled doubles and rolls again.`]);
	}

	passTurn(next, now);
	const nextPlayer = activeSeatOf(next).userId;
	return completeAction(next, seat.userId, [`It is now ${mentionPlayer(nextPlayer)}'s turn.`]);
}
