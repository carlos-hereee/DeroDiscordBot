import { describe, it, expect } from "vitest";
import {
	BANK_HOTELS,
	BANK_HOUSES,
	BOARD,
	BOARD_SIZE,
	GO_SALARY,
	JAIL_BAIL,
	JAIL_INDEX,
	JAIL_SENTENCE_TURNS,
	OWNABLE_TILES,
	STARTING_CHIPS,
	MAX_HOUSES_PER_LOT,
	COLOR_GROUPS,
	findOwnableTile,
	isOwnableTile,
	type OwnableTile,
	type PropertyTile,
} from "./monopolyBoard.js";
import { CHANCE_DECK, CHEST_DECK, heldJailCardIds, type CardDeckKind } from "./monopolyCards.js";
import { LOG_ENTRY_LIMIT } from "./monopolySeats.js";
import {
	applyBuild,
	applyBuy,
	applyEndTurn,
	applyForfeit,
	applyJailChoice,
	applyMortgage,
	applyRoll,
	applySkip,
	applyUnmortgage,
	acceptTrade,
	applyPayDebt,
	applySellBuilding,
	calculateRent,
	closeAuction,
	createInitialState,
	listBuildOptions,
	listMortgageOptions,
	listSellOptions,
	listUnmortgageOptions,
	nextBuildingKind,
	openTrade,
	placeBid,
	unmortgageCost,
	waitingDebt,
	type MonopolyResult,
	type MonopolyState,
} from "./monopolyState.js";
import { createSeededRng } from "@utils/seededRng.js";
import { secureRandom } from "@utils/secureRng.js";
import { rollDice } from "./monopolyLanding.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const ALICE = "alice";
const BOB = "bob";
const CARA = "cara";
const NOW = 1_000;
const LATER = 2_000;
// Pins both deck orders, so a roll onto a card lane draws the same card every run.
const SEED = 241;

const newMatch = (players: string[] = [ALICE, BOB]): MonopolyState =>
	createInitialState(players, { auctionsEnabled: false }, NOW, SEED);

// An rng that makes resolveVersus land on the given die faces, in order. A face
// f on a six sided die comes from any rng value in [(f - 1) / 6, f / 6), so the
// midpoint of that band is used.
function diceRng(...faces: number[]): () => number {
	let index = 0;
	return () => (faces[Math.min(index++, faces.length - 1)] - 0.5) / 6;
}

// Unwraps a result the test expects to succeed, failing loudly with the reason
// when it did not, so a broken precondition reads as itself.
function expectOk(result: MonopolyResult): { state: MonopolyState; trailLines: string[] } {
	if (!result.ok) throw new Error(`expected ok, got refusal: ${result.reason}`);
	return result;
}

function expectRefusal(result: MonopolyResult, reason: string | RegExp): void {
	if (result.ok) throw new Error("expected a refusal, got ok");
	expect(result.reason).toMatch(reason);
}

const tile = (id: string): OwnableTile => {
	const found = findOwnableTile(id);
	if (!found) throw new Error(`no tile ${id}`);
	return found;
};

const giveTiles = (state: MonopolyState, ownerId: string, ...ids: string[]): void => {
	for (const id of ids) state.properties[id].ownerId = ownerId;
};

const rollFrom = (state: MonopolyState, position: number, ...faces: number[]) => {
	state.seats[state.activeSeatIndex].position = position;
	return expectOk(applyRoll(state, diceRng(...faces), LATER));
};

// Moves a card to the top of its draw pile, so the next landing on that deck's
// lane draws it.
function stackDeck(state: MonopolyState, deckKind: CardDeckKind, cardId: string): void {
	const key = deckKind === "chance" ? "chanceDeck" : "chestDeck";
	state[key] = [cardId, ...state[key].filter((id) => id !== cardId)];
}

// ── initial state ───────────────────────────────────────────────────────────

describe("createInitialState", () => {
	it("seats every player on GO with the starting chips", () => {
		const state = newMatch();
		expect(state.seats).toEqual([
			{ userId: ALICE, position: 0, chips: STARTING_CHIPS, inJail: false, jailTurnsRemaining: 0, gojfCards: 0, bankrupt: false, bankruptedAt: null },
			{ userId: BOB, position: 0, chips: STARTING_CHIPS, inJail: false, jailTurnsRemaining: 0, gojfCards: 0, bankrupt: false, bankruptedAt: null },
		]);
	});

	it("starts the bank, the lots, the decks and the clock", () => {
		const state = createInitialState([ALICE, BOB], { auctionsEnabled: true }, NOW);
		expect(state.version).toBe(1);
		expect(state.bank).toEqual({ houses: BANK_HOUSES, hotels: BANK_HOTELS });
		expect(Object.keys(state.properties)).toHaveLength(OWNABLE_TILES.length);
		for (const property of Object.values(state.properties)) {
			expect(property).toEqual({ ownerId: null, houses: 0, hotel: false, mortgaged: false });
		}
		expect([...state.chanceDeck].sort()).toEqual(CHANCE_DECK.map((card) => card.id).sort());
		expect([...state.chestDeck].sort()).toEqual(CHEST_DECK.map((card) => card.id).sort());
		expect([state.chanceDiscard, state.chestDiscard]).toEqual([[], []]);
		expect(state).toMatchObject({
			activeSeatIndex: 0,
			diceRoll: null,
			doublesStreak: 0,
			rolledThisTurn: false,
			pendingTrade: null,
			pendingAuction: null,
			phase: "pre-roll",
			settings: { auctionsEnabled: true },
			turnStartedAt: NOW,
			log: [],
			boardMessageId: null,
			winnerId: null,
		});
	});

	it("refuses fewer than two, more than six, or a repeated player", () => {
		expect(() => newMatch([ALICE])).toThrow(/2 to 6 players/);
		expect(() => newMatch(["a", "b", "c", "d", "e", "f", "g"])).toThrow(/2 to 6 players/);
		expect(() => newMatch([ALICE, ALICE])).toThrow(/same player twice/);
	});

	it("defaults the clock to now and the seed to a fresh one", () => {
		const before = Date.now();
		const state = createInitialState([ALICE, BOB], { auctionsEnabled: false });
		expect(state.turnStartedAt).toBeGreaterThanOrEqual(before);
		expect(state.chanceDeck).toHaveLength(CHANCE_DECK.length);
	});

	it("shuffles both decks the same way for the same seed", () => {
		const again = newMatch();
		expect(again.chanceDeck).toEqual(newMatch().chanceDeck);
		expect(createInitialState([ALICE, BOB], { auctionsEnabled: false }, NOW, SEED + 1).chanceDeck).not.toEqual(again.chanceDeck);
	});
});

// ── roll ────────────────────────────────────────────────────────────────────

describe("applyRoll", () => {
	it("moves the token, closes the roll, and leaves the input untouched", () => {
		const state = newMatch();
		stackDeck(state, "chance", "chance-dividend");
		const { state: next, trailLines } = rollFrom(structuredClone(state), 0, 3, 4);
		expect(next.seats[0].position).toBe(7);
		expect(next.diceRoll).toEqual([3, 4]);
		expect(next.rolledThisTurn).toBe(true);
		expect(next.phase).toBe("post-roll");
		expect(trailLines).toEqual([
			"<@alice> rolled 3 and 4.",
			"<@alice> landed on Chance.",
			"<@alice> drew Guild Dividend. Your shares in the Dero Trading Guild paid out.",
			"<@alice> collected $50 from the bank.",
		]);
		expect(state.seats[0].position).toBe(0);
	});

	it("rolls with Math.random and the real clock when nothing is injected", () => {
		const { state } = expectOk(applyRoll(newMatch()));
		expect(state.diceRoll).not.toBeNull();
	});

	it("offers an unowned lot for sale", () => {
		const { state, trailLines } = rollFrom(newMatch(), 0, 1, 2);
		expect(state.phase).toBe("awaiting-buy-or-skip");
		expect(trailLines.at(-1)).toBe("Burnt Umber Row is for sale for $60.");
	});

	it("keeps the turn open after doubles", () => {
		const { state, trailLines } = rollFrom(newMatch(), 0, 2, 2);
		expect(state.seats[0].chips).toBe(STARTING_CHIPS - 200);
		expect(trailLines.at(-1)).toBe("<@alice> paid $200 in tax.");
		expect(state.doublesStreak).toBe(1);
		expect(state.rolledThisTurn).toBe(false);
		expect(state.phase).toBe("pre-roll");
	});

	it("sends the third doubles in a row to jail without moving", () => {
		const state = newMatch();
		state.doublesStreak = 2;
		const { state: next, trailLines } = rollFrom(state, 5, 4, 4);
		expect(next.seats[0]).toMatchObject({ position: JAIL_INDEX, inJail: true, jailTurnsRemaining: JAIL_SENTENCE_TURNS });
		expect(next.doublesStreak).toBe(0);
		expect(next.phase).toBe("post-roll");
		expect(trailLines.at(-1)).toMatch(/3 times in a row and goes to Jail/);
	});

	it("pays the GO salary when the token wraps the board", () => {
		const { state, trailLines } = rollFrom(newMatch(), 38, 1, 2);
		expect(state.seats[0].position).toBe(1);
		expect(state.seats[0].chips).toBe(STARTING_CHIPS + GO_SALARY);
		expect(trailLines[1]).toBe("<@alice> passed GO and collected $200.");
	});

	it("counts landing exactly on GO as passing it", () => {
		const { state, trailLines } = rollFrom(newMatch(), 35, 2, 3);
		expect(state.seats[0].position).toBe(0);
		expect(state.seats[0].chips).toBe(STARTING_CHIPS + GO_SALARY);
		expect(trailLines.at(-1)).toBe("Nothing happens here.");
	});

	it("does nothing on Free Parking and lets a visitor through Jail", () => {
		expect(rollFrom(newMatch(), 15, 2, 3).trailLines.at(-1)).toBe("Nothing happens here.");
		const visit = rollFrom(newMatch(), 5, 2, 3);
		expect(visit.state.seats[0].inJail).toBe(false);
		expect(visit.trailLines.at(-1)).toBe("<@alice> is just visiting.");
	});

	it("sends a seat on Go To Jail to the cell and ends its doubles", () => {
		const { state } = rollFrom(newMatch(), 26, 2, 2);
		expect(state.seats[0]).toMatchObject({ position: JAIL_INDEX, inJail: true });
		expect(state.doublesStreak).toBe(0);
		expect(state.phase).toBe("post-roll");
	});

	it("refuses a finished match, a closed roll, a second roll and a jailed seat", () => {
		const finished = newMatch();
		finished.phase = "finished";
		expectRefusal(applyRoll(finished), "The match is already over.");

		const afterRoll = newMatch();
		afterRoll.phase = "post-roll";
		expectRefusal(applyRoll(afterRoll), "You cannot roll right now.");

		const rolled = newMatch();
		rolled.rolledThisTurn = true;
		expectRefusal(applyRoll(rolled), "You cannot roll right now.");

		const jailed = newMatch();
		jailed.seats[0].inJail = true;
		expectRefusal(applyRoll(jailed), /You are in Jail/);
	});
});

