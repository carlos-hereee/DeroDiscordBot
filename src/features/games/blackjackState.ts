// ── blackjackState ──────────────────────────────────────────────────────────
// The table's rules, kept PURE and separate from blackjackHandler's Discord
// work, the same split hangmanState / hangmanHandler and versusResolve /
// versusHandler already draw. Every fiddly part of blackjack (soft aces, what
// counts as a natural, what a split may and may not do afterwards, when the
// dealer stops) is decided here, so it is testable without a single Discord mock.
//
// ⚠️ WRITTEN FOR N SEATS FROM THE FIRST LINE, and that is the whole point.
// A solo game against the dealer is simply the N=1 case, so the three surfaces
// the owner asked for (create a solo game, create a table, join a public table)
// all run this one engine. Writing a one player state machine first and bolting
// seats on later would mean rewriting the turn order, the split handling and the
// settle pass, which is the expensive half.
//
// ⚠️ applyAction is SYNCHRONOUS by contract, for the same reason hangmanState's
// applyGuess and rpsRound's applyPick are: the board is a public message and two
// members can click in the same tick. An uninterrupted check-then-write is what
// stops a double click from drawing two cards for one Hit.
//
// ⚠️ A ROOM TABLE PLAYS FOR A BANKROLL (2026-10 item 267, owner decision 6). The first
// version played no chips at all (R22 of the arcade plan), because no wallet existed to buy
// in from. Chips are one global wallet now, so a room table seats every player with a stack
// of their buy in, each hand opens with a betting turn per seat (placeBet), the hand pays
// the bets (collectPayouts), and the table deals hand after hand (startNextHand) until every
// seat is broke or gone. A free table plays the same way with a pretend stack. The one hand
// table createTable builds (the inline slash forms) still bets nothing: every stake is zero.
//
// ⚠️ US RULES: THE DEALER PEEKS, AND A CUT CARD ENDS THE SHOE (2026-10 item 276, owner decision
// D5). A dealer dealt a natural ends the hand at once, before any seat acts (dealRound), so a
// seat never doubles or splits into a hand already lost and loses only its first bet; a seat
// dealt a natural too pushes. And the shoe is never dealt to its last card: once
// CUT_CARD_PENETRATION of it is dealt the cut card is out, the hand in play finishes, and the
// shoe is shuffled whole before the next one (startNextHand), because every card is public and
// a shoe dealt to the end let a player count it into a profit.
//
// ⚠️ NO INSURANCE, and it is still not an oversight. Insurance is a SIDE BET on the dealer's
// hole card, a second wager inside a hand the owner's bankroll decision never asked for, and
// one more turn every seat would sit through on every dealer ace.

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── Table rules, named rather than inlined ──
// Every one of these is a rule a reader would otherwise have to infer from a
// magic number in a comparison.
export const BLACKJACK_TARGET = 21;
// The dealer's floor. Reaching 17 by any route ends the dealer's turn, subject
// to the soft 17 option below.
export const DEALER_STANDS_ON = 17;
// A six deck shoe, which is the common casino configuration and, more usefully
// here, deep enough that a long table never exhausts it mid hand.
export const DEFAULT_DECK_COUNT = 6;
// Splitting caps at four hands per seat, matching the standard casino limit.
// Without a cap a seat dealt repeated pairs could split without bound, and every
// extra hand is another turn the rest of the table waits through.
export const MAX_HANDS_PER_SEAT = 4;
// How much of the shoe is dealt before the cut card comes out: about three quarters, the
// usual casino placement. Deeper lets a counter play the last quarter at an edge; much
// shallower reshuffles so often a shoe is barely played.
export const CUT_CARD_PENETRATION = 0.75;

export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
export type Rank = (typeof RANKS)[number];

// Suits carry no scoring meaning in blackjack; they exist so the renderer can
// draw a real card and so a shoe holds genuine duplicates rather than 52 copies
// of the same object.
export const SUITS = ["S", "H", "D", "C"] as const;
export type Suit = (typeof SUITS)[number];

