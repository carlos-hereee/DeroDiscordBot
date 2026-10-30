import { describe, it, expect, vi, beforeEach } from "vitest";

// ── coinMarket (2026-10 item 267 Session 2a, risk R4) ─────────────────────────
// Both stores are in memory fakes whose conditional writes check and change their row in
// one synchronous step, the way one Mongo update does, so two trades started together race
// exactly as two real ones would: each conditional write lands whole or not at all.

const state = vi.hoisted(() => ({
	chips: new Map<string, number>(),
	coins: new Map<string, { balance: number; totalEarned: number; marketDayKey?: string; marketBoughtToday?: number }>(),
	ledger: [] as Array<Record<string, unknown>>,
	failNextTrade: false,
}));

vi.mock("@db/stores/chipWalletStore.js", () => ({
	chipWalletStore: {
		findOne: vi.fn(async ({ userId }: { userId: string }) => (state.chips.has(userId) ? { balance: state.chips.get(userId), lastClaimAt: null } : null)),
		debit: vi.fn(async ({ userId }: { userId: string }, amount: number) => {
			const balance = state.chips.get(userId) ?? 0;
			if (balance < amount) return null;
			state.chips.set(userId, balance - amount);
			return { balance: balance - amount };
		}),
		credit: vi.fn(async ({ userId }: { userId: string }, amount: number) => {
			state.chips.set(userId, (state.chips.get(userId) ?? 0) + amount);
			return { balance: state.chips.get(userId) };
		}),
	},
}));

vi.mock("@db/stores/deroCoinStore.js", () => {
	const wallet = (userId: string) => {
		if (!state.coins.has(userId)) state.coins.set(userId, { balance: 0, totalEarned: 0 });
		return state.coins.get(userId)!;
	};
	return {
		deroCoinStore: {
			findWallet: vi.fn(async (userId: string) => (state.coins.has(userId) ? { userId, ...state.coins.get(userId)! } : null)),
			reserveMarketBuy: vi.fn(async (userId: string, amount: number, dayKey: string, cap: number) => {
				const row = wallet(userId);
				const bought = row.marketDayKey === dayKey ? (row.marketBoughtToday ?? 0) : 0;
				if (bought + amount > cap) return null;
				row.marketDayKey = dayKey;
				row.marketBoughtToday = bought + amount;
				return { userId, ...row };
			}),
			releaseMarketBuy: vi.fn(async (userId: string, amount: number, dayKey: string) => {
				const row = state.coins.get(userId);
				if (row?.marketDayKey === dayKey && (row.marketBoughtToday ?? 0) >= amount) row.marketBoughtToday = (row.marketBoughtToday ?? 0) - amount;
			}),
			debit: vi.fn(async (userId: string, amount: number) => {
				const row = state.coins.get(userId);
				if (!row || row.balance < amount) return null;
				row.balance -= amount;
				return { userId, ...row };
			}),
			creditBalance: vi.fn(async (userId: string, amount: number) => {
				wallet(userId).balance += amount;
			}),
			insertTrade: vi.fn(async (row: Record<string, unknown>) => {
				if (state.failNextTrade) {
					state.failNextTrade = false;
					throw new Error("the ledger refused the row");
				}
				state.ledger.push(row);
			}),
		},
	};
});

import { buyCoins, buyLeftToday, parseCoinAmount, sellCoins } from "./coinMarket.js";

const NOW = new Date("2026-10-29T15:00:00Z");
const TOMORROW = new Date("2026-10-30T00:00:01Z");
const trade = (coins: number, now: Date = NOW) => ({ userId: "u1", guildId: "g1", coins, now });

beforeEach(() => {
	state.chips.clear();
	state.coins.clear();
	state.ledger.length = 0;
	state.failNextTrade = false;
});

