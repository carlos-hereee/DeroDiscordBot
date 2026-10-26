import { describe, it, expect } from "vitest";
import { EXPECTED_FORTUNE_LUCK, fortuneLuck, rollFortune, ULTRA_WEIGHT } from "./rollFortune.js";
import { COMMON_FORTUNES, ULTRA_FORTUNES } from "./fortunes.js";

describe("rollFortune", () => {
	it("returns ultra when the roll is below the weight", () => {
		const result = rollFortune(() => 0);
		expect(result.tier).toBe("ultra");
		expect(ULTRA_FORTUNES.some((f) => f.verdict === result.verdict && f.flavor === result.flavor)).toBe(true);
	});

	it("treats the weight boundary as common (roll === weight is not ultra)", () => {
		const result = rollFortune(() => ULTRA_WEIGHT);
		expect(result.tier).toBe("common");
		expect(COMMON_FORTUNES.some((f) => f.verdict === result.verdict)).toBe(true);
	});

	it("returns common when the roll is above the weight", () => {
		const result = rollFortune(() => 0.99);
		expect(result.tier).toBe("common");
		expect(COMMON_FORTUNES.some((f) => f.verdict === result.verdict)).toBe(true);
	});

	it("keeps the ultra rate near the configured weight over many rolls", () => {
		const runs = 5000;
		let ultra = 0;
		for (let i = 0; i < runs; i++) {
			if (rollFortune().tier === "ultra") ultra++;
		}
		const rate = ultra / runs;
		// Loose band around ULTRA_WEIGHT (0.03). At n=5000 the 3-sigma spread is
		// ~0.007, so [0.012, 0.055] is a safe, non-flaky envelope.
		expect(rate).toBeGreaterThan(0.012);
		expect(rate).toBeLessThan(0.055);
	});

	it("ships enough non-empty content to not feel stale at launch", () => {
		expect(COMMON_FORTUNES.length).toBeGreaterThanOrEqual(20);
		expect(ULTRA_FORTUNES.length).toBeGreaterThanOrEqual(5);
		for (const f of [...COMMON_FORTUNES, ...ULTRA_FORTUNES]) {
			expect(f.verdict.trim().length).toBeGreaterThan(0);
			expect(f.flavor.trim().length).toBeGreaterThan(0);
		}
	});
});

// ── the luck board's weights (2026-10 item 250 Phase 5) ──────────────────────
// The owner's weights: gold +3, a firm yes +2, a yes +1, neutral 0, a soft no -1, a
// firm no -2. The board counts each reading above the average one, so the average must
// be the pools' true mean at the base gold rate, or spamming the 8 ball would drift.
describe("the luck weights", () => {
	it("weights every gold reading +3 and the common ones from -2 to +2", () => {
		expect(ULTRA_FORTUNES.every((fortune) => fortune.luck === 3)).toBe(true);
		expect(COMMON_FORTUNES.every((fortune) => fortune.luck >= -2 && fortune.luck <= 2)).toBe(true);
		expect(fortuneLuck("common", "IT IS CERTAIN")).toBe(2);
		expect(fortuneLuck("common", "OUTLOOK GOOD")).toBe(1);
		expect(fortuneLuck("common", "UNCLEAR")).toBe(0);
		expect(fortuneLuck("common", "NOT TODAY")).toBe(-1);
		expect(fortuneLuck("common", "VERY DOUBTFUL")).toBe(-2);
		expect(fortuneLuck("ultra", "GO NOW")).toBe(3);
		expect(fortuneLuck("common", "NO SUCH VERDICT")).toBe(0);
	});

	it("puts the average reading at the pools' mean for the base gold rate", () => {
		const mean = (luck: number[]) => luck.reduce((sum, value) => sum + value, 0) / luck.length;
		const expected = ULTRA_WEIGHT * mean(ULTRA_FORTUNES.map((f) => f.luck)) + (1 - ULTRA_WEIGHT) * mean(COMMON_FORTUNES.map((f) => f.luck));
		expect(EXPECTED_FORTUNE_LUCK).toBeCloseTo(expected, 10);
		// 9 points over 20 common readings and +3 gold at 3 percent.
		expect(EXPECTED_FORTUNE_LUCK).toBeCloseTo(0.5265, 4);
	});

	it("nets close to zero over many readings counted above the average", () => {
		let total = 0;
		const runs = 20_000;
		for (let i = 0; i < runs; i++) {
			const reading = rollFortune();
			total += fortuneLuck(reading.tier, reading.verdict) - EXPECTED_FORTUNE_LUCK;
		}
		expect(Math.abs(total / runs)).toBeLessThan(0.05);
	});
});
