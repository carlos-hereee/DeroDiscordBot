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
import { buildPots, awardPots, uncalledPortion, type PlayerCommitment } from "./holdemPots.js";

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
// ⚠️ NOTHING HERE READS OR WRITES A BALANCE outside this object, at any table. A table
// opened where the server has chips on carries `chips` (2026-10 item 250 Phase 5, the
// owner's reversal of A9 and R22, which had chips die with every table): its buy in came
// out of each player's wallet and its stacks go back when they leave or it ends, and
// game-rooms/holdemChips.ts moves those chips. A table without `chips` is free play, and
// its chips still die with it. Either way the engine only keeps the stacks.

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
	// The seat's last decision this hand, for the live table card. Cleared at every
	// deal. Absent on a row stored before it existed, which reads as no action yet.
	lastAction?: SeatLastAction | null;
	// Turn clock timeouts in a row. Any decision the player makes starts it over, and
	// reaching HOLDEM_SIT_OUT_TIMEOUTS sits the seat out. Absent reads as none.
	timeoutsInRow?: number;
	// Sitting out: still dealt in and still posting blinds, but folded whenever the
	// action reaches it, until the player presses I'm back. Absent reads as false.
	sittingOut?: boolean;
}

/** A seat's last decision this hand, as the live table card words it. */
export interface SeatLastAction {
	action: BettingAction;
	/** The total a bet or raise made, or what an all in put in this hand; 0 for the rest. */
	amount: number;
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
	// When the board first showed the table in the state stamped `stamp` (a
	// lastActionAt). The turn clock and the next hand's delay count from `shownAt`
	// while the stamp still matches (clockStartOf), so the trail lines and the render
	// ahead of a prompt never eat a player's time. Written by the room's redraw and
	// carried over by returnToTable; absent until a board has shown the table.
	turnPrompt?: { stamp: number; shownAt: number };
	boardMessageId: string | null;
	// What the table message currently on the board showed of the hand: the hand number, how
	// many board cards, and whether a hand was live (roomHoldemHandlers.revealKeyOf). A redraw
	// whose key differs posts a FRESH table message instead of editing (2026-10 item 257 Phase
	// 4a). Written only in the same claim that moves boardMessageId. Absent reads as the joining
	// table, which every table starts as.
	revealKey?: string;
	// The street on the board's lines so far, which the table message's This turn block shows
	// (2026-10 item 263 R3-29). Display only, never read by the rules here: the room stamps it
	// into the same compare and swap as the move whose lines it adds, so two moves cannot lose
	// each other's lines. Absent on a table from before the block, read as no lines.
	turnLog?: string[];
	winnerId: string | null;
	// Busted players worst-first, so placement is derivable at the end.
	bustOrder: string[];
	// Host defined terms (a table Dero opened on request). ABSENT on every table made
	// without terms, including every row stored before terms existed, which is why
	// both are optional and every reader goes through startingStackOf and seatCapOf.
	startingStack?: number;
	maxSeats?: number;
	// Present when the table plays for the members' wallet chips (2026-10 item 250 Phase
	// 5), which holdemChips pays back into each member's global wallet. Absent on a free
	// play table and on every row stored before chips existed.
	chips?: TableChips;
	// The stacks of seats that left a chip table once play began (2026-10 item 276, owner
	// decisions D3 and D12): a ranked leaver forfeits their chips into the winner's prize, so
	// they stay with the table, outside every seat, until holdemChips pays them at the end.
	forfeitedChips?: number;
	// Late joiners who claimed a free seat while the host had seats open (2026-10 item
	// 244 Phase 4), waiting for the next deal. ⚠️ NOT SEATS. Nothing that reads the
	// hand, the pots, the blinds, the button or the bust order looks here, and the
	// only code that turns one into a seat is seatLatePlayers at the top of dealHand,
	// before the next hand exists. Absent on every table stored before it existed.
	pendingSeats?: PendingSeat[];
	// Who posted the big blind on the hand dealt last, written by dealHand. Read once, when a
	// hand ends with two players left, so the button can be set so nobody posts the big blind
	// twice in a row (2026-10 item 280). Absent on a row stored before it existed, which
	// passes the button the ordinary way.
	bigBlindUserId?: string;
}

/**
 * The mark of a chip table: the server it was opened in, kept for the logs. The buy ins
 * come from, and are paid back to, each member's one global wallet (2026-10 item 267).
 */
export interface TableChips {
	guildId: string;
}

/** A late joiner holding a seat for the next deal, with the name its seat will carry. */
export interface PendingSeat {
	userId: string;
	username: string;
}

/**
 * The rules a table can be opened with. Validated by the caller (dero-brain's
 * resolveTerms); the table only stores them. The blinds are the STARTING blinds:
 * escalation doubles them on the usual schedule, exactly as it doubles the standard
 * ones.
 */
