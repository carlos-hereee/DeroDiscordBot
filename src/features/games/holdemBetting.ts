// ── holdemBetting ───────────────────────────────────────────────────────────
// What:  the betting round state machine. Who acts next, what they may legally
//        do, what each action costs, and when the round is closed.
// Who:   the hold em table handler. It asks what is legal, renders those buttons,
//        and hands the chosen action straight back.
// When:  on every action, four times a hand (preflop, flop, turn, river).
// Where: PURE. Chips and seats in, a new state out. No Discord, no store, no rng.
// How:   one `applyAction` that validates and advances, plus `legalActions` that
//        answers the same question ahead of time so the UI cannot offer an illegal
//        button. Both read the same rules, so what is shown and what is accepted
//        cannot disagree.
//
// ⚠️ THE ROUND-CLOSING RULE IS THE PART THAT IS ALWAYS WRONG. "Everyone has acted"
// is NOT enough: after a raise, players who already acted must act again. The
// condition is that every player still in either matches the current bet or is all
// in, AND at least one full orbit has happened since the last raise. `actedSince`
// tracks exactly that and is reset by every raise, which is why it is not simply a
// boolean per player.

export type BettingAction = "fold" | "check" | "call" | "bet" | "raise" | "allIn";

export interface Seat {
	userId: string;
	// Chips in front of the player, not yet committed.
	stack: number;
	// Chips this player has put in during the CURRENT round.
	committed: number;
	// Total chips this player has put in across the whole hand, which is what the
	// pot builder needs.
	totalCommitted: number;
	folded: boolean;
	allIn: boolean;
}

export interface BettingState {
	seats: Seat[];
	// Index into `seats` of the player to act.
	toAct: number;
	// The highest `committed` at this table this round. Zero at the start of every
	// street after preflop.
	currentBet: number;
	// The size of the last bet or raise, which is the minimum a further raise must
	// add. Seeded with the big blind preflop, because a minimum raise is "at least
	// the last raise" and the blind counts as one.
	lastRaiseSize: number;
	// Player ids that have acted since the last aggressive action. Cleared by every
	// bet and raise, which is what makes a re-raised player act again.
	actedSince: string[];
	closed: boolean;
}

export interface LegalAction {
	action: BettingAction;
	// What it costs the actor, in chips, from their stack. Zero for a check or fold.
	cost: number;
	// For bet and raise only: the smallest and largest legal TOTAL commitment this
	// round, so the UI can offer presets without re-deriving the rules.
	min?: number;
	max?: number;
}

const active = (state: BettingState): Seat[] => state.seats.filter((seat) => !seat.folded);
const contesting = (state: BettingState): Seat[] => active(state).filter((seat) => !seat.allIn);

export function seatOf(state: BettingState, userId: string): Seat | undefined {
	return state.seats.find((seat) => seat.userId === userId);
}

/**
 * What the player to act may legally do.
 *
 * Returns an empty list when it is not their turn or the round is closed, so a
 * stale button press is refused by the same rules that drew the buttons.
 */
export function legalActions(state: BettingState, userId: string): LegalAction[] {
	if (state.closed) return [];
	const seat = state.seats[state.toAct];
	if (!seat || seat.userId !== userId || seat.folded || seat.allIn) return [];

	const toCall = state.currentBet - seat.committed;
	const actions: LegalAction[] = [{ action: "fold", cost: 0 }];

	if (toCall <= 0) {
		actions.push({ action: "check", cost: 0 });
	} else {
		// ⚠️ A CALL IS CAPPED BY THE STACK. A player with fewer chips than the bet
		// calls all in for what they have; charging them the full amount would take
		// chips they do not own and drive the stack negative.
		actions.push({ action: "call", cost: Math.min(toCall, seat.stack) });
	}

	const minTotal = state.currentBet + Math.max(state.lastRaiseSize, 1);
	const maxTotal = seat.committed + seat.stack;

	// A raise needs enough chips to make the MINIMUM legal one. Below that the only
	// aggressive move left is all in.
	if (maxTotal >= minTotal) {
		const label: BettingAction = state.currentBet === 0 ? "bet" : "raise";
		actions.push({ action: label, cost: minTotal - seat.committed, min: minTotal, max: maxTotal });
	}

	// ⚠️ ALL IN IS LEGAL WHENEVER THE PLAYER HAS CHIPS, and gating it on beating the
	// current bet is the bug that hides it exactly when it matters most. A short
	// stack facing a bet LARGER than everything they own cannot raise, cannot fold
	// profitably, and must be able to put the rest in: that is the all-in that
	// creates a side pot. Requiring `maxTotal > currentBet` silently leaves such a
	// player with only fold and a capped call, which is a different game.
	if (seat.stack > 0) {
		actions.push({ action: "allIn", cost: seat.stack, min: maxTotal, max: maxTotal });
	}

	return actions;
}

