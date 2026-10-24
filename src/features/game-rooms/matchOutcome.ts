import { HAND_CATEGORIES, type HandCategory } from "@features/games/holdemHand.js";
import type { GameSlug } from "./roomTypes.js";

// ── matchOutcome ─────────────────────────────────────────────────────
// What:  decides HOW a match was won (post-launch plan item 21), as one of eight
//        outcome buckets, so the challenge card can close with a flavor line that
//        fits: a rout reads differently from a comeback.
// Who:   each game's finishing call site gathers the plain facts below from its own
//        final state and passes the bucket to roomLifecycle.finish, which closes the
//        challenge card. Pure: no Discord, no I/O, no randomness except pickFlavor's
//        injectable rng.
// Where: the facts are per game because the games keep different state, but the
//        buckets are shared, so the flavor table and the card read one vocabulary.
// How:   each classifier checks the buckets in a fixed priority, most specific first,
//        and falls back to "narrow", the plan's default when nothing else matches.
//
// The thresholds are the plan's, adapted where the plan named a fact the game never
// stores (the build record in the plan names each adaptation).

export const OUTCOME_BUCKETS = ["decisive", "narrow", "comeback", "routing", "tactic", "forfeit", "timeout", "draw"] as const;

export type OutcomeBucket = (typeof OUTCOME_BUCKETS)[number];

/** How the finish happened, for the buckets that are about the ending rather than the play. */
export type FinishCause = "played" | "forfeit" | "timeout";

// ── hold em ──────────────────────────────────────────────────────────

// A winner holding this share of every chip at the table is a decisive win.
const HOLDEM_DECISIVE_SHARE = 0.7;
// Three of a kind or better at the showdown is a hand that won by its strength.
const HOLDEM_TACTIC_CATEGORY: HandCategory = "three of a kind";

export interface HoldemOutcomeFacts {
	cause: FinishCause | "ended";
	// How many seats busted on the hand that ended the tournament.
	bustedInFinalHand: number;
	// The winner's made hand at the final showdown, or null when the hand ended on a fold.
	winnerHandCategory: HandCategory | null;
	// The winner's share of all chips at the START of the final hand (0 to 1). For a
	// table the host ended, their share at the end.
	winnerShare: number;
}

/**
 * Hold em's bucket. A host who ends the table early is judged on the standings alone:
 * a dominant chip lead is decisive, anything else narrow.
 */
export function holdemOutcome(facts: HoldemOutcomeFacts): OutcomeBucket {
	if (facts.cause === "forfeit") return "forfeit";
	if (facts.cause === "timeout") return "timeout";
	if (facts.cause === "ended") return facts.winnerShare >= HOLDEM_DECISIVE_SHARE ? "decisive" : "narrow";
	// Every other seat gone on the one hand: two or more busted together.
	if (facts.bustedInFinalHand >= 2) return "routing";
	if (facts.winnerHandCategory && HAND_CATEGORIES.indexOf(facts.winnerHandCategory) >= HAND_CATEGORIES.indexOf(HOLDEM_TACTIC_CATEGORY)) return "tactic";
	if (facts.winnerShare >= HOLDEM_DECISIVE_SHARE) return "decisive";
	return "narrow";
}

/** Each seat's chips at the start of the hand in play: its stack plus what it has put in. */
export function chipsAtHandStart(seats: readonly { userId: string; stack: number; totalCommitted: number }[]): Map<string, number> {
	return new Map(seats.map((seat) => [seat.userId, seat.stack + seat.totalCommitted]));
}

/** One player's share of every chip in `chips`, or 0 when there are none. */
export function shareOf(chips: ReadonlyMap<string, number>, userId: string | null): number {
	if (!userId) return 0;
	let total = 0;
	for (const amount of chips.values()) total += amount;
	return total > 0 ? (chips.get(userId) ?? 0) / total : 0;
}

// ── monopoly ─────────────────────────────────────────────────────────

// The last rival bankrupt within this many rounds (turns divided by the seats that
// started) is a rout. The plan's "by turn 20", read as twenty rounds of the table.
const MONOPOLY_ROUTING_ROUNDS = 20;
// A winner who once held less than this share of all cash came back to win.
const MONOPOLY_COMEBACK_SHARE = 0.2;

export interface MonopolyOutcomeFacts {
	cause: FinishCause;
	turnsTaken: number;
	seatCount: number;
	auctionsOpened: number;
	// Seats that left on their own or were removed, as against going bankrupt.
	forfeits: number;
	// The lowest share of all cash the winner ever held, 1 when never tracked.
	winnerLowestShare: number;
}

