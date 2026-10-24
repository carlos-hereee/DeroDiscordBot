import type { MonopolyMatchStats, MonopolyResult, MonopolySeat, MonopolyState, PropertyState } from "./monopolyState.js";

// ── monopolySeats ───────────────────────────────────────────────────────────
// What:  the small shared helpers every Monopoly action module leans on: cloning
//        a state, finding seats, refusing an action, recording trail lines and
//        passing the turn.
// Who:   monopolyState and every split action module beside it. Not a
//        public API; callers outside src/features/games go through monopolyState.
// When:  inside every apply function, on the clone it is about to return.
// Where: split out of monopolyState (rule 18) so the action modules can share
//        these without importing each other in a circle. It imports only TYPES
//        from monopolyState, which the compiler erases.
// How:   everything here except cloneState mutates the state it is handed, which
//        is always the caller's private clone, never the input state.

// How many trail lines the state keeps for the board embed. The full history is
// the room transcript; this is only the recent tail, so the persisted row stays
// small however long a match runs.
export const LOG_ENTRY_LIMIT = 12;

/** A deep copy, so an apply function can never mutate the state it was given. */
export const cloneState = (state: MonopolyState): MonopolyState => structuredClone(state);

export const activeSeatOf = (state: MonopolyState): MonopolySeat => state.seats[state.activeSeatIndex];

export const findSeat = (state: MonopolyState, userId: string): MonopolySeat | undefined =>
	state.seats.find((seat) => seat.userId === userId);

export const solventSeats = (state: MonopolyState): MonopolySeat[] => state.seats.filter((seat) => !seat.bankrupt);

// A Discord user mention. The engine has no usernames (the persisted seat has
// none), and a mention renders as the member's current name wherever it posts.
export const mentionPlayer = (userId: string): string => `<@${userId}>`;

/** "1 lot", "2 lots", "0 lots": a count and its noun for a trail line. */
export const countNoun = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The state of a lot nobody owns, at match start and when forfeit hands it back. */
export const createBankProperty = (): PropertyState => ({ ownerId: null, houses: 0, hotel: false, mortgaged: false });

export const rejectAction = (reason: string): MonopolyResult => ({ ok: false, reason });

/**
 * The refusal every turn action shares, or null when the action may proceed. A
 * finished match refuses everything; when an actor is named it must be the seat
 * on the clock. Actions without an actor (roll, end turn, jail) are checked for
 * the clicker by the room handler, which knows who pressed the button.
 */
export function guardActiveTurn(state: MonopolyState, actorId?: string): string | null {
	if (state.phase === "finished") return "The match is already over.";
	if (actorId !== undefined && actorId !== activeSeatOf(state).userId) return "It is not your turn.";
	return null;
}

/** The state's running match facts, created on first use (post-launch plan item 21). */
export function ensureStats(state: MonopolyState): MonopolyMatchStats {
	state.stats ??= { turnsTaken: 0, auctionsOpened: 0, forfeits: 0, lowestCashShare: {} };
	return state.stats;
}

// Each solvent seat's share of every chip at the table, kept at its lowest. Read after
// every action, which is what lets "came back from under a fifth of the cash" be
// judged at the end without a history of every balance.
function recordCashShares(state: MonopolyState): void {
	const solvent = solventSeats(state);
	const total = solvent.reduce((sum, seat) => sum + seat.chips, 0);
	if (total <= 0) return;
	const lowest = ensureStats(state).lowestCashShare;
	for (const seat of solvent) {
		const share = seat.chips / total;
		lowest[seat.userId] = Math.min(lowest[seat.userId] ?? share, share);
	}
}

/** Bumps the state's revision, records the trail lines on its log, and wraps them as a successful result. */
export function completeAction(state: MonopolyState, actorId: string, trailLines: string[]): MonopolyResult {
	state.revision += 1;
	recordCashShares(state);
	state.log.push(...trailLines.map((text) => ({ userId: actorId, text })));
	state.log = state.log.slice(-LOG_ENTRY_LIMIT);
	return { ok: true, state, trailLines };
}

/**
 * Hands the clock to the next seat still in the match, skipping bankrupt seats,
 * and resets the per turn fields. Only called while two or more seats remain,
 * so the loop always finds one.
 */
export function passTurn(state: MonopolyState, now: number): void {
	for (let step = 1; step <= state.seats.length; step++) {
		const index = (state.activeSeatIndex + step) % state.seats.length;
		if (!state.seats[index].bankrupt) {
			state.activeSeatIndex = index;
			break;
		}
	}
	state.rolledThisTurn = false;
	state.doublesStreak = 0;
	state.phase = "pre-roll";
	state.turnStartedAt = now;
	ensureStats(state).turnsTaken += 1;
}