export interface ApplyResult {
	ok: boolean;
	state: BettingState;
	reason?: "notYourTurn" | "illegal" | "closed" | "belowMinimum" | "insufficient";
}

/**
 * Apply an action. `amount` is the TOTAL this player will have committed this
 * round, and is read only for bet and raise; every other action derives its own.
 */
export function applyAction(
	state: BettingState,
	userId: string,
	action: BettingAction,
	amount = 0
): ApplyResult {
	if (state.closed) return { ok: false, state, reason: "closed" };

	const seat = state.seats[state.toAct];
	if (!seat || seat.userId !== userId) return { ok: false, state, reason: "notYourTurn" };

	const legal = legalActions(state, userId);
	const match = legal.find((entry) => entry.action === action);
	if (!match) return { ok: false, state, reason: "illegal" };

	const next = clone(state);
	const actor = next.seats[next.toAct];

	switch (action) {
		case "fold":
			actor.folded = true;
			break;

		case "check":
			break;

		case "call": {
			const cost = Math.min(next.currentBet - actor.committed, actor.stack);
			commit(actor, cost);
			break;
		}

		case "bet":
		case "raise": {
			const total = Math.floor(amount);
			if (total < (match.min ?? 0)) return { ok: false, state, reason: "belowMinimum" };
			if (total > (match.max ?? 0)) return { ok: false, state, reason: "insufficient" };
			const raiseSize = total - next.currentBet;
			commit(actor, total - actor.committed);
			next.currentBet = total;
			next.lastRaiseSize = raiseSize;
			// Aggression reopens the round: everyone who already acted must act again.
			//
			// ⚠️ THIS LINE IS BELT AND BRACES, NOT THE PRIMARY GUARD, and a mutation
			// run on 2026-08-12 proved it: deleting it broke nothing, because a raise
			// by definition pushes `currentBet` above what everyone else has
			// committed, so `everyoneSquare` in `advance` already holds the round open
			// on its own. It is kept because the two conditions answer different
			// questions ("has everyone paid?" and "has everyone spoken?"), and a
			// future rule that lets a player match the bet without acting would need
			// it. Do not read the surviving mutation as proof the reset is wrong;
			// read it as proof that `everyoneSquare` is what is actually load bearing.
			//
			// The place `actedSince` genuinely IS the only guard is the big blind's
			// option: after `postBlinds` everyone can be square at the big blind with
			// nobody having acted, and only the empty `actedSince` keeps that round
			// open. `postBlinds` documents that, and a test pins it.
			next.actedSince = [];
			break;
		}

		case "allIn": {
			const total = actor.committed + actor.stack;
			commit(actor, actor.stack);
			if (total > next.currentBet) {
				// A short all in that does NOT reach a full raise still counts as
				// aggression for the pot, but a raise smaller than the minimum does not
				// reopen the betting for players who already called. Tracking that
				// properly needs the "incomplete raise" rule; v1 treats any all in over
				// the current bet as a raise, which is simpler and errs toward giving
				// players another chance to act rather than fewer.
				next.lastRaiseSize = Math.max(total - next.currentBet, next.lastRaiseSize);
				next.currentBet = total;
				next.actedSince = [];
			}
			break;
		}
	}

	if (!next.actedSince.includes(userId)) next.actedSince.push(userId);
	advance(next);
	return { ok: true, state: next };
}

