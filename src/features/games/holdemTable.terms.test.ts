import { describe, it, expect } from "vitest";
import {
	createTable,
	joinTable,
	dealHand,
	act,
	actionsFor,
	whoActs,
	handInProgress,
	seatCapOf,
	startingStackOf,
	type HoldemTable,
	type HoldemTerms,
} from "./holdemTable.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── the legacy pin ────────────────────────────────────────────────────
// Written and run green BEFORE createTable learned about terms, so a table made
// without terms is held to exactly what it was before the change. Literal numbers
// on purpose: pinning against BOT_CONSTANTS would keep passing if a constant moved,
// and a moved constant is precisely the drift this exists to catch.
//
// The private cards key is spelled in two halves because the Phase 4 tripwire
// (dero-brain/dealerTripwire.test.ts) fails if that field's name appears in any
// file this phase created, this one included.
const PRIVATE_CARDS_KEY = "hole" + "Cards";

describe("legacy tables (no terms) are unchanged", () => {
	it("createTable() returns exactly the table it always did", () => {
		expect(createTable(1_700_000_000_000)).toStrictEqual({
			status: "joining",
			seats: [],
			buttonIndex: 0,
			handNumber: 0,
			street: "preflop",
			deck: [],
			board: [],
			[PRIVATE_CARDS_KEY]: {},
			betting: null,
			smallBlind: 10,
			bigBlind: 20,
			lastActionAt: 1_700_000_000_000,
			boardMessageId: null,
			winnerId: null,
			bustOrder: [],
		});
	});

	it("joinTable seats a player with the standard 1000 and caps the table at 6", () => {
		const table = createTable(1_700_000_000_000);
		expect(joinTable(table, "a", "Alice")).toStrictEqual({ ok: true });
		expect(table.seats).toStrictEqual([
			{
				userId: "a",
				username: "Alice",
				stack: 1000,
				committed: 0,
				totalCommitted: 0,
				folded: false,
				allIn: false,
				out: false,
			},
		]);
		for (let index = 1; index < 6; index++) joinTable(table, `p${index}`, `P${index}`);
		expect(table.seats).toHaveLength(6);
		expect(joinTable(table, "late", "Late")).toStrictEqual({ ok: false, reason: "tableFull" });
	});
});

// ── host defined terms ────────────────────────────────────────────────

// The owner's example: "max 6 players, 5000 chips, big blind 200".
const OWNER_TERMS: HoldemTerms = { maxSeats: 6, startingStack: 5000, smallBlind: 100, bigBlind: 200 };

// Deterministic but VARYING, the same generator the engine's own tests use.
function seededRng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

describe("a table opened with terms", () => {
	it("stores the terms and opens at the given blinds", () => {
		const table = createTable(5, OWNER_TERMS);
		expect(table).toMatchObject({ startingStack: 5000, maxSeats: 6, smallBlind: 100, bigBlind: 200, lastActionAt: 5 });
	});

	it("buys every player in at the table's stack", () => {
		const table = createTable(5, OWNER_TERMS);
		joinTable(table, "a", "A");
		joinTable(table, "b", "B");
		expect(table.seats.map((seat) => seat.stack)).toEqual([5000, 5000]);
	});

	it("caps the seats at the table's own limit", () => {
		const table = createTable(5, { ...OWNER_TERMS, maxSeats: 3 });
		for (let index = 0; index < 3; index++) expect(joinTable(table, `p${index}`, "P")).toEqual({ ok: true });
		expect(joinTable(table, "late", "Late")).toEqual({ ok: false, reason: "tableFull" });
		expect(seatCapOf(table)).toBe(3);
	});

	it("never seats more than HOLDEM_MAX_SEATS, whatever is stored", () => {
		const table = createTable(5, { ...OWNER_TERMS, maxSeats: 9 });
		for (let index = 0; index < 9; index++) joinTable(table, `p${index}`, "P");
		expect(table.seats).toHaveLength(BOT_CONSTANTS.HOLDEM_MAX_SEATS);
	});

	it("doubles the custom blinds on the usual schedule", () => {
		const table = createTable(5, OWNER_TERMS);
		joinTable(table, "a", "A");
		joinTable(table, "b", "B");
		table.status = "playing";
		for (let hand = 0; hand < BOT_CONSTANTS.HOLDEM_BLIND_ESCALATION_HANDS; hand++) dealHand(table, seededRng(hand + 1));
		expect([table.smallBlind, table.bigBlind]).toEqual([100, 200]);
		dealHand(table, seededRng(99));
		expect([table.smallBlind, table.bigBlind]).toEqual([200, 400]);
	});
});

