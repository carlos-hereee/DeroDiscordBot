import { describe, it, expect } from "vitest";
import { createRandomSeed, createSeededRng } from "./seededRng.js";

describe("createSeededRng", () => {
	it("repeats its sequence for a seed and stays in [0, 1)", () => {
		const first = createSeededRng(241);
		const second = createSeededRng(241);
		const values = Array.from({ length: 50 }, () => first());
		expect(Array.from({ length: 50 }, () => second())).toEqual(values);
		for (const value of values) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
		expect(createSeededRng(242)()).not.toBe(values[0]);
	});
});

describe("createRandomSeed", () => {
	it("scales the rng onto a 32 bit integer", () => {
		expect(createRandomSeed(() => 0)).toBe(0);
		expect(createRandomSeed(() => 0.5)).toBe(2 ** 31);
		expect(Number.isInteger(createRandomSeed())).toBe(true);
	});
});