export interface HoldemTerms {
	startingStack: number;
	maxSeats: number;
	smallBlind: number;
	bigBlind: number;
}

const seatOf = (table: HoldemTable, userId: string): TableSeat | undefined =>
	table.seats.find((seat) => seat.userId === userId);

// Players still in the TOURNAMENT (have chips or are in the current hand).
export const livePlayers = (table: HoldemTable): TableSeat[] => table.seats.filter((seat) => !seat.out);

// Players still in the CURRENT HAND.
export const inHand = (table: HoldemTable): TableSeat[] => livePlayers(table).filter((seat) => !seat.folded);

// The stack every buy in gets and the most seats the table takes. A table without
// terms reads the standard constants, and the cap is clamped to HOLDEM_MAX_SEATS
// whatever is stored, because the board's rows and embed are laid out for six.
export const startingStackOf = (table: HoldemTable): number => table.startingStack ?? BOT_CONSTANTS.HOLDEM_STARTING_STACK;

export const seatCapOf = (table: HoldemTable): number =>
	Math.min(table.maxSeats ?? BOT_CONSTANTS.HOLDEM_MAX_SEATS, BOT_CONSTANTS.HOLDEM_MAX_SEATS);

/**
 * A fresh joining table. Without terms it is exactly the standard table; with terms
 * it also carries the stack and seat cap, and opens at the given blinds. The terms
 * keys are only ADDED when terms are passed, so a standard table stays the same
 * object, key for key, as it was before terms existed.
 */
export function createTable(now = Date.now(), terms?: HoldemTerms): HoldemTable {
	const table = createStandardTable(now);
	if (!terms) return table;
	table.startingStack = terms.startingStack;
	table.maxSeats = terms.maxSeats;
	table.smallBlind = terms.smallBlind;
	table.bigBlind = terms.bigBlind;
	return table;
}