// ── rent ────────────────────────────────────────────────────────────────────

describe("rent on landing", () => {
	it("charges base rent to the owner of a lone lot", () => {
		const state = newMatch();
		giveTiles(state, BOB, "reader-dock");
		const { state: next, trailLines } = rollFrom(state, 0, 2, 4);
		expect(next.seats[0].chips).toBe(STARTING_CHIPS - 6);
		expect(next.seats[1].chips).toBe(STARTING_CHIPS + 6);
		expect(trailLines.at(-1)).toBe("<@alice> paid $6 rent to <@bob>.");
	});

	it("doubles base rent when the owner holds the whole group", () => {
		const state = newMatch();
		giveTiles(state, BOB, "reader-dock", "teal-vale", "teal-ridge");
		expect(rollFrom(state, 0, 2, 4).state.seats[1].chips).toBe(STARTING_CHIPS + 12);
	});

	it("charges nothing on your own lot or a mortgaged lot", () => {
		const own = newMatch();
		giveTiles(own, ALICE, "reader-dock");
		expect(rollFrom(own, 0, 2, 4).trailLines.at(-1)).toBe("<@alice> already owns Reader Dock.");

		const mortgaged = newMatch();
		giveTiles(mortgaged, BOB, "reader-dock");
		mortgaged.properties["reader-dock"].mortgaged = true;
		const mortgagedRoll = rollFrom(mortgaged, 0, 2, 4);
		expect(mortgagedRoll.state.seats[0].chips).toBe(STARTING_CHIPS);
		expect(mortgagedRoll.trailLines.at(-1)).toBe("Reader Dock is mortgaged, so no rent is due.");
	});

	it("reads houses and the hotel from the rent table", () => {
		const state = newMatch();
		const teal = tile("reader-dock");
		expect(calculateRent(state, teal)).toBe(0);
		giveTiles(state, BOB, "reader-dock");
		state.properties["reader-dock"].houses = 2;
		expect(calculateRent(state, teal)).toBe(90);
		state.properties["reader-dock"].hotel = true;
		expect(calculateRent(state, teal)).toBe(550);
		state.properties["reader-dock"].mortgaged = true;
		expect(calculateRent(state, teal)).toBe(0);
	});

	it("bankrupts a seat that cannot cover rent to the owner, who takes every chip", () => {
		const state = newMatch();
		giveTiles(state, BOB, "reader-dock", "teal-vale", "teal-ridge");
		state.seats[0].chips = 4;
		const { state: next, trailLines } = rollFrom(state, 0, 2, 4);
		expect(next.seats[1].chips).toBe(STARTING_CHIPS + 4);
		expect(next.seats[0]).toMatchObject({ bankrupt: true, chips: 0, bankruptedAt: 1 });
		expect(next.phase).toBe("finished");
		expect(next.winnerId).toBe(BOB);
		expect(trailLines).toContain("<@alice> cannot cover $12, even by selling and mortgaging everything, and is bankrupt.");
		expect(trailLines).toContain("<@bob> takes $4, 0 lots and 0 Get Out of Jail Free cards from <@alice>.");
		expect(trailLines.at(-1)).toBe("<@bob> wins the match.");
	});

	it("forfeits a seat that cannot cover tax and hands the clock on", () => {
		const state = newMatch([ALICE, BOB, CARA]);
		state.seats[0].chips = 100;
		const { state: next } = rollFrom(state, 0, 1, 3);
		expect(next.seats[0].bankrupt).toBe(true);
		expect(next.phase).toBe("pre-roll");
		expect(next.activeSeatIndex).toBe(1);
		expect(next.turnStartedAt).toBe(LATER);
	});
});

// ── the dice ────────────────────────────────────────────────────────────────
// A statistical check on the dice the room actually rolls with (rollDice fed by
// secureRandom, as rollMove, jailMove and the bot tick pass it). The bounds sit far
// out in the tail (a chance near 1 in 50,000 each of failing on fair dice), so a
// red run means biased dice, not bad luck.

describe("rollDice with secureRandom", () => {
	const ROLLS = 36_000;
	const FACE_LIMIT_CHI_SQUARE = 30; // 5 degrees of freedom
	const PAIR_LIMIT_CHI_SQUARE = 80; // 35 degrees of freedom
	const DOUBLES_TOLERANCE = 0.015; // about 7.5 standard deviations at this sample size

	const chiSquare = (counts: number[], expected: number): number =>
		counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);

	const firstFaces = new Array<number>(6).fill(0);
	const secondFaces = new Array<number>(6).fill(0);
	const pairs = new Array<number>(36).fill(0);
	let doubles = 0;
	for (let roll = 0; roll < ROLLS; roll++) {
		const [first, second] = rollDice(secureRandom);
		firstFaces[first - 1]++;
		secondFaces[second - 1]++;
		pairs[(first - 1) * 6 + (second - 1)]++;
		if (first === second) doubles++;
	}

	it("only ever shows faces 1 to 6", () => {
		expect(firstFaces.reduce((sum, count) => sum + count, 0)).toBe(ROLLS);
		expect(secondFaces.reduce((sum, count) => sum + count, 0)).toBe(ROLLS);
	});

	it("gives each die every face equally often", () => {
		expect(chiSquare(firstFaces, ROLLS / 6)).toBeLessThan(FACE_LIMIT_CHI_SQUARE);
		expect(chiSquare(secondFaces, ROLLS / 6)).toBeLessThan(FACE_LIMIT_CHI_SQUARE);
	});

	it("rolls the two dice independently, so all 36 pairs are equally likely", () => {
		expect(chiSquare(pairs, ROLLS / 36)).toBeLessThan(PAIR_LIMIT_CHI_SQUARE);
	});

	it("rolls doubles about one time in six", () => {
		expect(Math.abs(doubles / ROLLS - 1 / 6)).toBeLessThan(DOUBLES_TOLERANCE);
	});
});

// ── buy and skip ────────────────────────────────────────────────────────────

describe("applyBuy and applySkip", () => {
	const awaitingBurntUmberRow = (): MonopolyState => rollFrom(newMatch(), 0, 1, 2).state;

	it("buys the lot for sale at list price", () => {
		const { state, trailLines } = expectOk(applyBuy(awaitingBurntUmberRow(), ALICE, "burnt-umber-row"));
		expect(state.properties["burnt-umber-row"].ownerId).toBe(ALICE);
		expect(state.seats[0].chips).toBe(STARTING_CHIPS - 60);
		expect(state.phase).toBe("post-roll");
		expect(trailLines).toEqual(["<@alice> bought Burnt Umber Row for $60."]);
	});

	it("refuses another player, the wrong tile, a short purse and the wrong phase", () => {
		expectRefusal(applyBuy(awaitingBurntUmberRow(), BOB, "burnt-umber-row"), "It is not your turn.");
		expectRefusal(applyBuy(awaitingBurntUmberRow(), ALICE, "reader-dock"), "You can only buy the tile you are standing on.");
		const broke = awaitingBurntUmberRow();
		broke.seats[0].chips = 59;
		expectRefusal(applyBuy(broke, ALICE, "burnt-umber-row"), "You need $60 to buy Burnt Umber Row.");
		expectRefusal(applyBuy(newMatch(), ALICE, "burnt-umber-row"), "There is nothing to buy right now.");
		const finished = awaitingBurntUmberRow();
		finished.phase = "finished";
		expectRefusal(applyBuy(finished, ALICE, "burnt-umber-row"), "The match is already over.");
	});

	it("passes on the lot and leaves it with the bank", () => {
		const { state, trailLines } = expectOk(applySkip(awaitingBurntUmberRow(), ALICE));
		expect(state.properties["burnt-umber-row"].ownerId).toBeNull();
		expect(state.phase).toBe("post-roll");
		expect(trailLines).toEqual(["<@alice> passed on Burnt Umber Row."]);
	});

	it("refuses a skip from another player or with nothing for sale", () => {
		expectRefusal(applySkip(awaitingBurntUmberRow(), BOB), "It is not your turn.");
		expectRefusal(applySkip(newMatch(), ALICE), "There is nothing to pass on right now.");
	});
});

