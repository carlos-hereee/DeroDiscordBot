import { createSeededRng } from "@utils/seededRng.js";
import { GO_INDEX, boardIndexOf } from "./monopolyBoard.js";
import { shuffle } from "./holdemHand.js";
import type { CardId, MonopolyState } from "./monopolyState.js";

// ── monopolyCards ───────────────────────────────────────────────────────────
// What:  the Chance and Community Chest decks as pure data, the seeded shuffle a
//        match starts with, the draw, and the bookkeeping that keeps the two Get
//        Out of Jail Free cards in the right deck.
// Who:   createInitialState (the starting shuffle), monopolyLanding (a draw on a
//        card lane, then applying it), monopolyJail (spending a held card) and
//        monopolyForfeit (returning held cards). Applying a card's EFFECT lives in
//        monopolyLanding, because most effects move a token or charge a debt.
// When:  at match start and on every landing on one of the six card lanes.
// Where: src/features/games beside the board. The persisted piles are card ids
//        on MonopolyState; the definitions stay here, so a stored match never
//        carries card text that could drift from this file.
// How:   a draw takes the top of the draw pile. A spent card goes to the bottom
//        of the discard pile, and when the draw pile runs dry the discard is
//        turned over in order. That is the standard "bottom of the deck" rule
//        written as two piles, so the order a match sees is fixed by its seed.
//
// Card names and flavor are Dero world inventions by owner decision (2026-10
// item 241): no Hasbro card text or place names. The effects and amounts are the
// standard US deck.

// ── types ────────────────────────────────────────────────────────────────────

export type CardDeckKind = "chance" | "chest";

interface CardText {
	id: CardId;
	title: string;
	// Theme only, with no amounts in it: the trail line states the effect from the
	// card's fields, so a number lives in exactly one place.
	flavor: string;
}

export type MonopolyCard = CardText &
	(
		| { kind: "collect"; amount: number }
		| { kind: "pay"; amount: number }
		| { kind: "collect-from-each"; amount: number }
		| { kind: "pay-each"; amount: number }
		// Board position to move forward to, passing GO on the way when it wraps.
		| { kind: "advance"; destination: number }
		// boostedRent charges the card rent (twice the transport rent, ten times the
		// dice on a utility) instead of the plain landing rent.
		| { kind: "advance-nearest"; target: "railroad" | "utility"; boostedRent: boolean }
		| { kind: "go-back"; steps: number }
		| { kind: "go-to-jail" }
		| { kind: "get-out-of-jail" }
		| { kind: "repairs"; perHouse: number; perHotel: number }
	);

export interface CardDraw {
	card: MonopolyCard;
	deck: CardId[];
	discard: CardId[];
}

// ── decks ────────────────────────────────────────────────────────────────────

export const CHANCE_DECK: readonly MonopolyCard[] = [
	{ id: "chance-sapphire-keep", kind: "advance", destination: boardIndexOf("sapphire-keep"), title: "Summons to Sapphire Keep", flavor: "Dero found a banquet at the Keep and saved you a seat." },
	{ id: "chance-go", kind: "advance", destination: GO_INDEX, title: "Ring the Starting Bell", flavor: "Dero rings the bell and waves you all the way home." },
	{ id: "chance-crimson-gate", kind: "advance", destination: boardIndexOf("crimson-gate"), title: "March on Crimson Gate", flavor: "The gate captain wants a word, and Dero will not say about what." },
	{ id: "chance-rosequartz-court", kind: "advance", destination: boardIndexOf("rosequartz-court"), title: "Audience at Rosequartz Court", flavor: "The court jesters asked for you by name." },
	{ id: "chance-nearest-transport-1", kind: "advance-nearest", target: "railroad", boostedRent: true, title: "Catch the Next Ride", flavor: "Dero hails whatever is leaving soonest and shoves you aboard." },
	{ id: "chance-nearest-transport-2", kind: "advance-nearest", target: "railroad", boostedRent: true, title: "Hitch a Lift", flavor: "A driver owes Dero a favor, and you are the favor." },
	{ id: "chance-nearest-utility", kind: "advance-nearest", target: "utility", boostedRent: true, title: "Follow the Cable", flavor: "Dero tripped over a cable. Follow it to whatever it powers." },
	{ id: "chance-dividend", kind: "collect", amount: 50, title: "Guild Dividend", flavor: "Your shares in the Dero Trading Guild paid out." },
	{ id: "chance-jail-free", kind: "get-out-of-jail", title: "Dero's Spare Key", flavor: "Dero copied the jailer's key. Keep it until you need it." },
	{ id: "chance-go-back", kind: "go-back", steps: 3, title: "Wrong Turn", flavor: "Dero read the map upside down again." },
	{ id: "chance-jail", kind: "go-to-jail", title: "Caught Red Handed", flavor: "The watch caught you holding Dero's snack stash." },
	{ id: "chance-repairs", kind: "repairs", perHouse: 25, perHotel: 100, title: "Storm Season", flavor: "A storm rattled every roof you own." },
	{ id: "chance-speeding", kind: "pay", amount: 15, title: "Cart Speeding Fine", flavor: "Racing Dero's cart through the market was frowned upon." },
	{ id: "chance-skyrail", kind: "advance", destination: boardIndexOf("skyrail-station"), title: "Ride the Skyrail", flavor: "Dero bought you a ticket and lost the return half." },
	{ id: "chance-chairman", kind: "pay-each", amount: 50, title: "Elected Arcade Chair", flavor: "The arcade made you its chair, and every rival expects a gift." },
	{ id: "chance-loan", kind: "collect", amount: 150, title: "Forge Loan Matures", flavor: "Your loan to the smiths came back with interest." },
];

