import type { IPluginCopy } from "@base/copy/types.js";
import type { IGameResultCount } from "@db/models/GameResultCount.js";
import type { ILuckStat } from "@db/models/LuckStat.js";
import type { IPlayerRating } from "@db/models/PlayerRating.js";
import { gameResultCountStore } from "@db/stores/gameResultCountStore.js";
import { luckStatStore } from "@db/stores/luckStatStore.js";
import { matchResultStore, type IFinishedBetween } from "@db/stores/matchResultStore.js";
import { playerRatingStore } from "@db/stores/playerRatingStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { consentingAmong } from "@features/game-rooms/networkConsent.js";
import { phraseHoldemHandLabel } from "./gameResultCounts.js";
import { FORTUNE_LUCK_GAME, luckScore, type LuckTally } from "./luckStats.js";
import { isProvisional, RATED_GAMES, type RatedGame } from "./ratingEngine.js";

// ── ratingBoards ─────────────────────────────────────────────────────
// The read side of the arcade ratings (2026-10 item 244 Phase 3b): a member's own
// rating per rated game, one server's best rated players of one game, one server's
// luck board for a month, and one server's top winning Hold'em hands for a month.
// /rating and the monthly arcade post both read through here, so a board and the
// post can never rank the same players two different ways.
//
// It writes nothing and knows no discord.js: who is still a member, and by what
// name, comes from the NameResolver the caller hands in (memberNames.ts builds
// one from a Guild). A player the resolver cannot name (they left, or are a bot)
// sits out the board rather than showing up as a bare id.
//
// ⚠️ A SERVER BOARD IS NEVER NETWORK WIDE. A PlayerRating has no guildId, so every
// server board starts from the players who have a MatchResult in THAT server. The
// network scope boards (Phase 5b) are the one exception, and they list ONLY players
// who accepted the network notice (networkRules.consentingAmong), so no rating shows
// outside a server its owner played in without their consent (risk R9).