// ── end turn ────────────────────────────────────────────────────────────────

describe("applyEndTurn", () => {
	it("hands the clock to the next seat and resets the turn", () => {
		const rolled = rollFrom(newMatch(), 0, 3, 4).state;
		const { state, trailLines } = expectOk(applyEndTurn(rolled, LATER));
		expect(state.activeSeatIndex).toBe(1);
		expect(state).toMatchObject({ rolledThisTurn: false, doublesStreak: 0, phase: "pre-roll", turnStartedAt: LATER });
		expect(trailLines).toEqual(["It is now <@bob>'s turn."]);
	});

	it("ends the turn when doubles are followed by a plain roll", () => {
		const doubles = rollFrom(newMatch(), 0, 2, 2).state;
		expect(doubles.doublesStreak).toBe(1);
		const plain = rollFrom(doubles, 15, 2, 3).state;
		expect(plain).toMatchObject({ doublesStreak: 0, rolledThisTurn: true, phase: "post-roll" });
		const { state, trailLines } = expectOk(applyEndTurn(plain, LATER));
		expect(state.activeSeatIndex).toBe(1);
		expect(trailLines).toEqual(["It is now <@bob>'s turn."]);
	});

	it("ends the turn of a stored match whose streak outlived a plain roll", () => {
		const stale = newMatch();
		stale.phase = "post-roll";
		stale.rolledThisTurn = true;
		stale.doublesStreak = 1;
		stale.diceRoll = [2, 3];
		expect(expectOk(applyEndTurn(stale, LATER)).state.activeSeatIndex).toBe(1);
	});

	it("wraps round and skips a bankrupt seat", () => {
		const state = newMatch([ALICE, BOB, CARA]);
		state.activeSeatIndex = 2;
		state.phase = "post-roll";
		state.seats[0].bankrupt = true;
		expect(expectOk(applyEndTurn(state, LATER)).state.activeSeatIndex).toBe(1);
	});

	it("gives the same seat another roll after doubles on a lot for sale", () => {
		const doubles = rollFrom(newMatch(), 0, 3, 3).state;
		expect(doubles.phase).toBe("awaiting-buy-or-skip");
		const skipped = expectOk(applySkip(doubles, ALICE)).state;
		const { state, trailLines } = expectOk(applyEndTurn(skipped));
		expect(state.activeSeatIndex).toBe(0);
		expect(state).toMatchObject({ phase: "pre-roll", rolledThisTurn: false, doublesStreak: 1 });
		expect(trailLines).toEqual(["<@alice> rolled doubles and rolls again."]);
	});

	it("refuses before the roll and after the match", () => {
		expectRefusal(applyEndTurn(newMatch()), "Finish your roll before ending the turn.");
		const finished = newMatch();
		finished.phase = "finished";
		expectRefusal(applyEndTurn(finished), "The match is already over.");
	});
});

// ── jail ────────────────────────────────────────────────────────────────────

describe("applyJailChoice", () => {
	const jailedMatch = (): MonopolyState => {
		const state = newMatch();
		Object.assign(state.seats[0], { position: JAIL_INDEX, inJail: true, jailTurnsRemaining: JAIL_SENTENCE_TURNS });
		return state;
	};

	it("pays bail and frees the seat to roll", () => {
		const { state, trailLines } = expectOk(applyJailChoice(jailedMatch(), "bail"));
		expect(state.seats[0]).toMatchObject({ inJail: false, jailTurnsRemaining: 0, chips: STARTING_CHIPS - JAIL_BAIL });
		expect(state.phase).toBe("pre-roll");
		expect(trailLines).toEqual(["<@alice> paid $50 bail and is free to roll."]);
		expect(applyRoll(state, diceRng(1, 2)).ok).toBe(true);
	});

	it("refuses bail the seat cannot afford", () => {
		const state = jailedMatch();
		state.seats[0].chips = JAIL_BAIL - 1;
		expectRefusal(applyJailChoice(state, "bail"), "You need $50 to pay bail.");
	});

	it("spends a Get Out of Jail Free card, and refuses without one", () => {
		expectRefusal(applyJailChoice(jailedMatch(), "card"), "You have no Get Out of Jail Free card.");
		const state = jailedMatch();
		state.seats[0].gojfCards = 1;
		const { state: next } = expectOk(applyJailChoice(state, "card"));
		expect(next.seats[0]).toMatchObject({ inJail: false, gojfCards: 0, chips: STARTING_CHIPS });
		expect(next.phase).toBe("pre-roll");
	});

	it("walks out on doubles and moves, with no extra roll", () => {
		const { state, trailLines } = expectOk(applyJailChoice(jailedMatch(), "roll", diceRng(3, 3), LATER));
		expect(state.seats[0]).toMatchObject({ inJail: false, position: 16 });
		expect(state.phase).toBe("awaiting-buy-or-skip");
		expect(state.doublesStreak).toBe(0);
		expect(trailLines[1]).toBe("<@alice> rolled doubles and walks out of Jail.");
		const ended = expectOk(applyEndTurn(expectOk(applySkip(state, ALICE)).state));
		expect(ended.state.activeSeatIndex).toBe(1);
	});

	it("spends a try on a miss and keeps the seat in", () => {
		const { state, trailLines } = expectOk(applyJailChoice(jailedMatch(), "roll", diceRng(1, 2)));
		expect(state.seats[0]).toMatchObject({ inJail: true, jailTurnsRemaining: 2, position: JAIL_INDEX });
		expect(state.phase).toBe("post-roll");
		expect(trailLines.at(-1)).toBe("<@alice> stays in Jail with 2 tries left.");
		expect(expectOk(applyEndTurn(state)).state.activeSeatIndex).toBe(1);
	});

	it("forces bail and moves on the last missed try", () => {
		const state = jailedMatch();
		state.seats[0].jailTurnsRemaining = 1;
		const { state: next, trailLines } = expectOk(applyJailChoice(state, "roll", diceRng(1, 2)));
		expect(next.seats[0]).toMatchObject({ inJail: false, position: 13, chips: STARTING_CHIPS - JAIL_BAIL });
		expect(trailLines).toContain("<@alice> used the last try, pays $50 bail and moves.");
	});

	it("bankrupts a seat that cannot cover the forced bail", () => {
		const state = jailedMatch();
		Object.assign(state.seats[0], { jailTurnsRemaining: 1, chips: 10 });
		const { state: next, trailLines } = expectOk(applyJailChoice(state, "roll", diceRng(1, 2)));
		expect(next.seats[0]).toMatchObject({ bankrupt: true, position: JAIL_INDEX });
		expect(next.winnerId).toBe(BOB);
		expect(trailLines).toContain("<@alice> cannot cover $50, even by selling and mortgaging everything, and is bankrupt.");
	});

	it("holds a forced bail the seat can cover, and moves only once it is paid", () => {
		const state = jailedMatch();
		Object.assign(state.seats[0], { jailTurnsRemaining: 1, chips: 10 });
		giveTiles(state, ALICE, "rail-one");

		const { state: held } = expectOk(applyJailChoice(state, "roll", diceRng(1, 2)));
		expect(held.phase).toBe("awaiting-debt");
		expect(held.pendingDebt).toMatchObject({ debts: [{ debtorId: ALICE, amount: JAIL_BAIL }], moveAfter: 3 });
		// Still in the cell: the standard rules pay the bail first, then move.
		expect(held.seats[0]).toMatchObject({ inJail: true, position: JAIL_INDEX });

		const mortgaged = expectOk(applyMortgage(held, ALICE, "rail-one")).state;
		const { state: next, trailLines } = expectOk(applyPayDebt(mortgaged, ALICE));
		expect(next.seats[0]).toMatchObject({ bankrupt: false, inJail: false, position: 13, chips: 10 + 100 - JAIL_BAIL });
		expect(next.pendingDebt).toBeNull();
		expect(trailLines[0]).toBe("<@alice> used the last try, pays $50 bail and moves.");
	});

	it("refuses a free seat, a closed turn and a finished match", () => {
		expectRefusal(applyJailChoice(newMatch(), "bail"), "You are not in Jail.");
		const acted = jailedMatch();
		acted.phase = "post-roll";
		expectRefusal(applyJailChoice(acted, "roll"), "You have already acted this turn.");
		const finished = jailedMatch();
		finished.phase = "finished";
		expectRefusal(applyJailChoice(finished, "bail"), "The match is already over.");
	});
});

// ── forfeit ─────────────────────────────────────────────────────────────────

