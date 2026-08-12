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
// ⚠️ NO INSURANCE, and it is not an oversight. Insurance is a SIDE BET, and the
// plan fixes v1 at no chips, no wager, no economy (R22). There is nothing to
// insure and nothing to pay it from, so the button would be theatre. Double
// survives the same cut only because it can be re-expressed as a real decision
// without money: take exactly one card, then stand, for a doubled XP stake.

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
// that is final and not bust.
export type HandStatus = "playing" | "stood" | "bust" | "blackjack";

export interface Hand {
	cards: Card[];
	status: HandStatus;
	// Doubled hands pay double. Tracked on the hand rather than the seat because
	// a split seat can double one hand and not the other.
	doubled: boolean;
	// A hand created by splitting. Load bearing: a 21 here is an ordinary 21, NOT
	// a natural, which is the single most commonly mis-implemented blackjack rule.
	fromSplit: boolean;
}

export interface Seat {
	userId: string;
	username: string;
	// One entry until the seat splits. The renderer and the settle pass both walk
	// this, so a solo seat and a four way split take the same code path.
	hands: Hand[];
	activeHand: number;
}

export type TablePhase = "playing" | "dealer" | "settled";

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
}

export type BlackjackAction = "hit" | "stand" | "double" | "split";

function emptyHand(fromSplit = false): Hand {
	return { cards: [], status: "playing", doubled: false, fromSplit };
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
	const card = table.shoe.shift();
	// A six deck shoe cannot be exhausted by any realistic table, but an empty
	// shoe would otherwise surface as `undefined` cards and a NaN total several
	// layers away from the cause. Rebuild rather than throw: a reshuffle is what a
	// real table does, and a thrown error here would kill a live game.
	if (!card) {
		table.shoe = buildShoe();
		return table.shoe.shift() as Card;
	}
	return card;
}

interface CreateTableInput {
	players: Array<{ userId: string; username: string }>;
	rng?: () => number;
	deckCount?: number;
	hitsSoft17?: boolean;
}

// Builds the table AND deals the opening round, because a table that exists but
// is not dealt is a state no caller wants and every caller would have to
// remember to advance past.
//
// Deal order is real casino order: one card to every seat, one to the dealer,
// then a second to every seat and the dealer. It is observably different from
// dealing each hand complete in turn (the cards land in a different order), and
// matching the real thing costs nothing.
export function createTable(input: CreateTableInput): BlackjackTable {
	const table: BlackjackTable = {
		seats: input.players.map((player) => ({
			userId: player.userId,
			username: player.username,
			hands: [emptyHand()],
			activeHand: 0,
		})),
		dealer: emptyHand(),
		shoe: buildShoe(input.deckCount ?? DEFAULT_DECK_COUNT, input.rng ?? Math.random),
		phase: "playing",
		turn: 0,
		hitsSoft17: input.hitsSoft17 ?? false,
	};

	for (let round = 0; round < 2; round += 1) {
		for (const seat of table.seats) seat.hands[0].cards.push(draw(table));
		table.dealer.cards.push(draw(table));
	}

	// Naturals are settled before anyone acts, so a seat dealt 21 never sees a Hit
	// button it must not press.
	for (const seat of table.seats) {
		if (isNatural(seat.hands[0])) seat.hands[0].status = "blackjack";
	}

	// Everyone may already be done (a one seat table dealt a natural), so the turn
	// pointer has to be settled through the same advance logic rather than assumed
	// to be valid.
	settleTurn(table);
	return table;
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

	// Double is a two card decision everywhere. Allowing it on three cards is a
	// house variant nobody expects and it would let a seat double into a stiff.
	if (isOpeningPair) actions.push("double");

	if (isOpeningPair && seat.hands.length < MAX_HANDS_PER_SEAT) {
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
			if (handValue(hand.cards).total > BLACKJACK_TARGET) hand.status = "bust";
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
			hand.cards.push(draw(table));
			hand.status = handValue(hand.cards).total > BLACKJACK_TARGET ? "bust" : "stood";
			break;
		}
		case "split": {
			const moved = hand.cards.pop() as Card;
			const created = emptyHand(true);
			created.cards.push(moved);
			// The original hand is retroactively a split hand too, so neither half can
			// score a natural. Marking only the new one is the subtle version of the
			// same bug isNatural exists to prevent.
			hand.fromSplit = true;
			// Each half draws back up to two cards immediately, which is what a dealer
			// does and what keeps every later pass able to assume a two card minimum.
			hand.cards.push(draw(table));
			created.cards.push(draw(table));
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
	const anyLive = table.seats.some((seat) => seat.hands.some((hand) => hand.status !== "bust"));

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
}

// Compares one hand against the dealer. Order matters: bust loses before
// anything else is considered (a bust hand loses even to a bust dealer, which is
// the house edge in its entirety), then naturals, then totals.
export function resolveHand(hand: Hand, dealer: Hand): HandOutcome {
	if (hand.status === "bust") return "lose";

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

// The whole table, every seat, every hand. Safe to call more than once: it reads
// state and writes nothing, so a re-render after a reconnect cannot double pay.
export function settle(table: BlackjackTable): SeatResult[] {
	return table.seats.map((seat) => ({
		userId: seat.userId,
		username: seat.username,
		hands: seat.hands.map((hand) => resolveHand(hand, table.dealer)),
		doubled: seat.hands.map((hand) => hand.doubled),
	}));
}