function createStandardTable(now: number): HoldemTable {
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

// Buy in. Every player starts with the same stack, the table's one buy in: at a chip
// table the host sets it before anybody sits (setBuyIn) and every player pays it, by the
// owner's choice of equal stacks over a buy in each player picks (2026-10 item 250 Phase 5).
export function joinTable(table: HoldemTable, userId: string, username: string): JoinResult {
	if (table.status !== "joining") return { ok: false, reason: "started" };
	if (seatOf(table, userId)) return { ok: false, reason: "alreadySeated" };
	if (table.seats.length >= seatCapOf(table)) return { ok: false, reason: "tableFull" };

	table.seats.push(freshSeat(userId, username, startingStackOf(table)));
	return { ok: true };
}

export type SetBuyInResult = { ok: true } | { ok: false; reason: "notJoining" | "seated" };

/**
 * The host's one buy in for the table, the starting stack every seat gets. Only while
 * the table is joining and nobody has sat down, so no player ever paid an amount the
 * table no longer deals. The amount is validated by the caller (holdemChips' bounds).
 */
export function setBuyIn(table: HoldemTable, amount: number): SetBuyInResult {
	if (table.status !== "joining") return { ok: false, reason: "notJoining" };
	if (table.seats.length > 0) return { ok: false, reason: "seated" };
	table.startingStack = amount;
	return { ok: true };
}

// A seat as it is before its first hand. Shared by the buy in and the late seat, so a
// player who sat down mid tournament starts from exactly the seat a first buyer gets.
function freshSeat(userId: string, username: string, stack: number): TableSeat {
	return { userId, username, stack, committed: 0, totalCommitted: 0, folded: false, allIn: false, out: false };
}

// ── late seats (2026-10 item 244 Phase 4) ─────────────────────────────
export type LateSeatResult = { ok: true } | { ok: false; reason: "notPlaying" | "alreadySeated" | "alreadyWaiting" | "tableFull" };

/**
 * Claim a free seat at a tournament already under way, the Take a seat button's
 * engine half. The seat waits in `pendingSeats` and is dealt in at the start of the
 * next hand with the table's starting stack (seatLatePlayers); this never touches a
 * seat, a hand or a pot.
 *
 * A player who already has a seat entry is refused even when it is `out`: that entry
 * is what their bust order place hangs on, and a second entry for one player would
 * leave seatOf finding the dead one. Coming back after busting would be a rebuy,
 * which a tournament does not have. A free seat counts the players still in plus
 * those already waiting, against the table's seat cap.
 *
 * Moves the action stamp, which is the table's compare and swap version, so a move
 * that read the table before this claim loses its write instead of writing the
 * waiting list away; the turn clock is carried over (restampKeepingClock), so the
 * player on the clock keeps the time they had.
 */
export function requestLateSeat(table: HoldemTable, userId: string, username: string, now: number = Date.now()): LateSeatResult {
	if (table.status !== "playing") return { ok: false, reason: "notPlaying" };
	if (seatOf(table, userId)) return { ok: false, reason: "alreadySeated" };
	const waiting = table.pendingSeats ?? [];
	if (waiting.some((entry) => entry.userId === userId)) return { ok: false, reason: "alreadyWaiting" };
	if (!hasLateSeatFree(table)) return { ok: false, reason: "tableFull" };

	table.pendingSeats = [...waiting, { userId, username }];
	restampKeepingClock(table, now);
	return { ok: true };
}

/** True while a late joiner could still claim a seat: the players still in plus those waiting are under the seat cap. */
export function hasLateSeatFree(table: HoldemTable): boolean {
	return livePlayers(table).length + (table.pendingSeats ?? []).length < seatCapOf(table);
}

/** Drop a waiting late seat, the host removing its player. Answers whether one was waiting. */
export function withdrawLateSeat(table: HoldemTable, userId: string, now: number = Date.now()): boolean {
	const waiting = table.pendingSeats ?? [];
	if (!waiting.some((entry) => entry.userId === userId)) return false;
	table.pendingSeats = waiting.filter((entry) => entry.userId !== userId);
	restampKeepingClock(table, now);
	return true;
}

// ⚠️ THE ONE PLACE A SEAT JOINS A RUNNING TOURNAMENT, and dealHand calls it first,
// while no hand exists: the last hand has settled (its commitments are zeroed, its
// busts recorded and the button passed), and the next has not been dealt. So the new
// seat is in livePlayers before the deal, the blinds, the betting round and the pots
// are built, and it is an ordinary seat for every one of them. It is appended to the
// END of the seat array, which leaves every existing seat at its live index, so the
// button (an index into the live seats) stays on the seat it was passed to. The
// handInProgress guard is the backstop: a hand still live is never touched, and the
// late seat waits for the next deal instead.
function seatLatePlayers(table: HoldemTable): string[] {
	const waiting = table.pendingSeats ?? [];
	if (waiting.length === 0 || handInProgress(table)) return [];

	const seated: string[] = [];
	const stillWaiting: PendingSeat[] = [];
	for (const entry of waiting) {
		if (seatOf(table, entry.userId)) continue;
		// Cannot happen while requestLateSeat holds the cap, since busts only free seats;
		// a seat that would not fit waits for the next deal rather than vanishing.
		if (livePlayers(table).length >= seatCapOf(table)) {
			stillWaiting.push(entry);
			continue;
		}
		table.seats.push(freshSeat(entry.userId, entry.username, startingStackOf(table)));
		seated.push(entry.userId);
	}
	table.pendingSeats = stillWaiting;
	return seated;
}

// Move the action stamp without restarting the clock on whoever is to act. The
// stamp is the table's compare and swap version, so moving it makes a write racing
// on the old one lose; the turn prompt is carried over to the new stamp, so the
// player on the clock keeps the time they had rather than a fresh clock because
// somebody else changed something off their seat.
function restampKeepingClock(table: HoldemTable, now: number): void {
	table.turnPrompt = { stamp: now, shownAt: clockStartOf(table) };
	table.lastActionAt = now;
}

// ── dealing ───────────────────────────────────────────────────────────
// A fresh shuffled deck per hand. Not a continuing shoe: a deck that carried over
// would let a player who watched the previous hand narrow what is left, and the
// only reason to keep one is a performance saving that does not exist here.
//
// Answers what the deal set off: a seat sitting out that the action reaches at once
// is folded right away (see foldSeatsSittingOut), and that can end the hand.
export function dealHand(table: HoldemTable, rng: () => number = Math.random): ActionOutcome {
	// Before ANYTHING about the new hand is read, so a late seat is part of the whole
	// of it: see seatLatePlayers for why this is the only safe moment.
	const lateSeated = seatLatePlayers(table);
	const players = livePlayers(table);
	if (players.length < BOT_CONSTANTS.HOLDEM_MIN_SEATS) {
		finishTournament(table);
		return { ok: false, reason: "tooFewPlayers" };
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
		seat.lastAction = null;
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
	table.bigBlindUserId = order[(smallBlindSeat + 1) % order.length]?.userId;
	table.betting = postBlinds(toBettingSeats(order), smallBlindSeat, table.smallBlind, table.bigBlind);
	writeBack(table);
	table.lastActionAt = Date.now();
	// ⚠️ THE BLINDS CAN END THE BETTING BEFORE ANYBODY ACTS (2026-10 item 280): every
	// player all in on a blind, or one player with chips whose blind already covers every
	// all in opponent. Nobody has a decision, so nothing would ever call advanceStreet and
	// the table would wait forever on a turn nobody holds; run the board out here instead.
	if (table.betting.closed) {
		const settled = runOutAndSettle(table, rng);
		return lateSeated.length > 0 ? { ...settled, lateSeated } : settled;
	}
	// Attached AFTER the sit out folds, whose merge rebuilds the outcome from each fold
	// and would otherwise drop the late seats a deal made.
	const outcome = foldSeatsSittingOut(table, rng, { ok: true });
	return lateSeated.length > 0 ? { ...outcome, lateSeated } : outcome;
}

// The live seats in play order starting AT the button. Dealing and the blinds are
// both defined from the button itself, so this is the order they read.
function seatOrderFrom(table: HoldemTable, buttonIndex: number): TableSeat[] {
	const players = livePlayers(table);
	if (players.length === 0) return [];
	const start = buttonIndex % players.length;
	return [...players.slice(start), ...players.slice(0, start)];
}

// The same ring rotated one seat, so it starts LEFT of the button. Two rules read
// this rather than the button-first order: post-flop action, and the odd chip in a
// split pot, which holdemPots defines as "the earliest eligible player in seatOrder,
// which is the house rule closest to first left of the button". Passing the
// button-first order to either one silently hands the button an advantage it is not
// entitled to.
function seatOrderAfterButton(table: HoldemTable): TableSeat[] {
	const order = seatOrderFrom(table, table.buttonIndex);
	return order.length <= 1 ? order : [...order.slice(1), order[0]];
}

// A hand is live from the deal until settleHand stamps the showdown street. Between
// hands the table is still "playing" with nothing to act on, which is the state the
// host is offered the next deal in and the state a second deal must be refused in.
export const handInProgress = (table: HoldemTable): boolean =>
	table.status === "playing" && table.street !== "showdown";

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
	// Chips handed straight back because nobody ever called them. NOT a win, and
	// reported separately so the transcript does not claim somebody won chips they
	// were never at risk of losing.
	returned?: { userId: string; amount: number };
	// Who busted on this hand, worst first.
	busted?: string[];
	// Set at showdown, for the result card.
	showdown?: { userId: string; hand: string }[];
	// Seats folded because they sit out, in the order the action reached them. NOT in
	// `narration`: the room posts its own line for each.
	sittingOutFolds?: string[];
	// Set on a deal that seated late joiners, in the order they sat down, so the room
	// can name them and give them the playersOnly gate in the deal's own write.
	lateSeated?: string[];
}

/**
 * A player's own decision: apply it, then fold any seat sitting out that the action
 * reaches next. A decision made by the player starts their run of timeouts over;
 * forceFold puts the run back for the one decision the clock made for them.
 */
export function act(
	table: HoldemTable,
	userId: string,
	action: BettingAction,
	amount = 0,
	rng: () => number = Math.random
): ActionOutcome {
	const outcome = resolveAction(table, userId, action, amount, rng);
	if (!outcome.ok) return outcome;
	const seat = seatOf(table, userId);
	if (seat) seat.timeoutsInRow = 0;
	return foldSeatsSittingOut(table, rng, outcome);
}

// One action through the betting round and whatever it ends: the street, or the
// hand. Every action goes through here, a player's, the clock's and a sit out fold.
function resolveAction(table: HoldemTable, userId: string, action: BettingAction, amount: number, rng: () => number): ActionOutcome {
	if (table.status !== "playing" || !table.betting) return { ok: false, reason: "closed" };

	const result = applyAction(table.betting, userId, action, amount);
	if (!result.ok) return { ok: false, reason: result.reason };

	table.betting = result.state;
	writeBack(table);
	table.lastActionAt = Date.now();
	recordLastAction(table, userId, action, amount);

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

// Read after writeBack and before any settle, which zeroes the hand's commitments,
// so an all in records what it put in, the same figure describeAction names.
function recordLastAction(table: HoldemTable, userId: string, action: BettingAction, amount: number): void {
	const seat = seatOf(table, userId);
	if (!seat) return;
	seat.lastAction = { action, amount: lastActionAmount(seat, action, amount) };
}

function lastActionAmount(seat: TableSeat, action: BettingAction, amount: number): number {
	if (action === "allIn") return seat.totalCommitted;
	if (action === "bet" || action === "raise") return amount;
	return 0;
}

// ⚠️ A SEAT SITTING OUT IS FOLDED THE MOMENT THE ACTION REACHES IT, so a table never
// waits out a clock on a player who already ran theirs out twice. It still posted its
// blinds at the deal, the way a tournament blinds off an absent player. The loop stops
// at the first seat that is present, or when a fold ends the hand; each fold makes the
// next seat the one to act, so it can run at most once per seat.
function foldSeatsSittingOut(table: HoldemTable, rng: () => number, outcome: ActionOutcome): ActionOutcome {
	const folded = [...(outcome.sittingOutFolds ?? [])];
	let merged = outcome;
	for (let guard = 0; guard < table.seats.length && !merged.handOver; guard++) {
		const userId = whoActs(table);
		if (!userId || !seatOf(table, userId)?.sittingOut) break;
		const fold = resolveAction(table, userId, "fold", 0, rng);
		if (!fold.ok) break;
		folded.push(userId);
		// The caller's own narration leads; only a fold that ends the hand carries a settlement.
		merged = { ...fold, narration: outcome.narration };
	}
	return folded.length > 0 ? { ...merged, sittingOutFolds: folded } : merged;
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

	// ⚠️ FEWER THAN TWO PLAYERS WITH CHIPS MEANS THERE IS NO BETTING LEFT, and the
	// off-by-one here is the difference between a table that finishes and one that
	// hangs. Checking only for ZERO contenders misses the ordinary all-in shape: one
	// player is all in and ONE other still has chips, so there is nobody left to bet
	// against. That street would open with a single player to act, no bet to call
	// and nothing to raise into, and the table would sit there forever waiting for
	// an action that has no legal form.
	const contenders = streetSeats.filter((seat) => !seat.folded && !seat.allIn);
	if (contenders.length < 2) return runOutAndSettle(table, rng);

	// ⚠️ THE BUTTON ACTS LAST AFTER THE FLOP, NOT FIRST. `order` starts AT the
	// button, so opening at index 0 handed the worst position to the seat that is
	// supposed to have the best, on every street of every hand, and nothing threw.
	// Start one seat later instead. When the button has folded they are absent from
	// `streetSeats` altogether and index 0 is already the first player left of them,
	// which is why the miss resolves to 0 rather than to an error.
	const buttonId = order[0]?.userId;
	const buttonAt = streetSeats.findIndex((seat) => seat.userId === buttonId);
	const opensAt = buttonAt === -1 ? 0 : (buttonAt + 1) % streetSeats.length;

	// openRound skips forward when the seat it lands on cannot act, so an all-in
	// player never becomes the opener here.
	table.betting = nextStreet({ ...table.betting!, seats: streetSeats }, opensAt, table.bigBlind);
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
	// Read before any chip moves, for ordering the busts below.
	const chipsAtHandStart = new Map(table.seats.map((seat) => [seat.userId, seat.stack + seat.totalCommitted]));

	const commitments: PlayerCommitment[] = table.seats
		.filter((seat) => seat.totalCommitted > 0)
		.map((seat) => ({ userId: seat.userId, committed: seat.totalCommitted, folded: seat.folded }));

	// ⚠️ RETURN THE UNCALLED CHIPS BEFORE BUILDING THE POTS, AND SUBTRACT THEM FROM
	// THE COMMITMENT RATHER THAN REFUNDING ON TOP. holdemPots has documented this
	// rule since it was written and nothing called it, which cost real chips: chips
	// nobody could match were never contested, so they formed a layer whose only
	// contributor was the player who bet them, and when that player had FOLDED (legal,
	// and reachable any time their bet went uncalled) the layer arrived at awardPots
	// with an empty eligible list and was dropped on the floor.
	//
	// Subtracting is what keeps the table's total conserved. Refunding on top would
	// leave the same chips inside a pot AND in a stack, paying the top bettor twice,
	// and the pots test would not catch it: expectConserved computes the uncalled
	// portion and never asserts on it.
	//
	// ⚠️ EXCEPT A SEAT THAT LEFT THE TABLE (2026-10 item 276, audit P2-9). A leaver's bet stays
	// in the pot like any folded chips: handed back here it landed on a seat that is out, and an
	// out seat is never paid again (its stack was cashed out as it left, and the end of the table
	// skips it), so the chips left the table for good. Left in its commitment, the layer only the
	// leaver reached has no eligible winner, and buildPots carries it into the last pot somebody
	// can win, so the pot's winner takes it.
	const topBet = uncalledPortion(commitments);
	const uncalled = topBet && !seatOf(table, topBet.userId)?.out ? topBet : null;
	if (uncalled) {
		const owner = commitments.find((entry) => entry.userId === uncalled.userId);
		if (owner) owner.committed -= uncalled.amount;
		const ownerSeat = seatOf(table, uncalled.userId);
		if (ownerSeat) ownerSeat.stack += uncalled.amount;
	}

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

	// Left of the button, not the button. awardPots breaks an odd chip by this order,
	// and its own comment names the rule as "first left of the button".
	const seatOrderIds = seatOrderAfterButton(table).map((seat) => seat.userId);
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

	// The button's seat as the hand ends, read BEFORE the busts below shrink the live
	// list its index counts (2026-10 item 276, P2-7).
	const buttonSeat = seatOrderFrom(table, table.buttonIndex)[0];

	// Bust anyone with nothing left, recording the order so placement is derivable.
	//
	// ⚠️ SEVERAL BUSTS ON ONE HAND ARE ORDERED BY THE CHIPS EACH STARTED IT WITH, NOT BY
	// SEAT (2026-10 item 280). The tournament rule is that the bigger starting stack
	// finishes higher, so the smaller one busts first, worst first being the order
	// bustOrder keeps. A true tie keeps seat order, since sort is stable.
	const busted = table.seats
		.filter((seat) => !seat.out && seat.stack <= 0)
		.sort((first, second) => (chipsAtHandStart.get(first.userId) ?? 0) - (chipsAtHandStart.get(second.userId) ?? 0))
		.map((seat) => {
			seat.out = true;
			table.bustOrder.push(seat.userId);
			return seat.userId;
		});

	table.street = "showdown";
	table.buttonIndex = nextButtonIndex(table, buttonSeat);

	const tournamentOver = livePlayers(table).length <= 1;
	if (tournamentOver) finishTournament(table);

	return {
		ok: true,
		handOver: true,
		tournamentOver,
		awards,
		returned: uncalled ?? undefined,
		busted,
		showdown: shown.length ? shown : undefined,
	};
}

// The button passes to the next seat still in after the one that held it, walking the
// seat array (the table's fixed seating order, out seats included) rather than adding
// one to an index into the live seats. Busts shrink that live list under the index, so
// "plus one" slid the button backwards or past a seat: A B C D with the button on C and
// A busting gave it to B, and D never got it. Answers an index into the live seats,
// which is what buttonIndex counts.
//
// ⚠️ TWO PLAYERS LEFT IS THE EXCEPTION (2026-10 item 280). Heads up the button posts the
// small blind, so passing it on as usual when a table drops to two can hand the big
// blind straight back to whoever just posted it: A button, B small, C big, A busts, and
// the button passing to B leaves C on the big blind again. The tournament rule is that
// nobody posts the big blind twice in a row going heads up, so when last hand's big
// blind is still in, the button goes to them and the other player takes the big blind.
// When that player busted, the ordinary pass already gives each survivor a blind they
// did not just post. Heads up to heads up this lands where the ordinary pass does.
function nextButtonIndex(table: HoldemTable, buttonSeat: TableSeat | undefined): number {
	const live = livePlayers(table);
	const lastBigBlind = live.length === 2 && table.bigBlindUserId ? live.findIndex((seat) => seat.userId === table.bigBlindUserId) : -1;
	if (lastBigBlind !== -1) return lastBigBlind;
	const from = buttonSeat ? table.seats.indexOf(buttonSeat) : -1;
	if (live.length === 0 || from === -1) return 0;
	for (let step = 1; step <= table.seats.length; step++) {
		const seat = table.seats[(from + step) % table.seats.length];
		if (!seat.out) return live.indexOf(seat);
	}
	return 0;
}

function finishTournament(table: HoldemTable): void {
	table.status = "finished";
	table.winnerId = livePlayers(table)[0]?.userId ?? null;
	table.betting = null;
}

// ── the turn clock ────────────────────────────────────────────────────
/**
 * When the clock on the table's current state started: when the board first showed
 * that state, or the action stamp itself until a board has. The turn clock and the
 * next hand's delay both count from here.
 */
export function clockStartOf(table: HoldemTable): number {
	const prompt = table.turnPrompt;
	return prompt && prompt.stamp === table.lastActionAt ? prompt.shownAt : table.lastActionAt;
}

// ⚠️ FORCE FOLD, NEVER PAUSE. Pausing hands one absent player the power to stall
// five present ones, which is the exact failure a turn clock exists to prevent.
// A player who is checked to and vanishes is folded, not waited for, and one who
// runs out of time HOLDEM_SIT_OUT_TIMEOUTS turns in a row sits out (`satOut`).
export function forceFold(table: HoldemTable, rng: () => number = Math.random): ActionOutcome & { userId?: string; satOut?: boolean } {
	const userId = whoActs(table);
	if (!userId) return { ok: false, reason: "nobodyToAct" };
	const seat = seatOf(table, userId);
	const timeoutsBefore = seat?.timeoutsInRow ?? 0;

	// Fold if there is something to call, otherwise check: taking a player's chips
	// off them for being slow when checking was free would be a punishment the
	// rules never asked for.
	const legal = actionsFor(table, userId).map((entry) => entry.action);
	const action: BettingAction = legal.includes("check") ? "check" : "fold";
	const outcome = act(table, userId, action, 0, rng);
	if (!outcome.ok || !seat) return { ...outcome, userId };

	// act started the run over, as it does for any decision; this one was the clock's.
	seat.timeoutsInRow = timeoutsBefore + 1;
	if (seat.timeoutsInRow < BOT_CONSTANTS.HOLDEM_SIT_OUT_TIMEOUTS || seat.sittingOut) return { ...outcome, userId };
	seat.sittingOut = true;
	// A seat the clock checked for is still in the hand and can be the next to act,
	// on a new street, so it is folded now rather than given another clock.
	return { ...foldSeatsSittingOut(table, rng, outcome), userId, satOut: true };
}

export type ReturnResult = { ok: true } | { ok: false; reason: "closed" | "notSeated" | "notSittingOut" };

/**
 * Bring a seat that sits out back to the table, the I'm back button's engine half:
 * from the next time the action reaches it, it plays again. Moves the action stamp,
 * so a write racing on the old stamp loses, but carries the turn prompt over to the
 * new one: the player on the clock keeps the time they had rather than a fresh
 * clock because somebody else came back.
 */
export function returnToTable(table: HoldemTable, userId: string, now: number = Date.now()): ReturnResult {
	if (table.status === "finished") return { ok: false, reason: "closed" };
	const seat = seatOf(table, userId);
	if (!seat || seat.out) return { ok: false, reason: "notSeated" };
	if (!seat.sittingOut) return { ok: false, reason: "notSittingOut" };
	seat.sittingOut = false;
	seat.timeoutsInRow = 0;
	restampKeepingClock(table, now);
	return { ok: true };
}

/** Seats still in the tournament and not sitting out: the players actually at the table. */
export const presentPlayers = (table: HoldemTable): TableSeat[] => livePlayers(table).filter((seat) => !seat.sittingOut);

// Finishing places, best first, for the placement bonus. The winner is first, then
// the bust order reversed: the last player to bust finished second.
export function placements(table: HoldemTable): string[] {
	const winner = table.winnerId ? [table.winnerId] : [];
	return [...winner, ...[...table.bustOrder].reverse()];
}

// ── leaving and ending a table ────────────────────────────────────────
export interface LeaveOutcome extends ActionOutcome {
	// True when the player still held cards in a live hand, which leaving folded.
	foldedHand?: boolean;
	// The stack the player walked away with, after any fold settled: what a chip table
	// pays back to their wallet (2026-10 item 250 Phase 5). A seat removed before the
	// first deal walks away with its whole buy in.
	stackLeft?: number;
}

/**
 * Take a player off the table for good, the Leave table button's engine half.
 *
 * Before the first deal the seat is simply removed, which frees it for the next
 * buyer. Once the tournament runs the seat stays in the array marked out, exactly
 * like a bust, so finishing order survives (see TableSeat.out); a live hand is
 * folded first, so the chips already in the pot stay there. The player's stack
 * leaves with them, reported as `stackLeft`: a chip table cashes it out to their
 * wallet (holdemChips), and at a free table it dies with the table. When one seat is
 * left the tournament ends the way a final bust ends it.
 * `narration` is never set, because the caller posts its own one line for the leave.
 */
export function leaveTable(table: HoldemTable, userId: string, rng: () => number = Math.random): LeaveOutcome {
	if (table.status === "finished") return { ok: false, reason: "closed" };
	const seat = seatOf(table, userId);
	if (!seat || seat.out) return { ok: false, reason: "notSeated" };

	if (table.status === "joining") {
		table.seats = table.seats.filter((entry) => entry.userId !== userId);
		table.lastActionAt = Date.now();
		return { ok: true, foldedHand: false, stackLeft: seat.stack };
	}

	const holdsCards = handInProgress(table) && !seat.folded;
	keepButtonOnItsSeat(table, seat);
	// Out BEFORE the fold, so the fold's own checks (one player left in the hand, one
	// player left in the tournament) already count this seat as gone.
	seat.out = true;
	table.bustOrder.push(userId);

	let outcome: ActionOutcome = { ok: true };
	if (holdsCards) outcome = whoActs(table) === userId ? act(table, userId, "fold", 0, rng) : foldOutOfTurn(table, userId, rng);
	else table.lastActionAt = Date.now();

	// After the fold, so the stack read is the one the fold left (settleHand never hands an
	// out seat its uncalled bet back, so nothing a later settle does can owe this seat more),
	// and the betting round's copy is zeroed too so the next writeBack cannot put the chips back
	// on a player who has gone.
	const stackLeft = seat.stack;
	seat.stack = 0;
	const bettingSeat = table.betting?.seats.find((entry) => entry.userId === userId);
	if (bettingSeat) bettingSeat.stack = 0;

	if (!outcome.tournamentOver && table.status === "playing" && livePlayers(table).length <= 1) {
		finishTournament(table);
		outcome = { ...outcome, tournamentOver: true };
	}
	return { ...outcome, narration: undefined, foldedHand: holdsCards, stackLeft };
}

// buttonIndex counts LIVE seats, so a seat going out before the button would slide
// the button one seat on. Moving the index back keeps it on the player who holds it.
// When the leaver IS the button there are two cases:
//  ① Between hands the same index now names the next seat, which is where the button
//    passes for the deal anyway.
//  ② Mid hand the button must stay where it was for the rest of the hand (2026-10 item
//    276, P2-8): the flop opens with the first seat LEFT of it, and settleHand passes
//    it on from there. An out seat cannot hold a live index, so the index parks on the
//    seat to the leaver's right, which plays the hand exactly as the button would have
//    from that side: the seat left of the leaver opens each street, and the next button
//    is the seat after the parked one, the leaver's left. Left on the next seat, the
//    flop opened one seat late and the next hand's button skipped a seat.
function keepButtonOnItsSeat(table: HoldemTable, leaving: TableSeat): void {
	const live = livePlayers(table);
	const buttonAt = table.buttonIndex % live.length;
	const leavingAt = live.indexOf(leaving);
	if (leavingAt === buttonAt && handInProgress(table) && live.length > 1) {
		table.buttonIndex = leavingAt === 0 ? live.length - 2 : leavingAt - 1;
		return;
	}
	table.buttonIndex = leavingAt < buttonAt ? buttonAt - 1 : buttonAt;
}

// A leave can come from a seat that is not on the clock, which the betting engine's
// applyAction refuses by design. Folding the seat in place is safe because the round
// only closes on an action by the player to act, and that player has not acted yet.
function foldOutOfTurn(table: HoldemTable, userId: string, rng: () => number): ActionOutcome {
	const bettingSeat = table.betting?.seats.find((entry) => entry.userId === userId);
	if (bettingSeat) bettingSeat.folded = true;
	const seat = seatOf(table, userId);
	if (seat) seat.folded = true;
	table.lastActionAt = Date.now();
	if (inHand(table).length <= 1) return settleHand(table, false, rng);
	return { ok: true };
}

/**
 * The finishing order right now, best first: every seat still in, most chips first
 * (ties keep seat order, since sort is stable), then every seat that is out, last
 * one out first. Meaningful between hands, when stacks are the whole truth; endTable
 * calls any running hand off before it reads this.
 */
export function standings(table: HoldemTable): string[] {
	const stillIn = [...livePlayers(table)].sort((a, b) => b.stack - a.stack).map((seat) => seat.userId);
	return [...stillIn, ...[...table.bustOrder].reverse()];
}

/**
 * What each seat still in gets back when a running hand is called off (the host's End table,
 * or a room finished from outside the table): every chip it put into the hand, plus an even
 * share of what seats that left mid hand put in (2026-10 item 276, audit P2-14). A leaver
 * forfeited those chips when it folded, and with no showdown to win them they belong to the
 * seats still playing; dropping them, as the table once did, took them off the table for good.
 * An odd chip goes first left of the button, the house rule awardPots keeps. Between hands every
 * commitment is zero, so this answers nothing. Pure: it reads the table and writes nothing.
 */
export function chipsBackOnCallOff(table: HoldemTable): Map<string, number> {
	const back = new Map<string, number>();
	const stillIn = seatOrderAfterButton(table);
	for (const seat of stillIn) if (seat.totalCommitted > 0) back.set(seat.userId, seat.totalCommitted);
	const forfeited = table.seats.filter((seat) => seat.out).reduce((sum, seat) => sum + seat.totalCommitted, 0);
	if (forfeited === 0 || stillIn.length === 0) return back;

	const share = Math.floor(forfeited / stillIn.length);
	let oddChips = forfeited - share * stillIn.length;
	for (const seat of stillIn) {
		const extra = share + (oddChips > 0 ? 1 : 0);
		if (oddChips > 0) oddChips--;
		if (extra > 0) back.set(seat.userId, (back.get(seat.userId) ?? 0) + extra);
	}
	return back;
}

/**
 * End the table now, the host's End table button. A running hand is called off
 * (chipsBackOnCallOff): every chip a seat still in put into it goes back to that
 * seat, with an even share of what a seat that left mid hand put in, and the
 * standings are read from the stacks that leaves. A table ended before its first
 * deal had nothing played, so it has no winner. Returns the standings, best first.
 */
export function endTable(table: HoldemTable): string[] {
	const back = chipsBackOnCallOff(table);
	for (const seat of table.seats) {
		seat.stack += back.get(seat.userId) ?? 0;
		seat.committed = 0;
		seat.totalCommitted = 0;
	}
	const order = standings(table);
	table.status = "finished";
	table.betting = null;
	table.winnerId = table.handNumber > 0 ? (order[0] ?? null) : null;
	table.lastActionAt = Date.now();
	return order;
}
