import { evaluateHand, HAND_CATEGORIES, type Card, type HandCategory } from "./holdemHand.js";
import type { BettingAction, LegalAction } from "./holdemBetting.js";
import { actionsFor, handInProgress, livePlayers, whoActs, type HoldemTable } from "./holdemTable.js";
import { buildPots, potTotal } from "./holdemPots.js";

// ── holdemBot ───────────────────────────────────────────────────────
// What:  the decision a Dero bot seat makes at a Hold'em table (2026-10 item 250 Phase
//        5): fold, check, call, bet or raise an amount, or all in. A solid, honest
//        player: it values its starting hand by the standard 169 hand groups, plays
//        tighter early and wider late, weighs a made hand and its draws against the pot
//        odds after the flop, and sizes bets in the spell's bands.
// Who:   the room's bot driver (game-rooms/botTurns.ts), once per turn the bot is on
//        the clock, and the tests.
// Does NOT: bluff (the plan's v1 scope, a follow up may add it), read any other seat's
//        cards, or touch the table. PURE: the decision comes back as data and the room
//        applies it through the engine's `act`, the same call a member's press makes.
//
// ⚠️ THE BOT SEES ONLY WHAT ITS SEAT WOULD SEE. botViewOf copies the bot's own two cards,
// the board, the pot and the bets, and nothing else; decideHoldemMove reads only that
// view. A decision built from the whole table would let the bot read the other hands,
// which a test pins it never does.

/** Everything a seat at the table can see when it is on the clock. */
export interface HoldemBotView {
	holeCards: Card[];
	board: Card[];
	pot: number;
	/** Chips to put in to call; 0 when checking is free. */
	toCall: number;
	stack: number;
	/** What this seat has put in on this street. */
	committed: number;
	/** What this seat has put in across the hand. */
	handCommitted: number;
	currentBet: number;
	bigBlind: number;
	/** Opponents still in the hand. */
	opponents: number;
	position: PositionClass;
	legal: readonly LegalAction[];
}

export type PositionClass = "early" | "middle" | "late" | "blind";

export interface HoldemBotMove {
	action: BettingAction;
	/** The TOTAL committed this street for a bet or raise, the engine's convention; 0 otherwise. */
	amount: number;
}

// ── the spell's sizing bands (2026-10 item 250 Phase 5) ───────────────
// Bets take 50 to 75 percent of the pot, raises 2.5 to 3.5 times the bet they face,
// and the pick inside each band is random so the bot's size gives nothing away.
const BET_POT_SHARE = { min: 0.5, max: 0.75 } as const;
const RAISE_MULTIPLE = { min: 2.5, max: 3.5 } as const;
// All in only with two pair or better made with a hole card, and only once half the
// seat's chips this hand are already in the pot (the spell's rule): before that, a
// strong hand still builds the pot with ordinary sizes.
const ALL_IN_MIN_CATEGORY: HandCategory = "two pair";
const ALL_IN_COMMITTED_SHARE = 0.5;
// At ten big blinds or fewer there is no room to raise and fold, so the bot plays
// push or fold preflop, the standard short stack strategy.
const SHORT_STACK_BIG_BLINDS = 10;

// ── preflop: the 169 starting hands ───────────────────────────────────
// Sklansky's groups, 1 the strongest; a hand on no list is group 9. "s" is suited,
// "o" offsuit, a pair has neither. Listed rather than computed because the groups
// are a published table, and a formula would drift from it at the edges.
const HAND_GROUPS: Readonly<Record<string, number>> = groupTable([
	["AA KK QQ JJ AKs", 1],
	["TT AQs AJs KQs AKo", 2],
	["99 ATs KJs QJs JTs AQo", 3],
	["88 KTs QTs J9s T9s 98s AJo KQo", 4],
	["77 A9s A8s A7s A6s A5s A4s A3s A2s Q9s T8s 97s 87s 76s KJo QJo JTo", 5],
	["66 55 K9s J8s 86s 75s 54s ATo KTo QTo", 6],
	["44 33 22 K8s K7s K6s K5s K4s K3s K2s Q8s T7s 64s 53s 43s J9o T9o 98o", 7],
	["J7s 96s 85s 74s 42s 32s A9o K9o Q9o J8o T8o 87o 76o 65o 54o", 8],
]);
const UNLISTED_GROUP = 9;

