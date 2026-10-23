// ── seededRng ───────────────────────────────────────────────────────────────
// What:  a small seeded generator shaped like Math.random, and a helper that
//        picks a fresh seed. The same seed always yields the same sequence.
// Who:   the Monopoly card decks (monopolyCards), which shuffle from a seed so a
//        persisted match can be reasoned about and a test can pin a deck order.
// When:  once per deck shuffle at match start. It is NOT for anything that
//        decides who wins chips under adversarial eyes; hold em uses secureRng
//        for that, and this generator's sequence is recoverable by design.
// Where: a util with no feature import.
// How:   mulberry32, a 32 bit state generator with good spread for its size. The
//        state advances by a fixed odd constant and is mixed with shifts and
//        multiplies; the result is divided by 2 to the 32nd for [0, 1).

const UINT32_RANGE = 2 ** 32;
// The mulberry32 increment and mixing constants, from its published reference
// implementation. Changing any of them changes every seeded sequence.
const STATE_INCREMENT = 0x6d2b79f5;
const MIX_A = 15;
const MIX_B = 7;
const MIX_C = 61;
const MIX_D = 14;

/** A generator that returns the same [0, 1) sequence for the same seed. */
export function createSeededRng(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state = (state + STATE_INCREMENT) | 0;
		let mixed = Math.imul(state ^ (state >>> MIX_A), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> MIX_B), MIX_C | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> MIX_D)) >>> 0) / UINT32_RANGE;
	};
}

/** A fresh 32 bit seed. The rng is injectable so a test can pin it. */
export function createRandomSeed(rng: () => number = Math.random): number {
	return Math.floor(rng() * UINT32_RANGE);
}