export interface Card {
	rank: Rank;
	suit: Suit;
}

// ── Card and hand values ────────────────────────────────────────────────────

// An ace is scored as 11 here and demoted later by handValue. Returning 11
// unconditionally is what lets the demotion loop live in exactly one place
// rather than being re-derived per caller.
export function cardValue(card: Card): number {
	if (card.rank === "A") return 11;
	if (card.rank === "J" || card.rank === "Q" || card.rank === "K") return 10;
	return Number(card.rank);
}

export interface HandValue {
	total: number;
	// True when an ace is still counting as 11, which is what "soft 17" means and
	// what makes the dealer policy option below meaningful.
	soft: boolean;
}

// Count every ace as 11, then demote one ace at a time while the hand is over
// 21. Demoting one at a time (rather than deciding up front) is what handles
// A + A + 9 correctly: 31 soft, demote once to 21 hard, stop. Deciding up front
// that "the second ace is a 1" would get A + A right and A + A + 9 wrong.
export function handValue(cards: Card[]): HandValue {
	let total = 0;
	let aces = 0;
	for (const card of cards) {
		total += cardValue(card);
		if (card.rank === "A") aces += 1;
	}
	while (total > BLACKJACK_TARGET && aces > 0) {
		total -= 10;
		aces -= 1;
	}
	// Any ace left undemoted is still worth 11, which is the definition of soft.
	return { total, soft: aces > 0 };
}

// ── The shoe ────────────────────────────────────────────────────────────────

// Fisher-Yates, with the rng injected exactly as versusResolve injects it, so a
// test can hand in a scripted sequence and get a known deal. Production passes
// nothing and takes Math.random.
export function buildShoe(deckCount: number = DEFAULT_DECK_COUNT, rng: () => number = Math.random): Card[] {
	const cards: Card[] = [];
	for (let deck = 0; deck < deckCount; deck += 1) {
		for (const suit of SUITS) {
			for (const rank of RANKS) cards.push({ rank, suit });
		}
	}
	for (let i = cards.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rng() * (i + 1));
		const swap = cards[i];
		cards[i] = cards[j];
		cards[j] = swap;
	}
	return cards;
}

// ── Hands, seats and the table ──────────────────────────────────────────────

// "stood" covers both a deliberate Stand and the forced stand after a Double or
// a split ace, because from every later pass they are the same thing: a hand
// that is final and not bust. "left" is a hand whose seat left the table during
// the hand (2026-10 item 254, Arcade 12): final, and a loss whatever its cards say.
export type HandStatus = "playing" | "stood" | "bust" | "blackjack" | "left";

export interface Hand {
	cards: Card[];
	status: HandStatus;
	// Doubled hands pay double. Tracked on the hand rather than the seat because
	// a split seat can double one hand and not the other.
	doubled: boolean;
	// A hand created by splitting. Load bearing: a 21 here is an ordinary 21, NOT
	// a natural, which is the single most commonly mis-implemented blackjack rule.
	fromSplit: boolean;
	// The chips riding on this hand, already out of the seat's stack. A double doubles it and
	// a split hand carries the original bet again, so it lives on the hand, not the seat.
	bet: number;
}

/** Why a seat is no longer dealt in: its stack ran out, or it left the table. */
export type SeatOut = "broke" | "left";

export interface Seat {
	userId: string;
	username: string;
	// One entry until the seat splits. The renderer and the settle pass both walk
	// this, so a solo seat and a four way split take the same code path. Empty for a
	// seat that is out, and for every seat while the table takes its bets.
	hands: Hand[];
	activeHand: number;
	// The seat's chips outside any bet in play. Zero at a one hand table, which bets nothing.
	stack: number;
	// What the seat bet this hand, taken from the stack when it was placed; zero until it bets.
	bet: number;
	// Null while the seat is dealt in.
	out: SeatOut | null;
}