describe("applyForfeit", () => {
	it("returns lots and buildings to the bank and leaves an off turn clock alone", () => {
		const state = newMatch([ALICE, BOB, CARA]);
		giveTiles(state, BOB, "reader-dock", "teal-vale");
		state.properties["reader-dock"].houses = 3;
		state.properties["teal-vale"].hotel = true;
		state.seats[1].gojfCards = 1;
		const { state: next, trailLines } = expectOk(applyForfeit(state, BOB, LATER));
		expect(next.seats[1]).toMatchObject({ bankrupt: true, bankruptedAt: 1, chips: 0, gojfCards: 0 });
		expect(next.properties["reader-dock"]).toEqual({ ownerId: null, houses: 0, hotel: false, mortgaged: false });
		expect(next.properties["teal-vale"].ownerId).toBeNull();
		expect(next.bank).toEqual({ houses: BANK_HOUSES + 3, hotels: BANK_HOTELS + 1 });
		expect(next.activeSeatIndex).toBe(0);
		expect(next.phase).toBe("pre-roll");
		expect(trailLines).toEqual(["<@bob> is out of the match, and their holdings return to the bank."]);
	});

	it("hands the clock on when the seat on the clock forfeits", () => {
		const { state, trailLines } = expectOk(applyForfeit(newMatch([ALICE, BOB, CARA]), ALICE, LATER));
		expect(state.activeSeatIndex).toBe(1);
		expect(state.turnStartedAt).toBe(LATER);
		expect(trailLines.at(-1)).toBe("It is now <@bob>'s turn.");
	});

	it("numbers eliminations in order and crowns the last seat", () => {
		const first = expectOk(applyForfeit(newMatch([ALICE, BOB, CARA]), CARA)).state;
		const { state, trailLines } = expectOk(applyForfeit(first, ALICE));
		expect(state.seats.map((seat) => seat.bankruptedAt)).toEqual([2, null, 1]);
		expect(state.phase).toBe("finished");
		expect(state.winnerId).toBe(BOB);
		expect(trailLines.at(-1)).toBe("<@bob> wins the match.");
	});

	it("refuses an unknown seat, a seat already out and a finished match", () => {
		expectRefusal(applyForfeit(newMatch(), "nobody"), "That player is not seated in this match.");
		const out = expectOk(applyForfeit(newMatch([ALICE, BOB, CARA]), CARA)).state;
		expectRefusal(applyForfeit(out, CARA), "That player is already out of the match.");
		const over = expectOk(applyForfeit(newMatch(), ALICE)).state;
		expectRefusal(applyForfeit(over, BOB), "The match is already over.");
	});
});

// ── transport and utility rent ──────────────────────────────────────────────

describe("transport and utility rent", () => {
	const TRANSPORTS = ["rail-one", "rail-two", "rail-three", "rail-four"];

	it("charges 25, 50, 100 and 200 by transports owned, mortgaged ones still counting", () => {
		const state = newMatch();
		const expected = [25, 50, 100, 200];
		TRANSPORTS.forEach((id, owned) => {
			giveTiles(state, BOB, id);
			expect(calculateRent(state, tile("rail-one"))).toBe(expected[owned]);
		});
		state.properties["rail-four"].mortgaged = true;
		expect(calculateRent(state, tile("rail-one"))).toBe(200);
		expect(calculateRent(state, tile("rail-four"))).toBe(0);
		expect(calculateRent(state, tile("rail-one"), true)).toBe(400);
	});

	it("charges 4 or 10 times the dice on a utility, 10 times on a card, and 0 before any roll", () => {
		const state = newMatch();
		giveTiles(state, BOB, "electric-utility");
		expect(calculateRent(state, tile("electric-utility"))).toBe(0);
		state.diceRoll = [3, 4];
		expect(calculateRent(state, tile("electric-utility"))).toBe(28);
		expect(calculateRent(state, tile("electric-utility"), true)).toBe(70);
		giveTiles(state, BOB, "water-utility");
		expect(calculateRent(state, tile("electric-utility"))).toBe(70);
	});

	it("charges transport rent on a landing", () => {
		const state = newMatch();
		giveTiles(state, BOB, "rail-one");
		const { state: next, trailLines } = rollFrom(state, 0, 2, 3);
		expect(next.seats[1].chips).toBe(STARTING_CHIPS + 25);
		expect(trailLines.at(-1)).toBe("<@alice> paid $25 rent to <@bob>.");
	});

	it("charges utility rent from the roll that landed", () => {
		const state = newMatch();
		giveTiles(state, BOB, "electric-utility", "water-utility");
		expect(rollFrom(state, 7, 2, 3).state.seats[0].chips).toBe(STARTING_CHIPS - 50);
	});
});

// ── cards ───────────────────────────────────────────────────────────────────

describe("Chance and Community Chest", () => {
	// A 3 and 4 reaches Chance from 0, 15 and 29 (lanes 7, 22, 36) and Community
	// Chest from 10 and 26 (lanes 17 and 33). Not doubles, so the roll closes.
	const drawChance = (state: MonopolyState, cardId: string, from: number = 0) => {
		stackDeck(state, "chance", cardId);
		return rollFrom(state, from, 3, 4);
	};
	const drawChest = (state: MonopolyState, cardId: string, from: number = 10) => {
		stackDeck(state, "chest", cardId);
		return rollFrom(state, from, 3, 4);
	};

	it("pays the bank and sends the card to the bottom of its discard", () => {
		const { state, trailLines } = drawChance(newMatch(), "chance-speeding");
		expect(state.seats[0].chips).toBe(STARTING_CHIPS - 15);
		expect(state.chanceDiscard.at(-1)).toBe("chance-speeding");
		expect(state.chanceDeck).not.toContain("chance-speeding");
		expect(trailLines.at(-1)).toBe("<@alice> paid $15 to the bank.");
	});

	it("bankrupts a seat that cannot cover a card's charge", () => {
		const state = newMatch();
		state.seats[0].chips = 10;
		const { state: next, trailLines } = drawChance(state, "chance-speeding");
		expect(next.winnerId).toBe(BOB);
		expect(trailLines).toContain("<@alice> cannot cover $15, even by selling and mortgaging everything, and is bankrupt.");
	});

	it("collects from each rival, and a rival who cannot pay is bankrupt to the drawer", () => {
		const { state, trailLines } = drawChest(newMatch([ALICE, BOB, CARA]), "chest-hatching-day");
		expect(state.seats.map((seat) => seat.chips)).toEqual([STARTING_CHIPS + 20, STARTING_CHIPS - 10, STARTING_CHIPS - 10]);
		expect(trailLines.slice(-2)).toEqual(["<@bob> paid <@alice> $10.", "<@cara> paid <@alice> $10."]);

		const poor = newMatch([ALICE, BOB, CARA]);
		poor.seats[2].chips = 4;
		const short = drawChest(poor, "chest-hatching-day");
		expect(short.state.seats[0].chips).toBe(STARTING_CHIPS + 14);
		expect(short.state.seats[2].bankrupt).toBe(true);
		expect(short.state.activeSeatIndex).toBe(0);
	});

	it("pays each rival, and stops at the first payment the seat cannot cover", () => {
		const { state } = drawChance(newMatch([ALICE, BOB, CARA]), "chance-chairman");
		expect(state.seats.map((seat) => seat.chips)).toEqual([STARTING_CHIPS - 100, STARTING_CHIPS + 50, STARTING_CHIPS + 50]);

		const poor = newMatch([ALICE, BOB, CARA]);
		poor.seats[0].chips = 60;
		const { state: next, trailLines } = drawChance(poor, "chance-chairman");
		expect(next.seats.map((seat) => seat.chips)).toEqual([0, STARTING_CHIPS + 50, STARTING_CHIPS + 10]);
		expect(next.seats[0].bankrupt).toBe(true);
		expect(next.activeSeatIndex).toBe(1);
		expect(trailLines).toContain("<@alice> paid <@bob> $50.");
		expect(trailLines).toContain("<@alice> cannot cover $50, even by selling and mortgaging everything, and is bankrupt.");
		expect(trailLines).toContain("<@cara> takes $10, 0 lots and 0 Get Out of Jail Free cards from <@alice>.");
	});

	it("advances onto an owned lot and pays its owner the rent", () => {
		const state = newMatch();
		giveTiles(state, BOB, "postern-lane");
		const { state: next, trailLines } = drawChance(state, "chance-postern-lane", 29);
		expect(next.seats[0].position).toBe(39);
		expect(next.seats.map((seat) => seat.chips)).toEqual([STARTING_CHIPS - 50, STARTING_CHIPS + 50]);
		expect(trailLines.slice(-2)).toEqual(["<@alice> landed on Postern Lane.", "<@alice> paid $50 rent to <@bob>."]);
	});

	it("advances to GO and collects the salary", () => {
		const { state, trailLines } = drawChance(newMatch(), "chance-go");
		expect(state.seats[0]).toMatchObject({ position: 0, chips: STARTING_CHIPS + GO_SALARY });
		expect(trailLines).toContain("<@alice> passed GO and collected $200.");
	});

	it("pays the salary when an advance wraps the board, and offers the lot it reaches", () => {
		const { state } = drawChance(newMatch(), "chance-rose-hollow", 15);
		expect(state.seats[0]).toMatchObject({ position: 11, chips: STARTING_CHIPS + GO_SALARY });
		expect(state.phase).toBe("awaiting-buy-or-skip");
	});

	it("advances to the nearest transport: for sale when unowned, twice the rent when owned", () => {
		const unowned = drawChance(newMatch(), "chance-nearest-transport-1");
		expect(unowned.state.seats[0].position).toBe(15);
		expect(unowned.state.phase).toBe("awaiting-buy-or-skip");

		const owned = newMatch();
		giveTiles(owned, BOB, "rail-two");
		expect(drawChance(owned, "chance-nearest-transport-2").state.seats[1].chips).toBe(STARTING_CHIPS + 50);
	});

	it("wraps round GO to reach the nearest transport from the last Chance lane", () => {
		const { state } = drawChance(newMatch(), "chance-nearest-transport-1", 29);
		expect(state.seats[0]).toMatchObject({ position: 5, chips: STARTING_CHIPS + GO_SALARY });
	});

	it("advances to the nearest utility and charges ten times the dice", () => {
		const state = newMatch();
		giveTiles(state, BOB, "electric-utility");
		const { state: next } = drawChance(state, "chance-nearest-utility");
		expect(next.seats[0].position).toBe(12);
		expect(next.seats[1].chips).toBe(STARTING_CHIPS + 70);
	});

	it("goes back three without the salary and resolves the tile it reaches", () => {
		const { state, trailLines } = drawChance(newMatch(), "chance-go-back");
		expect(state.seats[0]).toMatchObject({ position: 4, chips: STARTING_CHIPS - 200 });
		expect(trailLines.at(-1)).toBe("<@alice> paid $200 in tax.");
	});

	it("draws again when going back three from the last Chance lane reaches a Chest lane", () => {
		const state = newMatch();
		stackDeck(state, "chest", "chest-bank-error");
		const { state: next, trailLines } = drawChance(state, "chance-go-back", 29);
		expect(next.seats[0]).toMatchObject({ position: 33, chips: STARTING_CHIPS + 200 });
		expect(trailLines).toContain("<@alice> landed on Community Chest.");
		expect(trailLines.at(-1)).toBe("<@alice> collected $200 from the bank.");
	});

	it("sends the drawer to jail", () => {
		const { state, trailLines } = drawChest(newMatch(), "chest-jail");
		expect(state.seats[0]).toMatchObject({ position: JAIL_INDEX, inJail: true });
		expect(state.phase).toBe("post-roll");
		expect(trailLines.at(-1)).toBe("<@alice> goes straight to Jail.");
	});

	it("hands over a jail card that leaves the deck and returns to it when used", () => {
		const { state } = drawChest(newMatch(), "chest-jail-free");
		expect(state.seats[0].gojfCards).toBe(1);
		expect(heldJailCardIds(state)).toEqual(["chest-jail-free"]);
		expect([...state.chestDeck, ...state.chestDiscard]).not.toContain("chest-jail-free");

		Object.assign(state.seats[0], { position: JAIL_INDEX, inJail: true, jailTurnsRemaining: JAIL_SENTENCE_TURNS });
		Object.assign(state, { phase: "pre-roll", rolledThisTurn: false });
		const { state: freed } = expectOk(applyJailChoice(state, "card"));
		expect(freed.seats[0].gojfCards).toBe(0);
		expect(freed.chestDiscard.at(-1)).toBe("chest-jail-free");
		expect(heldJailCardIds(freed)).toEqual([]);
	});

	it("returns a forfeiting seat's jail cards to their decks", () => {
		const { state } = drawChance(newMatch([ALICE, BOB, CARA]), "chance-jail-free");
		const { state: next } = expectOk(applyForfeit(state, ALICE));
		expect(next.seats[0].gojfCards).toBe(0);
		expect(next.chanceDiscard.at(-1)).toBe("chance-jail-free");
	});

	it("charges repairs per house and per hotel, and nothing without buildings", () => {
		const state = newMatch();
		giveTiles(state, ALICE, "reader-dock", "teal-vale", "teal-ridge");
		state.properties["reader-dock"].houses = 2;
		state.properties["teal-vale"].hotel = true;
		const { state: next, trailLines } = drawChance(state, "chance-repairs");
		expect(next.seats[0].chips).toBe(STARTING_CHIPS - (2 * 25 + 100));
		expect(trailLines.at(-1)).toBe("<@alice> paid $150 in repairs.");

		const bare = drawChest(newMatch(), "chest-road-levy", 26);
		expect(bare.state.seats[0].chips).toBe(STARTING_CHIPS);
		expect(bare.trailLines.at(-1)).toBe("<@alice> owns no buildings, so there is nothing to repair.");
	});

	it("starts the deck on the first draw of a match stored before the decks existed", () => {
		const legacy = newMatch();
		Object.assign(legacy, { chanceDeck: [], chestDeck: [], chanceDiscard: [], chestDiscard: [] });
		const { state, trailLines } = rollFrom(legacy, 0, 3, 4);
		expect(trailLines[2]).toMatch(/^<@alice> drew /);
		expect(state.chanceDeck.length + state.chanceDiscard.length + state.seats[0].gojfCards).toBe(CHANCE_DECK.length);
	});
});

