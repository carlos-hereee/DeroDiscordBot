import { matchResultStore } from "@db/stores/matchResultStore.js";
import { playerRatingStore } from "@db/stores/playerRatingStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { IMatchResult, IMatchResultEntry } from "@db/models/MatchResult.js";
import { displayRating, isRatedGame, newRating, rateFinishingOrder, type SkillRating } from "./ratingEngine.js";

// ── recordMatchRatings ───────────────────────────────────────────────
// Records a finished Hold'em, Battleship or Monopoly match (2026-10 item 244): one
// MatchResult row, and one OpenSkill update for every rated player. Called fire and
// forget BESIDE each game's finish site, only by the call that won
// roomLifecycle.finish's claim, so a match is rated once however many paths raced
// to end it. It never decides who won; the finish site hands it the finishing order.
//
// What is NOT rated, by owner decision: a room finished as abandoned (the caller
// never calls this, and `abandoned` refuses it anyway), any game outside RATED_GAMES,
// an excluded (kicked) player, and a match the caller marks unrated (a Hold'em
// session under 10 dealt hands). An unrated match still writes its MatchResult.
//
// How a rated match is written: ① read the players' stored ratings in one query,
// ② compute every update in memory, ③ INSERT THE MATCH RESULT FIRST, because its
// unique roomId is the claim (a duplicate means the match was already recorded, so
// nothing moves twice), ④ then upsert each player's rating. A crash between ③ and ④
// leaves a result whose ratings never moved, which is the safe direction: the other
// order could move ratings for a match a retry would then rate again.
//
// ⚠️ NEVER THROWS INTO THE GAME, and never makes it wait: every failure is caught and
// logged here, and the finish sites call it with `void`.

// A rating needs somebody to beat: one remaining player is a record, not a match.
const MIN_RATED_PLAYERS = 2;

/** The slice of a room row this recorder reads. */
export type RatingRoom = Pick<IGameRoom, "roomId" | "guildId" | "game">;

export interface MatchRatingOptions {
	/** False records the match without moving any rating (a Hold'em session under 10 dealt hands). */
	rated?: boolean;
	/** True for an ending nobody chose. Such a room is never rated and nothing is written. */
	abandoned?: boolean;
	now?: Date;
}

/** One rated player's move: the ratings before and after, and the numbers members see. */
export interface PlayerRatingUpdate {
	userId: string;
	before: SkillRating;
	after: SkillRating;
	displayBefore: number;
	displayAfter: number;
}

/** A stored rating as the recorder reads it; a player with no row gets a fresh one. */
export interface StoredSkill extends SkillRating {
	userId: string;
}

// ⚠️ ONE RATING WRITE AT A TIME, process wide. A rating is read, recomputed and
// written back, so two matches finishing together with a player in common (a
// player can sit in several rooms they do not host) would each start from the same
// stored rating and the later write would erase the earlier match. The bot runs as
// one process, so chaining every write on one promise closes that window without a
// version field on the row.
let ratingWrites: Promise<void> = Promise.resolve();

// ── finishing orders ──────────────────────────────────────────────────
/** A two player match's finishing order: the winner, then the other player. */
export function twoPlayerFinishingOrder(playerIds: readonly string[], winnerId: string): string[] {
	return [winnerId, ...playerIds.filter((userId) => userId !== winnerId)];
}

/** The seat fields a Monopoly finishing order reads. */
export interface EliminatedSeat {
	userId: string;
	// The elimination ordinal monopolyForfeit stamps: 1 for the first seat out.
	bankruptedAt: number | null;
}

/**
 * A finished Monopoly match's finishing order: the winner, then the seats in REVERSE
 * elimination order, so the last seat out finished second. A seat forfeited for
 * inactivity carries a bankruptedAt like any bankruptcy (removeFromMatch stamps
 * both), which is the owner's rule that a forfeit counts as a bankruptcy. A seat with
 * no stamp that is not the winner cannot happen in a finished match, and is left out
 * rather than guessed at.
 */
export function monopolyFinishingOrder(match: { winnerId: string | null; seats: readonly EliminatedSeat[] }): string[] {
	const eliminated = match.seats
		.flatMap((seat) => (seat.bankruptedAt !== null && seat.userId !== match.winnerId ? [{ userId: seat.userId, at: seat.bankruptedAt }] : []))
		.sort((first, second) => second.at - first.at)
		.map((seat) => seat.userId);
	return match.winnerId ? [match.winnerId, ...eliminated] : eliminated;
}