// "betting" opens every hand of a bankroll table: each seat in turn picks its bet, and the
// last bet deals the hand.
export type TablePhase = "betting" | "playing" | "dealer" | "settled";

export interface BlackjackTable {
	seats: Seat[];
	dealer: Hand;
	shoe: Card[];
	phase: TablePhase;
	// Index into seats. Meaningless once phase leaves "playing".
	turn: number;
	// The one genuine rules variant worth exposing: stand on soft 17 (player
	// friendly, the default) versus hit it (the house edge version).
	hitsSoft17: boolean;
	// The decks in the shoe, so a reshuffle rebuilds the same shoe the table opened with.
	deckCount: number;
	// Set by draw once the cut card is out; startNextHand shuffles a fresh shoe and clears it,
	// and the hand's result says the shoe is being shuffled.
	reshuffleDue: boolean;
	// What every seat bought in for; the bet choices are percents of it. Zero at a one hand table.
	buyIn: number;
	// Counts from 1, so a turn of hand 2 never reads like the same turn of hand 1.
	handNumber: number;
	// ⚠️ The payout claim: set by collectPayouts, the one writer of a settled hand into the
	// stacks, so a second call for the same hand pays nothing (risk R5).
	paid: boolean;
}

export type BlackjackAction = "hit" | "stand" | "double" | "split";

function emptyHand(fromSplit = false, bet = 0): Hand {
	return { cards: [], status: "playing", doubled: false, fromSplit, bet };
}

// A natural is 21 on the FIRST TWO CARDS of a hand that was not split. Both
// halves matter: three cards totalling 21 is an ordinary 21, and 21 on a split
// ace pair is an ordinary 21 too. Casinos are unanimous on this and it changes
// who wins a push against a dealer 21.
export function isNatural(hand: Hand): boolean {
	return !hand.fromSplit && hand.cards.length === 2 && handValue(hand.cards).total === BLACKJACK_TARGET;
}

// ── Dealing ─────────────────────────────────────────────────────────────────

// Draw from the front of the shoe. Mutates, because the shoe IS the table's
// state and copying a 312 card array on every card would be the only allocation
// in a hot path that has no other.
function draw(table: BlackjackTable): Card {
	// The cut card reshuffles between hands, so a quarter of the shoe is always left and
	// this can only empty for a hand built by hand. An empty shoe would otherwise surface
	// as `undefined` cards and a NaN total several layers away from the cause, so it is
	// rebuilt rather than thrown: a thrown error here would kill a live game.
	if (table.shoe.length === 0) table.shoe = buildShoe(table.deckCount);
	const card = table.shoe.shift() as Card;
	if (table.shoe.length <= cardsLeftAtCutCard(table)) table.reshuffleDue = true;
	return card;
}

// How many cards are still in the shoe when the cut card comes out.
function cardsLeftAtCutCard(table: BlackjackTable): number {
	return Math.round(table.deckCount * SUITS.length * RANKS.length * (1 - CUT_CARD_PENETRATION));
}

interface CreateTableInput {
	players: Array<{ userId: string; username: string }>;
	rng?: () => number;
	deckCount?: number;
	hitsSoft17?: boolean;
}

function buildTable(input: CreateTableInput, buyIn: number): BlackjackTable {
	const deckCount = input.deckCount ?? DEFAULT_DECK_COUNT;
	return {
		seats: input.players.map((player) => ({ userId: player.userId, username: player.username, hands: [], activeHand: 0, stack: buyIn, bet: 0, out: null })),
		dealer: emptyHand(),
		shoe: buildShoe(deckCount, input.rng ?? Math.random),
		phase: "betting",
		turn: 0,
		hitsSoft17: input.hitsSoft17 ?? false,
		deckCount,
		reshuffleDue: false,
		buyIn,
		handNumber: 1,
		paid: false,
	};
}

// Builds a one hand table AND deals it, because a table that exists but is not dealt is a
// state no caller wants. Every stake is zero: this is the inline slash forms' table, which
// plays for nothing and settles once.
export function createTable(input: CreateTableInput): BlackjackTable {
	const table = buildTable(input, 0);
	dealRound(table);
	return table;
}