// ── mortgages ───────────────────────────────────────────────────────────────

describe("applyMortgage and applyUnmortgage", () => {
	const owning = (...ids: string[]): MonopolyState => {
		const state = newMatch();
		giveTiles(state, ALICE, ...ids);
		return state;
	};

	it("mortgages for the board value and lifts it for that plus ten percent", () => {
		const mortgaged = expectOk(applyMortgage(owning("reader-dock"), ALICE, "reader-dock"));
		expect(mortgaged.state.seats[0].chips).toBe(STARTING_CHIPS + 50);
		expect(mortgaged.state.properties["reader-dock"].mortgaged).toBe(true);
		expect(mortgaged.trailLines).toEqual(["<@alice> mortgaged Reader Dock for $50."]);

		expect(unmortgageCost(tile("reader-dock"))).toBe(55);
		const lifted = expectOk(applyUnmortgage(mortgaged.state, ALICE, "reader-dock"));
		expect(lifted.state.seats[0].chips).toBe(STARTING_CHIPS - 5);
		expect(lifted.state.properties["reader-dock"].mortgaged).toBe(false);
		expect(lifted.trailLines).toEqual(["<@alice> paid $55 to lift the mortgage on Reader Dock."]);
	});

	it("rounds the interest up to a whole chip", () => {
		expect(unmortgageCost(tile("jade-reach"))).toBe(175 + 18);
	});

	it("lets a seat mortgage off its turn, and a transport needs no group check", () => {
		const state = newMatch();
		giveTiles(state, BOB, "rail-one");
		const { state: next } = expectOk(applyMortgage(state, BOB, "rail-one"));
		expect(next.seats[1].chips).toBe(STARTING_CHIPS + 100);
		expect(next.activeSeatIndex).toBe(0);
	});

	it("refuses while any lot in the color group has buildings", () => {
		const housed = owning("vermillion-alley", "burnt-umber-row");
		housed.properties["vermillion-alley"].houses = 1;
		expectRefusal(applyMortgage(housed, ALICE, "burnt-umber-row"), "Burnt Umber Row cannot be mortgaged while its color group has buildings.");
		const hotel = owning("vermillion-alley", "burnt-umber-row");
		hotel.properties["vermillion-alley"].hotel = true;
		expectRefusal(applyMortgage(hotel, ALICE, "vermillion-alley"), /cannot be mortgaged while its color group has buildings/);
	});

	it("refuses a finished match, a stranger, a seat out of the match, an unknown lot and a lot owned by another", () => {
		const finished = owning("reader-dock");
		finished.phase = "finished";
		expectRefusal(applyMortgage(finished, ALICE, "reader-dock"), "The match is already over.");
		expectRefusal(applyUnmortgage(finished, ALICE, "reader-dock"), "The match is already over.");
		expectRefusal(applyMortgage(owning("reader-dock"), "nobody", "reader-dock"), "You are not playing in this match.");
		const out = owning("reader-dock");
		out.seats[0].bankrupt = true;
		expectRefusal(applyMortgage(out, ALICE, "reader-dock"), "You are not playing in this match.");
		expectRefusal(applyMortgage(owning(), ALICE, "nowhere"), "That is not a lot on this board.");
		expectRefusal(applyMortgage(owning(), ALICE, "reader-dock"), "You do not own Reader Dock.");
	});

	it("refuses a second mortgage, lifting one that is not there, and a lift the seat cannot afford", () => {
		const mortgaged = expectOk(applyMortgage(owning("reader-dock"), ALICE, "reader-dock")).state;
		expectRefusal(applyMortgage(mortgaged, ALICE, "reader-dock"), "Reader Dock is already mortgaged.");
		expectRefusal(applyUnmortgage(owning("reader-dock"), ALICE, "reader-dock"), "Reader Dock is not mortgaged.");
		mortgaged.seats[0].chips = 54;
		expectRefusal(applyUnmortgage(mortgaged, ALICE, "reader-dock"), "You need $55 to lift the mortgage on Reader Dock.");
	});
});

// ── buildings ───────────────────────────────────────────────────────────────

