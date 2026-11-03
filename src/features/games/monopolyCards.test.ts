import { describe, it, expect } from "vitest";
import { BOARD, BOARD_SIZE, GO_INDEX, boardIndicesOfKind, isOwnableTile } from "./monopolyBoard.js";
import {
	CHANCE_DECK,
	CHEST_DECK,
	drawCard,
	drawCardFromState,
	findCard,
	heldJailCardIds,
	returnJailCards,
	shuffleDeck,
	shuffleStartingDecks,
	type MonopolyCard,
} from "./monopolyCards.js";
import { createInitialState, type MonopolyState } from "./monopolyState.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SEED = 241;
const DECK_SIZE = 16;
const ALL_CARDS = [...CHANCE_DECK, ...CHEST_DECK];

const newMatch = (): MonopolyState => createInitialState(["alice", "bob"], { auctionsEnabled: false }, 1_000, SEED);

// Where a moving card sends a token standing on `from`, or null for a card that
// does not move it. Mirrors the engine's three movement rules so the deck data
// can be checked without playing a match.
function destinationOf(card: MonopolyCard, from: number): number | null {
	if (card.kind === "advance") return card.destination;
	if (card.kind === "go-back") return (from - card.steps + BOARD_SIZE) % BOARD_SIZE;
	if (card.kind !== "advance-nearest") return null;
	const targets = boardIndicesOfKind(card.target);
	return targets.find((index) => index > from) ?? targets[0];
}

const isCardLane = (index: number): boolean => BOARD[index].kind === "chance" || BOARD[index].kind === "chest";

// ── the decks ───────────────────────────────────────────────────────────────

describe("the decks", () => {
	it("hold 16 cards each, with ids unique across both and one jail card apiece", () => {
		expect(CHANCE_DECK).toHaveLength(DECK_SIZE);
		expect(CHEST_DECK).toHaveLength(DECK_SIZE);
		expect(new Set(ALL_CARDS.map((card) => card.id)).size).toBe(DECK_SIZE * 2);
		expect(CHANCE_DECK.filter((card) => card.kind === "get-out-of-jail")).toHaveLength(1);
		expect(CHEST_DECK.filter((card) => card.kind === "get-out-of-jail")).toHaveLength(1);
	});

	it("keeps amounts out of the flavor text, so each number lives on the card's fields", () => {
		for (const card of ALL_CARDS) {
			expect(card.flavor).not.toMatch(/\d/);
			expect(card.title.length).toBeGreaterThan(0);
		}
	});

	it("carries no long dash and no spaced hyphen used as a dash", () => {
		// Built from code points so this file itself carries no long dash.
		const longDashes = [String.fromCodePoint(0x2013), String.fromCodePoint(0x2014)];
		for (const card of ALL_CARDS) {
			for (const text of [card.title, card.flavor]) {
				for (const dash of longDashes) expect(text).not.toContain(dash);
				expect(text).not.toContain(" - ");
			}
		}
	});

	it("only advances to GO or to a lot", () => {
		for (const card of ALL_CARDS) {
			if (card.kind !== "advance") continue;
			expect(card.destination === GO_INDEX || isOwnableTile(BOARD[card.destination])).toBe(true);
		}
	});

	it("chains at most one extra draw: only Go Back Three reaches a card lane, and only into the Chest deck", () => {
		const chained: string[] = [];
		BOARD.forEach((tile, lane) => {
			if (tile.kind !== "chance" && tile.kind !== "chest") return;
			const deck = tile.kind === "chance" ? CHANCE_DECK : CHEST_DECK;
			for (const card of deck) {
				const destination = destinationOf(card, lane);
				if (destination !== null && isCardLane(destination)) chained.push(`${card.id}@${lane}>${BOARD[destination].kind}`);
			}
		});
		expect(chained).toEqual(["chance-go-back@36>chest"]);
		// So a chained draw is always a Chest card, and no Chest card moves onto a
		// card lane from anywhere on the board.
		for (const card of CHEST_DECK) {
			for (let from = 0; from < BOARD_SIZE; from++) {
				const destination = destinationOf(card, from);
				if (destination !== null) expect(isCardLane(destination)).toBe(false);
			}
		}
	});
});

// ── shuffle ─────────────────────────────────────────────────────────────────

describe("shuffleDeck", () => {
	it("is a deterministic permutation of the deck for a seed", () => {
		const first = shuffleDeck(CHANCE_DECK, SEED);
		expect(shuffleDeck(CHANCE_DECK, SEED)).toEqual(first);
		expect([...first].sort()).toEqual(CHANCE_DECK.map((card) => card.id).sort());
		expect(shuffleDeck(CHANCE_DECK, SEED + 1)).not.toEqual(first);
	});

	it("gives the two starting decks different permutations from one seed", () => {
		const decks = shuffleStartingDecks(SEED);
		expect(shuffleStartingDecks(SEED)).toEqual(decks);
		const chanceOrder = decks.chance.map((id) => CHANCE_DECK.findIndex((card) => card.id === id));
		const chestOrder = decks.chest.map((id) => CHEST_DECK.findIndex((card) => card.id === id));
		expect(chestOrder).not.toEqual(chanceOrder);
	});
});

