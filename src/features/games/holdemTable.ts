import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { freshDeck, shuffle, evaluateHand, compareHands, type Card } from "./holdemHand.js";
import {
	postBlinds,
	nextStreet,
	applyAction,
	legalActions,
	type BettingAction,
	type BettingState,
	type Seat,
} from "./holdemBetting.js";
import { buildPots, awardPots, type PlayerCommitment } from "./holdemPots.js";

// ── holdemTable ─────────────────────────────────────────────────────────────
// What:  the tournament on top of the three pure modules. Seats, chips, the
//        button, dealing, street advancement, the showdown, blind escalation and
//        who busted in what order.
// Who:   the hold em room handlers, and nothing else.
// When:  once per action, and once per hand boundary.
// Where: PURE apart from an injectable rng. Everything a table needs to resume
//        lives in the returned object, which the room row stores verbatim, so a
//        Railway deploy mid-hand costs nothing.
// How:   the table's `seats` are the single source of truth for chips. A betting
//        round builds its own seat array from them and is written back at the end
//        of every action, so the two can never drift.
//
// ⚠️ CHIPS DIE WITH THE TABLE (A9, R22). Nothing here reads or writes a balance
// outside this object. A persistent stack is an economy, and an economy players
// can accumulate is a gambling moderation surface, which is why the plan's
// recommendation for open question Q7 was "never" and this is what never looks
// like in code: there is no store, no field, and nowhere to add one.

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";

export interface TableSeat {
	userId: string;
	username: string;
	stack: number;
	// Per-hand state, mirrored from the betting round after every action.
	committed: number;
	totalCommitted: number;
	folded: boolean;
	allIn: boolean;
	// Busted out of the TOURNAMENT. The seat stays in the array so finishing order
	// survives, which is what the placement bonus is paid from.
	out: boolean;
}

export interface HoldemTable {
	status: "joining" | "playing" | "finished";
	seats: TableSeat[];
	buttonIndex: number;
	handNumber: number;
	street: Street;
	deck: Card[];
	board: Card[];
	// ⚠️ NEVER RENDERED PUBLICLY. Reachable only through an ephemeral reply to the
	// owner's own click, exactly like battleship's private board (T16).
	holeCards: Record<string, Card[]>;
	betting: BettingState | null;
	smallBlind: number;
	bigBlind: number;
	// Epoch millis of the last action, for the turn clock.
	lastActionAt: number;
	boardMessageId: string | null;
	winnerId: string | null;
	// Busted players worst-first, so placement is derivable at the end.
	bustOrder: string[];
}

const seatOf = (table: HoldemTable, userId: string): TableSeat | undefined =>
	table.seats.find((seat) => seat.userId === userId);

// Players still in the TOURNAMENT (have chips or are in the current hand).
export const livePlayers = (table: HoldemTable): TableSeat[] => table.seats.filter((seat) => !seat.out);

// Players still in the CURRENT HAND.
export const inHand = (table: HoldemTable): TableSeat[] => livePlayers(table).filter((seat) => !seat.folded);

export function createTable(now = Date.now()): HoldemTable {
	return {
		status: "joining",
		seats: [],
		buttonIndex: 0,
		handNumber: 0,
		street: "preflop",
		deck: [],
		board: [],
		holeCards: {},
		betting: null,
		smallBlind: BOT_CONSTANTS.HOLDEM_SMALL_BLIND,
		bigBlind: BOT_CONSTANTS.HOLDEM_BIG_BLIND,
		lastActionAt: now,
		boardMessageId: null,
		winnerId: null,
		bustOrder: [],
	};
}

export type JoinResult = { ok: true } | { ok: false; reason: "alreadySeated" | "tableFull" | "started" };

// Buy in. Every player starts with the same stack, because the alternative is a
// buy-in amount, and a buy-in amount needs a balance to buy in FROM.
export function joinTable(table: HoldemTable, userId: string, username: string): JoinResult {
	if (table.status !== "joining") return { ok: false, reason: "started" };
	if (seatOf(table, userId)) return { ok: false, reason: "alreadySeated" };
	if (table.seats.length >= BOT_CONSTANTS.HOLDEM_MAX_SEATS) return { ok: false, reason: "tableFull" };

	table.seats.push({
		userId,
		username,
		stack: BOT_CONSTANTS.HOLDEM_STARTING_STACK,
		committed: 0,
		totalCommitted: 0,
		folded: false,
		allIn: false,
		out: false,
	});
	return { ok: true };
}

