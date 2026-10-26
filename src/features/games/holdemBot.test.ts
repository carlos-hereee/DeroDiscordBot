import { describe, it, expect } from "vitest";
import { botViewOf, decideHoldemMove, handKey, readHand, startingHandGroup, type HoldemBotView } from "./holdemBot.js";
import { act, actionsFor, createTable, dealHand, handInProgress, joinTable, livePlayers, whoActs, type HoldemTable } from "./holdemTable.js";
import type { Card, Suit } from "./holdemHand.js";
import type { LegalAction } from "./holdemBetting.js";

// ── the Hold'em bot (2026-10 item 250 Phase 5) ──────────────────────────────
// The spell's rules: the 169 hand groups preflop, tighter early and wider late, made
// hand and draw strength against the pot odds after the flop, bets of 50 to 75 percent
// of the pot, raises of 2.5 to 3.5 times, all in only with two pair or better once half
// its chips are in, no bluffs, and never a look at another seat's cards. The simulation
// plays a hundred hands against a random player and checks every move was legal.

function seededRng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

const RANKS: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
// "As" is the ace of spades, "Td" the ten of diamonds.
const card = (text: string): Card => ({ rank: RANKS[text[0]] ?? Number(text[0]), suit: text[1] as Suit });
const cards = (text: string): Card[] => text.split(" ").map(card);

const legal = (entries: Partial<Record<LegalAction["action"], [number, number]>>, toCall: number): LegalAction[] => {
	const list: LegalAction[] = [{ action: "fold", cost: 0 }, toCall === 0 ? { action: "check", cost: 0 } : { action: "call", cost: toCall }];
	for (const [action, [min, max]] of Object.entries(entries) as Array<[LegalAction["action"], [number, number]]>) list.push({ action, cost: min, min, max });
	return list;
};

function view(overrides: Partial<HoldemBotView>): HoldemBotView {
	return {
		holeCards: cards("As Ad"),
		board: [],
		pot: 30,
		toCall: 20,
		stack: 980,
		committed: 0,
		handCommitted: 0,
		currentBet: 20,
		bigBlind: 20,
		opponents: 3,
		position: "early",
		legal: legal({ raise: [40, 980], allIn: [980, 980] }, 20),
		...overrides,
	};
}

describe("the starting hands", () => {
	it("names two cards high card first, with s for suited and o for offsuit", () => {
		expect(handKey(card("Kd"), card("As"))).toBe("AKo");
		expect(handKey(card("9h"), card("Th"))).toBe("T9s");
		expect(handKey(card("7c"), card("7d"))).toBe("77");
	});

	it("places hands in the standard groups, and anything unlisted in 9", () => {
		expect(startingHandGroup(cards("As Ah"))).toBe(1);
		expect(startingHandGroup(cards("As Ks"))).toBe(1);
		expect(startingHandGroup(cards("As Kd"))).toBe(2);
		expect(startingHandGroup(cards("5h 4h"))).toBe(6);
		expect(startingHandGroup(cards("7s 2d"))).toBe(9);
	});
});

describe("preflop", () => {
	it("opens aces from early position to 2.5 to 3.5 big blinds", () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			const move = decideHoldemMove(view({}), seededRng(seed));
			expect(move.action).toBe("raise");
			expect(move.amount).toBeGreaterThanOrEqual(50);
			expect(move.amount).toBeLessThanOrEqual(70);
		}
	});

	it("folds seven deuce facing a raise, and checks it in the big blind when nobody raised", () => {
		const trash = cards("7s 2d");
		expect(decideHoldemMove(view({ holeCards: trash, currentBet: 60, toCall: 60, pot: 90 })).action).toBe("fold");
		expect(decideHoldemMove(view({ holeCards: trash, position: "blind", toCall: 0, committed: 20, legal: legal({ raise: [40, 1000] }, 0) })).action).toBe("check");
	});

	it("opens wider on the button than up front", () => {
		const suitedConnector = cards("8h 7h"); // group 5
		expect(decideHoldemMove(view({ holeCards: suitedConnector, position: "early" })).action).toBe("fold");
		expect(decideHoldemMove(view({ holeCards: suitedConnector, position: "late" })).action).toBe("raise");
	});

	it("re-raises the top groups and calls the next ones", () => {
		const facing = { currentBet: 60, toCall: 60, pot: 90, legal: legal({ raise: [100, 980], allIn: [980, 980] }, 60) };
		expect(decideHoldemMove(view({ ...facing, holeCards: cards("Ks Kh") }), seededRng(9)).action).toBe("raise");
		expect(decideHoldemMove(view({ ...facing, holeCards: cards("9s 9h") })).action).toBe("call");
	});

	it("goes all in short stacked with a strong hand, and folds a weak one", () => {
		const short = { stack: 150, legal: legal({ raise: [40, 150], allIn: [150, 150] }, 20) };
		expect(decideHoldemMove(view({ ...short, holeCards: cards("Qs Qh") })).action).toBe("allIn");
		expect(decideHoldemMove(view({ ...short, holeCards: cards("9s 3h") })).action).toBe("fold");
	});
});

