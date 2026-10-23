import { ordinal, rate, rating } from "openskill";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { RatingBand } from "@features/game-rooms/roomTypes.js";

// ── ratingEngine ─────────────────────────────────────────────────────
// The arcade's rating math, and nothing else (2026-10 item 244): a fresh rating,
// one OpenSkill update over a finishing order, the display number members read,
// the provisional mark, and whether a joiner fits a host's rating band. PURE: no
// Mongoose, no discord.js, no clock. recordMatchRatings calls it at the finish
// sites; Phase 4's host controls will call fitsBand.
//
// One shared OpenSkill model (Weng-Lin, the library's defaults) for every rated
// game, at full weight, because two systems would mean two display rules members
// have to learn. Members see "rating"; it is never called Elo, because it is not.

const LIMITS = BOT_CONSTANTS.RATINGS;

// Owner decision 2026-10-23 (2026-10 item 244): the ordinal is mu minus 3 sigma.
// Passed explicitly rather than left to the library default, so a default change
// in a future openskill release cannot silently move every display rating.
const ORDINAL_SIGMAS = 3;

// The games that move a rating, and the ones that only feed the luck board.
// Luck games (pure chance) and hangman (cooperative) and blackjack (against the
// house) are never rated: a rating there would measure nothing a player did.
export const RATED_GAMES = ["holdem", "battleship", "monopoly"] as const;
export type RatedGame = (typeof RATED_GAMES)[number];

export const LUCK_GAMES = ["coinflip", "diceroll", "rps"] as const;
export type LuckGame = (typeof LUCK_GAMES)[number];

// The band list lives in the game rooms vocabulary, where the GameRoom model reads it
// for its enum; re-exported so the band math and the stored value share one list.
export { RATING_BANDS, type RatingBand } from "@features/game-rooms/roomTypes.js";

/** One player's skill estimate in one game: the mean and its uncertainty. */
export interface SkillRating {
	mu: number;
	sigma: number;
}

/** What a band check needs to know about a player: the number shown and how many rated games stand behind it. */
export interface RatingStanding {
	displayRating: number;
	ratedGames: number;
}

const BAND_WIDTHS: Record<Exclude<RatingBand, "any">, number> = {
	close: LIMITS.BAND_CLOSE,
	tight: LIMITS.BAND_TIGHT,
};

/** How many display points either side of the host a band admits, or null for Any, which admits everyone. */
export function bandWidth(band: RatingBand): number | null {
	return band === "any" ? null : BAND_WIDTHS[band];
}

export const isRatedGame = (game: string): game is RatedGame => (RATED_GAMES as readonly string[]).includes(game);

export const isLuckGame = (game: string): game is LuckGame => (LUCK_GAMES as readonly string[]).includes(game);

/** The rating every player starts a game at, before their first rated result. */
export function newRating(): SkillRating {
	const fresh = rating();
	return { mu: fresh.mu, sigma: fresh.sigma };
}

/**
 * One OpenSkill update for a finished match. `bestFirst` is each player's rating
 * before the match, in finishing order (the winner first); the answer is each
 * player's rating after it, in the same order.
 *
 * Every player is a team of one and ranks are 1, 2, 3 by position, lower better,
 * which is how openskill reads a free for all finishing order. Fewer than two
 * players is not a match, so it answers the ratings unchanged.
 */
export function rateFinishingOrder(bestFirst: readonly SkillRating[]): SkillRating[] {
	if (bestFirst.length < 2) return bestFirst.map((entry) => ({ mu: entry.mu, sigma: entry.sigma }));

	const teams = bestFirst.map((entry) => [{ mu: entry.mu, sigma: entry.sigma }]);
	const ranks = bestFirst.map((_entry, index) => index + 1);
	const rated = rate(teams, { rank: ranks });

	return rated.map((team, index) => {
		const after = team[0] ?? bestFirst[index];
		return { mu: after.mu, sigma: after.sigma };
	});
}

/** The number members see: round(1000 + 40 x (mu minus 3 sigma)). A fresh rating reads 1000. */
export function displayRating(skill: SkillRating): number {
	return Math.round(LIMITS.DISPLAY_BASE + LIMITS.DISPLAY_SCALE * ordinal(skill, { z: ORDINAL_SIGMAS }));
}

/** True while a player has fewer than 10 rated games in the game, so their number is still settling. */
export function isProvisional(ratedGames: number): boolean {
	return ratedGames < LIMITS.PROVISIONAL_GAMES;
}

/** True when a Hold'em session dealt enough hands to be rated. Shorter sessions are recorded, never rated. */
export function isRatedHoldemSession(handsDealt: number): boolean {
	return handsDealt >= LIMITS.HOLDEM_MIN_RATED_HANDS;
}

/** The standing of a player with no rated game yet in a game: the fresh display, provisional. */
export const UNRATED_STANDING: RatingStanding = { displayRating: displayRating(newRating()), ratedGames: 0 };

/**
 * Whether `joiner` may join a table `host` banded at `band`.
 *
 * ① Any admits everyone. ② A provisional HOST means Any whatever the preset, because
 * a band drawn around a number that is still settling locks out the wrong people.
 * ③ A provisional JOINER fits every band for the same reason: their number does not
 * yet say where they belong. ④ Otherwise the two display ratings must sit within the
 * band's width (Close 150, Tight 75), inclusive.
 */
export function fitsBand(host: RatingStanding, joiner: RatingStanding, band: RatingBand): boolean {
	if (band === "any") return true;
	if (isProvisional(host.ratedGames)) return true;
	if (isProvisional(joiner.ratedGames)) return true;
	return Math.abs(joiner.displayRating - host.displayRating) <= BAND_WIDTHS[band];
}