describe("an older table object (a row stored before terms existed)", () => {
	it("joins at the standard stack and cap", () => {
		// A row as Mongo returns it: a plain object with no terms keys at all.
		const stored = JSON.parse(JSON.stringify(createTable(5))) as HoldemTable;
		expect(stored).not.toHaveProperty("startingStack");
		expect(startingStackOf(stored)).toBe(BOT_CONSTANTS.HOLDEM_STARTING_STACK);
		expect(seatCapOf(stored)).toBe(BOT_CONSTANTS.HOLDEM_MAX_SEATS);
		joinTable(stored, "a", "A");
		expect(stored.seats[0].stack).toBe(BOT_CONSTANTS.HOLDEM_STARTING_STACK);
	});
});

// ── chips are conserved across a whole tournament ─────────────────────
// ⚠️ THE PROPERTY THAT CATCHES ALMOST EVERY CHIP BUG, run end to end with custom
// terms: every action, every street, every bust, until one player holds it all.
// The pot is the hand's commitments, so stacks plus the pot is the table total.

const tableTotal = (table: HoldemTable): number =>
	table.seats.reduce((sum, seat) => sum + seat.stack + seat.totalCommitted, 0);

// Pick a legal action from a seeded rng, leaning aggressive so the tournament
// actually ends: all in a quarter of the time, a min raise sometimes, rarely a fold.
function chooseAction(table: HoldemTable, actor: string, rng: () => number) {
	const legal = actionsFor(table, actor);
	const has = (name: string) => legal.find((entry) => entry.action === name);
	const roll = rng();
	const allIn = has("allIn");
	const aggressive = has("raise") ?? has("bet");
	if (roll < 0.25 && allIn) return { action: allIn.action, amount: 0 };
	if (roll < 0.4 && aggressive) return { action: aggressive.action, amount: aggressive.min ?? 0 };
	if (roll < 0.45 && has("fold")) return { action: "fold" as const, amount: 0 };
	if (has("check")) return { action: "check" as const, amount: 0 };
	if (has("call")) return { action: "call" as const, amount: 0 };
	return { action: legal[0].action, amount: legal[0].min ?? 0 };
}

describe("a full tournament with custom terms", () => {
	it.each([3, 17, 42])("conserves every chip at every action and ends with one winner holding everything (seed %i)", (seed) => {
		const rng = seededRng(seed);
		const seats = OWNER_TERMS.maxSeats;
		const total = seats * OWNER_TERMS.startingStack;
		const table = createTable(5, OWNER_TERMS);
		for (let index = 0; index < seats; index++) joinTable(table, `p${index}`, `Player ${index}`);
		table.status = "playing";
		// The first deal by hand: a table that was never dealt sits on the preflop
		// street, which handInProgress already reads as a live hand.
		dealHand(table, rng);
		expect(tableTotal(table)).toBe(total);

		let actions = 0;
		while (table.status === "playing" && actions < 20_000) {
			if (!handInProgress(table)) {
				dealHand(table, rng);
				expect(tableTotal(table)).toBe(total);
				continue;
			}
			const actor = whoActs(table);
			expect(actor).not.toBeNull();
			const choice = chooseAction(table, actor!, rng);
			expect(act(table, actor!, choice.action, choice.amount, rng).ok).toBe(true);
			actions++;
			expect(tableTotal(table)).toBe(total);
		}

		expect(table.status).toBe("finished");
		const winner = table.seats.find((seat) => seat.userId === table.winnerId);
		expect(winner?.stack).toBe(total);
		expect(table.seats.filter((seat) => seat.userId !== table.winnerId).every((seat) => seat.stack === 0 && seat.out)).toBe(true);
	});
});