describe("after the flop", () => {
	const flop = cards("Kh 7c 2d");
	const unbet = { board: flop, currentBet: 0, toCall: 0, pot: 120, opponents: 1, legal: legal({ bet: [20, 940], allIn: [940, 940] }, 0) };

	it("bets top pair with a good kicker for 50 to 75 percent of the pot", () => {
		for (const seed of [11, 12, 13]) {
			const move = decideHoldemMove(view({ ...unbet, holeCards: cards("Ks Qd") }), seededRng(seed));
			expect(move.action).toBe("bet");
			expect(move.amount).toBeGreaterThanOrEqual(60);
			expect(move.amount).toBeLessThanOrEqual(90);
		}
	});

	it("checks with nothing rather than bluffing", () => {
		expect(decideHoldemMove(view({ ...unbet, holeCards: cards("9s 8s") })).action).toBe("check");
	});

	it("folds nothing to a big bet and calls a draw getting the right price", () => {
		const facing = { board: cards("Kh 7h 2d"), currentBet: 100, toCall: 100, pot: 220, opponents: 1, legal: legal({ raise: [200, 940], allIn: [940, 940] }, 100) };
		expect(decideHoldemMove(view({ ...facing, holeCards: cards("9s 8c") })).action).toBe("fold");
		// A flush draw: 9 outs times 4 percent is 36 percent, against odds of 100 in 320 (31 percent).
		expect(decideHoldemMove(view({ ...facing, holeCards: cards("Ah 4h") })).action).toBe("call");
	});

	it("never reads a pair on the board as its own", () => {
		expect(readHand({ holeCards: cards("9s 8c"), board: cards("Kh Kc 2d") })).toEqual({ strength: 0.12, category: null });
		expect(readHand({ holeCards: cards("Ks 8c"), board: cards("Kh Kc 2d") }).category).toBe("three of a kind");
	});

	it("goes all in with two pair only once half its chips are in, and never with one pair", () => {
		const twoPair = cards("Ks 7s");
		const deep = { ...unbet, holeCards: twoPair, stack: 900, handCommitted: 100 };
		expect(decideHoldemMove(view(deep), seededRng(3)).action).toBe("bet");
		const committed = { ...unbet, holeCards: twoPair, stack: 300, handCommitted: 700, legal: legal({ bet: [20, 300], allIn: [300, 300] }, 0) };
		expect(decideHoldemMove(view(committed)).action).toBe("allIn");
		const onePair = { ...committed, holeCards: cards("Ks Qd") };
		expect(decideHoldemMove(view(onePair), seededRng(3)).action).not.toBe("allIn");
	});
});

describe("what the bot sees", () => {
	it("is its own two cards and the public table, never another seat's hand", () => {
		const table = createTable();
		joinTable(table, "dero-bot-red", "Dero Red");
		joinTable(table, "human", "Human");
		table.status = "playing";
		dealHand(table, seededRng(4));
		const botId = whoActs(table) === "dero-bot-red" ? "dero-bot-red" : null;
		if (!botId) act(table, "human", "call");
		const seen = botViewOf(table, "dero-bot-red");
		expect(seen).not.toBeNull();
		expect(seen?.holeCards).toEqual(table.holeCards["dero-bot-red"]);
		const humanCards = JSON.stringify(table.holeCards.human);
		expect(JSON.stringify({ ...seen, holeCards: [] })).not.toContain(humanCards.slice(1, -1));
		expect(botViewOf(table, "human")).toBeNull();
	});
});

// ── the simulation ────────────────────────────────────────────────────
// A random player picks uniformly among its legal actions (a random legal size for a
// bet or raise). Every bot move must be in the engine's legal list and land, the chips
// at the table must stay constant, and a hundred hands must play out.
function randomMove(table: HoldemTable, userId: string, rng: () => number): { action: LegalAction["action"]; amount: number } {
	const options = actionsFor(table, userId);
	const choice = options[Math.floor(rng() * options.length)];
	if (choice.action === "bet" || choice.action === "raise") {
		const min = choice.min ?? 0;
		const max = choice.max ?? min;
		return { action: choice.action, amount: Math.floor(min + (max - min) * rng()) };
	}
	return { action: choice.action, amount: 0 };
}

const chipsAt = (table: HoldemTable): number => table.seats.reduce((sum, seat) => sum + seat.stack + seat.totalCommitted, 0);

describe("a hundred hands against a random player", () => {
	it.each([3, 17, 42])("plays only legal moves, seed %i", (seed) => {
		const rng = seededRng(seed);
		let hands = 0;
		let botMoves = 0;
		while (hands < 100) {
			const table = createTable();
			joinTable(table, "dero-bot-red", "Dero Red");
			joinTable(table, "dero-bot-blue", "Dero Blue");
			joinTable(table, "random", "Random");
			table.status = "playing";
			const total = chipsAt(table);
			// The first deal by hand: a table never dealt sits on the preflop street, which
			// handInProgress already reads as a live hand with nobody to act.
			dealHand(table, rng);
			hands++;
			while (table.status === "playing" && hands < 100) {
				if (!handInProgress(table)) {
					if (livePlayers(table).length < 2) break;
					dealHand(table, rng);
					hands++;
					continue;
				}
				const actor = whoActs(table);
				if (!actor) break;
				if (actor.startsWith("dero-bot-")) {
					const seen = botViewOf(table, actor);
					expect(seen).not.toBeNull();
					const move = decideHoldemMove(seen!, rng);
					const entry = seen!.legal.find((option) => option.action === move.action);
					expect(entry, `${move.action} was not legal`).toBeDefined();
					if (move.action === "bet" || move.action === "raise") {
						expect(move.amount).toBeGreaterThanOrEqual(entry!.min!);
						expect(move.amount).toBeLessThanOrEqual(entry!.max!);
					}
					expect(act(table, actor, move.action, move.amount, rng).ok).toBe(true);
					botMoves++;
				} else {
					const move = randomMove(table, actor, rng);
					expect(act(table, actor, move.action, move.amount, rng).ok).toBe(true);
				}
				expect(chipsAt(table)).toBe(total);
			}
		}
		expect(hands).toBe(100);
		expect(botMoves).toBeGreaterThan(100);
	});
});