// The worst group the bot opens with when nobody has raised, by position: tight up
// front, where everyone behind can wake up with a hand, and wider on the button.
const OPEN_GROUP: Record<PositionClass, number> = { early: 3, middle: 4, late: 6, blind: 5 };
// Facing a raise: re-raise with the top two groups, call with these, fold the rest.
const RERAISE_GROUP = 2;
const CALL_RAISE_GROUP: Record<PositionClass, number> = { early: 3, middle: 3, late: 4, blind: 4 };
// A raise costing at most this share of the pot (a min raise into the blinds) is
// called a little wider, because the price is right.
const CHEAP_CALL_POT_SHARE = 0.25;
const CHEAP_CALL_GROUP_BONUS = 2;
// Push or fold: the worst group that shoves short, by position.
const SHOVE_GROUP: Record<PositionClass, number> = { early: 4, middle: 4, late: 6, blind: 5 };

// ── after the flop: how strong a hand is ──────────────────────────────
// A rough share of the time the hand wins at showdown against ONE typical opponent,
// by what it is. Approximations a solid human plays by, not a solver's numbers; the
// plan scoped the bot to "legal moves, basic hand strength", not expert play.
const STRENGTH = {
	monster: 0.88, // a straight or better, or a set, made with a hole card
	twoPair: 0.76,
	overpairOrTopPairGoodKicker: 0.66,
	topPairWeakKicker: 0.56,
	weakPair: 0.36,
	nothing: 0.12,
} as const;
// Each opponent past the first takes this share off, since the hand must beat them all.
const MULTIWAY_DISCOUNT = 0.85;
// Draw equity by the rule of four and two: outs times 4 percent with two cards to come,
// times 2 with one. A flush draw has 9 outs, an open ended straight draw 8.
const FLUSH_DRAW_OUTS = 9;
const STRAIGHT_DRAW_OUTS = 8;
const OUT_SHARE_TWO_CARDS = 0.04;
const OUT_SHARE_ONE_CARD = 0.02;
// Bet for value from this strength up when checking is free; a late position seat bets
// a little thinner, since fewer players act after it.
const VALUE_BET_STRENGTH = { inPosition: 0.55, outOfPosition: 0.62 } as const;
// Raise a bet from this strength up; call when the strength beats the pot odds by a margin.
const RAISE_STRENGTH = 0.75;
const CALL_MARGIN = 0.03;
// A good kicker for top pair: a queen or better.
const GOOD_KICKER_RANK = 12;
// Where the moving button put the big blind in the button first order (button 0, small
// blind 1, big blind 2): positionOf's fallback when this hand's big blind cannot be found.
const MOVING_BUTTON_BIG_BLIND_AT = 2;

// ── the view ──────────────────────────────────────────────────────────
/**
 * What `botId` sees at `table` on its turn, or null when it is not on the clock. Copies
 * only the bot's own cards: nothing below this line can reach another seat's hand.
 */
export function botViewOf(table: HoldemTable, botId: string): HoldemBotView | null {
	if (!handInProgress(table) || whoActs(table) !== botId || !table.betting) return null;
	const bettingSeat = table.betting.seats.find((seat) => seat.userId === botId);
	if (!bettingSeat) return null;
	const pot = potTotal(
		buildPots(table.seats.filter((seat) => seat.totalCommitted > 0).map((seat) => ({ userId: seat.userId, committed: seat.totalCommitted, folded: seat.folded })))
	);
	return {
		holeCards: [...(table.holeCards[botId] ?? [])],
		board: [...table.board],
		pot,
		toCall: Math.max(0, table.betting.currentBet - bettingSeat.committed),
		stack: bettingSeat.stack,
		committed: bettingSeat.committed,
		handCommitted: bettingSeat.totalCommitted,
		currentBet: table.betting.currentBet,
		bigBlind: table.bigBlind,
		opponents: table.betting.seats.filter((seat) => !seat.folded && seat.userId !== botId).length,
		position: positionOf(table, botId),
		legal: actionsFor(table, botId),
	};
}

// The seat's place relative to the button: the button and the seat before it are late,
// whoever posted a blind this hand is a blind, and the rest split early and middle. Heads
// up the button posts the small blind and acts first preflop, so it counts as late.
function positionOf(table: HoldemTable, botId: string): PositionClass {
	const live = livePlayers(table);
	const count = live.length;
	const start = table.buttonIndex % Math.max(count, 1);
	const order = [...live.slice(start), ...live.slice(0, start)];
	const index = order.findIndex((seat) => seat.userId === botId);
	if (count <= 2) return index === 0 ? "late" : "blind";
	// The blinds first: three handed, the big blind is also the seat before the button.
	const bigBlindAt = bigBlindIndexOf(table, order);
	if (index >= 1 && index <= bigBlindAt) return "blind";
	if (index === 0 || index === count - 1) return "late";
	const firstAfterBlinds = bigBlindAt + 1;
	const share = (index - firstAfterBlinds) / Math.max(count - 1 - firstAfterBlinds, 1);
	return share < 0.5 ? "early" : "middle";
}

