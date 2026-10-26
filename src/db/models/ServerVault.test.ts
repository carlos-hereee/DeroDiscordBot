import { describe, it, expect } from "vitest";
import { ServerVault } from "./ServerVault.js";

// ── ServerVault schema ─────────────────────────────────────────────────────
// SCHEMA assertions, not store tests. One vault per guild is what makes the monthly
// award's lastAwardMonth claim a claim: two rows for one guild would each pay the month.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexes = ServerVault.schema.indexes() as unknown as DeclaredIndex[];

describe("ServerVault schema", () => {
	it("declares only the unique guildId index", () => {
		expect(indexes).toHaveLength(1);
		const [fields, options] = indexes[0];
		expect(fields).toEqual({ guildId: 1 });
		expect(options.unique).toBe(true);
	});

	it("starts with no award month and no grants, and refuses a negative balance", () => {
		const vault = new ServerVault({ guildId: "g1", balance: 100 });
		expect(vault.lastAwardMonth).toBeNull();
		expect(vault.grantHistory).toHaveLength(0);
		expect(new ServerVault({ guildId: "g1", balance: -5 }).validateSync()?.errors.balance).toBeDefined();
	});
});