describe("buyCoins", () => {
	it("buying 3 coins takes 6,000 chips, credits 3 and writes one market row", async () => {
		state.chips.set("u1", 10_000);

		const result = await buyCoins(trade(3));

		expect(result).toEqual({ kind: "bought", coins: 3, chipsPaid: 6_000 });
		expect(state.chips.get("u1")).toBe(4_000);
		expect(state.coins.get("u1")?.balance).toBe(3);
		// Bought coins are no earnings, so the earned total stays where the awards left it.
		expect(state.coins.get("u1")?.totalEarned).toBe(0);
		expect(state.ledger).toEqual([{ userId: "u1", guildId: "g1", amount: 3, source: "market", marketSide: "buy", chips: 6_000, at: NOW }]);
	});

	it("refuses a fourth coin the same UTC day and moves nothing", async () => {
		state.chips.set("u1", 20_000);
		await buyCoins(trade(3));

		const result = await buyCoins(trade(1));

		expect(result).toEqual({ kind: "cap", leftToday: 0 });
		expect(state.chips.get("u1")).toBe(14_000);
		expect(state.coins.get("u1")?.balance).toBe(3);
		expect(state.ledger).toHaveLength(1);
	});

	it("never lets two racing buys pass the cap, and takes chips for the winner alone", async () => {
		state.chips.set("u1", 20_000);

		const results = await Promise.all([buyCoins(trade(2)), buyCoins(trade(2))]);

		expect(results.filter((result) => result.kind === "bought")).toHaveLength(1);
		expect(results.filter((result) => result.kind === "cap")).toEqual([{ kind: "cap", leftToday: 1 }]);
		expect(state.coins.get("u1")?.balance).toBe(2);
		expect(state.chips.get("u1")).toBe(16_000);
	});

	it("gives the reservation back when the chips cannot pay, so the day's cap is untouched", async () => {
		state.chips.set("u1", 3_000);

		const result = await buyCoins(trade(2));

		expect(result).toEqual({ kind: "chips", balance: 3_000, price: 4_000 });
		expect(await buyLeftToday("u1", NOW)).toBe(3);
		expect(state.coins.get("u1")?.balance).toBe(0);
		expect(state.ledger).toEqual([]);
	});

	it("returns the chips and the reservation when the ledger row fails, and throws", async () => {
		state.chips.set("u1", 10_000);
		state.failNextTrade = true;

		await expect(buyCoins(trade(1))).rejects.toThrow("the ledger refused the row");

		expect(state.chips.get("u1")).toBe(10_000);
		expect(state.coins.get("u1")?.balance).toBe(0);
		expect(await buyLeftToday("u1", NOW)).toBe(3);
	});

	it("refuses a first buy of the day larger than the whole cap before reserving anything (2026-10 item 280)", async () => {
		const { deroCoinStore } = await import("@db/stores/deroCoinStore.js");
		vi.mocked(deroCoinStore.reserveMarketBuy).mockClear();
		state.chips.set("u1", 1_000_000);

		const result = await buyCoins(trade(50));

		expect(result).toEqual({ kind: "cap", leftToday: 3 });
		// The real store's filter matches any amount on a fresh day, so the refusal must not reach it.
		expect(deroCoinStore.reserveMarketBuy).not.toHaveBeenCalled();
		expect(state.chips.get("u1")).toBe(1_000_000);
		expect(state.coins.get("u1")?.balance ?? 0).toBe(0);
	});

	it("opens the whole cap again on the next UTC day", async () => {
		state.chips.set("u1", 20_000);
		await buyCoins(trade(3));

		expect(await buyLeftToday("u1", TOMORROW)).toBe(3);
		expect(await buyCoins(trade(3, TOMORROW))).toMatchObject({ kind: "bought", coins: 3 });
	});
});

describe("sellCoins", () => {
	it("selling 2 coins takes them and credits 1,000 chips, uncapped by the buy cap", async () => {
		state.chips.set("u1", 0);
		state.coins.set("u1", { balance: 5, totalEarned: 5, marketDayKey: "2026-10-29", marketBoughtToday: 3 });

		const result = await sellCoins(trade(2));

		expect(result).toEqual({ kind: "sold", coins: 2, chipsPaid: 1_000 });
		expect(state.coins.get("u1")?.balance).toBe(3);
		expect(state.chips.get("u1")).toBe(1_000);
		expect(state.ledger).toEqual([{ userId: "u1", guildId: "g1", amount: 2, source: "market", marketSide: "sell", chips: 1_000, at: NOW }]);
	});

	it("refuses a sale past the coins held and moves nothing", async () => {
		state.coins.set("u1", { balance: 1, totalEarned: 1 });

		expect(await sellCoins(trade(2))).toEqual({ kind: "coins", balance: 1 });
		expect(state.coins.get("u1")?.balance).toBe(1);
		expect(state.chips.get("u1")).toBeUndefined();
		expect(state.ledger).toEqual([]);
	});

	it("never sells the same coins twice when two sales race", async () => {
		state.coins.set("u1", { balance: 2, totalEarned: 2 });

		const results = await Promise.all([sellCoins(trade(2)), sellCoins(trade(2))]);

		expect(results.map((result) => result.kind).sort()).toEqual(["coins", "sold"]);
		expect(state.chips.get("u1")).toBe(1_000);
	});

	it("puts the coins back and pays no chips when the ledger row fails", async () => {
		state.coins.set("u1", { balance: 2, totalEarned: 2 });
		state.failNextTrade = true;

		await expect(sellCoins(trade(2))).rejects.toThrow();

		expect(state.coins.get("u1")?.balance).toBe(2);
		expect(state.chips.get("u1")).toBeUndefined();
	});
});

describe("parseCoinAmount", () => {
	it.each([
		["2", 2],
		[" 3 ", 3],
		["0", null],
		["-1", null],
		["1.5", null],
		["two", null],
		["", null],
	])("reads %j as %j", (raw, expected) => {
		expect(parseCoinAmount(raw)).toBe(expected);
	});
});