function commit(seat: Seat, cost: number): void {
	const spend = Math.max(0, Math.min(cost, seat.stack));
	seat.stack -= spend;
	seat.committed += spend;
	seat.totalCommitted += spend;
	if (seat.stack === 0) seat.allIn = true;
}

function clone(state: BettingState): BettingState {
	return {
		...state,
		seats: state.seats.map((seat) => ({ ...seat })),
		actedSince: [...state.actedSince],
	};
}

// Move to the next player who can still act, and close the round when nobody can.
function advance(state: BettingState): void {
	// One player left unfolded wins the hand outright; the round is over regardless
	// of who has "acted".
	if (active(state).length <= 1) {
		state.closed = true;
		return;
	}

	const stillToAct = contesting(state);
	if (stillToAct.length === 0) {
		state.closed = true;
		return;
	}

	// ⚠️ THE CLOSING CONDITION, and the one that is always written wrong. Everyone
	// still contesting must have acted since the last aggression AND be square with
	// the current bet. Checking only the first lets a raise end a round; checking
	// only the second ends a round of checks after one player.
	const everyoneSquare = stillToAct.every((seat) => seat.committed === state.currentBet);
	const everyoneActed = stillToAct.every((seat) => state.actedSince.includes(seat.userId));
	if (everyoneSquare && everyoneActed) {
		state.closed = true;
		return;
	}

	// A single contesting player against one or more all-in opponents has nobody to
	// bet against once they are square: there is no more betting to do.
	if (stillToAct.length === 1 && stillToAct[0].committed >= state.currentBet && everyoneActed) {
		state.closed = true;
		return;
	}

	let index = state.toAct;
	for (let step = 0; step < state.seats.length; step++) {
		index = (index + 1) % state.seats.length;
		const candidate = state.seats[index];
		if (!candidate.folded && !candidate.allIn) {
			state.toAct = index;
			return;
		}
	}
	state.closed = true;
}

/**
 * Open a betting round.
 *
 * `firstToAct` is an index into `seats`. Preflop that is the player left of the
 * big blind; on every later street it is the first live player left of the button.
 */
export function openRound(seats: Seat[], firstToAct: number, currentBet = 0, lastRaiseSize = 0): BettingState {
	const state: BettingState = {
		seats: seats.map((seat) => ({ ...seat })),
		toAct: firstToAct,
		currentBet,
		lastRaiseSize,
		actedSince: [],
		closed: false,
	};
	// A round can be closed before anybody acts, when everyone is already all in.
	if (contesting(state).length === 0) state.closed = true;
	return state;
}

/**
 * Post the blinds and open the preflop round.
 *
 * ⚠️ A BLIND IS NOT AN ACTION. Posting it commits chips but does not count as
 * having acted, which is what gives the big blind their option to raise when the
 * table only calls. `actedSince` stays empty here on purpose.
 */
export function postBlinds(seats: Seat[], smallBlindIndex: number, smallBlind: number, bigBlind: number): BettingState {
	const next = seats.map((seat) => ({ ...seat }));
	const bigBlindIndex = (smallBlindIndex + 1) % next.length;

	commit(next[smallBlindIndex], Math.min(smallBlind, next[smallBlindIndex].stack));
	commit(next[bigBlindIndex], Math.min(bigBlind, next[bigBlindIndex].stack));

	const firstToAct = (bigBlindIndex + 1) % next.length;
	return openRound(next, firstToAct, bigBlind, bigBlind);
}

// Reset per-round commitments between streets. `totalCommitted` deliberately
// survives, because that is what the pot builder reads.
export function nextStreet(state: BettingState, firstToAct: number): BettingState {
	const seats = state.seats.map((seat) => ({ ...seat, committed: 0 }));
	return openRound(seats, firstToAct, 0, 0);
}