export const CHEST_DECK: readonly MonopolyCard[] = [
	{ id: "chest-go", kind: "advance", destination: GO_INDEX, title: "Homeward Bound", flavor: "Dero carries you home on its back, grumbling all the way." },
	{ id: "chest-bank-error", kind: "collect", amount: 200, title: "Ledger Mixup", flavor: "The bank counted your coins twice and will not admit it." },
	{ id: "chest-healer", kind: "pay", amount: 50, title: "Healer's Visit", flavor: "You tried to pet Dero while it was eating." },
	{ id: "chest-market", kind: "collect", amount: 50, title: "Market Windfall", flavor: "Your lantern stall sold out before noon." },
	{ id: "chest-jail-free", kind: "get-out-of-jail", title: "Pardon Scroll", flavor: "A sealed pardon, signed with a paw print. Keep it until you need it." },
	{ id: "chest-jail", kind: "go-to-jail", title: "Mistaken Identity", flavor: "The watch swears it was you. Dero is not helping." },
	{ id: "chest-festival", kind: "collect", amount: 100, title: "Festival Fund", flavor: "The harvest festival fund pays its members." },
	{ id: "chest-tax-refund", kind: "collect", amount: 20, title: "Tax Refund", flavor: "The collector finally checked his own sums." },
	{ id: "chest-hatching-day", kind: "collect-from-each", amount: 10, title: "Hatching Day", flavor: "It is your hatching day, and every rival chips in." },
	{ id: "chest-shield-policy", kind: "collect", amount: 100, title: "Shield Policy Pays", flavor: "Your shield policy matured without a single dent." },
	{ id: "chest-infirmary", kind: "pay", amount: 100, title: "Infirmary Bill", flavor: "The infirmary patched you up and sent the bill." },
	{ id: "chest-academy", kind: "pay", amount: 50, title: "Academy Fees", flavor: "Term fees are due at the arcade academy." },
	{ id: "chest-advice", kind: "collect", amount: 25, title: "Advice for Hire", flavor: "A merchant paid for your opinion on lanterns." },
	{ id: "chest-road-levy", kind: "repairs", perHouse: 40, perHotel: 115, title: "Road Levy", flavor: "The roads outside your buildings need patching." },
	{ id: "chest-lookalike", kind: "collect", amount: 10, title: "Second Prize", flavor: "You placed second in the Dero lookalike contest." },
	{ id: "chest-inheritance", kind: "collect", amount: 100, title: "Inheritance", flavor: "A distant aunt left you a chest of coins." },
];

const CARDS_BY_DECK: Record<CardDeckKind, readonly MonopolyCard[]> = { chance: CHANCE_DECK, chest: CHEST_DECK };

const CARD_BY_ID = new Map<CardId, { card: MonopolyCard; deckKind: CardDeckKind }>([
	...CHANCE_DECK.map((card) => [card.id, { card, deckKind: "chance" as const }] as const),
	...CHEST_DECK.map((card) => [card.id, { card, deckKind: "chest" as const }] as const),
]);

function lookupCard(cardId: CardId): { card: MonopolyCard; deckKind: CardDeckKind } {
	const found = CARD_BY_ID.get(cardId);
	// Only a hand edited or corrupted row can hold an id no deck defines.
	if (!found) throw new Error(`No Monopoly card has the id ${cardId}`);
	return found;
}

/** The card definition behind a persisted card id. */
export const findCard = (cardId: CardId): MonopolyCard => lookupCard(cardId).card;

// ── shuffle and draw ─────────────────────────────────────────────────────────