// ── dealing ───────────────────────────────────────────────────────────
// A fresh shuffled deck per hand. Not a continuing shoe: a deck that carried over
// would let a player who watched the previous hand narrow what is left, and the
// only reason to keep one is a performance saving that does not exist here.
export function dealHand(table: HoldemTable, rng: () => number = Math.random): void {
	const players = livePlayers(table);
	if (players.length < BOT_CONSTANTS.HOLDEM_MIN_SEATS) {
		finishTournament(table);
		return;
	}

	table.handNumber += 1;
	table.street = "preflop";
	table.board = [];
	table.holeCards = {};
	table.deck = shuffle(freshDeck(), rng);

	for (const seat of table.seats) {
		seat.committed = 0;
		seat.totalCommitted = 0;
		seat.folded = seat.out;
		seat.allIn = false;
	}

	// Two cards each, dealt one at a time around the table the way a real deal
	// goes. It changes nothing statistically against a shuffled deck; it is done
	// this way so a transcript of the deal reads like a deal.
	for (let round = 0; round < 2; round++) {
		for (const seat of players) {
			const card = table.deck.pop()!;
			table.holeCards[seat.userId] = [...(table.holeCards[seat.userId] ?? []), card];
		}
	}

	// Blinds escalate BEFORE the hand they apply to, so hand 7 is the first at the
	// higher level when the pace is 6.
	if (table.handNumber > 1 && (table.handNumber - 1) % BOT_CONSTANTS.HOLDEM_BLIND_ESCALATION_HANDS === 0) {
		table.smallBlind *= 2;
		table.bigBlind *= 2;
	}

	const order = seatOrderFrom(table, table.buttonIndex);
	// Heads up posts the small blind ON the button. With three or more it is the
	// seat after it. Getting this wrong is invisible until somebody counts.
	const smallBlindSeat = order.length === 2 ? 0 : 1;
	table.betting = postBlinds(toBettingSeats(order), smallBlindSeat, table.smallBlind, table.bigBlind);
	writeBack(table);
	table.lastActionAt = Date.now();
}

// The live seats in play order starting after the button.
function seatOrderFrom(table: HoldemTable, buttonIndex: number): TableSeat[] {
	const players = livePlayers(table);
	if (players.length === 0) return [];
	const start = buttonIndex % players.length;
	return [...players.slice(start), ...players.slice(0, start)];
}

const toBettingSeats = (seats: TableSeat[]): Seat[] =>
	seats.map((seat) => ({
		userId: seat.userId,
		stack: seat.stack,
		committed: seat.committed,
		totalCommitted: seat.totalCommitted,
		folded: seat.folded,
		allIn: seat.allIn,
	}));

// Copy the betting round's chip state back onto the table's seats, which are the
// single source of truth. Called after EVERY action so the two cannot drift.
function writeBack(table: HoldemTable): void {
	if (!table.betting) return;
	for (const bettingSeat of table.betting.seats) {
		const seat = seatOf(table, bettingSeat.userId);
		if (!seat) continue;
		seat.stack = bettingSeat.stack;
		seat.committed = bettingSeat.committed;
		seat.totalCommitted = bettingSeat.totalCommitted;
		seat.folded = bettingSeat.folded;
		seat.allIn = bettingSeat.allIn;
	}
}

export const whoActs = (table: HoldemTable): string | null =>
	table.betting && !table.betting.closed ? table.betting.seats[table.betting.toAct]?.userId ?? null : null;

export const actionsFor = (table: HoldemTable, userId: string) =>
	table.betting ? legalActions(table.betting, userId) : [];

export interface ActionOutcome {
	ok: boolean;
	reason?: string;
	// Set when the hand ended on this action.
	handOver?: boolean;
	// Set when the whole tournament ended on this action.
	tournamentOver?: boolean;
	// Human-readable line for the trail.
	narration?: string;
	// Payouts from the hand, when it ended.
	awards?: { userId: string; amount: number }[];
	// Who busted on this hand, worst first.
	busted?: string[];
	// Set at showdown, for the result card.
	showdown?: { userId: string; hand: string }[];
}