// ── the pure core ─────────────────────────────────────────────────────
/** Each id once, first appearance kept, so a repeated id cannot be rated twice in one match. */
function distinct(userIds: readonly string[]): string[] {
	return [...new Set(userIds)];
}

/** The finishing order with every excluded player taken out. An excluded player has no place in it. */
export function ratedOrder(rankedUserIds: readonly string[], excludedUserIds: readonly string[]): string[] {
	const excluded = new Set(excludedUserIds);
	return distinct(rankedUserIds).filter((userId) => !excluded.has(userId));
}

/** Every player's rating update for a finishing order, from the ratings stored before the match. */
export function rateMatch(order: readonly string[], stored: readonly StoredSkill[]): PlayerRatingUpdate[] {
	const byUser = new Map(stored.map((row) => [row.userId, { mu: row.mu, sigma: row.sigma }]));
	const before = order.map((userId) => byUser.get(userId) ?? newRating());
	const after = rateFinishingOrder(before);

	return order.map((userId, index) => ({
		userId,
		before: before[index],
		after: after[index],
		displayBefore: displayRating(before[index]),
		displayAfter: displayRating(after[index]),
	}));
}

/**
 * The MatchResult row: every ranked player at their place (1 is the winner), then
 * every excluded player with no place. Display numbers ride only on a rated match.
 */
export function buildMatchResult(
	room: RatingRoom,
	order: readonly string[],
	excludedUserIds: readonly string[],
	updates: readonly PlayerRatingUpdate[] | null,
	finishedAt: Date
): IMatchResult {
	const byUser = new Map((updates ?? []).map((update) => [update.userId, update]));
	const ranked: IMatchResultEntry[] = order.map((userId, index) => ({
		userId,
		rank: index + 1,
		excluded: false,
		displayBefore: byUser.get(userId)?.displayBefore ?? null,
		displayAfter: byUser.get(userId)?.displayAfter ?? null,
	}));
	const excluded: IMatchResultEntry[] = distinct(excludedUserIds).map((userId) => ({
		userId,
		rank: null,
		excluded: true,
		displayBefore: null,
		displayAfter: null,
	}));

	return {
		roomId: room.roomId,
		guildId: room.guildId,
		game: room.game,
		finishedAt,
		rated: updates !== null,
		entries: [...ranked, ...excluded],
	};
}

// ── the writer ────────────────────────────────────────────────────────
async function writeMatchRatings(
	room: RatingRoom,
	rankedUserIds: readonly string[],
	excludedUserIds: readonly string[],
	options: MatchRatingOptions
): Promise<void> {
	const finishedAt = options.now ?? new Date();
	const order = ratedOrder(rankedUserIds, excludedUserIds);
	const rated = options.rated !== false && order.length >= MIN_RATED_PLAYERS;

	if (!rated) {
		await matchResultStore.insertOnce(buildMatchResult(room, order, excludedUserIds, null, finishedAt));
		return;
	}

	const stored = await playerRatingStore.findForPlayers(order, room.game);
	const updates = rateMatch(order, stored);
	const recorded = await matchResultStore.insertOnce(buildMatchResult(room, order, excludedUserIds, updates, finishedAt));
	if (!recorded) return;

	await Promise.all(
		updates.map((update) =>
			playerRatingStore.applyRating(update.userId, room.game, {
				mu: update.after.mu,
				sigma: update.after.sigma,
				displayRating: update.displayAfter,
				ratedAt: finishedAt,
			})
		)
	);
}

/**
 * Record a finished match: its MatchResult, and a rating update for every player in
 * `rankedUserIds` (best first) who is not in `excludedUserIds`. Resolves once the
 * write is done or has failed; it never rejects, so a finish site calls it with
 * `void` and moves on.
 */
export function recordMatchRatings(
	room: RatingRoom,
	rankedUserIds: readonly string[],
	excludedUserIds: readonly string[] = [],
	options: MatchRatingOptions = {}
): Promise<void> {
	if (options.abandoned || !isRatedGame(room.game)) return Promise.resolve();

	const write = ratingWrites.then(() => writeMatchRatings(room, rankedUserIds, excludedUserIds, options));
	// The chain swallows a failure so one bad write cannot stall every rating after it.
	ratingWrites = write.catch(() => undefined);
	return write.catch((error) => {
		console.error(`[ratings] recording the ${room.game} result for room ${room.roomId} in guild ${room.guildId} failed`, error);
	});
}
