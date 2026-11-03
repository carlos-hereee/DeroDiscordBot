import { describe, it, expect } from "vitest";
import { ChipWallet } from "./ChipWallet.js";

// ── ChipWallet schema ──────────────────────────────────────────────────────
// SCHEMA assertions, not store tests, in the pattern LuckStat.test.ts set. The unique
// { guildId, userId } index keeps two racing first writes on one row, and the first
// claim's upsert relies on colliding with it. Importing the model only registers a schema.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexes = ChipWallet.schema.indexes() as unknown as DeclaredIndex[];

describe("ChipWallet schema", () => {
	it("declares only the unique { guildId, userId } index", () => {
		expect(indexes).toHaveLength(1);
		const [fields, options] = indexes[0];
		expect(fields).toEqual({ guildId: 1, userId: 1 });
		expect(options.unique).toBe(true);
	});

	it("starts a wallet empty, unclaimed and never below zero", () => {
		const wallet = new ChipWallet({ guildId: "g1", userId: "u1" });
		expect(wallet.balance).toBe(0);
		expect(wallet.lastClaimAt).toBeNull();
		expect(wallet.totalClaimed).toBe(0);
		expect(new ChipWallet({ guildId: "g1", userId: "u1", balance: -1 }).validateSync()?.errors.balance).toBeDefined();
	});
});
