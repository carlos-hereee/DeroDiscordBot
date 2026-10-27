import { describe, it, expect, vi, beforeEach } from "vitest";

// ── chipWallet ──────────────────────────────────────────────────────────────
// The claim ladder (25,000 once, then 1,000 a day), the cooldown answer, and the guards
// on every amount a wallet moves. The store is mocked, so this pins the feature's
// decisions and the exact writes it asks for; the atomicity lives in the store's filters.

const mocks = vi.hoisted(() => ({
	claimFirst: vi.fn(),
	claimDaily: vi.fn(),
	findOne: vi.fn(),
	credit: vi.fn(),
	debit: vi.fn(),
}));

vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: mocks }));

import { claimChips, isChipEconomyOn, nextClaimAt, parseChipAmount, readWallet, returnChips, takeChips } from "./chipWallet.js";

const KEY = { guildId: "g1", userId: "u1" };
const NOW = new Date("2026-10-25T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("claimChips", () => {
	it("pays 25,000 on the first claim ever", async () => {
		mocks.claimFirst.mockResolvedValue({ balance: 25_000 });
		await expect(claimChips(KEY, NOW)).resolves.toEqual({ kind: "first", amount: 25_000, balance: 25_000 });
		expect(mocks.claimFirst).toHaveBeenCalledWith(KEY, 25_000, NOW);
		expect(mocks.claimDaily).not.toHaveBeenCalled();
	});

	it("pays 1,000 once the first claim is taken and 24 hours have run", async () => {
		mocks.claimFirst.mockResolvedValue(null);
		mocks.claimDaily.mockResolvedValue({ balance: 26_000 });
		await expect(claimChips(KEY, NOW)).resolves.toEqual({ kind: "daily", amount: 1_000, balance: 26_000 });
		expect(mocks.claimDaily).toHaveBeenCalledWith(KEY, 1_000, NOW, new Date(NOW.getTime() - DAY_MS));
	});

	// 2026-10 item 257 Phase 3a: the rock paper scissors round multiplies whichever base pays.
	it("multiplies the first and the daily claim by the round's multiplier", async () => {
		mocks.claimFirst.mockResolvedValueOnce({ balance: 37_500 });
		await expect(claimChips(KEY, NOW, 1.5)).resolves.toEqual({ kind: "first", amount: 37_500, balance: 37_500 });
		expect(mocks.claimFirst).toHaveBeenCalledWith(KEY, 37_500, NOW);

		mocks.claimFirst.mockResolvedValueOnce(null);
		mocks.claimDaily.mockResolvedValueOnce({ balance: 39_500 });
		await expect(claimChips(KEY, NOW, 2)).resolves.toEqual({ kind: "daily", amount: 2_000, balance: 39_500 });
		expect(mocks.claimDaily).toHaveBeenCalledWith(KEY, 2_000, NOW, new Date(NOW.getTime() - DAY_MS));
	});

	it("answers the cooldown, with the balance and when the next claim opens, inside 24 hours", async () => {
		const lastClaimAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
		mocks.claimFirst.mockResolvedValue(null);
		mocks.claimDaily.mockResolvedValue(null);
		mocks.findOne.mockResolvedValue({ balance: 25_000, lastClaimAt });
		await expect(claimChips(KEY, NOW)).resolves.toEqual({ kind: "cooldown", balance: 25_000, nextClaimAt: new Date(lastClaimAt.getTime() + DAY_MS) });
	});
});

describe("the switch and the wallet reads", () => {
	it("reads a row that never stored the switch as on, and only false as off", () => {
		expect(isChipEconomyOn(null)).toBe(true);
		expect(isChipEconomyOn({})).toBe(true);
		expect(isChipEconomyOn({ chipEconomyEnabled: null })).toBe(true);
		expect(isChipEconomyOn({ chipEconomyEnabled: false })).toBe(false);
	});

	it("reads a member with no wallet as zero chips with their first claim waiting", async () => {
		mocks.findOne.mockResolvedValue(null);
		await expect(readWallet(KEY)).resolves.toEqual({ balance: 0, nextClaimAt: null });
	});

	it("puts the next claim 24 hours after the last", () => {
		expect(nextClaimAt(NOW)).toEqual(new Date(NOW.getTime() + DAY_MS));
	});
});

describe("takeChips and returnChips", () => {
	it("answers whether the debit landed, and never asks for a non whole amount", async () => {
		mocks.debit.mockResolvedValueOnce({ balance: 0 }).mockResolvedValueOnce(null);
		await expect(takeChips(KEY, 1_000)).resolves.toBe(true);
		await expect(takeChips(KEY, 1_000)).resolves.toBe(false);
		await expect(takeChips(KEY, 0)).resolves.toBe(false);
		await expect(takeChips(KEY, 2.5)).resolves.toBe(false);
		expect(mocks.debit).toHaveBeenCalledTimes(2);
	});

	it("credits a cash out and writes nothing for an empty one", async () => {
		await returnChips(KEY, 1_500);
		await returnChips(KEY, 0);
		expect(mocks.credit).toHaveBeenCalledTimes(1);
		expect(mocks.credit).toHaveBeenCalledWith(KEY, 1_500);
	});
});

describe("parseChipAmount", () => {
	it.each([
		["2500", 2_500],
		["2,500", 2_500],
		["10k", 10_000],
		["2.5k", 2_500],
		[" 750 ", 750],
	])("reads %j as %d", (raw, expected) => {
		expect(parseChipAmount(raw)).toBe(expected);
	});

	it.each(["", "abc", "-5", "1.5", "0", "1,00"])("refuses %j", (raw) => {
		expect(parseChipAmount(raw)).toBeNull();
	});
});
