import { describe, it, expect } from "vitest";
import { MAX_LEVEL_CEILING } from "./levelCurve.js";
import { MILESTONE_LEVELS, isMilestone, milestoneLevelsUpTo, nextMilestoneAtOrAbove } from "./primeLevels.js";

// The 25 primes under 100, written out BY HAND on purpose. Checking a sieve
// against another sieve proves nothing; this list is the independent source of
// truth, and it is the exact range members actually play through.
const PRIMES_UNDER_100 = [
	2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
];

describe("isMilestone", () => {
	it("matches the hand written list of primes under 100 exactly", () => {
		for (let level = 1; level < 100; level += 1) {
			expect(isMilestone(level), `level ${level}`).toBe(PRIMES_UNDER_100.includes(level));
		}
	});

	it("does not treat level 1 as a milestone", () => {
		// Every member starts at level 1. Celebrating the starting line would fire
		// a milestone card at a member who has done nothing yet.
		expect(isMilestone(1)).toBe(false);
	});

	it("treats level 2 as a milestone, so a new member's first level up is the loud one", () => {
		expect(isMilestone(2)).toBe(true);
	});

	it("rejects the composites that sit next to a prime", () => {
		// 9 (3 x 3), 49 (7 x 7) and 91 (7 x 13) are the ones a naive "odd numbers"
		// or "not divisible by small primes" shortcut gets wrong.
		expect(isMilestone(9)).toBe(false);
		expect(isMilestone(49)).toBe(false);
		expect(isMilestone(91)).toBe(false);
	});

	it("returns false rather than throwing on a non integer or an out of range level", () => {
		expect(isMilestone(0)).toBe(false);
		expect(isMilestone(-7)).toBe(false);
		expect(isMilestone(2.5)).toBe(false);
		expect(isMilestone(Number.NaN)).toBe(false);
		expect(isMilestone(MAX_LEVEL_CEILING + 1)).toBe(false);
	});
});

describe("the sieve itself", () => {
	it("covers the curve's ceiling and nothing beyond it", () => {
		// Sieved against MAX_LEVEL_CEILING so the two modules cannot disagree
		// about which levels exist.
		expect(MILESTONE_LEVELS.has(997)).toBe(true); // the largest prime under 1000
		expect(MILESTONE_LEVELS.has(1000)).toBe(false);
	});

	it("produces the documented milestone density curve", () => {
		// This is the reason primes beat "every 5 levels" and it is a claim the
		// plan makes in writing, so it is pinned rather than trusted.
		const inBand = (from: number, to: number): number =>
			Array.from({ length: to - from + 1 }, (_, index) => from + index).filter(isMilestone).length;

		expect(inBand(1, 20)).toBe(8); // 40 percent, high early
		expect(inBand(21, 50)).toBe(7); // 23 percent
		expect(inBand(51, 100)).toBe(10); // 20 percent, thinning out
	});
});

describe("milestoneLevelsUpTo", () => {
	it("counts the milestones a member has actually passed", () => {
		expect(milestoneLevelsUpTo(1)).toBe(0);
		expect(milestoneLevelsUpTo(2)).toBe(1);
		expect(milestoneLevelsUpTo(7)).toBe(4); // 2, 3, 5, 7
		expect(milestoneLevelsUpTo(20)).toBe(8);
		expect(milestoneLevelsUpTo(100)).toBe(25);
	});

	it("counts the milestone level itself the moment it is reached", () => {
		// The prime-mover achievement fires ON the level up, so an exclusive
		// count here would delay every tier by one milestone.
		expect(milestoneLevelsUpTo(11)).toBe(milestoneLevelsUpTo(10) + 1);
	});

	it("does not throw on junk or past the ceiling", () => {
		expect(milestoneLevelsUpTo(0)).toBe(0);
		expect(milestoneLevelsUpTo(-5)).toBe(0);
		expect(milestoneLevelsUpTo(Number.NaN)).toBe(0);
		expect(milestoneLevelsUpTo(MAX_LEVEL_CEILING + 500)).toBe(milestoneLevelsUpTo(MAX_LEVEL_CEILING));
	});
});

describe("nextMilestoneAtOrAbove", () => {
	it("returns the level itself when it is already a milestone", () => {
		expect(nextMilestoneAtOrAbove(13)).toBe(13);
	});

	it("reaches forward from a composite", () => {
		expect(nextMilestoneAtOrAbove(14)).toBe(17);
		expect(nextMilestoneAtOrAbove(1)).toBe(2);
		expect(nextMilestoneAtOrAbove(0)).toBe(2);
	});

	it("returns null once no milestone remains inside the table", () => {
		expect(nextMilestoneAtOrAbove(998)).toBeNull();
		expect(nextMilestoneAtOrAbove(MAX_LEVEL_CEILING + 10)).toBeNull();
	});
});