/**
 * A room's table (2026-10 item 267): every seat starts with a stack of the buy in and the
 * table opens on its first betting turn. Nothing is dealt until every seat has bet.
 */
export function createBankrollTable(input: CreateTableInput & { buyIn: number }): BlackjackTable {
	return buildTable(input, input.buyIn);
}

// Deals a hand to every seat still in, each hand carrying the bet its seat placed.
//
// Deal order is real casino order: one card to every seat, one to the dealer,
// then a second to every seat and the dealer. It is observably different from
// dealing each hand complete in turn (the cards land in a different order), and
// matching the real thing costs nothing.
function dealRound(table: BlackjackTable): void {
	table.dealer = emptyHand();
	for (const seat of table.seats) {
		seat.hands = seat.out ? [] : [emptyHand(false, seat.bet)];
		seat.activeHand = 0;
	}
	const dealt = table.seats.filter((seat) => seat.hands.length > 0);
	for (let round = 0; round < 2; round += 1) {
		for (const seat of dealt) seat.hands[0].cards.push(draw(table));
		table.dealer.cards.push(draw(table));
	}

	// Naturals are settled before anyone acts, so a seat dealt 21 never sees a Hit
	// button it must not press.
	for (const seat of dealt) {
		if (isNatural(seat.hands[0])) seat.hands[0].status = "blackjack";
	}

	table.paid = false;
	table.turn = 0;
	// The dealer peeks (D5): a dealer natural ends the hand before anyone acts. Every
	// dealer natural shows an ace or a ten, so checking the two cards IS the US peek. The
	// hands stay as dealt, so a natural pushes and every other hand loses only its bet.
	if (isNatural(table.dealer)) {
		table.phase = "dealer";
		return;
	}

	// Everyone may already be done (a one seat table dealt a natural), so the turn
	// pointer has to be settled through the same advance logic rather than assumed
	// to be valid.
	table.phase = "playing";
	settleTurn(table);
}

/**
 * True when the hand ended on the dealer's peek, before any seat acted. With the peek a
 * dealer natural never survives the deal, so holding one is the whole test.
 */
export const endedOnPeek = (table: BlackjackTable): boolean => isNatural(table.dealer);

// ── Betting (2026-10 item 267) ──────────────────────────────────────────────

/** One bet a seat may choose: a percent of the buy in, or everything it holds. */
export interface BetChoice {
	// The percent of the buy in, or null for All in.
	percent: number | null;
	amount: number;
}

/**
 * The bets this seat may place now, smallest first: each of BLACKJACK_BET_PERCENTS of the buy
 * in rounded down to whole chips (at least one), then All in. A percent at or above the stack
 * IS all in, so it gives way to All in rather than offering the same chips twice. Empty for a
 * seat with nothing to bet.
 */
export function betChoices(table: BlackjackTable, userId: string): BetChoice[] {
	const seat = table.seats.find((candidate) => candidate.userId === userId);
	if (!seat || seat.out || seat.stack <= 0) return [];
	const choices: BetChoice[] = [];
	for (const percent of BOT_CONSTANTS.BLACKJACK_BET_PERCENTS) {
		const amount = Math.max(1, Math.floor((table.buyIn * percent) / 100));
		if (amount >= seat.stack || choices.some((choice) => choice.amount === amount)) continue;
		choices.push({ percent, amount });
	}
	choices.push({ percent: null, amount: seat.stack });
	return choices;
}

/** The seat whose bet the table waits on, or undefined outside the betting phase. */
export function bettingSeat(table: BlackjackTable): Seat | undefined {
	return table.phase === "betting" ? table.seats[table.turn] : undefined;
}

export type BetOutcome = { status: "not-your-turn" } | { status: "illegal" } | { status: "ok"; amount: number; dealt: boolean };

