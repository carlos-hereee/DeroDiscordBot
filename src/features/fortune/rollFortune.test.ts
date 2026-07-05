import { describe, it, expect } from "vitest";
import { rollFortune, ULTRA_WEIGHT } from "./rollFortune.js";
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