// The big blind's place in the button first order. Under the dead button rule (2026-10
// item 280) a dead small blind leaves the big blind right after the button and the seat
// after it first to act, so reading "seats 1 and 2 are the blinds" would call that first
// actor a blind. Every seat between the button and the big blind posted a blind: the small
// blind when there is one, nobody when it is dead. The fallback is the moving button's
// place (small blind 1, big blind 2), for a hand dealt before bigBlindUserId existed or a
// big blind that left mid hand and is no longer live.
function bigBlindIndexOf(table: HoldemTable, order: HoldemTable["seats"]): number {
	const bigBlindAt = order.findIndex((seat) => seat.userId === table.bigBlindUserId);
	return bigBlindAt >= 1 ? bigBlindAt : MOVING_BUTTON_BIG_BLIND_AT;
}

// ── the decision ──────────────────────────────────────────────────────
/**
 * The bot's move from its view. Always legal: whatever the strategy picks is checked
 * against the view's legal actions, and a pick that is not there falls back to check,
 * then call, then fold. `rng` only chooses inside a sizing band.
 */
export function decideHoldemMove(view: HoldemBotView, rng: () => number = Math.random): HoldemBotMove {
	const wanted = view.board.length === 0 ? preflopMove(view, rng) : postflopMove(view, rng);
	return legalize(view, wanted);
}

function preflopMove(view: HoldemBotView, rng: () => number): HoldemBotMove {
	const group = startingHandGroup(view.holeCards);
	const shortStacked = view.stack + view.committed <= view.bigBlind * SHORT_STACK_BIG_BLINDS;
	if (shortStacked) return group <= SHOVE_GROUP[view.position] ? allIn() : checkOrFold(view);

	const facingRaise = view.currentBet > view.bigBlind;
	if (!facingRaise) {
		if (group <= OPEN_GROUP[view.position]) return raiseTo(view.bigBlind * pick(rng, RAISE_MULTIPLE));
		return checkOrFold(view);
	}
	if (group <= RERAISE_GROUP) return raiseTo(view.currentBet * pick(rng, RAISE_MULTIPLE));
	const cheap = view.toCall <= view.pot * CHEAP_CALL_POT_SHARE;
	const callGroup = CALL_RAISE_GROUP[view.position] + (cheap ? CHEAP_CALL_GROUP_BONUS : 0);
	return group <= callGroup ? call() : fold();
}

function postflopMove(view: HoldemBotView, rng: () => number): HoldemBotMove {
	const read = readHand(view);
	const strength = read.strength * MULTIWAY_DISCOUNT ** Math.max(view.opponents - 1, 0);
	const mayShove = mayGoAllIn(view, read.category);

	if (view.toCall === 0) {
		const valueBar = view.position === "late" ? VALUE_BET_STRENGTH.inPosition : VALUE_BET_STRENGTH.outOfPosition;
		if (strength < valueBar) return check();
		if (mayShove) return allIn();
		return raiseTo(view.committed + view.pot * pick(rng, BET_POT_SHARE));
	}

	if (strength >= RAISE_STRENGTH) {
		if (mayShove) return allIn();
		return raiseTo(view.currentBet * pick(rng, RAISE_MULTIPLE));
	}
	const potOdds = view.toCall / (view.pot + view.toCall);
	return strength >= potOdds + CALL_MARGIN ? call() : fold();
}

// ⚠️ THE SPELL'S ALL IN RULE: two pair or better, AND half the seat's chips this hand
// already in. The second half is what keeps the bot from shoving a strong hand into an
// unraised pot, where a normal bet wins more and risks less.
function mayGoAllIn(view: HoldemBotView, category: HandCategory | null): boolean {
	if (!category || categoryRank(category) < categoryRank(ALL_IN_MIN_CATEGORY)) return false;
	const chipsThisHand = view.stack + view.handCommitted;
	return chipsThisHand > 0 && view.handCommitted / chipsThisHand >= ALL_IN_COMMITTED_SHARE;
}