/** The deck's card ids in a seeded random order. The same seed gives the same order. */
export function shuffleDeck(deck: readonly MonopolyCard[], seed: number): CardId[] {
	return shuffle(
		deck.map((card) => card.id),
		createSeededRng(seed)
	);
}

/**
 * Draws the top card. A spent card goes to the bottom of the discard pile; a
 * Get Out of Jail Free card leaves both piles, because its drawer holds it until
 * it is used. An empty draw pile turns the discard over first. Throws when both
 * piles are empty, which a started deck can never be: only the two jail cards
 * ever leave them.
 */
export function drawCard(deck: readonly CardId[], discard: readonly CardId[]): CardDraw {
	const drawPile = deck.length > 0 ? deck : discard;
	const keptDiscard = deck.length > 0 ? [...discard] : [];
	if (drawPile.length === 0) throw new Error("Cannot draw from an empty Monopoly deck");

	const [topId, ...rest] = drawPile;
	const card = findCard(topId);
	if (card.kind !== "get-out-of-jail") keptDiscard.push(topId);
	return { card, deck: rest, discard: keptDiscard };
}

// ── decks on a match ─────────────────────────────────────────────────────────
// Everything below works on a MonopolyState clone. These mutate the state they
// are handed, like the helpers in monopolySeats.

const PILE_KEYS = {
	chance: { deck: "chanceDeck", discard: "chanceDiscard" },
	chest: { deck: "chestDeck", discard: "chestDiscard" },
} as const satisfies Record<CardDeckKind, { deck: keyof MonopolyState; discard: keyof MonopolyState }>;

// Both decks shuffle from one match seed. Mixing a constant into the Chest seed
// keeps the two decks from sharing a permutation, which they would with one seed
// because both hold 16 cards.
const CHEST_SEED_MIX = 0x5bd1e995;

/** Both draw piles for a new match, shuffled from its seed. */
export function shuffleStartingDecks(seed: number): Record<CardDeckKind, CardId[]> {
	return { chance: shuffleDeck(CHANCE_DECK, seed), chest: shuffleDeck(CHEST_DECK, seed ^ CHEST_SEED_MIX) };
}

/**
 * Draws from a match's deck and stores the new piles on it. A match persisted
 * before the decks existed (Phase 1 of 2026-10 item 241) has both piles empty;
 * its first draw shuffles the deck in, seeded from turnStartedAt so a replay of
 * the same stored state draws the same card.
 */
export function drawCardFromState(state: MonopolyState, deckKind: CardDeckKind): MonopolyCard {
	const keys = PILE_KEYS[deckKind];
	if (state[keys.deck].length === 0 && state[keys.discard].length === 0) {
		state[keys.deck] = shuffleDeck(CARDS_BY_DECK[deckKind], state.turnStartedAt);
	}
	const draw = drawCard(state[keys.deck], state[keys.discard]);
	state[keys.deck] = draw.deck;
	state[keys.discard] = draw.discard;
	return draw.card;
}

/**
 * The Get Out of Jail Free card ids some seat is holding right now, Chance first.
 *
 * A seat keeps only a COUNT of jail cards (the persisted shape from Section 5 of
 * the plan, which Phase 3 trades also move as a count). Which card is held is
 * derived instead: a jail card missing from both piles of its own started deck
 * is in somebody's hand. With two holders the engine cannot tell whose card is
 * whose, and it does not need to, since the two cards do the same thing. The
 * only effect is which deck a returned card rejoins first; once both are spent
 * both decks are whole again.
 */
export function heldJailCardIds(state: MonopolyState): CardId[] {
	const held: CardId[] = [];
	for (const deckKind of ["chance", "chest"] as const) {
		const keys = PILE_KEYS[deckKind];
		const inPlay = new Set([...state[keys.deck], ...state[keys.discard]]);
		// An unstarted deck (a Phase 1 match) has nothing in play and nothing out.
		if (inPlay.size === 0) continue;
		for (const card of CARDS_BY_DECK[deckKind]) {
			if (card.kind === "get-out-of-jail" && !inPlay.has(card.id)) held.push(card.id);
		}
	}
	return held;
}

/**
 * Puts up to `count` held jail cards back at the bottom of their own decks: one
 * when a seat spends its card, all of a seat's cards when it forfeits. A count
 * with no card missing from the piles (a hand edited state) returns nothing.
 */
export function returnJailCards(state: MonopolyState, count: number): void {
	for (const cardId of heldJailCardIds(state).slice(0, count)) {
		const keys = PILE_KEYS[lookupCard(cardId).deckKind];
		state[keys.discard] = [...state[keys.discard], cardId];
	}
}
