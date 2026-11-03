import { describe, it, expect } from "vitest";
import { BANK_HOTELS, COLOR_GROUPS, STARTING_CHIPS, type ColorGroup } from "./monopolyBoard.js";
import { buildingLevel } from "./monopolyBuildings.js";
import { applySellBuilding, createInitialState, listSellOptions, type MonopolyResult, type MonopolyState } from "./monopolyState.js";

// ── monopolyBuildings tests ─────────────────────────────────────────────────
// The house shortage hotel sale of 2026-10 item 280: selling a hotel the bank
// cannot hand four houses back for brings the whole color group down evenly to
// what the bank can supply, and pays half the house cost for every rung removed.

// ── fixtures ────────────────────────────────────────────────────────────────

const ALICE = "alice";
const BOB = "bob";
const NOW = 1_000;
const SEED = 241;

// Orange houses cost $100, so every rung sold back pays $50.
const ORANGE_RUNG_PRICE = 50;
// Brown houses cost $50, so every rung sold back pays $25.
const BROWN_RUNG_PRICE = 25;

const newMatch = (): MonopolyState => createInitialState([ALICE, BOB], { auctionsEnabled: false }, NOW, SEED);

function expectOk(result: MonopolyResult): { state: MonopolyState; trailLines: string[] } {
	if (!result.ok) throw new Error(`expected ok, got refusal: ${result.reason}`);
	return result;
}

// A color group owned by Alice with the given rung per lot (board order, 5 is a
// hotel) and `bankHouses` left in the bank. The bank's hotels are the full stock
// less the hotels on the board, so the hotel count conserves from the start.
function builtGroup(group: ColorGroup, levels: number[], bankHouses: number): MonopolyState {
	const state = newMatch();
	COLOR_GROUPS[group].forEach((tileId, index) => {
		const property = state.properties[tileId];
		property.ownerId = ALICE;
		property.hotel = levels[index] === 5;
		property.houses = property.hotel ? 0 : levels[index];
	});
	state.bank.houses = bankHouses;
	state.bank.hotels = BANK_HOTELS - levels.filter((level) => level === 5).length;
	return state;
}

const groupLevels = (state: MonopolyState, group: ColorGroup): number[] => COLOR_GROUPS[group].map((id) => buildingLevel(state.properties[id]));

// Houses and hotels on the board plus the bank's stock: a sale moves buildings
// between the two and must never create or destroy one.
function buildingStock(state: MonopolyState): { houses: number; hotels: number } {
	let houses = state.bank.houses;
	let hotels = state.bank.hotels;
	for (const property of Object.values(state.properties)) {
		houses += property.houses;
		if (property.hotel) hotels += 1;
	}
	return { houses, hotels };
}

const rungTotal = (levels: number[]): number => levels.reduce((sum, level) => sum + level, 0);

// ── the shortage sale ───────────────────────────────────────────────────────