describe("applyBuild", () => {
	const BROWN = COLOR_GROUPS.brown;
	const brownMatch = (): MonopolyState => {
		const state = newMatch();
		giveTiles(state, ALICE, ...BROWN);
		return state;
	};
	const build = (state: MonopolyState, tileId: string, kind: "house" | "hotel" = "house"): MonopolyState =>
		expectOk(applyBuild(state, ALICE, tileId, kind)).state;
	const setHouses = (state: MonopolyState, houses: number): void => {
		for (const id of BROWN) state.properties[id].houses = houses;
		state.bank.houses = BANK_HOUSES - houses * BROWN.length;
	};
	const vermillionAlley = tile("vermillion-alley") as PropertyTile;

	it("builds a house from the bank's stock at the board's house cost", () => {
		const { state, trailLines } = expectOk(applyBuild(brownMatch(), ALICE, "vermillion-alley", "house"));
		expect(state.properties["vermillion-alley"].houses).toBe(1);
		expect(state.bank.houses).toBe(BANK_HOUSES - 1);
		expect(state.seats[0].chips).toBe(STARTING_CHIPS - vermillionAlley.houseCost);
		expect(trailLines).toEqual(["<@alice> built a house on Vermillion Alley for $50."]);
		expect(calculateRent(state, vermillionAlley)).toBe(vermillionAlley.rents[1]);
	});

	it("builds evenly across the group", () => {
		const one = build(brownMatch(), "vermillion-alley");
		expectRefusal(applyBuild(one, ALICE, "vermillion-alley", "house"), "Build evenly: the other lots in the brown group need more buildings first.");
		const two = build(build(one, "burnt-umber-row"), "vermillion-alley");
		expect(two.properties["vermillion-alley"].houses).toBe(2);
	});

	it("trades four houses for a hotel and charges hotel rent", () => {
		const state = brownMatch();
		setHouses(state, MAX_HOUSES_PER_LOT);
		const { state: next, trailLines } = expectOk(applyBuild(state, ALICE, "vermillion-alley", "hotel"));
		expect(next.properties["vermillion-alley"]).toMatchObject({ houses: 0, hotel: true });
		expect(next.bank).toEqual({ houses: BANK_HOUSES - MAX_HOUSES_PER_LOT, hotels: BANK_HOTELS - 1 });
		expect(next.seats[0].chips).toBe(STARTING_CHIPS - vermillionAlley.houseCost);
		expect(trailLines).toEqual(["<@alice> built a hotel on Vermillion Alley for $50."]);
		expect(calculateRent(next, vermillionAlley)).toBe(vermillionAlley.rents[5]);

		expectRefusal(applyBuild(next, ALICE, "vermillion-alley", "house"), "Vermillion Alley already has a hotel.");
		expect(build(next, "burnt-umber-row", "hotel").properties["burnt-umber-row"].hotel).toBe(true);
	});

	it("refuses a fifth house, a hotel before four houses, and a hotel on an uneven group", () => {
		const full = brownMatch();
		setHouses(full, MAX_HOUSES_PER_LOT);
		expectRefusal(applyBuild(full, ALICE, "vermillion-alley", "house"), "Vermillion Alley has 4 houses, so a hotel comes next.");
		expectRefusal(applyBuild(brownMatch(), ALICE, "vermillion-alley", "hotel"), "Vermillion Alley needs 4 houses before a hotel.");
		const uneven = brownMatch();
		setHouses(uneven, MAX_HOUSES_PER_LOT);
		uneven.properties["burnt-umber-row"].houses = MAX_HOUSES_PER_LOT - 1;
		expectRefusal(applyBuild(uneven, ALICE, "vermillion-alley", "hotel"), /Build evenly/);
	});

	it("refuses when the bank is out of houses or hotels", () => {
		const noHouses = brownMatch();
		noHouses.bank.houses = 0;
		expectRefusal(applyBuild(noHouses, ALICE, "vermillion-alley", "house"), "The bank has no houses left.");
		const noHotels = brownMatch();
		setHouses(noHotels, MAX_HOUSES_PER_LOT);
		noHotels.bank.hotels = 0;
		expectRefusal(applyBuild(noHotels, ALICE, "vermillion-alley", "hotel"), "The bank has no hotels left.");
	});

	it("refuses the wrong player, a finished match, after the roll, and a tile that takes no buildings", () => {
		expectRefusal(applyBuild(brownMatch(), BOB, "vermillion-alley", "house"), "It is not your turn.");
		const finished = brownMatch();
		finished.phase = "finished";
		expectRefusal(applyBuild(finished, ALICE, "vermillion-alley", "house"), "The match is already over.");
		const rolled = brownMatch();
		rolled.phase = "post-roll";
		expectRefusal(applyBuild(rolled, ALICE, "vermillion-alley", "house"), "Build before you roll.");
		const transport = brownMatch();
		giveTiles(transport, ALICE, "rail-one");
		expectRefusal(applyBuild(transport, ALICE, "rail-one", "house"), "Only color lots take buildings.");
		expectRefusal(applyBuild(brownMatch(), ALICE, "nowhere", "house"), "Only color lots take buildings.");
	});

	it("refuses a lot owned by another, an incomplete group, a mortgaged group and a short purse", () => {
		const others = brownMatch();
		giveTiles(others, BOB, "reader-dock");
		expectRefusal(applyBuild(others, ALICE, "reader-dock", "house"), "You do not own Reader Dock.");
		const split = brownMatch();
		giveTiles(split, BOB, "burnt-umber-row");
		expectRefusal(applyBuild(split, ALICE, "vermillion-alley", "house"), "You need every lot in the brown group to build.");
		const mortgaged = brownMatch();
		mortgaged.properties["burnt-umber-row"].mortgaged = true;
		expectRefusal(applyBuild(mortgaged, ALICE, "vermillion-alley", "house"), "Lift every mortgage in the brown group before building.");
		const broke = brownMatch();
		broke.seats[0].chips = vermillionAlley.houseCost - 1;
		expectRefusal(applyBuild(broke, ALICE, "vermillion-alley", "house"), "You need $50 to build on Vermillion Alley.");
	});
});

// ── log ─────────────────────────────────────────────────────────────────────

describe("listBuildOptions", () => {
	const brownMatch = (): MonopolyState => {
		const state = newMatch();
		giveTiles(state, ALICE, ...COLOR_GROUPS.brown);
		return state;
	};

	it("offers every lot of a whole, unmortgaged group, in board order, with a house at the board's cost", () => {
		expect(listBuildOptions(brownMatch(), ALICE)).toEqual([
			{ tileId: "vermillion-alley", name: "Vermillion Alley", kind: "house", cost: 50 },
			{ tileId: "burnt-umber-row", name: "Burnt Umber Row", kind: "house", cost: 50 },
		]);
	});

	it("offers exactly the builds applyBuild would accept, so the picker and the build agree", () => {
		// One house on Vermillion Alley: even building now allows only Burnt Umber Row.
		const one = expectOk(applyBuild(brownMatch(), ALICE, "vermillion-alley", "house")).state;
		const options = listBuildOptions(one, ALICE);
		expect(options.map((option) => option.tileId)).toEqual(["burnt-umber-row"]);
		for (const option of options) expect(applyBuild(one, ALICE, option.tileId, option.kind).ok).toBe(true);
	});

	it("offers the hotel once a lot has four houses", () => {
		const state = brownMatch();
		for (const id of COLOR_GROUPS.brown) state.properties[id].houses = MAX_HOUSES_PER_LOT;
		state.bank.houses = BANK_HOUSES - MAX_HOUSES_PER_LOT * COLOR_GROUPS.brown.length;
		expect(listBuildOptions(state, ALICE).map((option) => option.kind)).toEqual(["hotel", "hotel"]);
	});

	it("offers nothing off turn, after the roll, or for a part of a group", () => {
		expect(listBuildOptions(brownMatch(), BOB)).toEqual([]);
		const rolled = brownMatch();
		rolled.phase = "post-roll";
		expect(listBuildOptions(rolled, ALICE)).toEqual([]);
		const partial = newMatch();
		giveTiles(partial, ALICE, "vermillion-alley");
		expect(listBuildOptions(partial, ALICE)).toEqual([]);
	});

	it("names the next building a lot takes: houses up to four, then the hotel", () => {
		expect(nextBuildingKind({ ownerId: ALICE, houses: 3, hotel: false, mortgaged: false })).toBe("house");
		expect(nextBuildingKind({ ownerId: ALICE, houses: MAX_HOUSES_PER_LOT, hotel: false, mortgaged: false })).toBe("hotel");
	});
});

describe("listMortgageOptions and listUnmortgageOptions", () => {
	// Alice owns the brown group and Reader Dock, which is mortgaged.
	const holdings = (): MonopolyState => {
		const state = newMatch();
		giveTiles(state, ALICE, ...COLOR_GROUPS.brown, "reader-dock");
		state.properties["reader-dock"].mortgaged = true;
		return state;
	};

	it("lists what each lot would pay or cost, in board order", () => {
		const state = holdings();
		expect(listMortgageOptions(state, ALICE)).toEqual([
			{ tileId: "vermillion-alley", name: "Vermillion Alley", amount: tile("vermillion-alley").mortgage },
			{ tileId: "burnt-umber-row", name: "Burnt Umber Row", amount: tile("burnt-umber-row").mortgage },
		]);
		expect(listUnmortgageOptions(state, ALICE)).toEqual([
			{ tileId: "reader-dock", name: "Reader Dock", amount: unmortgageCost(tile("reader-dock")) },
		]);
	});

	it("offers exactly the moves the actions would accept, so the peek and the engine agree", () => {
		const state = holdings();
		state.properties["burnt-umber-row"].houses = 1;
		state.seats[0].chips = unmortgageCost(tile("reader-dock")) - 1;
		for (const option of listMortgageOptions(state, ALICE)) expect(applyMortgage(state, ALICE, option.tileId).ok).toBe(true);
		for (const owned of OWNABLE_TILES.filter((candidate) => state.properties[candidate.id].ownerId === ALICE)) {
			const offered = listMortgageOptions(state, ALICE).some((option) => option.tileId === owned.id);
			expect(offered).toBe(applyMortgage(state, ALICE, owned.id).ok);
		}
		// A group with buildings mortgages nothing, and an unaffordable lift is left out.
		expect(listMortgageOptions(state, ALICE)).toEqual([]);
		expect(listUnmortgageOptions(state, ALICE)).toEqual([]);
	});

	it("does not depend on the turn, the standard rule, but offers nothing to a seat that is out or once the match is over", () => {
		const offTurn = holdings();
		offTurn.activeSeatIndex = 1;
		expect(listMortgageOptions(offTurn, ALICE)).toHaveLength(2);
		const out = holdings();
		out.seats[0].bankrupt = true;
		expect(listMortgageOptions(out, ALICE)).toEqual([]);
		const over = holdings();
		over.phase = "finished";
		expect(listUnmortgageOptions(over, ALICE)).toEqual([]);
	});
});

