import { describe, it, expect } from "vitest";
import { describeTerms, describeTermsRefusal, isStandardTerms, resolveTerms, STANDARD_HOLDEM_TERMS, type TermsRefusal } from "./holdemTerms.js";

// ── holdemTerms ───────────────────────────────────────────────────────────
// The bounds from the plan: seats 2 to 6, a stack of 100 to 1,000,000, a big
// blind of at least 2 and at most a tenth of the stack, the small blind half of
// it. A missing term is the standard one.

// The en dash and em dash by char code, so this file itself holds neither.
const LONG_OR_SPACED_DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]| - `);

describe("resolveTerms", () => {
	it("takes the owner's example as asked: 6 seats, 5000 chips, blinds 100 and 200", () => {
		expect(resolveTerms({ maxSeats: 6, startingStack: 5000, bigBlind: 200 })).toEqual({
			ok: true,
			terms: { maxSeats: 6, startingStack: 5000, smallBlind: 100, bigBlind: 200 },
		});
	});

	it("gives the standard rules when nothing is named", () => {
		expect(resolveTerms({})).toEqual({ ok: true, terms: { maxSeats: 6, startingStack: 1000, smallBlind: 10, bigBlind: 20 } });
	});

	it.each([
		["seats", { maxSeats: 4 }, { maxSeats: 4, startingStack: 1000, smallBlind: 10, bigBlind: 20 }],
		["the stack", { startingStack: 5000 }, { maxSeats: 6, startingStack: 5000, smallBlind: 10, bigBlind: 20 }],
		["the big blind", { bigBlind: 50 }, { maxSeats: 6, startingStack: 1000, smallBlind: 25, bigBlind: 50 }],
	])("fills every missing term with the standard one when only %s is named", (_label, request, terms) => {
		expect(resolveTerms(request)).toEqual({ ok: true, terms });
	});

	it("rounds an odd big blind's half down", () => {
		expect(resolveTerms({ bigBlind: 25 })).toMatchObject({ ok: true, terms: { smallBlind: 12, bigBlind: 25 } });
	});

	it("accepts the edges of every bound", () => {
		expect(resolveTerms({ maxSeats: 2, startingStack: 100, bigBlind: 10 })).toMatchObject({ ok: true, terms: { smallBlind: 5 } });
		expect(resolveTerms({ startingStack: 1_000_000, bigBlind: 100_000 })).toMatchObject({ ok: true });
		expect(resolveTerms({ bigBlind: 2 })).toMatchObject({ ok: true, terms: { smallBlind: 1, bigBlind: 2 } });
	});

	it.each<[string, Record<string, number>, TermsRefusal]>([
		["seats 1", { maxSeats: 1 }, "seats_out_of_range"],
		["seats 7", { maxSeats: 7 }, "seats_out_of_range"],
		["a stack under 100", { startingStack: 99 }, "stack_out_of_range"],
		["a stack over 1000000", { startingStack: 1_000_001 }, "stack_out_of_range"],
		["a big blind of 1", { bigBlind: 1 }, "big_blind_too_small"],
		["a big blind above a tenth of the stack", { startingStack: 5000, bigBlind: 501 }, "big_blind_too_large"],
		// The standard 20 is more than a tenth of 100, so a small stack must name its blind.
		["a 100 chip stack with the standard big blind", { startingStack: 100 }, "big_blind_too_large"],
		["a fraction", { maxSeats: 4.5 }, "not_a_whole_number"],
		["not a number", { startingStack: Number.NaN }, "not_a_whole_number"],
	])("refuses %s", (_label, request, reason) => {
		expect(resolveTerms(request)).toEqual({ ok: false, reason });
	});
});

describe("describeTerms", () => {
	it("says standard for the standard rules, and always that the blinds double every 6 hands", () => {
		expect(isStandardTerms(STANDARD_HOLDEM_TERMS)).toBe(true);
		expect(describeTerms(STANDARD_HOLDEM_TERMS)).toBe(
			"Standard rules: up to 6 players, 1000 chips each, blinds 10 and 20, and the blinds double every 6 hands.",
		);
	});

	it("lists custom terms", () => {
		const resolved = resolveTerms({ maxSeats: 6, startingStack: 5000, bigBlind: 200 });
		if (!resolved.ok) throw new Error("expected the owner's terms to resolve");
		expect(isStandardTerms(resolved.terms)).toBe(false);
		expect(describeTerms(resolved.terms)).toBe(
			"Custom rules: up to 6 players, 5000 chips each, blinds 100 and 200, and the blinds double every 6 hands.",
		);
	});

	it("names the bound in every refusal, with no dashes", () => {
		const reasons: TermsRefusal[] = ["not_a_whole_number", "seats_out_of_range", "stack_out_of_range", "big_blind_too_small", "big_blind_too_large"];
		for (const reason of reasons) {
			const line = describeTermsRefusal(reason);
			expect(line.length).toBeGreaterThan(0);
			expect(line).not.toMatch(LONG_OR_SPACED_DASH);
		}
		expect(describeTermsRefusal("seats_out_of_range")).toBe("A table seats 2 to 6 players.");
		expect(describeTermsRefusal("big_blind_too_large")).toContain("a tenth of the starting stack");
	});
});