/**
 * The seat on the betting turn places one of its bet choices. The bet leaves the stack at
 * once, and the last seat's bet deals the hand. Synchronous, like applyAction, so a double
 * Submit cannot bet twice.
 */
export function placeBet(table: BlackjackTable, userId: string, amount: number): BetOutcome {
	const seat = bettingSeat(table);
	if (!seat || seat.userId !== userId) return { status: "not-your-turn" };
	if (!betChoices(table, userId).some((choice) => choice.amount === amount)) return { status: "illegal" };
	seat.bet = amount;
	seat.stack -= amount;
	table.turn += 1;
	return { status: "ok", amount, dealt: advanceBetting(table) };
}

// Moves the betting turn past every seat that is out or has bet, and deals once nobody is
// left to bet. Answers whether it dealt.
function advanceBetting(table: BlackjackTable): boolean {
	while (table.turn < table.seats.length) {
		const seat = table.seats[table.turn];
		if (!seat.out && seat.bet === 0) return false;
		table.turn += 1;
	}
	if (isTableOver(table)) return false;
	dealRound(table);
	return true;
}

/**
 * After a settled hand has paid, open the next one on its first betting turn. False, with
 * nothing changed, when no seat is still in: the table is over.
 */
export function startNextHand(table: BlackjackTable): boolean {
	if (table.phase !== "settled" || !table.paid || isTableOver(table)) return false;
	for (const seat of table.seats) {
		seat.hands = [];
		seat.activeHand = 0;
		seat.bet = 0;
	}
	table.dealer = emptyHand();
	// The cut card came out during the hand just played, so the next one opens on a
	// whole shoe, shuffled.
	if (table.reshuffleDue) {
		table.shoe = buildShoe(table.deckCount);
		table.reshuffleDue = false;
	}
	table.handNumber += 1;
	table.phase = "betting";
	table.turn = 0;
	advanceBetting(table);
	return true;
}

/** True once every seat is broke or gone. */
export function isTableOver(table: BlackjackTable): boolean {
	return table.seats.every((seat) => seat.out !== null);
}

/**
 * The actions this hand could take but for chips: a double or a split needs the stack to
 * cover one more bet. The turn modal names them with the reason, beside the moves it offers.
 */
export function actionsShortOfChips(table: BlackjackTable, userId: string): BlackjackAction[] {
	const seat = table.phase === "playing" ? table.seats[table.turn] : undefined;
	if (!seat || seat.userId !== userId) return [];
	const hand = seat.hands[seat.activeHand];
	if (!hand || hand.status !== "playing" || hand.cards.length !== 2 || seat.stack >= hand.bet) return [];
	const short: BlackjackAction[] = ["double"];
	if (seat.hands.length < MAX_HANDS_PER_SEAT && cardValue(hand.cards[0]) === cardValue(hand.cards[1])) short.push("split");
	return short;
}

// ── Legality ────────────────────────────────────────────────────────────────

// The single source of truth for which buttons a seat may press. The handler
// renders from this rather than deciding for itself, so a button that appears is
// always a button applyAction will accept (convention 17: one helper per concept).
export function legalActions(table: BlackjackTable, userId: string): BlackjackAction[] {
	if (table.phase !== "playing") return [];
	const seat = table.seats[table.turn];
	if (!seat || seat.userId !== userId) return [];
	const hand = seat.hands[seat.activeHand];
	if (!hand || hand.status !== "playing") return [];

	const actions: BlackjackAction[] = ["hit", "stand"];
	const isOpeningPair = hand.cards.length === 2;
	// A double puts the hand's bet in again and a split bets it on the new hand, so both need
	// the stack to cover one more bet (2026-10 item 267). A zero stake table always covers it.
	const coversAnotherBet = seat.stack >= hand.bet;

	// Double is a two card decision everywhere. Allowing it on three cards is a
	// house variant nobody expects and it would let a seat double into a stiff.
	if (isOpeningPair && coversAnotherBet) actions.push("double");

	if (isOpeningPair && coversAnotherBet && seat.hands.length < MAX_HANDS_PER_SEAT) {
		// Split on equal VALUE, not equal rank, so a King and a Queen may be split.
		// That is the standard casino rule; rank equality would silently forbid the
		// most common ten-value split and read as a bug to any player.
		const [first, second] = hand.cards;
		if (cardValue(first) === cardValue(second)) actions.push("split");
	}

	return actions;
}

