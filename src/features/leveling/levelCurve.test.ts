import { describe, it, expect, beforeEach } from "vitest";
import {
	CURVE_PRESETS,
	MAX_LEVEL_CEILING,
	_clearCurveCache,
	_curveCacheSize,
	levelFromTotalXp,
	totalXpForLevel,
	xpForLevel,
	xpIntoLevel,
	xpToNextLevel,
} from "./levelCurve.js";

// ── the curve, pinned ──────────────────────────────────────────────────────
// These numbers are PUBLISHED in the master plan's cost table and quoted to
// members as "level 2 is about six messages", so they are contract, not
// implementation detail. A change to any coefficient reprices every guild's
// progression retroactively (level is derived from totalXp, never stored), so
// this file exists to make that impossible to do by accident.

describe("xpForLevel, the four presets", () => {
	// dero is 3n^2 + 47n + 101, all three coefficients prime by design.
	it("prices the dero curve at levels 1, 10 and 50", () => {
		expect(xpForLevel(1, "dero")).toBe(151);
		expect(xpForLevel(10, "dero")).toBe(871);
		expect(xpForLevel(50, "dero")).toBe(9951);
	});

	it("prices Arcane's linear preset", () => {
		expect(xpForLevel(1, "linear")).toBe(175);
		expect(xpForLevel(10, "linear")).toBe(1075);
		expect(xpForLevel(50, "linear")).toBe(5075);
	});

	// 5n^2 + 50n + 75, which is ARCANE's exponential. MEE6's is 5n^2 + 50n + 100
	// and the two are easy to transpose, so the constant term is pinned here.
	it("prices Arcane's exponential preset, not MEE6's", () => {
		expect(xpForLevel(1, "exponential")).toBe(130);
		expect(xpForLevel(10, "exponential")).toBe(1075);
		expect(xpForLevel(50, "exponential")).toBe(15075);
	});

	it("prices the flat preset identically at every level", () => {
		expect(xpForLevel(1, "flat")).toBe(1000);
		expect(xpForLevel(10, "flat")).toBe(1000);
		expect(xpForLevel(50, "flat")).toBe(1000);
	});

	it("defaults to dero when no preset is named", () => {
		expect(xpForLevel(10)).toBe(xpForLevel(10, "dero"));
	});
});

describe("the multiplier ROUNDS, it does not floor", () => {
	// Arcane's own case, and the reason this has its own describe block: the
	// linear preset at level 10 costs 1075, and half of that is 537.5. Flooring
	// gives 537 and undercharges every level of every halved guild.
	it("resolves 537.5 to 538", () => {
		expect(xpForLevel(10, "linear", 0.5)).toBe(538);
	});

	it("rounds the dero curve the same way", () => {
		// 151 * 0.5 = 75.5 -> 76.
		expect(xpForLevel(1, "dero", 0.5)).toBe(76);
		// 207 * 0.5 = 103.5 -> 104.
		expect(xpForLevel(2, "dero", 0.5)).toBe(104);
	});

	it("never lets a multiplier make a level free", () => {
		// A zero-cost level would make the cumulative table non strictly
		// increasing, and a binary search over a flat run returns an arbitrary
		// member of it, so the same totalXp could resolve to different levels.
		expect(xpForLevel(1, "dero", 0.0001)).toBe(1);
		expect(xpForLevel(1, "flat", 0.0001)).toBe(1);
	});

	it("falls back to 1 for a multiplier that is zero, negative or not a number", () => {
		const plain = xpForLevel(10, "dero", 1);
		expect(xpForLevel(10, "dero", 0)).toBe(plain);
		expect(xpForLevel(10, "dero", -5)).toBe(plain);
		expect(xpForLevel(10, "dero", Number.NaN)).toBe(plain);
		expect(xpForLevel(10, "dero", Number.POSITIVE_INFINITY)).toBe(plain);
	});
});

describe("totalXpForLevel, the published dero cumulative table", () => {
	// Cumulative xp to REACH the level, i.e. the sum of xpForLevel(1) through
	// xpForLevel(level - 1). Every row here appears in the plan's cost table.
	it.each([
		[2, 151],
		[3, 358],
		[5, 964],
		[7, 1_866],
		[10, 3_879],
		[13, 6_828],
		[17, 12_496],
		[23, 25_498],
		[25, 31_224],
		[31, 53_250],
		[41, 109_000],
		[50, 183_799],
		[53, 214_708],
		[97, 1_127_136],
		[100, 1_227_699],
	])("reaches level %i at %i total xp", (level, expected) => {
		expect(totalXpForLevel(level, "dero")).toBe(expected);
	});

	it("costs nothing to be level 1, which is where every member starts", () => {
		expect(totalXpForLevel(1, "dero")).toBe(0);
		expect(totalXpForLevel(0, "dero")).toBe(0);
		expect(totalXpForLevel(-5, "dero")).toBe(0);
	});

	// The member-facing claim in the release announcement. 151 xp at the average
	// message roll of 27.5 is 5.49 messages, so six is the first message at which
	// level 2 is actually reachable, and five (137.5 xp) is genuinely short.
	it("puts level 2 within six average messages", () => {
		const averageMessageXp = 27.5;
		expect(5 * averageMessageXp).toBeLessThan(totalXpForLevel(2, "dero"));
		expect(6 * averageMessageXp).toBeGreaterThanOrEqual(totalXpForLevel(2, "dero"));
	});
});

