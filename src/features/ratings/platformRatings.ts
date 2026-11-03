import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IPlayerRating } from "@db/models/PlayerRating.js";
import { networkConsentStore } from "@db/stores/networkConsentStore.js";
import { playerRatingStore } from "@db/stores/playerRatingStore.js";
import { RATED_GAMES, type RatedGame } from "./ratingEngine.js";
import { serverBoardsByGame, type ServerRatingRow } from "./serverRatings.js";

// ── platformRatings ──────────────────────────────────────────────────
// What:  the arcade ratings block of the platform report Dero's Castle reads (2026-10 item
//        244 Phase 5c): for each rated game, how many consenting players hold a rating and
//        how those ratings spread in 100 point buckets, plus each game's server board.
// Who:   GET /api/platform/render-analytics (platformAnalytics.routes.ts), whose one caller
//        is nexious-server's botApiClient behind the owner gated /throne/render-analytics.
// Does NOT: name a player, or carry a user id or a guild id. A server is named only when it
//        stands on a server board, which already takes its admin's network reach and five
//        consenting tag wearers (the plan's rule: no guild names unless the guild is on the
//        server board). Ratings keep no history, so the block is the ratings as they stand
//        now, whatever period the route was asked for.
//
// ⚠️ CONSENTING PLAYERS ONLY. A rating is network wide and the Castle sits outside every
// server, so a player who never accepted the network notice is not counted, the network
// scope board's rule (risk R9). These are aggregate counts, but it is one rule, applied
// the same way everywhere a rating leaves its server.

const RATINGS = BOT_CONSTANTS.RATINGS;

/** How many display ratings fall in one bucket; `bucket` is the bucket's lowest rating. */
export interface RatingBucket {
	bucket: number;
	count: number;
}

/** One rated game: how many consenting players hold a rating in it, and how those ratings spread. */
export interface GameRatingSpread {
	game: RatedGame;
	players: number;
	distribution: RatingBucket[];
}

/** One server on one game's server board, as the Castle shows it. */
export interface PlatformServerRating {
	guildName: string;
	tag: string | null;
	game: RatedGame;
	rating: number;
}

/** The ratings block of the platform report. */
export interface PlatformRatingsReport {
	games: GameRatingSpread[];
	servers: PlatformServerRating[];
}

// ── the pure core ─────────────────────────────────────────────────────
/**
 * Bucket display ratings by `bucketSize`, lowest bucket first. Every bucket between the
 * lowest and the highest is present, an empty one as 0, so a chart of the spread shows a
 * gap as a gap instead of closing it up. No ratings, no buckets.
 */
export function ratingDistribution(displayRatings: readonly number[], bucketSize: number = RATINGS.DISTRIBUTION_BUCKET): RatingBucket[] {
	if (displayRatings.length === 0) return [];
	const counts = new Map<number, number>();
	for (const rating of displayRatings) {
		const bucket = Math.floor(rating / bucketSize) * bucketSize;
		counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
	}
	const lowest = Math.min(...counts.keys());
	const highest = Math.max(...counts.keys());
	const buckets: RatingBucket[] = [];
	for (let bucket = lowest; bucket <= highest; bucket += bucketSize) buckets.push({ bucket, count: counts.get(bucket) ?? 0 });
	return buckets;
}

/** Every rated game's spread, in RATED_GAMES order; a game nobody holds a rating in reads 0 players and no buckets. */
export function gameSpreads(ratings: readonly Pick<IPlayerRating, "game" | "displayRating">[]): GameRatingSpread[] {
	return RATED_GAMES.map((game) => {
		const inGame = ratings.filter((row) => row.game === game).map((row) => row.displayRating);
		return { game, players: inGame.length, distribution: ratingDistribution(inGame) };
	});
}

/** Every game's server board as the Castle shows it, game by game, each best first: a name, a worn tag and a rating. */
export function platformServerRows(boards: ReadonlyMap<RatedGame, readonly ServerRatingRow[]>): PlatformServerRating[] {
	const rows: PlatformServerRating[] = [];
	for (const game of RATED_GAMES) {
		for (const row of boards.get(game) ?? []) rows.push({ guildName: row.name, tag: row.tag, game, rating: row.rating });
	}
	return rows;
}

// ── reading the block ─────────────────────────────────────────────────
/** The ratings block, read now. Rejects when a read fails; the route goes through readPlatformRatings. */
export async function buildPlatformRatings(client: Client): Promise<PlatformRatingsReport> {
	const consenting = await networkConsentStore.allConsentingUserIds(BOT_CONSTANTS.NETWORK.CONSENT_VERSION);
	const [ratings, boards] = await Promise.all([playerRatingStore.findForPlayersInAllGames(consenting), serverBoardsByGame(client)]);
	return { games: gameSpreads(ratings), servers: platformServerRows(boards) };
}

/**
 * The ratings block for the platform route, or null when a read failed or the block took
 * longer than `timeoutMs`. Never rejects, because the render report it rides beside must
 * answer either way: a null here costs the Castle its ratings widget and nothing else.
 */
export async function readPlatformRatings(client: Client, timeoutMs: number = RATINGS.PLATFORM_REPORT_TIMEOUT_MS): Promise<PlatformRatingsReport | null> {
	const building = buildPlatformRatings(client).catch((error) => {
		console.error("[platform ratings] building the ratings block failed", error);
		return null;
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			console.warn(`[platform ratings] the ratings block took longer than ${timeoutMs} ms, so the report answers without it`);
			resolve(null);
		}, timeoutMs);
	});
	try {
		return await Promise.race([building, timedOut]);
	} finally {
		clearTimeout(timer);
	}
}