export type ActionOutcome =
	// Not this member's turn, or the table is not in the playing phase. Returned
	// rather than thrown so a late click on a stale board is answered, not crashed.
	| { status: "not-your-turn" }
	| { status: "illegal"; action: BlackjackAction }
	| { status: "ok"; action: BlackjackAction; hand: Hand; busted: boolean; handFinished: boolean };

// ── The one mutator ─────────────────────────────────────────────────────────

export function applyAction(table: BlackjackTable, userId: string, action: BlackjackAction): ActionOutcome {
	if (!legalActions(table, userId).includes(action)) {
		const seat = table.seats[table.turn];
		if (table.phase !== "playing" || !seat || seat.userId !== userId) return { status: "not-your-turn" };
		return { status: "illegal", action };
	}

	const seat = table.seats[table.turn];
	const hand = seat.hands[seat.activeHand];

	switch (action) {
		case "hit": {
			hand.cards.push(draw(table));
			hand.status = statusAfterCard(hand);
			break;
		}
		case "stand": {
			hand.status = "stood";
			break;
		}
		case "double": {
			// Exactly one card, then final, win or lose. That forced stop is what
			// makes doubling a real decision rather than a free extra card.
			hand.doubled = true;
			seat.stack -= hand.bet;
			hand.bet *= 2;
			hand.cards.push(draw(table));
			hand.status = handValue(hand.cards).total > BLACKJACK_TARGET ? "bust" : "stood";
			break;
		}
		case "split": {
			const moved = hand.cards.pop() as Card;
			// The new hand carries the original bet again, from the stack.
			seat.stack -= hand.bet;
			const created = emptyHand(true, hand.bet);
			created.cards.push(moved);
			// The original hand is retroactively a split hand too, so neither half can
			// score a natural. Marking only the new one is the subtle version of the
			// same bug isNatural exists to prevent.
			hand.fromSplit = true;
			// Each half draws back up to two cards immediately, which is what a dealer
			// does and what keeps every later pass able to assume a two card minimum.
			hand.cards.push(draw(table));
			created.cards.push(draw(table));
			hand.status = statusAfterCard(hand);
			created.status = statusAfterCard(created);
			seat.hands.splice(seat.activeHand + 1, 0, created);

			// Split aces receive one card each and then stand, the standard rule. It
			// exists because unrestricted ace splitting is the strongest move in the
			// game; without it a seat would re-split aces indefinitely.
			if (moved.rank === "A") {
				hand.status = "stood";
				created.status = "stood";
			}
			break;
		}
	}

	const finished = hand.status !== "playing";
	if (finished) settleTurn(table);
	return { status: "ok", action, hand, busted: hand.status === "bust", handFinished: finished };
}

// A hand still being played after it takes a card: bust past 21, and stood ON 21, since no
// card can improve it (2026-10 item 276). Without the stand a seat on 21 that walked away
// held the whole table until its turn clock ran out.
function statusAfterCard(hand: Hand): HandStatus {
	const total = handValue(hand.cards).total;
	if (total > BLACKJACK_TARGET) return "bust";
	if (total === BLACKJACK_TARGET) return "stood";
	return "playing";
}

// ── Leaving during a hand (2026-10 item 254, Arcade 12) ──────────────────────

// `cashOut` is the stack the seat walks away with, which the table no longer holds.
export type LeaveOutcome = { status: "left"; cashOut: number } | { status: "not-seated" } | { status: "already-left" };