describe("levelFromTotalXp is the exact inverse of totalXpForLevel", () => {
	// The property that matters most in the whole module: a member standing on a
	// boundary is on the HIGHER level, and one xp short of it is on the lower.
	// Swept rather than spot checked, across every preset, because an off by one
	// here shows up as a level up announcement that fires a level early or late.
	it.each([...CURVE_PRESETS])("inverts cleanly across the %s curve", (preset) => {
		for (let level = 1; level <= 120; level += 1) {
			const boundary = totalXpForLevel(level, preset);
			expect(levelFromTotalXp(boundary, preset)).toBe(level);
			if (level > 1) expect(levelFromTotalXp(boundary - 1, preset)).toBe(level - 1);
		}
	});

	it("inverts cleanly under a multiplier too", () => {
		for (let level = 1; level <= 60; level += 1) {
			const boundary = totalXpForLevel(level, "dero", 2.5);
			expect(levelFromTotalXp(boundary, "dero", 2.5)).toBe(level);
		}
	});

	it("holds at the table ceiling", () => {
		const boundary = totalXpForLevel(MAX_LEVEL_CEILING, "dero");
		expect(levelFromTotalXp(boundary, "dero")).toBe(MAX_LEVEL_CEILING);
		expect(levelFromTotalXp(boundary * 10, "dero")).toBe(MAX_LEVEL_CEILING);
	});
});

describe("levelFromTotalXp never throws, whatever the row holds", () => {
	const junkBalances: Array<[string, number]> = [
		["zero", 0],
		["negative", -5_000],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
	];

	it.each(junkBalances)("resolves %s xp to a level inside the table rather than throwing", (_label, xp) => {
		const level = levelFromTotalXp(xp, "dero");
		expect(level).toBeGreaterThanOrEqual(1);
		expect(level).toBeLessThanOrEqual(MAX_LEVEL_CEILING);
	});

	it("treats a negative balance as level 1", () => {
		// Reachable in production: /leveling xp remove can drive totalXp below zero.
		expect(levelFromTotalXp(-1, "dero")).toBe(1);
	});
});

describe("maxLevel caps without throwing", () => {
	it("clamps a member past the cap to the cap", () => {
		const wayPastIt = totalXpForLevel(80, "dero");
		expect(levelFromTotalXp(wayPastIt, "dero", 1, 25)).toBe(25);
	});

	it("leaves a member below the cap alone", () => {
		const atTen = totalXpForLevel(10, "dero");
		expect(levelFromTotalXp(atTen, "dero", 1, 25)).toBe(10);
	});

	it("treats null as uncapped and a nonsense cap as the table ceiling", () => {
		const wayPastIt = totalXpForLevel(80, "dero");
		expect(levelFromTotalXp(wayPastIt, "dero", 1, null)).toBe(80);
		expect(levelFromTotalXp(wayPastIt, "dero", 1, Number.NaN)).toBe(80);
		// A cap above the table's own ceiling cannot invent entries it does not have.
		expect(levelFromTotalXp(Number.MAX_SAFE_INTEGER, "dero", 1, 99_999)).toBe(MAX_LEVEL_CEILING);
	});
});

describe("the progress bar's two numbers", () => {
	it("splits the current level exactly, so a bar needs no third lookup", () => {
		for (const level of [1, 2, 7, 13, 40]) {
			const xp = totalXpForLevel(level, "dero") + 17;
			const into = xpIntoLevel(xp, "dero");
			const toNext = xpToNextLevel(xp, "dero");
			expect(into + toNext).toBe(xpForLevel(level, "dero"));
			expect(into).toBe(17);
		}
	});

	it("reads empty on a fresh member and full on a boundary", () => {
		expect(xpIntoLevel(0, "dero")).toBe(0);
		expect(xpToNextLevel(0, "dero")).toBe(totalXpForLevel(2, "dero"));

		const boundary = totalXpForLevel(5, "dero");
		expect(xpIntoLevel(boundary, "dero")).toBe(0);
	});

	it("reports nothing left to earn at the cap", () => {
		// Otherwise the bar counts toward a level the member can never reach.
		const past = totalXpForLevel(90, "dero");
		expect(xpToNextLevel(past, "dero", 1, 25)).toBe(0);
	});

	it("does not throw on a negative balance", () => {
		expect(xpIntoLevel(-500, "dero")).toBe(0);
		expect(xpToNextLevel(-500, "dero")).toBe(totalXpForLevel(2, "dero"));
	});
});

describe("the cumulative table is built once per preset and multiplier", () => {
	beforeEach(() => {
		_clearCurveCache();
	});

	it("memoizes on the pair, not on the call", () => {
		// The guard against the loop-and-subtract implementation this module
		// exists to avoid: a thousand lookups must not build a thousand tables.
		for (let i = 0; i < 500; i += 1) levelFromTotalXp(i * 97, "dero", 1);
		expect(_curveCacheSize()).toBe(1);

		levelFromTotalXp(1_000, "dero", 2);
		expect(_curveCacheSize()).toBe(2);

		levelFromTotalXp(1_000, "linear", 1);
		expect(_curveCacheSize()).toBe(3);
	});

	it("normalizes the multiplier into the memo key so junk cannot fragment it", () => {
		levelFromTotalXp(1_000, "dero", 1);
		levelFromTotalXp(1_000, "dero", 0);
		levelFromTotalXp(1_000, "dero", Number.NaN);
		expect(_curveCacheSize()).toBe(1);
	});
});
