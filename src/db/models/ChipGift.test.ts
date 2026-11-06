import { describe, it, expect } from "vitest";
import { ChipGift } from "./ChipGift.js";

// ── ChipGift schema ─────────────────────────────────────────────────────────
// SCHEMA assertions, in the pattern ChipWallet.test.ts set. The partial unique index is what
// keeps one waiting gift per member while letting a collected gift be followed by another.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexes = ChipGift.schema.indexes() as unknown as DeclaredIndex[];

describe("ChipGift schema", () => {
	it("allows one pending gift per member, and leaves collected gifts out of that rule", () => {
		const unique = indexes.find(([, options]) => options.unique === true);
		expect(unique?.[0]).toEqual({ userId: 1 });
		expect(unique?.[1].partialFilterExpression).toEqual({ status: "pending" });
	});

	it("starts pending and refuses a gift of no chips", () => {
		const gift = new ChipGift({ userId: "u1", chips: 100_000, grantedBy: "owner", grantedAt: new Date() });
		expect(gift.status).toBe("pending");
		expect(gift.validateSync()).toBeUndefined();
		expect(new ChipGift({ userId: "u1", chips: 0, grantedBy: "owner", grantedAt: new Date() }).validateSync()?.errors.chips).toBeDefined();
	});
});