/** Answers the display names of the ids that are current members; an id it cannot name is absent. */
export type NameResolver = (userIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;

/** A rating as members read it: the display number, how many rated games stand behind it, and whether it is still settling. */
export interface RatingSnapshot {
	displayRating: number;
	ratedGames: number;
	provisional: boolean;
}

/** One rated game on /rating me. Null `rating` for a game the member has no rated result in yet. */
export interface MemberGameRating {
	game: RatedGame;
	rating: RatingSnapshot | null;
}

export interface RatedPlayer extends RatingSnapshot {
	userId: string;
	displayName: string;
}

export interface LuckyPlayer extends LuckTally {
	userId: string;
	displayName: string;
	/** Wins above an even split, never null here: the board lists only players past the minimum. */
	score: number;
}

/** A winning hand in members' words and how many showdowns it won. */
export interface WinningHand {
	phrase: string;
	count: number;
}

export interface GuildBoardQuery {
	guildId: string;
	limit: number;
	resolveNames: NameResolver;
}

const HOLDEM_GAME = "holdem";
const SCORE_DECIMALS = 1;

const snapshotOf = (row: Pick<IPlayerRating, "displayRating" | "ratedGames">): RatingSnapshot => ({
	displayRating: row.displayRating,
	ratedGames: row.ratedGames,
	provisional: isProvisional(row.ratedGames),
});

/** A member's rating in each of `games`, in that order, including the games they have not been rated in yet. */
export async function memberRatings(userId: string, games: readonly RatedGame[] = RATED_GAMES): Promise<MemberGameRating[]> {
	const rows = await playerRatingStore.findAllForPlayer(userId);
	const byGame = new Map(rows.map((row) => [row.game, row]));
	return games.map((game) => {
		const row = byGame.get(game);
		return { game, rating: row ? snapshotOf(row) : null };
	});
}

/**
 * One server's best rated players of one game: every player with a result in that
 * game in this guild (optionally only from matches that finished inside a window),
 * ranked by their rating, current members only, at most `limit` of them.
 */
export async function topRatedInGuild(query: GuildBoardQuery & { game: RatedGame; finishedBetween?: IFinishedBetween }): Promise<RatedPlayer[]> {
	const playerIds = await matchResultStore.playerIdsInGuild(query.guildId, query.game, query.finishedBetween);
	if (playerIds.length === 0) return [];
	const ranked = rankRatings(await playerRatingStore.findForPlayers(playerIds, query.game));
	return keepCurrentMembers(ranked, query.limit, query.resolveNames);
}

/** One server's luck board for one UTC month: players past the 20 decided game minimum, luckiest first, current members only. */
export async function luckBoardInGuild(query: GuildBoardQuery & { month: string }): Promise<LuckyPlayer[]> {
	const ranked = rankLuck(sumLuckByPlayer(await luckStatStore.findForGuildMonth(query.guildId, query.month)));
	return keepCurrentMembers(ranked, query.limit, query.resolveNames);
}

/** One member's luck for a month: their decided games and wins across the luck games, and the board's score (null below the minimum). */
export interface MemberLuck extends LuckTally {
	score: number | null;
}

/**
 * One member's luck in one server for one UTC month, the same sum the luck board
 * ranks, or null when they decided no luck game that month. Read by the /account
 * profile (post-launch plan item 7), so the profile and the board cannot disagree.
 */
export async function memberLuckInGuild(guildId: string, userId: string, month: string): Promise<MemberLuck | null> {
	const tally = sumLuckByPlayer(await luckStatStore.findForMember(guildId, userId, month)).get(userId);
	if (!tally || (tally.decided === 0 && !tally.readings)) return null;
	return { ...tally, score: luckScore(tally) };
}

// ── the network scope (2026-10 item 244 Phase 5b) ──

/**
 * The network's best rated players of one game: consenting players only, wherever they
 * play, at most `limit` of them. Reads the game's ratings a page at a time, best first,
 * and keeps the consenting ones, so a page full of players who never consented costs
 * one more read rather than the whole collection.
 */
export async function topRatedOnNetwork(query: { game: RatedGame; limit: number; resolveNames: NameResolver }): Promise<RatedPlayer[]> {
	const kept: RatedPlayer[] = [];
	const page = BOT_CONSTANTS.NETWORK.NETWORK_BOARD_PAGE;
	for (let skip = 0; kept.length < query.limit; skip += page) {
		const rows = await playerRatingStore.findTopInGame(query.game, page, skip);
		if (rows.length === 0) break;
		const consenting = await consentingAmong(rows.map((row) => row.userId));
		const ranked = rankRatings(rows.filter((row) => consenting.has(row.userId)));
		kept.push(...(await keepCurrentMembers(ranked, query.limit - kept.length, query.resolveNames)));
		if (rows.length < page) break;
	}
	return kept;
}

/** The network's luck board for one UTC month: consenting players only, each player's luck games in every server added up. */
export async function luckBoardOnNetwork(query: { month: string; limit: number; resolveNames: NameResolver }): Promise<LuckyPlayer[]> {
	const rows = await luckStatStore.findForMonth(query.month);
	const consenting = await consentingAmong([...new Set(rows.map((row) => row.userId))]);
	const ranked = rankLuck(sumLuckByPlayer(rows.filter((row) => consenting.has(row.userId))));
	return keepCurrentMembers(ranked, query.limit, query.resolveNames);
}

/** One server's most frequent winning Hold'em hands for one UTC month, phrased with the pack's words. */
export async function topWinningHands(query: { guildId: string; month: string; limit: number; words: IPluginCopy["holdemHands"] }): Promise<WinningHand[]> {
	const rows = await gameResultCountStore.findForGuildMonth(query.guildId, HOLDEM_GAME, query.month);
	return rankWinningHands(rows, query.words, query.limit);
}

// ── pure ranking, exported for the tests ──

/** Highest rating first; more rated games breaks a tie (more evidence), then the id, so a board never reshuffles between reads. */
export function rankRatings(rows: readonly IPlayerRating[]): Array<RatingSnapshot & { userId: string }> {
	return [...rows]
		.sort((a, b) => b.displayRating - a.displayRating || b.ratedGames - a.ratedGames || a.userId.localeCompare(b.userId))
		.map((row) => ({ userId: row.userId, ...snapshotOf(row) }));
}

/**
 * One tally per player, adding up their coin flip, dice and rock paper scissors rows for
 * the month, with their magic 8 ball row kept apart as readings and points (2026-10 item
 * 250 Phase 5), so a reading never counts as a decided game.
 */
export function sumLuckByPlayer(rows: readonly ILuckStat[]): Map<string, LuckTally> {
	const tallies = new Map<string, LuckTally>();
	for (const row of rows) {
		const tally = tallies.get(row.userId) ?? { decided: 0, wins: 0 };
		tallies.set(row.userId, row.game === FORTUNE_LUCK_GAME ? addReadings(tally, row) : { ...tally, decided: tally.decided + row.decided, wins: tally.wins + row.wins });
	}
	return tallies;
}

function addReadings(tally: LuckTally, row: ILuckStat): LuckTally {
	return { ...tally, readings: (tally.readings ?? 0) + row.decided, fortunePoints: (tally.fortunePoints ?? 0) + (row.points ?? 0) };
}

/**
 * The players past the luck minimum, by wins above an even split, luckiest first.
 * The three games add up into one score because each is a fair two player game,
 * so half of every decided game is the expected share in all of them alike.
 */
export function rankLuck(tallies: ReadonlyMap<string, LuckTally>): Array<LuckTally & { userId: string; score: number }> {
	const scored: Array<LuckTally & { userId: string; score: number }> = [];
	for (const [userId, tally] of tallies) {
		const score = luckScore(tally);
		if (score !== null) scored.push({ userId, ...tally, score });
	}
	return scored.sort((a, b) => b.score - a.score || b.decided - a.decided || a.userId.localeCompare(b.userId));
}

/**
 * The top `limit` hands in members' words. A label the pack cannot phrase is
 * skipped rather than printed, because a raw key ("pair:A") is not something a
 * member should ever read (2026-10 item 244 Phase 3a handoff).
 */
export function rankWinningHands(rows: readonly IGameResultCount[], words: IPluginCopy["holdemHands"], limit: number): WinningHand[] {
	const phrased: Array<WinningHand & { label: string }> = [];
	for (const row of rows) {
		const phrase = phraseHoldemHandLabel(row.label, words);
		if (phrase) phrased.push({ phrase, count: row.count, label: row.label });
	}
	return phrased
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
		.slice(0, limit)
		.map(({ phrase, count }) => ({ phrase, count }));
}

/** A display rating with the pack's provisional mark when it is still settling ("1120?"). */
export function formatRating(rating: Pick<RatingSnapshot, "displayRating" | "provisional">, provisionalMark: string): string {
	return rating.provisional ? `${rating.displayRating}${provisionalMark}` : String(rating.displayRating);
}

/** A luck score signed and to one decimal at most ("+6.5", "+4", "0", "-2"), so lucky and unlucky read apart at a glance. */
export function formatLuckScore(score: number): string {
	const rounded = Number(score.toFixed(SCORE_DECIMALS));
	return rounded > 0 ? `+${rounded}` : String(rounded);
}

/**
 * The first `limit` rows whose player the resolver can name, in rank order. Names
 * are asked for one board's length at a time, so the usual case (everyone near the
 * top is still here) costs one lookup, and a departed player only costs the next slice.
 */
async function keepCurrentMembers<Row extends { userId: string }>(
	ranked: readonly Row[],
	limit: number,
	resolveNames: NameResolver
): Promise<Array<Row & { displayName: string }>> {
	const kept: Array<Row & { displayName: string }> = [];
	if (limit < 1) return kept;
	for (let start = 0; start < ranked.length && kept.length < limit; start += limit) {
		const slice = ranked.slice(start, start + limit);
		const names = await resolveNames(slice.map((row) => row.userId));
		for (const row of slice) {
			const displayName = names.get(row.userId);
			if (displayName === undefined) continue;
			kept.push({ ...row, displayName });
			if (kept.length === limit) break;
		}
	}
	return kept;
}
