// ── versusResolve ────────────────────────────────────────────────────────────
// Pure resolution for /mini-game duel. No Discord types, no I/O, no module
// state, so the odds are testable in isolation exactly the way rollFortune.ts
// splits its roll from respondWithFortune's side effects. The rng is injectable
// for the same reason: production passes nothing and gets Math.random, tests
// pass a stub and pin the boundaries.

export type VersusFlip = "dice" | "coin";
export type VersusWinner = "challenger" | "opponent" | "tie";
export type CoinFace = "heads" | "tails";

// A twenty sided die rather than a six. Both are "dice" to a player, but d20
// puts the tie rate at 5 percent instead of nearly 17, and a duel that ties one
// time in six stops feeling like a duel. Named so the number is changeable in
// one place if that judgement turns out wrong in real use.
export const DUEL_DIE_SIDES = 20;

// The two modes resolve differently on purpose, which is what makes the option
// worth offering at all:
//   • dice, both players roll independently and the higher roll wins, so a tie
//     is possible and the numbers give the embed something to show.
//   • coin, ONE flip decides it. Heads is the challenger, tails is the opponent.
//     A single coin cannot tie, so this is the mode to pick when someone needs
//     an answer rather than a story. House rule: nobody calls a side in the air.
//     A fair coin makes the call worthless (either call wins half the time), and
//     fixing heads to the challenger saves a choice before every flip.
export type VersusResult =
	| { flip: "dice"; challengerRoll: number; opponentRoll: number; winner: VersusWinner }
	| { flip: "coin"; face: CoinFace; winner: "challenger" | "opponent" };

// `sides` defaults to the duel's d20. Monopoly passes 6 for its 2d6 movement roll,
// which is why the die size is a parameter rather than a second dice helper: one
// function owns turning an rng into die faces for every game in the arcade.
export function resolveVersus(flip: VersusFlip, rng: () => number = Math.random, sides: number = DUEL_DIE_SIDES): VersusResult {
	if (flip === "coin") {
		// Strictly below 0.5 is heads, so the two faces split the [0, 1) range
		// evenly. Math.random never returns 1, so tails is not shortchanged.
		const face: CoinFace = rng() < 0.5 ? "heads" : "tails";
		return { flip: "coin", face, winner: face === "heads" ? "challenger" : "opponent" };
	}

	const challengerRoll = rollDie(rng, sides);
	const opponentRoll = rollDie(rng, sides);
	const winner: VersusWinner =
		challengerRoll === opponentRoll ? "tie" : challengerRoll > opponentRoll ? "challenger" : "opponent";
	return { flip: "dice", challengerRoll, opponentRoll, winner };
}

// ── private ────────────────────────────────────────────────────────────────

// 1 through `sides` inclusive. rng() is [0, 1), so floor(rng * sides)
// lands in [0, sides - 1] and the +1 shifts it onto a real die face. An rng
// stubbed to exactly 0 must give 1, and one approaching 1 must give the top
// face, both of which the tests pin.
function rollDie(rng: () => number, sides: number): number {
	return Math.floor(rng() * sides) + 1;
}
