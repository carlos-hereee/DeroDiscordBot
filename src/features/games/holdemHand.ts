// ── holdemHand ──────────────────────────────────────────────────────────────
// What:  evaluates the best five card hand out of seven (two hole cards plus five
//        community cards) and compares two of them.
// Who:   the showdown, and nothing else. Betting and pots never look at a hand.
// When:  once per contested showdown, per player still in.
// Where: PURE. No Discord, no store, no rng. That is what makes an exhaustive
//        test possible, and exhaustive is the bar here: a hand evaluator that is
//        subtly wrong pays the wrong player and nobody notices for weeks, because
//        every individual result still LOOKS like a poker hand.
// How:   reduce a hand to a CATEGORY plus an ordered list of tie-break ranks, then
//        compare the two lexicographically. One comparison rule for all nine
//        categories rather than nine bespoke ones.

export type Suit = "s" | "h" | "d" | "c";

// 2 through 14, where 14 is the ace. Storing the ace HIGH and special-casing the
// wheel in one place beats storing it low and special-casing it everywhere else.
export interface Card {
	rank: number;
	suit: Suit;
}

export const RANK_LABELS: Record<number, string> = {
	2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
	10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

// Ordered worst to best, so the index IS the comparison. A named union plus a
// lookup would let the two drift; an ordered tuple cannot.
export const HAND_CATEGORIES = [
	"high card",
	"pair",
	"two pair",
	"three of a kind",
	"straight",
	"flush",
	"full house",
	"four of a kind",
	"straight flush",
] as const;

export type HandCategory = (typeof HAND_CATEGORIES)[number];

export interface HandValue {
	category: HandCategory;
	// The tie-break ranks, most significant first. Its LENGTH and MEANING differ by
	// category (a full house is [trips, pair]; a flush is its five ranks) and that is
	// fine, because two hands of the same category always produce the same shape.
	ranks: number[];
	// The five cards that made it, for rendering. Never used in comparison.
	cards: Card[];
}

const byRankDesc = (a: Card, b: Card): number => b.rank - a.rank;

// Group cards by rank, ordered by count first and rank second. That single
// ordering is what makes pairs, trips, quads and full houses fall out of one pass:
// the first group is always the most significant part of the hand.
function rankGroups(cards: Card[]): { rank: number; cards: Card[] }[] {
	const byRank = new Map<number, Card[]>();
	for (const card of cards) {
		const existing = byRank.get(card.rank);
		if (existing) existing.push(card);
		else byRank.set(card.rank, [card]);
	}
	return [...byRank.entries()]
		.map(([rank, group]) => ({ rank, cards: group }))
		.sort((a, b) => b.cards.length - a.cards.length || b.rank - a.rank);
}

// The highest straight inside a set of cards, or null.
//
// ⚠️ THE WHEEL IS THE CASE EVERY NAIVE IMPLEMENTATION GETS WRONG. A-2-3-4-5 is a
// straight whose HIGH CARD IS THE FIVE, not the ace, so it is the lowest straight
// rather than the highest. Handled by appending a rank-1 alias for every ace before
// the scan, which lets one loop find it without a second special case.
function findStraight(cards: Card[]): { high: number; cards: Card[] } | null {
	const seen = new Map<number, Card>();
	for (const card of cards) {
		if (!seen.has(card.rank)) seen.set(card.rank, card);
		// The ace also plays low.
		if (card.rank === 14 && !seen.has(1)) seen.set(1, card);
	}

	const ranks = [...seen.keys()].sort((a, b) => b - a);
	let run: number[] = [];
	for (const rank of ranks) {
		if (run.length === 0 || run[run.length - 1] - rank === 1) run.push(rank);
		else if (run[run.length - 1] !== rank) run = [rank];
		if (run.length === 5) {
			return { high: run[0], cards: run.map((value) => seen.get(value)!) };
		}
	}
	return null;
}

function flushSuit(cards: Card[]): Suit | null {
	const counts = new Map<Suit, number>();
	for (const card of cards) counts.set(card.suit, (counts.get(card.suit) ?? 0) + 1);
	for (const [suit, count] of counts) if (count >= 5) return suit;
	return null;
}

/**
 * Evaluate the best five card hand from five, six or seven cards.
 *
 * Throws on fewer than five, because a caller with four cards has a bug rather
 * than a weak hand, and returning a "high card" for it would hide that.
 */
export function evaluateHand(cards: Card[]): HandValue {
	if (cards.length < 5) throw new Error(`holdem: need at least 5 cards to evaluate, got ${cards.length}`);

	const suited = flushSuit(cards);

	// ① Straight flush. Checked FIRST and against the flush suit's cards only: a
	// board with five hearts and a separate straight in mixed suits is a flush and a
	// straight, never a straight flush, and scanning all seven would claim otherwise.
	if (suited) {
		const suitedCards = cards.filter((card) => card.suit === suited);
		const straightFlush = findStraight(suitedCards);
		if (straightFlush) {
			return { category: "straight flush", ranks: [straightFlush.high], cards: straightFlush.cards };
		}
	}

	const groups = rankGroups(cards);
	const kickers = (used: number[], count: number): Card[] =>
		cards
			.filter((card) => !used.includes(card.rank))
			.sort(byRankDesc)
			.slice(0, count);

	// ② Four of a kind.
	if (groups[0].cards.length === 4) {
		const quad = groups[0];
		const kicker = kickers([quad.rank], 1);
		return { category: "four of a kind", ranks: [quad.rank, kicker[0]?.rank ?? 0], cards: [...quad.cards, ...kicker] };
	}

	// ③ Full house. The SECOND group may itself be trips (two sets of three in
	// seven cards), in which case only its top two cards play, and the higher trips
	// is the set. The group ordering above already puts them in that order.
	const trips = groups.find((group) => group.cards.length === 3);
	const pairAfterTrips = groups.find((group) => group !== trips && group.cards.length >= 2);
	if (trips && pairAfterTrips) {
		return {
			category: "full house",
			ranks: [trips.rank, pairAfterTrips.rank],
			cards: [...trips.cards, ...pairAfterTrips.cards.slice(0, 2)],
		};
	}

	// ④ Flush. The five HIGHEST cards of the suit, which is not always the first
	// five found.
	if (suited) {
		const suitedCards = cards.filter((card) => card.suit === suited).sort(byRankDesc).slice(0, 5);
		return { category: "flush", ranks: suitedCards.map((card) => card.rank), cards: suitedCards };
	}

	// ⑤ Straight.
	const straight = findStraight(cards);
	if (straight) return { category: "straight", ranks: [straight.high], cards: straight.cards };

	// ⑥ Three of a kind.
	if (trips) {
		const kicker = kickers([trips.rank], 2);
		return {
			category: "three of a kind",
			ranks: [trips.rank, ...kicker.map((card) => card.rank)],
			cards: [...trips.cards, ...kicker],
		};
	}

	// ⑦ Two pair. With THREE pairs in seven cards only the top two play, and the
	// kicker is the best remaining card, which may be the third pair's rank.
	const pairs = groups.filter((group) => group.cards.length === 2);
	if (pairs.length >= 2) {
		const [high, low] = pairs;
		const kicker = kickers([high.rank, low.rank], 1);
		return {
			category: "two pair",
			ranks: [high.rank, low.rank, kicker[0]?.rank ?? 0],
			cards: [...high.cards, ...low.cards, ...kicker],
		};
	}

	// ⑧ One pair.
	if (pairs.length === 1) {
		const pair = pairs[0];
		const kicker = kickers([pair.rank], 3);
		return {
			category: "pair",
			ranks: [pair.rank, ...kicker.map((card) => card.rank)],
			cards: [...pair.cards, ...kicker],
		};
	}

	// ⑨ High card.
	const best = [...cards].sort(byRankDesc).slice(0, 5);
	return { category: "high card", ranks: best.map((card) => card.rank), cards: best };
}

/**
 * Compare two evaluated hands. Positive when `a` wins, negative when `b` wins,
 * ZERO when they genuinely tie and the pot must be split.
 *
 * ⚠️ A TIE IS A REAL RESULT, not a rounding error. Two players can hold the same
 * hand when the board plays, and a comparator that never returns 0 would silently
 * hand a split pot to whichever player happened to be compared first.
 */
export function compareHands(a: HandValue, b: HandValue): number {
	const categoryDelta = HAND_CATEGORIES.indexOf(a.category) - HAND_CATEGORIES.indexOf(b.category);
	if (categoryDelta !== 0) return categoryDelta;

	for (let index = 0; index < Math.max(a.ranks.length, b.ranks.length); index++) {
		const delta = (a.ranks[index] ?? 0) - (b.ranks[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

// Render a hand for the showdown card. Suits are the four Unicode pips rather than
// letters, because a table shows five of these side by side and "Ah Kd" is harder
// to read at a glance than "A♥ K♦".
const SUIT_PIPS: Record<Suit, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

export function formatCard(card: Card): string {
	return `${RANK_LABELS[card.rank] ?? card.rank}${SUIT_PIPS[card.suit]}`;
}

export function formatHand(value: HandValue): string {
	return `${value.category} (${value.cards.map(formatCard).join(" ")})`;
}

// A full 52 card deck in a fixed order. Shuffling is the caller's job, with an
// injectable rng, so a test can deal a known board.
export function freshDeck(): Card[] {
	const suits: Suit[] = ["s", "h", "d", "c"];
	const deck: Card[] = [];
	for (const suit of suits) for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
	return deck;
}

// Fisher-Yates, rng injected so production takes Math.random and a test can pin a
// deal. Returns a NEW array; the input is untouched.
export function shuffle(deck: Card[], rng: () => number = Math.random): Card[] {
	const out = [...deck];
	for (let index = out.length - 1; index > 0; index--) {
		const swap = Math.floor(rng() * (index + 1));
		[out[index], out[swap]] = [out[swap], out[index]];
	}
	return out;
}
