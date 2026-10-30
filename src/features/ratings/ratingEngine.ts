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
// Luck games (pure chance) and hangman (cooperative) are never rated: a rating
// there would measure nothing a player did. Blackjack is rated by the owner's
// ruling (2026-10 item 276, decision D8) against the house: each seat's result
// against its own buy in places it, and the house is one fixed entrant (see
// houseTablePlaces and rateAgainstHouse).
export const RATED_GAMES = ["holdem", "battleship", "monopoly", "blackjack"] as const;
export type RatedGame = (typeof RATED_GAMES)[number];

// Rock paper scissors is left out (2026-10 item 280, owner ruling): it is a game of choice,
// not chance, so two members trading wins could top a board meant to measure fortune.
export const LUCK_GAMES = ["coinflip", "diceroll"] as const;
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

/**
 * Whether a match is ranked: a rated game, the host's Rated choice (not Casual) and no Dero bot
 * seated. The one rule behind a card's RATED badge and whether a table plays for wallet chips
 * (2026-10 item 276, owner decision D1: chips move only in ranked matches), so a card can never
 * say RATED over a table that plays free, or CASUAL over one that takes a buy in.
 */
export function isRankedMatch(game: string, botCount: number, casual: boolean): boolean {
	return isRatedGame(game) && botCount === 0 && !casual;
}

/** The rating every player starts a game at, before their first rated result. */
export function newRating(): SkillRating {
	const fresh = rating();
	return { mu: fresh.mu, sigma: fresh.sigma };
}

/** One entrant's rating before a match and the place it finished in: 1 is first, and entrants who tied share a place. */
export interface PlacedSkill extends SkillRating {
	rank: number;
}

/**
 * One OpenSkill update over entrants at their places, ties allowed (equal ranks are a draw
 * between those entrants, lower is better). Every entrant is a team of one, which is how
 * openskill reads a free for all. Fewer than two entrants is not a match, so it answers the
 * ratings unchanged. The answer is each entrant's rating after the match, in the same order.
 */
export function rateRanks(entries: readonly PlacedSkill[]): SkillRating[] {
	if (entries.length < 2) return entries.map((entry) => ({ mu: entry.mu, sigma: entry.sigma }));

	const teams = entries.map((entry) => [{ mu: entry.mu, sigma: entry.sigma }]);
	const rated = rate(teams, { rank: entries.map((entry) => entry.rank) });

	return rated.map((team, index) => {
		const after = team[0] ?? entries[index];
		return { mu: after.mu, sigma: after.sigma };
	});
}

/**
 * One OpenSkill update for a finished match. `bestFirst` is each player's rating
 * before the match, in finishing order (the winner first), every place its own (ranks
 * 1, 2, 3 by position); the answer is each player's rating after it, in the same order.
 */
export function rateFinishingOrder(bestFirst: readonly SkillRating[]): SkillRating[] {
	return rateRanks(bestFirst.map((entry, index) => ({ mu: entry.mu, sigma: entry.sigma, rank: index + 1 })));
}

// ── a table played against the house (2026-10 item 276, owner decision D8) ──
/** A seat's result at a table played against the house: the chips it ended with less what it bought in for. */
export interface HouseTableResult {
	userId: string;
	net: number;
}

/** Every seat's place at a house table, best first, and the house's own place among them. */
export interface HouseTablePlaces {
	seats: Array<{ userId: string; rank: number }>;
	houseRank: number;
}

/**
 * The places of a table played against the house (Blackjack): each seat by its result against
 * its own buy in, with the house as one more entrant standing at a result of zero. A seat that
 * ended above its buy in places ahead of the house, level ties it, below places behind it, and
 * seats place against each other the same way, so a table of several seats is one finishing
 * order of the players and the house. Equal results share a place, numbered densely (1, 1, 2),
 * so a place reads as "how many distinct results finished ahead, plus one".
 */
export function houseTablePlaces(results: readonly HouseTableResult[]): HouseTablePlaces {
	const resultsBestFirst = [...new Set([0, ...results.map((result) => result.net)])].sort((first, second) => second - first);
	const placeOf = (net: number): number => resultsBestFirst.indexOf(net) + 1;
	const seats = [...results].sort((first, second) => second.net - first.net).map((result) => ({ userId: result.userId, rank: placeOf(result.net) }));
	return { seats, houseRank: placeOf(0) };
}

/**
 * One OpenSkill update for a house table: the seats at their places plus the house at
 * `houseRank`, which always enters at a fresh rating and whose own update is thrown away, so
 * the house is a fixed yardstick that never drifts and is never stored (owner decision D8).
 * Answers the seats' ratings after the match, in the order given.
 */
export function rateAgainstHouse(seats: readonly PlacedSkill[], houseRank: number): SkillRating[] {
	const house: PlacedSkill = { ...newRating(), rank: houseRank };
	return rateRanks([...seats, house]).slice(0, seats.length);
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