/**
 * The seat leaves the table, whoever's turn it is, and takes its stack with it (2026-10 item
 * 267). During a hand each of its hands becomes "left", which settles as a loss, never a
 * push: a seat that walked away from a bad hand must not get its bet back. During the betting
 * turns no card was dealt, so a bet already placed goes back to the stack first. The seat
 * stays in `seats` so the settle pass still records that loss. If it was the seat on the
 * clock the turn moves on, and a table with nobody left to act hands the round on. Between a
 * hand that has paid and the next one's bets, the seat simply takes its stack.
 */
export function applyLeave(table: BlackjackTable, userId: string): LeaveOutcome {
	const settledAndPaid = table.phase === "settled" && table.paid && table.buyIn > 0;
	if (table.phase !== "playing" && table.phase !== "betting" && !settledAndPaid) return { status: "not-seated" };
	const seat = table.seats.find((candidate) => candidate.userId === userId);
	if (!seat || seat.out === "broke") return { status: "not-seated" };
	if (seat.out === "left") return { status: "already-left" };
	if (table.phase === "betting") {
		seat.stack += seat.bet;
		seat.bet = 0;
	}
	// A settled hand's cards stay as they were dealt: the result already on the board reads them.
	if (table.phase === "playing") for (const hand of seat.hands) hand.status = "left";
	seat.out = "left";
	const cashOut = seat.stack;
	seat.stack = 0;
	if (table.phase === "betting") advanceBetting(table);
	else if (table.phase === "playing") settleTurn(table);
	return { status: "left", cashOut };
}

// ── Turn advance ────────────────────────────────────────────────────────────

// Walks forward from wherever the pointer is until it finds a hand that can act,
// or runs out of table and hands the round to the dealer. Written as a scan
// rather than an increment because a single action can finish several hands at
// once (splitting aces finishes both halves), and because createTable can deal a
// table where nobody may act at all.
function settleTurn(table: BlackjackTable): void {
	while (table.turn < table.seats.length) {
		const seat = table.seats[table.turn];
		while (seat.activeHand < seat.hands.length && seat.hands[seat.activeHand].status !== "playing") {
			seat.activeHand += 1;
		}
		if (seat.activeHand < seat.hands.length) return;
		table.turn += 1;
	}
	table.phase = "dealer";
}

// ── The dealer ──────────────────────────────────────────────────────────────

// Draws to DEALER_STANDS_ON, hitting soft 17 only when the table says to. Call
// once, after the phase reaches "dealer"; it drives the phase to "settled" itself.
export function playDealer(table: BlackjackTable): void {
	if (table.phase !== "dealer") return;

	// A table where every hand busted needs no dealer draw: the house has already
	// won every hand and drawing would only leak information about the shoe. A
	// natural still needs the dealer played out, because a dealer natural pushes it.
	// A hand given up by a seat that left is as lost as a bust one.
	const anyLive = table.seats.some((seat) => seat.hands.some((hand) => hand.status !== "bust" && hand.status !== "left"));

	if (anyLive) {
		for (;;) {
			const { total, soft } = handValue(table.dealer.cards);
			// Above the floor, including bust: the dealer is done either way.
			if (total > DEALER_STANDS_ON) break;
			// Exactly on the floor: stand, unless this is a SOFT 17 at a table that
			// hits it. Every other 17 stands.
			if (total === DEALER_STANDS_ON && !(soft && table.hitsSoft17)) break;
			table.dealer.cards.push(draw(table));
		}
	}

	const dealerTotal = handValue(table.dealer.cards).total;
	if (dealerTotal > BLACKJACK_TARGET) table.dealer.status = "bust";
	else if (isNatural(table.dealer)) table.dealer.status = "blackjack";
	else table.dealer.status = "stood";

	table.phase = "settled";
}

// ── Settlement ──────────────────────────────────────────────────────────────

export type HandOutcome = "blackjack" | "win" | "push" | "lose";

export interface SeatResult {
	userId: string;
	username: string;
	// One outcome per hand, in hand order, so a split seat reports both halves and
	// the XP payout can price each one separately.
	hands: HandOutcome[];
	doubled: boolean[];
	// Per hand, in hand order: the chips that rode on it and what it pays back.
	bets: number[];
	payouts: number[];
}