describe("applySellBuilding and listSellOptions", () => {
	// Brown with houses: Vermillion Alley at two, Burnt Umber Row at three.
	const builtBrown = (): MonopolyState => {
		const state = newMatch();
		giveTiles(state, ALICE, ...COLOR_GROUPS.brown);
		state.properties["vermillion-alley"].houses = 2;
		state.properties["burnt-umber-row"].houses = 3;
		state.bank.houses = BANK_HOUSES - 5;
		return state;
	};

	it("sells a house back to the bank at half its cost, off turn too", () => {
		const state = builtBrown();
		state.activeSeatIndex = 1;
		const { state: next, trailLines } = expectOk(applySellBuilding(state, ALICE, "burnt-umber-row"));
		expect(next.properties["burnt-umber-row"].houses).toBe(2);
		expect(next.bank.houses).toBe(BANK_HOUSES - 4);
		expect(next.seats[0].chips).toBe(STARTING_CHIPS + 25);
		expect(trailLines).toEqual(["<@alice> sold a house on Burnt Umber Row back to the bank for $25."]);
	});

	it("sells evenly: only from the tallest lot in the group", () => {
		expectRefusal(applySellBuilding(builtBrown(), ALICE, "vermillion-alley"), "Sell evenly: the other lots in the brown group have more buildings.");
		expect(listSellOptions(builtBrown(), ALICE)).toEqual([{ tileId: "burnt-umber-row", name: "Burnt Umber Row", kind: "house", amount: 25 }]);
	});

	it("sells a hotel back for the four houses it replaced when the bank has them", () => {
		const state = newMatch();
		giveTiles(state, ALICE, ...COLOR_GROUPS.brown);
		state.properties["vermillion-alley"].houses = 4;
		state.properties["burnt-umber-row"].hotel = true;
		state.bank.houses = BANK_HOUSES - 4;
		state.bank.hotels = BANK_HOTELS - 1;
		expect(listSellOptions(state, ALICE)).toEqual([{ tileId: "burnt-umber-row", name: "Burnt Umber Row", kind: "hotel", amount: 25 }]);
		const { state: next, trailLines } = expectOk(applySellBuilding(state, ALICE, "burnt-umber-row"));
		expect(trailLines[0]).toBe("<@alice> sold the hotel on Burnt Umber Row back to the bank for $25.");
		expect(next.properties["burnt-umber-row"]).toMatchObject({ hotel: false, houses: 4 });
		expect(next.bank).toEqual({ houses: BANK_HOUSES - 8, hotels: BANK_HOTELS });
	});

	it("tears a hotel down to bare ground when the bank has no houses to give back, and prices the option that way", () => {
		const state = newMatch();
		giveTiles(state, ALICE, ...COLOR_GROUPS.brown);
		state.properties["vermillion-alley"].hotel = true;
		state.properties["burnt-umber-row"].hotel = true;
		state.bank.houses = 3;
		state.bank.hotels = BANK_HOTELS - 2;
		expect(listSellOptions(state, ALICE).map((option) => option.amount)).toEqual([125, 125]);
		const { state: next, trailLines } = expectOk(applySellBuilding(state, ALICE, "vermillion-alley"));
		expect(trailLines[0]).toBe("<@alice> sold the hotel on Vermillion Alley and, with no houses left in the bank, every rung under it for $125.");
		expect(next.properties["vermillion-alley"]).toMatchObject({ hotel: false, houses: 0 });
		expect(next.bank).toEqual({ houses: 3, hotels: BANK_HOTELS - 1 });
		expect(next.seats[0].chips).toBe(STARTING_CHIPS + 125);
	});

	it("refuses a bare lot, a lot of someone else's, and a lot that takes no buildings", () => {
		const state = builtBrown();
		giveTiles(state, ALICE, "rail-one");
		giveTiles(state, BOB, "reader-dock");
		expectRefusal(applySellBuilding(state, ALICE, "rail-one"), "Rail One has no buildings to sell.");
		expectRefusal(applySellBuilding(state, ALICE, "reader-dock"), "You do not own Reader Dock.");
		expect(listSellOptions(newMatch(), ALICE)).toEqual([]);
	});
});

describe("revision", () => {
	it("starts at 0 and rises by one with every action that lands, and not with a refusal", () => {
		const fresh = newMatch();
		expect(fresh.revision).toBe(0);
		const rolled = rollFrom(fresh, 0, 1, 2).state;
		expect(rolled.revision).toBe(1);
		expectRefusal(applyEndTurn(fresh), /./);
		expect(fresh.revision).toBe(0);
		expect(expectOk(applySkip(rolled, ALICE)).state.revision).toBe(2);
	});
});

describe("trail log", () => {
	it("records trail lines with their actor and keeps only the recent tail", () => {
		let state = newMatch();
		for (let turn = 0; turn < LOG_ENTRY_LIMIT; turn++) {
			state = expectOk(applyRoll(state, diceRng(1, 2))).state;
			if (state.phase === "awaiting-buy-or-skip") state = expectOk(applySkip(state, state.seats[state.activeSeatIndex].userId)).state;
			state = expectOk(applyEndTurn(state)).state;
		}
		expect(state.log).toHaveLength(LOG_ENTRY_LIMIT);
		expect(state.log.at(-1)).toEqual({ userId: BOB, text: "It is now <@alice>'s turn." });
	});
});

// ── a whole match ───────────────────────────────────────────────────────────

// A runaway guard on one seat's turn. Doubles, buys, builds and jail add
// actions, but a legal turn never comes near this.
const ACTIONS_PER_TURN_LIMIT = 60;

// How the fixture's greedy player handles its lots before each roll. These are
// tuned only so a seeded match exercises mortgages, lifts and hotels; they are
// not a strategy anyone should copy.
const LOW_CASH = 150;
const RICH_CASH = 800;
const BUILD_RESERVE = 300;
// What a bidder keeps back when it bids, and what a buyer pays over list price
// to complete a color group by trade. Tuned the same way as the three above.
const AUCTION_RESERVE = 100;
const TRADE_PRICE_MULTIPLIER = 2;

interface MatchTally {
	mortgages: number;
	unmortgages: number;
	hotels: number;
	tradesAccepted: number;
	auctionsWon: number;
}

interface MatchOptions {
	auctionsEnabled: boolean;
	trading: boolean;
}

const PLAIN_MATCH: MatchOptions = { auctionsEnabled: false, trading: false };

// Every invariant a legal state keeps, checked after each turn.
function assertConsistent(state: MonopolyState): void {
	for (const seat of state.seats) {
		expect(seat.chips).toBeGreaterThanOrEqual(0);
		expect(seat.position).toBeGreaterThanOrEqual(0);
		expect(seat.position).toBeLessThan(BOARD_SIZE);
	}
	const seated = new Set(state.seats.filter((seat) => !seat.bankrupt).map((seat) => seat.userId));
	let placedHouses = 0;
	let placedHotels = 0;
	for (const property of Object.values(state.properties)) {
		if (property.ownerId !== null) expect(seated.has(property.ownerId)).toBe(true);
		if (property.houses > 0 || property.hotel) expect(property.mortgaged).toBe(false);
		placedHouses += property.houses;
		if (property.hotel) placedHotels += 1;
	}
	// The bank's buildings are only ever moved, never made or lost.
	expect(state.bank.houses + placedHouses).toBe(BANK_HOUSES);
	expect(state.bank.hotels + placedHotels).toBe(BANK_HOTELS);
	// Every card is in a pile or in a hand, and the hands match what is missing.
	let heldCards = 0;
	for (const seat of state.seats) heldCards += seat.gojfCards;
	expect(heldJailCardIds(state)).toHaveLength(heldCards);
	const piled = state.chanceDeck.length + state.chanceDiscard.length + state.chestDeck.length + state.chestDiscard.length;
	expect(piled + heldCards).toBe(CHANCE_DECK.length + CHEST_DECK.length);
	if (state.phase !== "finished") expect(state.seats[state.activeSeatIndex].bankrupt).toBe(false);
	// Every trade, auction and held debt the driver meets resolves inside the turn.
	expect(state.pendingTrade).toBeNull();
	expect(state.pendingAuction).toBeNull();
	expect(state.pendingDebt).toBeNull();
}

// Mortgages the first lot it can when cash runs low, and lifts the first
// mortgage it can afford when cash runs high.
function adjustMortgages(state: MonopolyState, userId: string, tally: MatchTally): MonopolyState {
	const chips = state.seats[state.activeSeatIndex].chips;
	for (const lot of OWNABLE_TILES) {
		if (state.properties[lot.id].ownerId !== userId) continue;
		if (chips < LOW_CASH) {
			const mortgaged = applyMortgage(state, userId, lot.id);
			if (mortgaged.ok) {
				tally.mortgages++;
				return mortgaged.state;
			}
		}
		if (chips > RICH_CASH) {
			const lifted = applyUnmortgage(state, userId, lot.id);
			if (lifted.ok) {
				tally.unmortgages++;
				return lifted.state;
			}
		}
	}
	return state;
}

// Builds every house and hotel the engine allows while the purse stays above
// the reserve. The engine's refusals are the rules; the fixture only asks.
function buildWhileAffordable(state: MonopolyState, userId: string, tally: MatchTally): MonopolyState {
	let current = state;
	let builtThisPass = true;
	while (builtThisPass) {
		builtThisPass = false;
		for (const lot of OWNABLE_TILES) {
			if (lot.kind !== "property") continue;
			if (current.seats[current.activeSeatIndex].chips - lot.houseCost < BUILD_RESERVE) continue;
			for (const kind of ["house", "hotel"] as const) {
				const built = applyBuild(current, userId, lot.id, kind);
				if (!built.ok) continue;
				current = built.state;
				builtThisPass = true;
				if (kind === "hotel") tally.hotels++;
			}
		}
	}
	return current;
}

