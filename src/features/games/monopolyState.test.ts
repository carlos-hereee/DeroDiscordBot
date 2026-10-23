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
	findOwnableTile,
	isOwnableTile,
	type OwnableTile,
} from "./monopolyBoard.js";
import { LOG_ENTRY_LIMIT } from "./monopolySeats.js";
import {
	applyBuy,
	applyEndTurn,
	applyForfeit,
	applyJailChoice,
	applyRoll,
	applySkip,
	calculateRent,
	createInitialState,
	type MonopolyResult,
	type MonopolyState,
} from "./monopolyState.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const ALICE = "alice";
const BOB = "bob";
const CARA = "cara";
const NOW = 1_000;
const LATER = 2_000;

const newMatch = (players: string[] = [ALICE, BOB]): MonopolyState =>
	createInitialState(players, { auctionsEnabled: false }, NOW);

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
		expect([state.chanceDeck, state.chestDeck, state.chanceDiscard, state.chestDiscard]).toEqual([[], [], [], []]);
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

	it("defaults the clock to now", () => {
		const before = Date.now();
		const state = createInitialState([ALICE, BOB], { auctionsEnabled: false });
		expect(state.turnStartedAt).toBeGreaterThanOrEqual(before);
	});
});

// ── roll ────────────────────────────────────────────────────────────────────