export function act(
	table: HoldemTable,
	userId: string,
	action: BettingAction,
	amount = 0,
	rng: () => number = Math.random
): ActionOutcome {
	if (table.status !== "playing" || !table.betting) return { ok: false, reason: "closed" };

	const result = applyAction(table.betting, userId, action, amount);
	if (!result.ok) return { ok: false, reason: result.reason };

	table.betting = result.state;
	writeBack(table);
	table.lastActionAt = Date.now();

	const narration = describeAction(table, userId, action, amount);

	// Everyone but one folded: the hand is over without a showdown, and no cards
	// are ever revealed. Showing them would teach the table how that player plays
	// for free, which is a real edge in a game of incomplete information.
	if (inHand(table).length <= 1) return { ...settleHand(table, false), narration };

	if (table.betting.closed) {
		const advanced = advanceStreet(table, rng);
		if (advanced.handOver) return { ...advanced, narration };
	}

	return { ok: true, narration };
}

function describeAction(table: HoldemTable, userId: string, action: BettingAction, amount: number): string {
	const seat = seatOf(table, userId);
	const name = `<@${userId}>`;
	switch (action) {
		case "fold":
			return `${name} folds.`;
		case "check":
			return `${name} checks.`;
		case "call":
			return `${name} calls.`;
		case "bet":
			return `${name} bets ${amount}.`;
		case "raise":
			return `${name} raises to ${amount}.`;
		case "allIn":
			return `${name} is all in for ${seat?.totalCommitted ?? 0}.`;
	}
}

// Burn nothing and turn the next cards. A burn card is tradition rather than a
// rule and buys nothing against a shuffled deck nobody can see.
function advanceStreet(table: HoldemTable, rng: () => number): ActionOutcome {
	const order = seatOrderFrom(table, table.buttonIndex);

	switch (table.street) {
		case "preflop":
			table.street = "flop";
			table.board.push(table.deck.pop()!, table.deck.pop()!, table.deck.pop()!);
			break;
		case "flop":
			table.street = "turn";
			table.board.push(table.deck.pop()!);
			break;
		case "turn":
			table.street = "river";
			table.board.push(table.deck.pop()!);
			break;
		case "river":
			return settleHand(table, true);
		default:
			return settleHand(table, true);
	}

	// ⚠️ BUILD THE SEAT LIST FIRST, THEN OPEN THE ROUND FROM IT. An earlier version
	// called nextStreet and then replaced `.seats`, which meant the round's `closed`
	// flag and its cleared per-street commitments were both computed from the OLD
	// list. The visible symptom was a hand that silently stalled on the flop with
	// nobody to act, which reads as a hung table rather than as a bug.
	const streetSeats = toBettingSeats(order.filter((seat) => !seat.folded && !seat.out)).map((seat) => ({
		...seat,
		// Per-street commitments reset; the hand total is what the pots read and
		// must survive.
		committed: 0,
	}));

	// Everyone still in is all in, so there is nothing left to decide. Deal the rest
	// of the board rather than asking a player with no chips to act.
	if (!streetSeats.some((seat) => !seat.folded && !seat.allIn)) return runOutAndSettle(table, rng);

	// Post-flop the first live player after the button acts, not the blinds.
	table.betting = nextStreet({ ...table.betting!, seats: streetSeats }, 0);
	const firstLive = table.betting.seats.findIndex((seat) => !seat.folded && !seat.allIn);
	table.betting.toAct = firstLive;
	writeBack(table);
	return { ok: true };
}

// Every remaining player is all in, so there is nothing left to decide. Deal the
// rest of the board and settle, rather than asking a player with no chips to act.
function runOutAndSettle(table: HoldemTable, rng: () => number): ActionOutcome {
	while (table.board.length < 5) table.board.push(table.deck.pop()!);
	table.street = "river";
	return settleHand(table, true, rng);
}

