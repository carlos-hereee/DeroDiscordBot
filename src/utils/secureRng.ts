import { randomInt } from "node:crypto";

// ── secureRng ─────────────────────────────────────────────────────────────
// What:  a drop in for Math.random built on the operating system's secure
//        random source, for the one place randomness decides who wins chips.
// Who:   every hold em call site that can reach the deck shuffle (dealHand, act,
//        forceFold) passes it as the engine's rng argument.
// When:  once per card swap in a shuffle, so 51 calls per deal.
// Where: a util with no feature import. The engine keeps Math.random as its
//        default on purpose: its tests and the other games seed or ignore it, and
//        the secure source is chosen at the call site, where a source scan test
//        (secureRng.test.ts) fails any dealHand call that leaves it out.
// How:   two crypto.randomInt draws, 26 high bits and 27 low bits, joined into one
//        uniform integer below 2 to the 53rd and divided by it: a uniform number
//        from 0 up to but not including 1, at the full precision of a double.
//        Two draws because one cannot reach the required range: randomInt's span
//        must stay under 2 to the 48th, one short of the "at least 2 to the 48th"
//        the plan asks for.
//
// ⚠️ Math.random is a fast generator whose state can be recovered from its
// output. Nobody here sees raw output, but a shuffle is exactly the place where
// "nobody can predict it" should hold by construction rather than by luck.

const HIGH_BITS = 26;
const LOW_BITS = 27;

/** How many distinct values secureRandom can return: 2 to the 53rd. */
export const SECURE_RANDOM_RANGE = 2 ** (HIGH_BITS + LOW_BITS);

/** A secure uniform number in [0, 1), shaped like Math.random. */
export function secureRandom(): number {
	const high = randomInt(0, 2 ** HIGH_BITS);
	const low = randomInt(0, 2 ** LOW_BITS);
	return (high * 2 ** LOW_BITS + low) / SECURE_RANDOM_RANGE;
}
