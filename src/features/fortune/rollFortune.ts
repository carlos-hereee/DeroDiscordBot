import { getRandom } from "@utils/getRandom.js";
import { COMMON_FORTUNES, ULTRA_FORTUNES, type Fortune, type FortuneTier } from "./fortunes.js";

// Probability of an ultra (gold) reading on any single roll. Kept rare so the
// gold tier stays a genuine jackpot, and named rather than inlined so the rate is
// one edit away and the test can assert against the same source of truth. 0.03 is
// deliberately prime: it is the base rung of the secret-code buff ladder
// (3 / 19 / 43 / 83 percent, all primes), where a redeemed code raises a user's
// effective weight above this floor. See FUTURE_PLANS item 88.
export const ULTRA_WEIGHT = 0.03;

// Pity: after this many consecutive non-gold readings, the next reading is a
// GUARANTEED gold (respondWithFortune passes weight 1 to force it), so nobody
// stays cold forever. 23 is prime, matches the luck ladder's style, and caps the
// worst dry streak. The per-user streak lives in fortuneBuffStore.
export const PITY_THRESHOLD = 23;

// Pick a tier by weighted coin flip, then a line from that tier's pool.
// `rng` is injectable ONLY so tests can drive the tier boundary deterministically;
// production always uses Math.random. getRandom handles the within-tier uniform
// pick (DRY — the same helper the greeter and go-live features use). A one-shot
// Discord handler is a safe place for Math.random; never call this from a
// deterministic/replayable context.
export function rollFortune(
	rng: () => number = Math.random,
	ultraWeight: number = ULTRA_WEIGHT
): { tier: FortuneTier; verdict: string; flavor: string } {
	// ultraWeight defaults to the base rate; a buffed member (or a forced pity gold)
	// passes a higher weight via respondWithFortune so only their gold odds rise.
	// getRandom picks a { verdict, flavor } pair so the orb window and the embed text
	// always agree.
	const tier: FortuneTier = rng() < ultraWeight ? "ultra" : "common";
	const pool = tier === "ultra" ? ULTRA_FORTUNES : COMMON_FORTUNES;
	const pick = getRandom(pool) as Fortune;
	return { tier, verdict: pick.verdict, flavor: pick.flavor };
}