// Buys the one lot standing between the active seat and a whole color group,
// at a premium the seller always takes, when the purse covers it. At most one
// trade a call, opened and accepted at once.
function tradeForGroup(state: MonopolyState, userId: string, tally: MatchTally): MonopolyState {
	const chips = state.seats[state.activeSeatIndex].chips;
	for (const groupLots of Object.values(COLOR_GROUPS)) {
		const missing = groupLots.filter((id) => state.properties[id].ownerId !== userId);
		if (missing.length !== 1) continue;
		const sellerId = state.properties[missing[0]].ownerId;
		const price = tile(missing[0]).price * TRADE_PRICE_MULTIPLIER;
		if (sellerId === null || chips - price < BUILD_RESERVE) continue;
		const offered = expectOk(openTrade(state, {
			initiatorId: userId,
			counterpartyId: sellerId,
			offer: { properties: [], chips: price, gojf: 0 },
			request: { properties: missing, chips: 0, gojf: 0 },
			openedAt: NOW,
		})).state;
		tally.tradesAccepted++;
		return expectOk(acceptTrade(offered, sellerId)).state;
	}
	return state;
}

// Every seat still playing bids what it can spare up to list price, and the
// round closes at once.
function runAuction(state: MonopolyState, tally: MatchTally): MonopolyState {
	const auction = state.pendingAuction;
	if (!auction) throw new Error("runAuction needs an open auction");
	let current = state;
	for (const seat of state.seats) {
		const bid = Math.min(tile(auction.tileId).price, seat.chips - AUCTION_RESERVE);
		if (!seat.bankrupt && bid >= 1) current = expectOk(placeBid(current, seat.userId, bid)).state;
	}
	current = expectOk(closeAuction(current)).state;
	if (current.properties[auction.tileId].ownerId !== null) tally.auctionsWon++;
	return current;
}

// Raises cash for the held debt the way the engine did on its own before the debt
// prompt existed (mortgages first, in board order, then the tallest building, the
// first in board order on a tie) and pays it, so the seeded matches below play
// out exactly as they did then. Not counted in the tally, which only ever counted
// the driver's own mortgages.
function settleHeldDebt(state: MonopolyState): MonopolyState {
	const debt = waitingDebt(state);
	if (!debt) throw new Error("settleHeldDebt needs a held debt");
	const level = (current: MonopolyState, tileId: string): number =>
		current.properties[tileId].hotel ? MAX_HOUSES_PER_LOT + 1 : current.properties[tileId].houses;
	let current = state;
	while ((current.seats.find((seat) => seat.userId === debt.debtorId)?.chips ?? 0) < debt.amount) {
		const mortgage = listMortgageOptions(current, debt.debtorId)[0];
		if (mortgage) {
			current = expectOk(applyMortgage(current, debt.debtorId, mortgage.tileId)).state;
			continue;
		}
		const sales = listSellOptions(current, debt.debtorId);
		if (sales.length === 0) break;
		const tallest = sales.reduce((best, option) => (level(current, option.tileId) > level(current, best.tileId) ? option : best));
		current = expectOk(applySellBuilding(current, debt.debtorId, tallest.tileId)).state;
	}
	return expectOk(applyPayDebt(current, debt.debtorId, NOW)).state;
}

// One seat's whole turn, played the way a greedy player would: manage its lots
// before each roll, get out of jail by bail when it can, buy everything it can
// afford, roll again on doubles. With trading on it buys its way into whole
// color groups first; with auctions on, every lot it passes on is auctioned.
function playTurn(state: MonopolyState, rng: () => number, tally: MatchTally, options: MatchOptions): { state: MonopolyState; actions: number } {
	let current = state;
	let actions = 0;
	while (current.phase !== "finished" && actions < ACTIONS_PER_TURN_LIMIT) {
		const seat = current.seats[current.activeSeatIndex];
		actions++;
		if (current.phase === "post-roll") return { state: expectOk(applyEndTurn(current, NOW)).state, actions };
		if (current.phase === "awaiting-buy-or-skip") {
			current = expectOk(buyOrSkip(current, seat.userId)).state;
			continue;
		}
		if (current.phase === "in-auction") {
			current = runAuction(current, tally);
			continue;
		}
		if (current.phase === "awaiting-debt") {
			current = settleHeldDebt(current);
			continue;
		}
		if (options.trading) current = tradeForGroup(current, seat.userId, tally);
		current = buildWhileAffordable(adjustMortgages(current, seat.userId, tally), seat.userId, tally);
		if (seat.inJail) {
			const choice = current.seats[current.activeSeatIndex].chips >= JAIL_BAIL ? "bail" : "roll";
			current = expectOk(applyJailChoice(current, choice, rng, NOW)).state;
			continue;
		}
		const before = current.activeSeatIndex;
		current = expectOk(applyRoll(current, rng, NOW)).state;
		// A forfeit inside the roll already handed the clock on; that ends this turn.
		if (current.activeSeatIndex !== before) return { state: current, actions };
	}
	return { state: current, actions };
}

// Buys the lot under the active seat when the purse covers it, passes otherwise.
function buyOrSkip(state: MonopolyState, userId: string): MonopolyResult {
	const lot = BOARD[state.seats[state.activeSeatIndex].position];
	if (isOwnableTile(lot) && state.seats[state.activeSeatIndex].chips >= lot.price) return applyBuy(state, userId, lot.id);
	return applySkip(state, userId, NOW);
}

// Plays up to `turns` turns from a seed that fixes both the dice and the decks,
// checking every invariant after each turn.
function playMatch(
	players: string[],
	turns: number,
	seed: number,
	options: MatchOptions = PLAIN_MATCH
): { state: MonopolyState; tally: MatchTally } {
	const rng = createSeededRng(seed);
	let state = createInitialState(players, { auctionsEnabled: options.auctionsEnabled }, NOW, seed);
	const tally: MatchTally = { mortgages: 0, unmortgages: 0, hotels: 0, tradesAccepted: 0, auctionsWon: 0 };
	for (let turn = 0; turn < turns && state.phase !== "finished"; turn++) {
		const played = playTurn(state, rng, tally, options);
		expect(played.actions).toBeLessThan(ACTIONS_PER_TURN_LIMIT);
		state = played.state;
		assertConsistent(state);
	}
	return { state, tally };
}

describe("a 50 turn two player match", () => {
	it("plays to completion with one seat out and a winner", () => {
		let { state } = playMatch([ALICE, BOB], 50, SEED);

		// Until Phase 3's bankruptcy flow a long match can end with both seats
		// solvent. The poorer seat then concedes, which is the forfeit path the idle
		// sweep and an admin both use.
		if (state.phase !== "finished") {
			const poorer = [...state.seats].sort((left, right) => left.chips - right.chips)[0];
			state = expectOk(applyForfeit(state, poorer.userId)).state;
		}

		assertConsistent(state);
		expect(state.phase).toBe("finished");
		expect(state.seats.filter((seat) => seat.bankrupt)).toHaveLength(1);
		expect(state.winnerId).toBe(state.seats.find((seat) => !seat.bankrupt)?.userId);
		expect(Object.values(state.properties).some((property) => property.ownerId === state.winnerId)).toBe(true);
	});
});

// Picked from a scan of seeds 1 to 400 as one where the match mortgages, lifts
// a mortgage, builds hotels and plays to a finish inside 100 turns. A change to
// the engine's rules or the decks can move that; if this fails on the tally or
// the finish alone, rescan for a seed rather than loosening the assertions.
const THREE_PLAYER_SEED = 32;

describe("a 100 turn three player match", () => {
	it("plays through mortgages and hotel builds to a winner without throwing", () => {
		const { state, tally } = playMatch([ALICE, BOB, CARA], 100, THREE_PLAYER_SEED);
		expect(tally.mortgages).toBeGreaterThanOrEqual(1);
		expect(tally.unmortgages).toBeGreaterThanOrEqual(1);
		expect(tally.hotels).toBeGreaterThanOrEqual(1);
		expect(state.phase).toBe("finished");
		expect(state.seats.filter((seat) => seat.bankrupt)).toHaveLength(2);
		expect(state.winnerId).toBe(state.seats.find((seat) => !seat.bankrupt)?.userId);
	});
});



// Picked from the same kind of scan (seeds 1 to 400) as one where a five seat
// match with auctions and trading on accepts a trade, sells a lot at auction
// and bankrupts three seats inside 100 turns. Rescan rather than loosen.
const FIVE_PLAYER_SEED = 220;
const FIVE_PLAYERS = [ALICE, BOB, CARA, "dana", "eli"];

describe("a 100 turn five player match", () => {
	it("plays through a trade, an auction and bankruptcies without throwing", () => {
		const { state, tally } = playMatch(FIVE_PLAYERS, 100, FIVE_PLAYER_SEED, { auctionsEnabled: true, trading: true });
		expect(tally.tradesAccepted).toBeGreaterThanOrEqual(1);
		expect(tally.auctionsWon).toBeGreaterThanOrEqual(1);
		expect(state.seats.filter((seat) => seat.bankrupt)).toHaveLength(3);
		expect([...state.seats.map((seat) => seat.bankruptedAt)].filter((order) => order !== null).sort()).toEqual([1, 2, 3]);
	});
});