export function monopolyOutcome(facts: MonopolyOutcomeFacts): OutcomeBucket {
	if (facts.cause === "timeout") return "timeout";
	if (facts.cause === "forfeit" || facts.forfeits > 0) return "forfeit";
	if (facts.seatCount > 0 && facts.turnsTaken <= MONOPOLY_ROUTING_ROUNDS * facts.seatCount) return "routing";
	if (facts.winnerLowestShare < MONOPOLY_COMEBACK_SHARE) return "comeback";
	if (facts.auctionsOpened === 0) return "decisive";
	return "narrow";
}

// ── battleship ───────────────────────────────────────────────────────

// Five ships to a fleet. The plan said "10+ ships remaining", which a five ship fleet
// can never reach, so decisive is four or more still afloat and narrow two or fewer.
const BATTLESHIP_DECISIVE_AFLOAT = 4;
const BATTLESHIP_NARROW_AFLOAT = 2;

export interface BattleshipOutcomeFacts {
	cause: FinishCause;
	winnerShipsAfloat: number;
	// True when the winner had fewer ships afloat than the loser at any point.
	winnerWasBehind: boolean;
}

export function battleshipOutcome(facts: BattleshipOutcomeFacts): OutcomeBucket {
	if (facts.cause === "forfeit") return "forfeit";
	if (facts.cause === "timeout") return "timeout";
	if (facts.winnerWasBehind) return "comeback";
	if (facts.winnerShipsAfloat <= BATTLESHIP_NARROW_AFLOAT) return "narrow";
	if (facts.winnerShipsAfloat >= BATTLESHIP_DECISIVE_AFLOAT) return "decisive";
	return "narrow";
}

/**
 * Whether the winner was ever behind on ships, replayed from the sinkings in the order
 * they happened. `sinkings` lists who sank a ship, oldest first; `fleetSize` is the ships
 * each side started with.
 */
export function wasBehindOnShips(sinkings: readonly string[], winnerId: string, loserId: string, fleetSize: number): boolean {
	let winnerAfloat = fleetSize;
	let loserAfloat = fleetSize;
	for (const shooterId of sinkings) {
		if (shooterId === winnerId) loserAfloat -= 1;
		else if (shooterId === loserId) winnerAfloat -= 1;
		if (winnerAfloat < loserAfloat) return true;
	}
	return false;
}

// ── hangman and the luck games ───────────────────────────────────────

/**
 * Hangman's bucket for a solved word: decisive with no miss at all. The plan's narrow
 * is five misses, one from the rope, and one to four misses fall to the default
 * narrow as well, so every miss count but zero lands there.
 */
export function hangmanOutcome(misses: number): OutcomeBucket {
	return misses === 0 ? "decisive" : "narrow";
}

/** A coin flip, dice roll or rps round: narrow, or a draw on a tie. */
export function luckOutcome(tied: boolean): OutcomeBucket {
	return tied ? "draw" : "narrow";
}

// ── the flavor line ──────────────────────────────────────────────────

/** Which flavor shelf a game reads. The three luck games share one. */
export type FlavorGame = "holdem" | "monopoly" | "battleship" | "hangman" | "luck";

const FLAVOR_GAME: Partial<Record<GameSlug, FlavorGame>> = {
	holdem: "holdem",
	monopoly: "monopoly",
	battleship: "battleship",
	hangman: "hangman",
	coinflip: "luck",
	diceroll: "luck",
	rps: "luck",
};

/** The flavor shelf for a room's game, or null for a game with no challenge card. */
export function flavorGameOf(game: GameSlug): FlavorGame | null {
	return FLAVOR_GAME[game] ?? null;
}

export interface FlavorTable {
	byGame: Partial<Record<FlavorGame, Partial<Record<OutcomeBucket, readonly string[]>>>>;
	shared: Record<OutcomeBucket, readonly string[]>;
}

/**
 * One flavor line for (game, bucket): the game's own shelf when it has one for the
 * bucket, the shared shelf otherwise, picked at random.
 */
export function pickFlavor(table: FlavorTable, game: FlavorGame, bucket: OutcomeBucket, rng: () => number = Math.random): string {
	const own = table.byGame[game]?.[bucket];
	const lines = own && own.length > 0 ? own : table.shared[bucket];
	return lines[Math.floor(rng() * lines.length)] ?? "";
}