// ── reading the hand ──────────────────────────────────────────────────
interface HandRead {
	strength: number;
	/** The made hand's category when a hole card plays in it, else null (the board's own hand). */
	category: HandCategory | null;
}

/** How strong the bot's hand is after the flop: its made hand, or its draws, whichever is worth more. */
export function readHand(view: Pick<HoldemBotView, "holeCards" | "board">): HandRead {
	const made = madeHandRead(view.holeCards, view.board);
	const draws = drawStrength(view.holeCards, view.board);
	return { strength: Math.max(made.strength, draws), category: made.category };
}

// ⚠️ ONLY WHAT THE HOLE CARDS MAKE COUNTS. A pair on the board is everyone's pair, and a
// bot that read it as its own would bet the board. So each category asks whether the
// bot's own ranks are in the part that makes it: the pair, either of the two pairs, the
// trips; a straight or better must play a hole card and beat what the board makes alone.
function madeHandRead(hole: Card[], board: Card[]): HandRead {
	const hand = evaluateHand([...hole, ...board]);
	const own = new Set(hole.map((card) => card.rank));
	const nothing: HandRead = { strength: STRENGTH.nothing, category: null };

	switch (hand.category) {
		case "high card":
			return nothing;
		case "pair":
			return own.has(hand.ranks[0]) ? { strength: pairStrength(hole, board, hand.ranks[0]), category: "pair" } : nothing;
		case "two pair":
			return twoPairRead(hole, board, hand.ranks[0], hand.ranks[1], own);
		case "three of a kind":
			return own.has(hand.ranks[0]) ? { strength: STRENGTH.monster, category: hand.category } : nothing;
		default:
			return playsHoleCard(hand.cards, hole) && !boardMakesAtLeast(hand.category, board) ? { strength: STRENGTH.monster, category: hand.category } : nothing;
	}
}

// Two pair with both pairs the bot's is two pair; with one of them on the board it is
// really one pair, the bot's; with both on the board it is nothing of the bot's.
function twoPairRead(hole: Card[], board: Card[], highPair: number, lowPair: number, own: ReadonlySet<number>): HandRead {
	const ownHigh = own.has(highPair);
	const ownLow = own.has(lowPair);
	if (ownHigh && ownLow) return { strength: STRENGTH.twoPair, category: "two pair" };
	if (ownHigh || ownLow) return { strength: pairStrength(hole, board, ownHigh ? highPair : lowPair), category: "pair" };
	return { strength: STRENGTH.nothing, category: null };
}

const playsHoleCard = (cards: Card[], hole: Card[]): boolean => cards.some((card) => hole.some((own) => own.rank === card.rank && own.suit === card.suit));

// A pair is only as good as where it sits: over the board, on top of it with a good
// kicker, on top with a weak one, or below the top card.
function pairStrength(hole: Card[], board: Card[], pairRank: number): number {
	const topBoard = Math.max(...board.map((card) => card.rank));
	const pocketPair = hole.length === 2 && hole[0].rank === hole[1].rank;
	if (pocketPair && pairRank > topBoard) return STRENGTH.overpairOrTopPairGoodKicker;
	if (pairRank < topBoard) return STRENGTH.weakPair;
	const kicker = Math.max(...hole.filter((card) => card.rank !== pairRank).map((card) => card.rank), 0);
	return kicker >= GOOD_KICKER_RANK ? STRENGTH.overpairOrTopPairGoodKicker : STRENGTH.topPairWeakKicker;
}

// Whether the five card board alone already makes this category or better, so the
// bot's cards only kick. Under five board cards the board cannot make a straight or
// better on its own.
function boardMakesAtLeast(category: HandCategory, board: Card[]): boolean {
	if (board.length < 5) return false;
	return categoryRank(evaluateHand(board).category) >= categoryRank(category);
}

// The equity of the bot's best draw by the rule of four and two. No draw on the river.
function drawStrength(hole: Card[], board: Card[]): number {
	const cardsToCome = 5 - board.length;
	if (cardsToCome <= 0) return 0;
	const cards = [...hole, ...board];
	const outs = Math.max(hasFlushDraw(cards, hole) ? FLUSH_DRAW_OUTS : 0, hasOpenEndedDraw(cards, hole) ? STRAIGHT_DRAW_OUTS : 0);
	return outs * (cardsToCome === 2 ? OUT_SHARE_TWO_CARDS : OUT_SHARE_ONE_CARD);
}

// Exactly four of one suit, at least one of them the bot's own.
function hasFlushDraw(cards: Card[], hole: Card[]): boolean {
	return hole.some((own) => cards.filter((card) => card.suit === own.suit).length === 4);
}