// ── draw ────────────────────────────────────────────────────────────────────

describe("drawCard", () => {
	it("takes the top card and puts it on the bottom of the discard", () => {
		const { card, deck, discard } = drawCard(["chance-dividend", "chance-loan"], ["chance-speeding"]);
		expect(card.id).toBe("chance-dividend");
		expect(deck).toEqual(["chance-loan"]);
		expect(discard).toEqual(["chance-speeding", "chance-dividend"]);
	});

	it("turns the discard over in order when the draw pile is empty", () => {
		const { card, deck, discard } = drawCard([], ["chance-speeding", "chance-loan"]);
		expect(card.id).toBe("chance-speeding");
		expect(deck).toEqual(["chance-loan"]);
		expect(discard).toEqual(["chance-speeding"]);
	});

	it("keeps a Get Out of Jail Free card out of both piles", () => {
		const { card, deck, discard } = drawCard(["chest-jail-free", "chest-go"], []);
		expect(card.kind).toBe("get-out-of-jail");
		expect(deck).toEqual(["chest-go"]);
		expect(discard).toEqual([]);
	});

	it("rotates a whole deck back to its starting order", () => {
		let deck = shuffleDeck(CHEST_DECK, SEED).filter((id) => id !== "chest-jail-free");
		let discard: string[] = [];
		const drawn: string[] = [];
		for (let draw = 0; draw < (DECK_SIZE - 1) * 2; draw++) {
			const result = drawCard(deck, discard);
			drawn.push(result.card.id);
			deck = result.deck;
			discard = result.discard;
		}
		expect(drawn.slice(DECK_SIZE - 1)).toEqual(drawn.slice(0, DECK_SIZE - 1));
	});

	it("throws on two empty piles and on an id no deck defines", () => {
		expect(() => drawCard([], [])).toThrow(/empty Monopoly deck/);
		expect(() => drawCard(["no-such-card"], [])).toThrow(/No Monopoly card has the id no-such-card/);
		expect(findCard("chest-go").title).toBe("Homeward Bound");
	});
});

// ── decks on a match ────────────────────────────────────────────────────────

describe("decks on a match", () => {
	it("draws from the match's piles and stores the new ones", () => {
		const state = newMatch();
		const top = state.chanceDeck[0];
		const card = drawCardFromState(state, "chance");
		expect(card.id).toBe(top);
		expect(state.chanceDeck).toHaveLength(DECK_SIZE - 1);
		expect(state.chestDeck).toHaveLength(DECK_SIZE);
	});

	it("shuffles a deck in on the first draw of a match stored before the decks existed", () => {
		const legacy = (): MonopolyState => Object.assign(newMatch(), { chestDeck: [], chestDiscard: [] });
		const first = legacy();
		const card = drawCardFromState(first, "chest");
		expect(first.chestDeck.length + first.chestDiscard.length).toBe(card.kind === "get-out-of-jail" ? DECK_SIZE - 1 : DECK_SIZE);
		expect(drawCardFromState(legacy(), "chest").id).toBe(card.id);
	});

	it("derives which jail cards are held from what is missing in each started deck", () => {
		const state = newMatch();
		expect(heldJailCardIds(state)).toEqual([]);
		state.chestDeck = state.chestDeck.filter((id) => id !== "chest-jail-free");
		state.chanceDeck = state.chanceDeck.filter((id) => id !== "chance-jail-free");
		expect(heldJailCardIds(state)).toEqual(["chance-jail-free", "chest-jail-free"]);
		// An unstarted deck (both piles empty) holds nothing and has nothing out.
		Object.assign(state, { chanceDeck: [], chanceDiscard: [] });
		expect(heldJailCardIds(state)).toEqual(["chest-jail-free"]);
	});

	it("returns held jail cards to the bottom of their own decks, up to the count", () => {
		const state = newMatch();
		state.chanceDeck = state.chanceDeck.filter((id) => id !== "chance-jail-free");
		state.chestDeck = state.chestDeck.filter((id) => id !== "chest-jail-free");
		state.chestDiscard = ["chest-go"];
		returnJailCards(state, 1);
		expect(state.chanceDiscard).toEqual(["chance-jail-free"]);
		expect(state.chestDiscard).toEqual(["chest-go"]);
		returnJailCards(state, 2);
		expect(state.chestDiscard).toEqual(["chest-go", "chest-jail-free"]);
		returnJailCards(state, 1);
		expect(heldJailCardIds(state)).toEqual([]);
		expect(state.chanceDiscard).toEqual(["chance-jail-free"]);
	});
});