describe("selling a hotel during a house shortage", () => {
	// Three orange hotels, sold from the middle lot, with 0 to 3 houses in the bank.
	// The group comes down to houses only, the extra house on the first lots in
	// board order, and every rung removed pays $50.
	const orangeShortages = [
		{ bankHouses: 0, after: [0, 0, 0] },
		{ bankHouses: 1, after: [1, 0, 0] },
		{ bankHouses: 2, after: [1, 1, 0] },
		{ bankHouses: 3, after: [1, 1, 1] },
	];

	for (const { bankHouses, after } of orangeShortages) {
		it(`brings three orange hotels down evenly to ${after.join(", ")} with ${bankHouses} houses in the bank`, () => {
			const state = builtGroup("orange", [5, 5, 5], bankHouses);
			const stockBefore = buildingStock(state);
			const { state: next } = expectOk(applySellBuilding(state, ALICE, "market-avenue"));

			expect(groupLevels(next, "orange")).toEqual(after);
			const paid = next.seats[0].chips - STARTING_CHIPS;
			expect(paid).toBe((15 - rungTotal(after)) * ORANGE_RUNG_PRICE);
			expect(buildingStock(next)).toEqual(stockBefore);
			expect(next.bank).toEqual({ houses: bankHouses - rungTotal(after), hotels: BANK_HOTELS });
		});
	}

	it("brings the group down the same way whichever lot's hotel is sold", () => {
		for (const tileId of COLOR_GROUPS.orange) {
			const { state: next } = expectOk(applySellBuilding(builtGroup("orange", [5, 5, 5], 2), ALICE, tileId));
			expect(groupLevels(next, "orange")).toEqual([1, 1, 0]);
		}
	});

	it("tells the table the whole group came down and what it paid", () => {
		const { trailLines } = expectOk(applySellBuilding(builtGroup("orange", [5, 5, 5], 2), ALICE, "amber-walk"));
		expect(trailLines).toEqual([
			"<@alice> sold the hotel on Amber Walk, and with too few houses in the bank to rebuild under it, the orange group came down evenly to 2 houses for $650.",
		]);
	});

	it("brings a two lot group down evenly: two brown hotels with 3 houses in the bank become 2 and 1", () => {
		const state = builtGroup("brown", [5, 5], 3);
		const stockBefore = buildingStock(state);
		const { state: next } = expectOk(applySellBuilding(state, ALICE, "burnt-umber-row"));
		expect(groupLevels(next, "brown")).toEqual([2, 1]);
		expect(next.seats[0].chips).toBe(STARTING_CHIPS + 7 * BROWN_RUNG_PRICE);
		expect(buildingStock(next)).toEqual(stockBefore);
		expect(next.bank).toEqual({ houses: 0, hotels: BANK_HOTELS });
	});

	it("counts the houses already on the group toward what it can keep", () => {
		// A hotel and four houses with 2 in the bank: the six houses spread to 3 and 3.
		const brown = builtGroup("brown", [4, 5], 2);
		const brownNext = expectOk(applySellBuilding(brown, ALICE, "burnt-umber-row")).state;
		expect(groupLevels(brownNext, "brown")).toEqual([3, 3]);
		expect(brownNext.seats[0].chips).toBe(STARTING_CHIPS + 3 * BROWN_RUNG_PRICE);
		expect(buildingStock(brownNext)).toEqual(buildingStock(brown));

		// Two hotels and four houses with 3 in the bank: seven houses spread to 3, 2 and 2.
		const orange = builtGroup("orange", [5, 5, 4], 3);
		const orangeNext = expectOk(applySellBuilding(orange, ALICE, "amber-walk")).state;
		expect(groupLevels(orangeNext, "orange")).toEqual([3, 2, 2]);
		expect(orangeNext.seats[0].chips).toBe(STARTING_CHIPS + 7 * ORANGE_RUNG_PRICE);
		expect(buildingStock(orangeNext)).toEqual(buildingStock(orange));
	});

	it("always leaves the group even and never raises a lot", () => {
		const shapes = [
			[5, 5, 5],
			[5, 5, 4],
			[5, 4, 4],
			[4, 5, 5],
		];
		for (const levels of shapes) {
			for (let bankHouses = 0; bankHouses < 4; bankHouses++) {
				const hotelLot = COLOR_GROUPS.orange[levels.indexOf(5)];
				const next = expectOk(applySellBuilding(builtGroup("orange", levels, bankHouses), ALICE, hotelLot)).state;
				const after = groupLevels(next, "orange");
				expect(Math.max(...after) - Math.min(...after)).toBeLessThanOrEqual(1);
				after.forEach((level, index) => expect(level).toBeLessThanOrEqual(levels[index]));
				expect(after.every((level) => level < 5)).toBe(true);
			}
		}
	});

	it("sells a hotel exactly as before when the bank has the four houses", () => {
		const state = builtGroup("orange", [5, 5, 5], 4);
		const { state: next, trailLines } = expectOk(applySellBuilding(state, ALICE, "market-avenue"));
		expect(groupLevels(next, "orange")).toEqual([5, 4, 5]);
		expect(next.seats[0].chips).toBe(STARTING_CHIPS + ORANGE_RUNG_PRICE);
		expect(next.bank).toEqual({ houses: 0, hotels: BANK_HOTELS - 2 });
		expect(trailLines).toEqual(["<@alice> sold the hotel on Market Avenue back to the bank for $50."]);
	});
});

// ── the picker and the action agree ─────────────────────────────────────────

describe("listSellOptions during a house shortage", () => {
	it("offers each hotel for exactly what selling it pays (rule 17)", () => {
		const shapes: Array<{ group: ColorGroup; levels: number[] }> = [
			{ group: "orange", levels: [5, 5, 5] },
			{ group: "orange", levels: [5, 5, 4] },
			{ group: "brown", levels: [5, 5] },
			{ group: "brown", levels: [4, 5] },
		];
		for (const { group, levels } of shapes) {
			for (let bankHouses = 0; bankHouses <= 4; bankHouses++) {
				const state = builtGroup(group, levels, bankHouses);
				const options = listSellOptions(state, ALICE);
				expect(options.length).toBeGreaterThan(0);
				for (const option of options) {
					const next = expectOk(applySellBuilding(state, ALICE, option.tileId)).state;
					expect(next.seats[0].chips - state.seats[0].chips).toBe(option.amount);
				}
			}
		}
	});

	it("marks a hotel sale that brings the group down, and only that one, so the picker can say so (2026-10 item 280)", () => {
		expect(listSellOptions(builtGroup("orange", [5, 5, 5], 2), ALICE).every((option) => option.tearsDownGroup)).toBe(true);
		expect(listSellOptions(builtGroup("orange", [5, 5, 5], 4), ALICE).some((option) => option.tearsDownGroup)).toBe(false);
	});

	it("prices three orange hotels with 2 houses in the bank at the thirteen rungs the sale removes", () => {
		const options = listSellOptions(builtGroup("orange", [5, 5, 5], 2), ALICE);
		expect(options.map((option) => [option.tileId, option.kind, option.amount])).toEqual([
			["amber-walk", "hotel", 13 * ORANGE_RUNG_PRICE],
			["market-avenue", "hotel", 13 * ORANGE_RUNG_PRICE],
			["market-row", "hotel", 13 * ORANGE_RUNG_PRICE],
		]);
	});
});
