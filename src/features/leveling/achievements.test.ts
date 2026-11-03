import { describe, it, expect } from "vitest";
import { ACHIEVEMENTS, ACHIEVEMENTS_BY_ID } from "./achievements.js";
import { LEVELING_GAME_SLUGS } from "./levelingTypes.js";

// ── the twelve tracks ──────────────────────────────────────────────────────
// These definitions ARE the feature's content, and three of their properties
// are load bearing in ways nothing else would catch:
//   • every threshold and every tier reward is PRIME, which is the design
//     signature that ties achievements to the milestone levels,
//   • ids are permanent, because MemberLevel.unlocked stores them,
//   • exactly three tracks are hidden, and hidden means genuinely absent.

// Trial division, written by hand ON PURPOSE. primeLevels.ts only sieves to
// MAX_LEVEL_CEILING (1000) and thresholds run to 5003, but more importantly:
// checking a sieve against the same sieve proves nothing. This is the
// independent check.
function isPrime(value: number): boolean {
	if (!Number.isInteger(value) || value < 2) return false;
	if (value % 2 === 0) return value === 2;
	for (let factor = 3; factor * factor <= value; factor += 2) {
		if (value % factor === 0) return false;
	}
	return true;
}

describe("the trial division helper itself", () => {
	// Without this the primality assertions below could pass for the wrong reason.
	it("agrees with a hand written list of small primes", () => {
		expect([2, 3, 5, 7, 11, 13, 17, 19, 23].every(isPrime)).toBe(true);
	});

	it("rejects composites, including the ones a naive check misses", () => {
		expect([1, 4, 9, 49, 91, 5002].some(isPrime)).toBe(false);
	});
});

describe("⚠️ every number in every track is PRIME", () => {
	it.each(ACHIEVEMENTS.map((achievement) => [achievement.id, achievement] as const))(
		"%s has prime thresholds",
		(_id, achievement) => {
			// Do NOT round these to 50 / 250 / 1000 / 5000. Prime numbers are also
			// the milestone levels, and the pairing is the design signature of the
			// whole system.
			for (const tier of achievement.tiers) {
				expect(isPrime(tier.threshold), `${achievement.id} ${tier.name} threshold ${tier.threshold}`).toBe(true);
			}
		}
	);

	it.each(ACHIEVEMENTS.map((achievement) => [achievement.id, achievement] as const))(
		"%s has prime xp rewards",
		(_id, achievement) => {
			for (const tier of achievement.tiers) {
				expect(isPrime(tier.xp), `${achievement.id} ${tier.name} xp ${tier.xp}`).toBe(true);
			}
		}
	);
});

describe("the shape of every track", () => {
	it("ships exactly thirteen tracks", () => {
		expect(ACHIEVEMENTS).toHaveLength(13);
	});

	it("gives every track four tiers, named bronze to diamond in that order", () => {
		for (const achievement of ACHIEVEMENTS) {
			expect(achievement.tiers.map((tier) => tier.name)).toEqual(["bronze", "silver", "gold", "diamond"]);
		}
	});

	it("keeps thresholds strictly ascending, which the engine's early break depends on", () => {
		// evaluate() breaks out of a track's tier loop at the first threshold the
		// member has not reached. A non ascending list would silently skip tiers.
		for (const achievement of ACHIEVEMENTS) {
			const thresholds = achievement.tiers.map((tier) => tier.threshold);
			expect(thresholds, achievement.id).toEqual([...thresholds].sort((left, right) => left - right));
			expect(new Set(thresholds).size, `${achievement.id} has duplicate thresholds`).toBe(thresholds.length);
		}
	});

	it("keeps tier rewards ascending too, so a higher tier is always worth more", () => {
		for (const achievement of ACHIEVEMENTS) {
			const rewards = achievement.tiers.map((tier) => tier.xp);
			expect(rewards, achievement.id).toEqual([...rewards].sort((left, right) => left - right));
		}
	});

	it("has a unique id per track", () => {
		// ⚠️ AN ID IS FOREVER. MemberLevel.unlocked stores these strings, so renaming
		// one orphans every unlock referencing it and a member silently loses an
		// achievement they earned.
		expect(new Set(ACHIEVEMENTS.map((achievement) => achievement.id)).size).toBe(ACHIEVEMENTS.length);
		expect(ACHIEVEMENTS_BY_ID.size).toBe(ACHIEVEMENTS.length);
	});

	it("composes an earnedBy sentence that names the number", () => {
		// /account shows HOW an achievement was earned, and the sentence is stored at
		// unlock time because the counter behind it will have moved on.
		for (const achievement of ACHIEVEMENTS) {
			for (const tier of achievement.tiers) {
				expect(achievement.earnedBy(tier), `${achievement.id} ${tier.name}`).toContain(
					String(tier.threshold).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
				);
			}
		}
	});

	it("points every per game metric at a declared slug", () => {
		// A metric naming a game that does not exist would read as a permanent zero
		// and its track would never fire, with no error anywhere.
		for (const achievement of ACHIEVEMENTS) {
			if (!achievement.metric.endsWith(".won")) continue;
			const slug = achievement.metric.slice(0, -".won".length);
			expect(LEVELING_GAME_SLUGS as readonly string[], `${achievement.id} metric`).toContain(slug);
		}
	});

	it("declares monopoly, so a finished match records on /account", () => {
		expect(LEVELING_GAME_SLUGS).toContain("monopoly");
	});
});

describe("the three hidden tracks", () => {
	const hidden = ACHIEVEMENTS.filter((achievement) => achievement.hidden);

	it("ships exactly three", () => {
		// The differentiator: MEE6 ships none, and the dedicated Achievements bot
		// only offers USER controlled privacy, which is a different thing. These are
		// DESIGNER hidden.
		expect(hidden.map((achievement) => achievement.id).sort()).toEqual(["dero-knows", "prime-mover", "the-assist"]);
	});

	it("hides prime-mover, the one that ties the system together", () => {
		// It rewards reaching PRIME levels, which a member only discovers by hitting
		// a few and noticing the pattern. Revealing it in a list hands over the
		// discovery and deletes the point.
		expect(ACHIEVEMENTS_BY_ID.get("prime-mover")?.hidden).toBe(true);
		expect(ACHIEVEMENTS_BY_ID.get("prime-mover")?.metric).toBe("milestoneLevels");
	});

	it("backs dero-knows with the counter nothing else increments", () => {
		// fortuneReadings exists on MemberLevel from Phase 1 solely for this track.
		expect(ACHIEVEMENTS_BY_ID.get("dero-knows")?.metric).toBe("fortuneReadings");
	});

	it("backs the-assist with the outcome only hangman can produce today", () => {
		expect(ACHIEVEMENTS_BY_ID.get("the-assist")?.metric).toBe("assists");
	});
});

describe("role rewards on a track", () => {
	it("declares none today, and the plumbing is there for when one is wanted", () => {
		// A guild-specific role on an achievement is a data change rather than a
		// code change, but nothing ships with one, so no guild inherits a role it
		// never configured.
		for (const achievement of ACHIEVEMENTS) {
			expect(achievement.roleId, achievement.id).toBeNull();
		}
	});
});
