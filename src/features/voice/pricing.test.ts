import { describe, it, expect } from "vitest";
import { estimateSttCents, estimateTtsCents, formatUsd, usdToCents, FLASH_TTS_USD_PER_1K_CHARS, SCRIBE_V2_USD_PER_HOUR } from "./pricing.js";

// ── pricing ────────────────────────────────────────────────────────────────
// The estimate runs BEFORE every paid call and is what the monthly cap is
// checked against, so it must round up and never price real text as free.

describe("estimateTtsCents", () => {
	it("prices nothing for empty or nonsensical input", () => {
		expect(estimateTtsCents(0)).toBe(0);
		expect(estimateTtsCents(-5)).toBe(0);
		expect(estimateTtsCents(Number.NaN)).toBe(0);
	});

	it("never returns 0 for a non empty text, however short", () => {
		expect(estimateTtsCents(1)).toBe(1);
	});

	it("rounds UP to a whole cent", () => {
		// At 0.04 dollars per 1K characters a character costs 0.004 cents, so 250
		// characters are exactly 1 cent and the 251st tips it to 2.
		expect(FLASH_TTS_USD_PER_1K_CHARS).toBe(0.04);
		expect(estimateTtsCents(250)).toBe(1);
		expect(estimateTtsCents(251)).toBe(2);
		expect(estimateTtsCents(1000)).toBe(4);
		expect(estimateTtsCents(1001)).toBe(5);
	});

	it("prices the Listen and provider limits", () => {
		expect(estimateTtsCents(600)).toBe(3);
		expect(estimateTtsCents(1500)).toBe(6);
	});
});

describe("dollar helpers", () => {
	it("formats cents as dollars with two decimals", () => {
		expect(formatUsd(0)).toBe("0.00");
		expect(formatUsd(1234)).toBe("12.34");
	});

	it("converts a whole dollar cap to cents", () => {
		expect(usdToCents(25)).toBe(2500);
		expect(usdToCents(0)).toBe(0);
	});
});

describe("estimateSttCents", () => {
	it("prices nothing for no audio", () => {
		expect(estimateSttCents(0)).toBe(0);
		expect(estimateSttCents(-1)).toBe(0);
		expect(estimateSttCents(Number.NaN)).toBe(0);
	});

	it("meters every utterance the turn loop can send at the one cent floor", () => {
		// 0.22 dollars an hour: 20 seconds is about 0.12 cents.
		expect(SCRIBE_V2_USD_PER_HOUR).toBe(0.22);
		expect(estimateSttCents(400)).toBe(1);
		expect(estimateSttCents(20_000)).toBe(1);
	});

	it("rounds UP past the floor for long audio", () => {
		// One cent buys about 163.6 seconds at this rate.
		expect(estimateSttCents(163_000)).toBe(1);
		expect(estimateSttCents(164_000)).toBe(2);
		expect(estimateSttCents(3_600_000)).toBe(22);
	});
});