// Four ranks in a row with room at both ends (so not one running to the ace or from
// the wheel's bottom), at least one of them the bot's own.
function hasOpenEndedDraw(cards: Card[], hole: Card[]): boolean {
	const ranks = new Set(cards.map((card) => card.rank));
	const ownRanks = new Set(hole.map((card) => card.rank));
	for (let low = 2; low <= 10; low++) {
		const run = [low, low + 1, low + 2, low + 3];
		const openBothEnds = low > 2 && low + 3 < 14;
		if (openBothEnds && run.every((rank) => ranks.has(rank)) && run.some((rank) => ownRanks.has(rank)) && !ranks.has(low - 1) && !ranks.has(low + 4)) return true;
	}
	return false;
}

/** A starting hand's group, 1 (aces) to 9 (unlisted), from the bot's two cards. */
export function startingHandGroup(hole: Card[]): number {
	if (hole.length !== 2) return UNLISTED_GROUP;
	return HAND_GROUPS[handKey(hole[0], hole[1])] ?? UNLISTED_GROUP;
}

const RANK_LETTERS: Readonly<Record<number, string>> = { 14: "A", 13: "K", 12: "Q", 11: "J", 10: "T" };
const rankLetter = (rank: number): string => RANK_LETTERS[rank] ?? String(rank);

/** The canonical name of two cards: "AA", "AKs", "T9o", high card first. */
export function handKey(first: Card, second: Card): string {
	const [high, low] = first.rank >= second.rank ? [first, second] : [second, first];
	if (high.rank === low.rank) return `${rankLetter(high.rank)}${rankLetter(low.rank)}`;
	return `${rankLetter(high.rank)}${rankLetter(low.rank)}${high.suit === low.suit ? "s" : "o"}`;
}

function groupTable(rows: ReadonlyArray<readonly [string, number]>): Record<string, number> {
	const table: Record<string, number> = {};
	for (const [hands, group] of rows) for (const hand of hands.split(" ")) table[hand] = group;
	return table;
}

const categoryRank = (category: HandCategory): number => HAND_CATEGORIES.indexOf(category);

// ── moves, and keeping them legal ─────────────────────────────────────
const fold = (): HoldemBotMove => ({ action: "fold", amount: 0 });
const check = (): HoldemBotMove => ({ action: "check", amount: 0 });
const call = (): HoldemBotMove => ({ action: "call", amount: 0 });
const allIn = (): HoldemBotMove => ({ action: "allIn", amount: 0 });
const checkOrFold = (view: HoldemBotView): HoldemBotMove => (view.toCall === 0 ? check() : fold());
const pick = (rng: () => number, band: { min: number; max: number }): number => band.min + (band.max - band.min) * rng();

// An aggressive move to a TOTAL this street, whatever the engine calls it (a bet when
// nothing is bet yet, a raise otherwise); legalize fills in the name and the bounds.
const raiseTo = (total: number): HoldemBotMove => ({ action: "raise", amount: Math.round(total) });

// Map the strategy's wish onto the engine's legal list. A bet or raise takes the
// engine's name for it and is clamped into its band; a size that only fits as the
// whole stack plays as a call or check instead, since the all in rule above already
// decided whether shoving is allowed. Anything else missing falls back to the cheapest
// legal way to stay in or get out.
function legalize(view: HoldemBotView, wanted: HoldemBotMove): HoldemBotMove {
	const has = (action: BettingAction) => view.legal.some((entry) => entry.action === action);
	if (wanted.action === "raise") {
		const aggressive = view.legal.find((entry) => entry.action === "bet" || entry.action === "raise");
		if (aggressive?.min !== undefined && aggressive.max !== undefined && wanted.amount < aggressive.max) {
			return { action: aggressive.action, amount: Math.min(aggressive.max, Math.max(aggressive.min, wanted.amount)) };
		}
		// No legal size short of the whole stack: stay in for what it costs instead.
		if (view.toCall > 0 && has("call")) return call();
		return safeFallback(view);
	}
	if (has(wanted.action)) return { action: wanted.action, amount: 0 };
	return safeFallback(view);
}

function safeFallback(view: HoldemBotView): HoldemBotMove {
	const has = (action: BettingAction) => view.legal.some((entry) => entry.action === action);
	if (has("check")) return check();
	if (has("call") && view.toCall <= view.stack * CHEAP_CALL_POT_SHARE) return call();
	return fold();
}