/**
 * What a hand pays back to its seat, its bet included (owner decision 6 of 2026-10 item 267):
 * a win pays the bet 1 to 1, a natural 3 to 2 rounded down to whole chips, a push returns the
 * bet, a loss pays nothing.
 */
export function handPayout(outcome: HandOutcome, bet: number): number {
	if (outcome === "blackjack") return bet + Math.floor((bet * 3) / 2);
	if (outcome === "win") return bet * 2;
	if (outcome === "push") return bet;
	return 0;
}

// Compares one hand against the dealer. Order matters: bust loses before
// anything else is considered (a bust hand loses even to a bust dealer, which is
// the house edge in its entirety), then naturals, then totals.
export function resolveHand(hand: Hand, dealer: Hand): HandOutcome {
	// A seat that left gave its hand up, so it loses before the cards are even read.
	if (hand.status === "bust" || hand.status === "left") return "lose";

	const playerNatural = isNatural(hand);
	const dealerNatural = isNatural(dealer);
	if (playerNatural && dealerNatural) return "push";
	if (playerNatural) return "blackjack";
	if (dealerNatural) return "lose";

	const player = handValue(hand.cards).total;
	const house = handValue(dealer.cards).total;

	// Derived from the cards rather than read off dealer.status, so resolveHand
	// stays correct for a caller that never ran playDealer (a test, a re-render
	// after a restart) instead of silently scoring a bust dealer as a live one.
	if (house > BLACKJACK_TARGET) return "win";

	if (player > house) return "win";
	if (player < house) return "lose";
	return "push";
}

// The whole table, every seat dealt this hand, every hand. Safe to call more than once: it
// reads state and writes nothing, so a re-render after a reconnect cannot double pay.
export function settle(table: BlackjackTable): SeatResult[] {
	return table.seats
		.filter((seat) => seat.hands.length > 0)
		.map((seat) => {
			const hands = seat.hands.map((hand) => resolveHand(hand, table.dealer));
			return {
				userId: seat.userId,
				username: seat.username,
				hands,
				doubled: seat.hands.map((hand) => hand.doubled),
				bets: seat.hands.map((hand) => hand.bet),
				payouts: seat.hands.map((hand, index) => handPayout(hands[index], hand.bet)),
			};
		});
}

/**
 * Pay a settled hand into the stacks, once (risk R5): `paid` is claimed before any stack
 * moves, so a second call answers null and pays nothing. A bankroll seat left with no chips
 * is out. A seat that left mid hand gave its hands up and took its stack when it left, so it
 * is paid nothing here.
 */
export function collectPayouts(table: BlackjackTable): SeatResult[] | null {
	if (table.phase !== "settled" || table.paid) return null;
	table.paid = true;
	const results = settle(table);
	for (const result of results) {
		const seat = table.seats.find((candidate) => candidate.userId === result.userId);
		if (!seat || seat.out === "left") continue;
		seat.stack += result.payouts.reduce((sum, payout) => sum + payout, 0);
		if (table.buyIn > 0 && seat.stack <= 0) seat.out = "broke";
	}
	return results;
}

/** A seat's chips at the end of a bankroll table, against what it bought in for. */
export interface FinalStack {
	userId: string;
	buyIn: number;
	stack: number;
}

/**
 * The one winner a bankroll table names (2026-10 item 267): the member whose final stack is
 * the largest AND above their buy in. Null when nobody finished up, or when the largest stack
 * is shared, since a tie names no single winner.
 */
export function bankrollWinnerOf(stacks: readonly FinalStack[]): string | null {
	const ahead = stacks.filter((entry) => entry.stack > entry.buyIn);
	if (ahead.length === 0) return null;
	const best = Math.max(...ahead.map((entry) => entry.stack));
	const leaders = ahead.filter((entry) => entry.stack === best);
	return leaders.length === 1 ? leaders[0].userId : null;
}