describe("applyRoll", () => {
	it("moves the token, closes the roll, and leaves the input untouched", () => {
		const state = newMatch();
		const { state: next, trailLines } = rollFrom(structuredClone(state), 0, 3, 4);
		expect(next.seats[0].position).toBe(7);
		expect(next.diceRoll).toEqual([3, 4]);
		expect(next.rolledThisTurn).toBe(true);
		expect(next.phase).toBe("post-roll");
		expect(trailLines).toEqual([
			"<@alice> rolled 3 and 4.",
			"<@alice> landed on Chance.",
			"The card decks are not in play yet, so nothing happens.",
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
		expect(trailLines.at(-1)).toBe("Cinder Row is for sale for $60.");
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
		giveTiles(state, BOB, "teal-ridge");
		const { state: next, trailLines } = rollFrom(state, 0, 2, 4);
		expect(next.seats[0].chips).toBe(STARTING_CHIPS - 6);
		expect(next.seats[1].chips).toBe(STARTING_CHIPS + 6);
		expect(trailLines.at(-1)).toBe("<@alice> paid $6 rent to <@bob>.");
	});

	it("doubles base rent when the owner holds the whole group", () => {
		const state = newMatch();
		giveTiles(state, BOB, "teal-ridge", "frost-hollow", "skyglass-terrace");
		expect(rollFrom(state, 0, 2, 4).state.seats[1].chips).toBe(STARTING_CHIPS + 12);
	});

	it("charges nothing on your own lot, a mortgaged lot, or a transport for now", () => {
		const own = newMatch();
		giveTiles(own, ALICE, "teal-ridge");
		expect(rollFrom(own, 0, 2, 4).trailLines.at(-1)).toBe("<@alice> already owns Teal Ridge.");

		const mortgaged = newMatch();
		giveTiles(mortgaged, BOB, "teal-ridge");
		mortgaged.properties["teal-ridge"].mortgaged = true;
		const mortgagedRoll = rollFrom(mortgaged, 0, 2, 4);
		expect(mortgagedRoll.state.seats[0].chips).toBe(STARTING_CHIPS);
		expect(mortgagedRoll.trailLines.at(-1)).toBe("Teal Ridge is mortgaged, so no rent is due.");

		const transport = newMatch();
		giveTiles(transport, BOB, "skyrail-station");
		expect(rollFrom(transport, 0, 2, 3).trailLines.at(-1)).toBe("No rent is charged on Skyrail Station yet.");
	});

	it("reads houses and the hotel from the rent table", () => {
		const state = newMatch();
		const teal = tile("teal-ridge");
		expect(calculateRent(state, teal)).toBe(0);
		giveTiles(state, BOB, "teal-ridge");
		state.properties["teal-ridge"].houses = 2;
		expect(calculateRent(state, teal)).toBe(90);
		state.properties["teal-ridge"].hotel = true;
		expect(calculateRent(state, teal)).toBe(550);
		state.properties["teal-ridge"].mortgaged = true;
		expect(calculateRent(state, teal)).toBe(0);
	});

	it("takes every chip a seat has when rent is short, and forfeits it", () => {
		const state = newMatch();
		giveTiles(state, BOB, "teal-ridge", "frost-hollow", "skyglass-terrace");
		state.seats[0].chips = 4;
		const { state: next, trailLines } = rollFrom(state, 0, 2, 4);
		expect(next.seats[1].chips).toBe(STARTING_CHIPS + 4);
		expect(next.seats[0]).toMatchObject({ bankrupt: true, chips: 0, bankruptedAt: 1 });
		expect(next.phase).toBe("finished");
		expect(next.winnerId).toBe(BOB);
		expect(trailLines).toContain("<@alice> could cover only $4 of $12.");
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

// ── buy and skip ────────────────────────────────────────────────────────────

describe("applyBuy and applySkip", () => {
	const awaitingCinderRow = (): MonopolyState => rollFrom(newMatch(), 0, 1, 2).state;

	it("buys the lot for sale at list price", () => {
		const { state, trailLines } = expectOk(applyBuy(awaitingCinderRow(), ALICE, "cinder-row"));
		expect(state.properties["cinder-row"].ownerId).toBe(ALICE);
		expect(state.seats[0].chips).toBe(STARTING_CHIPS - 60);
		expect(state.phase).toBe("post-roll");
		expect(trailLines).toEqual(["<@alice> bought Cinder Row for $60."]);
	});

	it("refuses another player, the wrong tile, a short purse and the wrong phase", () => {
		expectRefusal(applyBuy(awaitingCinderRow(), BOB, "cinder-row"), "It is not your turn.");
		expectRefusal(applyBuy(awaitingCinderRow(), ALICE, "teal-ridge"), "You can only buy the tile you are standing on.");
		const broke = awaitingCinderRow();
		broke.seats[0].chips = 59;
		expectRefusal(applyBuy(broke, ALICE, "cinder-row"), "You need $60 to buy Cinder Row.");
		expectRefusal(applyBuy(newMatch(), ALICE, "cinder-row"), "There is nothing to buy right now.");
		const finished = awaitingCinderRow();
		finished.phase = "finished";
		expectRefusal(applyBuy(finished, ALICE, "cinder-row"), "The match is already over.");
	});

	it("passes on the lot and leaves it with the bank", () => {
		const { state, trailLines } = expectOk(applySkip(awaitingCinderRow(), ALICE));
		expect(state.properties["cinder-row"].ownerId).toBeNull();
		expect(state.phase).toBe("post-roll");
		expect(trailLines).toEqual(["<@alice> passed on Cinder Row."]);
	});

	it("refuses a skip from another player or with nothing for sale", () => {
		expectRefusal(applySkip(awaitingCinderRow(), BOB), "It is not your turn.");
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

	it("forfeits a seat that cannot cover the forced bail", () => {
		const state = jailedMatch();
		Object.assign(state.seats[0], { jailTurnsRemaining: 1, chips: 10 });
		const { state: next, trailLines } = expectOk(applyJailChoice(state, "roll", diceRng(1, 2)));
		expect(next.seats[0]).toMatchObject({ bankrupt: true, position: JAIL_INDEX });
		expect(next.winnerId).toBe(BOB);
		expect(trailLines).toContain("<@alice> could cover only $10 of $50.");
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
		giveTiles(state, BOB, "teal-ridge", "frost-hollow");
		state.properties["teal-ridge"].houses = 3;
		state.properties["frost-hollow"].hotel = true;
		state.seats[1].gojfCards = 1;
		const { state: next, trailLines } = expectOk(applyForfeit(state, BOB, LATER));
		expect(next.seats[1]).toMatchObject({ bankrupt: true, bankruptedAt: 1, chips: 0, gojfCards: 0 });
		expect(next.properties["teal-ridge"]).toEqual({ ownerId: null, houses: 0, hotel: false, mortgaged: false });
		expect(next.properties["frost-hollow"].ownerId).toBeNull();
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

// ── log ─────────────────────────────────────────────────────────────────────

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

// A seeded generator (mulberry32) so the 50 turn match is the same match on
// every run. It drives only the fixture; the engine still rolls through
// resolveVersus.
function seededRng(seed: number): () => number {
	let value = seed;
	return () => {
		value = (value + 0x6d2b79f5) | 0;
		let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

const MATCH_TURNS = 50;
// Doubles and buys add actions within a turn; this is a runaway guard, far above
// what 50 turns can take.
const ACTION_LIMIT = MATCH_TURNS * 20;

// Every invariant a legal state keeps, checked after each action.
function assertConsistent(state: MonopolyState): void {
	for (const seat of state.seats) {
		expect(seat.chips).toBeGreaterThanOrEqual(0);
		expect(seat.position).toBeGreaterThanOrEqual(0);
		expect(seat.position).toBeLessThan(BOARD_SIZE);
	}
	const seated = new Set(state.seats.filter((seat) => !seat.bankrupt).map((seat) => seat.userId));
	for (const property of Object.values(state.properties)) {
		if (property.ownerId !== null) expect(seated.has(property.ownerId)).toBe(true);
	}
	if (state.phase !== "finished") expect(state.seats[state.activeSeatIndex].bankrupt).toBe(false);
}

// One seat's whole turn, played the way a greedy player would: get out of jail
// by bail when it can, buy everything it can afford, roll again on doubles.
function playTurn(state: MonopolyState, rng: () => number): { state: MonopolyState; actions: number } {
	let current = state;
	let actions = 0;
	while (current.phase !== "finished" && actions < ACTION_LIMIT) {
		const seat = current.seats[current.activeSeatIndex];
		actions++;
		if (current.phase === "post-roll") return { state: expectOk(applyEndTurn(current, NOW)).state, actions };
		if (current.phase === "awaiting-buy-or-skip") {
			current = expectOk(buyOrSkip(current, seat.userId)).state;
			continue;
		}
		if (seat.inJail) {
			const choice = seat.chips >= JAIL_BAIL ? "bail" : "roll";
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
	return applySkip(state, userId);
}

describe("a 50 turn two player match", () => {
	it("plays to completion with one seat out and a winner", () => {
		const rng = seededRng(241);
		let state = newMatch();
		let turns = 0;
		let actions = 0;
		while (turns < MATCH_TURNS && state.phase !== "finished") {
			const played = playTurn(state, rng);
			state = played.state;
			actions += played.actions;
			turns++;
			assertConsistent(state);
		}
		expect(actions).toBeLessThan(ACTION_LIMIT);

		// Phase 1 has no bankruptcy flow, so a long match usually ends with both
		// seats solvent. The poorer seat then concedes, which is the forfeit path
		// the idle sweep and an admin both use.
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
