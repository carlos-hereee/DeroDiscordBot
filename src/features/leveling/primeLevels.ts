// ── primeLevels ────────────────────────────────────────────────────────────
// PRIME LEVELS ARE THE MILESTONE LEVELS. Levels 2, 3, 5, 7, 11, 13, 17, 19, 23
// and so on get the loud celebration; everything else gets a compact line. This
// REPLACES an "every N levels" rule rather than sitting beside it (locked
// decision D2), and milestoneMode "everyN" survives in GuildConfig only as an
// opt out for a guild that wants the ordinary thing.
//
// What:  a sieve of Eratosthenes computed ONCE at module load into a Set, and an
//        O(1) membership test over it.
// Who:   levelUpAnnouncer (which tier of celebration to send), /account (the
//        "your next level is a milestone" nudge), the achievement engine (the
//        hidden prime-mover track counts milestone levels reached).
// When:  isMilestone runs on every level up, so it is a Set.has and nothing more.
// Where: pure. No discord.js, no store, no I/O, no clock. Same discipline as
//        levelCurve.ts, duelResolve.ts and hangmanState.ts.
//
// WHY PRIMES, and this is the part worth keeping: it started as the owner's
// aesthetic preference and turns out to be structurally correct. Milestone
// density should be HIGH EARLY and thin out late, because early milestones are
// what prove to a new member that the system is real, while late ones are valued
// precisely for being rare. "Every 5 levels" gives a flat 20 percent density
// forever, which is wrong at both ends. Prime gaps do the right thing for free:
//
//   levels 1 to 20    2 3 5 7 11 13 17 19                    8 in 20, 40 percent
//   levels 21 to 50   23 29 31 37 41 43 47                   7 in 30, 23 percent
//   levels 51 to 100  53 59 61 67 71 73 79 83 89 97         10 in 50, 20 percent
//
// Four milestones in a member's first day or two, then a gap that widens and
// never fully closes.

import { MAX_LEVEL_CEILING } from "./levelCurve.js";

// Sieved to the curve's own ceiling so the two modules can never disagree about
// what levels exist. A level above the ceiling is unreachable, so a milestone
// question about one is answered false rather than by extending the sieve.
function sievePrimes(ceiling: number): ReadonlySet<number> {
	// composite[n] is true once n has been struck out. Index 0 and 1 are seeded
	// as composite because neither is prime and 1 in particular would otherwise
	// make every member's starting level a milestone.
	const composite = new Array<boolean>(ceiling + 1).fill(false);
	composite[0] = true;
	if (ceiling >= 1) composite[1] = true;

	// Only sieve up to the square root: any composite has a factor at or below
	// it, so every larger multiple has already been struck by a smaller prime.
	for (let candidate = 2; candidate * candidate <= ceiling; candidate += 1) {
		if (composite[candidate]) continue;
		for (let multiple = candidate * candidate; multiple <= ceiling; multiple += candidate) {
			composite[multiple] = true;
		}
	}

	const primes = new Set<number>();
	for (let value = 2; value <= ceiling; value += 1) {
		if (!composite[value]) primes.add(value);
	}
	return primes;
}

// Computed at module load, exactly once for the process lifetime. The sieve to
// 1000 is a few microseconds of boot cost that buys an O(1) lookup on a path
// that runs on every level up.
export const MILESTONE_LEVELS: ReadonlySet<number> = sievePrimes(MAX_LEVEL_CEILING);

// ── isMilestone ─────────────────────────────────────────────────────────────
// The whole public surface. Level 1 is not a milestone (a member starts there,
// and celebrating the starting line is noise); level 2 is, which is what makes a
// new member's very first level up the loud one.
export function isMilestone(level: number): boolean {
	if (!Number.isInteger(level)) return false;
	return MILESTONE_LEVELS.has(level);
}

// ── the two derived lookup tables, also built once ──────────────────────────
// Both of the questions below are asked on hot paths (the achievement engine
// runs per flushed member per flush, and /account renders the nudge on every
// profile), so neither may walk the prime set at call time. One boot-time pass
// turns both into an array index.
const MILESTONE_COUNT_UP_TO: readonly number[] = (() => {
	const counts = new Array<number>(MAX_LEVEL_CEILING + 1).fill(0);
	for (let level = 2; level <= MAX_LEVEL_CEILING; level += 1) {
		counts[level] = counts[level - 1] + (MILESTONE_LEVELS.has(level) ? 1 : 0);
	}
	return counts;
})();

const NEXT_MILESTONE_AT_OR_ABOVE: readonly (number | null)[] = (() => {
	const next = new Array<number | null>(MAX_LEVEL_CEILING + 2).fill(null);
	// Walk DOWN so each slot can carry its successor's answer forward, which is
	// what makes this one pass instead of a scan per level.
	for (let level = MAX_LEVEL_CEILING; level >= 0; level -= 1) {
		next[level] = MILESTONE_LEVELS.has(level) ? level : next[level + 1];
	}
	return next;
})();

// How many milestone levels a member has passed on their way to `level`. Backs
// the hidden prime-mover achievement, which counts milestones REACHED rather
// than levels gained, and is why that track cannot be derived from level alone.
export function milestoneLevelsUpTo(level: number): number {
	if (!Number.isFinite(level) || level < 2) return 0;
	return MILESTONE_COUNT_UP_TO[Math.min(Math.floor(level), MAX_LEVEL_CEILING)];
}

// The next milestone at or above `level`, or null when none remains inside the
// table. Feeds the /account nudge: a member who has noticed the pattern gets
// told when their next level is one of the loud ones.
export function nextMilestoneAtOrAbove(level: number): number | null {
	if (!Number.isFinite(level)) return NEXT_MILESTONE_AT_OR_ABOVE[2] ?? null;
	const start = Math.max(0, Math.ceil(level));
	if (start > MAX_LEVEL_CEILING) return null;
	return NEXT_MILESTONE_AT_OR_ABOVE[start] ?? null;
}
