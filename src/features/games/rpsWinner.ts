// ── rpsWinner ──────────────────────────────────────────────────────────────
// Pure scoring for /mini-game rps. No Discord types, no I/O, no module state,
// matching the pure and impure split rollFortune.ts / respondWithFortune.ts
// already draw. There is no rng here at all: resolving two KNOWN choices is
// deterministic, which is exactly why this half is worth isolating, the only
// way to get it wrong is a bad table and a bad table is trivially testable.

export type RpsChoice = "rock" | "paper" | "scissors";
export type RpsOutcome = "challenger" | "opponent" | "tie";

export const RPS_CHOICES: readonly RpsChoice[] = ["rock", "paper", "scissors"] as const;

// What each choice defeats. One table rather than a chain of comparisons, so the
// rules are readable as data and a typo is visible rather than buried in a
// branch. Every choice appears exactly once as a key and exactly once as a
// value, which is the property that makes the game fair; the tests assert it.
const BEATS: Record<RpsChoice, RpsChoice> = {
	rock: "scissors",
	paper: "rock",
	scissors: "paper",
};

export function scoreRps(challenger: RpsChoice, opponent: RpsChoice): RpsOutcome {
	if (challenger === opponent) return "tie";
	return BEATS[challenger] === opponent ? "challenger" : "opponent";
}