// ── the showdown ──────────────────────────────────────────────────────
function settleHand(table: HoldemTable, showdown: boolean, _rng: () => number = Math.random): ActionOutcome {
	const contenders = inHand(table);

	const commitments: PlayerCommitment[] = table.seats
		.filter((seat) => seat.totalCommitted > 0)
		.map((seat) => ({ userId: seat.userId, committed: seat.totalCommitted, folded: seat.folded }));

	const pots = buildPots(commitments);

	// Strength is only meaningful at a showdown. When everyone folded, the single
	// remaining player wins every pot they are eligible for regardless of cards.
	const strength = new Map<string, number>();
	const shown: { userId: string; hand: string }[] = [];

	if (showdown && contenders.length > 1) {
		const evaluated = contenders.map((seat) => ({
			userId: seat.userId,
			value: evaluateHand([...(table.holeCards[seat.userId] ?? []), ...table.board]),
		}));
		// Rank by comparing against every other hand: the count of hands this one
		// beats or ties is a total order that awardPots can use directly.
		for (const entry of evaluated) {
			const score = evaluated.filter((other) => compareHands(entry.value, other.value) >= 0).length;
			strength.set(entry.userId, score);
			shown.push({ userId: entry.userId, hand: `${entry.value.category}` });
		}
	} else {
		for (const seat of contenders) strength.set(seat.userId, 1);
	}

	const seatOrderIds = seatOrderFrom(table, table.buttonIndex).map((seat) => seat.userId);
	const awards = awardPots(pots, (userId) => strength.get(userId) ?? 0, seatOrderIds);
	for (const award of awards) {
		const seat = seatOf(table, award.userId);
		if (seat) seat.stack += award.amount;
	}

	// ⚠️ THE HAND'S COMMITMENTS ARE CLEARED HERE, NOT ONLY AT THE NEXT DEAL, and
	// the difference is not cosmetic. Between settlement and the next hand, `stack`
	// already holds the winnings; leaving `totalCommitted` standing means the same
	// chips are counted twice by anything that sums stack plus commitments, which is
	// how a table appears to double its chips every hand. `stack` is the sole truth
	// between hands.
	for (const seat of table.seats) {
		seat.committed = 0;
		seat.totalCommitted = 0;
	}

	// Bust anyone with nothing left, recording the order so placement is derivable.
	const busted: string[] = [];
	for (const seat of table.seats) {
		if (!seat.out && seat.stack <= 0) {
			seat.out = true;
			busted.push(seat.userId);
			table.bustOrder.push(seat.userId);
		}
	}

	table.street = "showdown";
	table.buttonIndex = (table.buttonIndex + 1) % Math.max(livePlayers(table).length, 1);

	const tournamentOver = livePlayers(table).length <= 1;
	if (tournamentOver) finishTournament(table);

	return {
		ok: true,
		handOver: true,
		tournamentOver,
		awards,
		busted,
		showdown: shown.length ? shown : undefined,
	};
}

function finishTournament(table: HoldemTable): void {
	table.status = "finished";
	table.winnerId = livePlayers(table)[0]?.userId ?? null;
	table.betting = null;
}

// ── the turn clock ────────────────────────────────────────────────────
// ⚠️ FORCE FOLD, NEVER PAUSE. Pausing hands one absent player the power to stall
// five present ones, which is the exact failure a turn clock exists to prevent.
// A player who is checked to and vanishes is folded, not waited for.
export function forceFold(table: HoldemTable, rng: () => number = Math.random): ActionOutcome & { userId?: string } {
	const userId = whoActs(table);
	if (!userId) return { ok: false, reason: "nobodyToAct" };

	// Fold if there is something to call, otherwise check: taking a player's chips
	// off them for being slow when checking was free would be a punishment the
	// rules never asked for.
	const legal = actionsFor(table, userId).map((entry) => entry.action);
	const action: BettingAction = legal.includes("check") ? "check" : "fold";
	const outcome = act(table, userId, action, 0, rng);
	return { ...outcome, userId };
}

// Finishing places, best first, for the placement bonus. The winner is first, then
// the bust order reversed: the last player to bust finished second.
export function placements(table: HoldemTable): string[] {
	const winner = table.winnerId ? [table.winnerId] : [];
	return [...winner, ...[...table.bustOrder].reverse()];
}
