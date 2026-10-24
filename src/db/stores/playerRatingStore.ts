// src/db/stores/playerRatingStore.ts
import { PlayerRating, type IPlayerRating } from "@db/models/PlayerRating.js";

// ── Player rating store ──
// Every DB touch for PlayerRating. Thin on purpose: features/ratings decides the
// finishing order, the OpenSkill update and the display number. The store reads the
// players of one match (or of one server's board) in one query, reads one player's
// every game for /rating me, and writes one player's new rating as a single upsert,
// so a first rated game creates the row and every later one moves it.

export interface IRatingWrite {
	mu: number;
	sigma: number;
	displayRating: number;
	ratedAt: Date;
}

export const playerRatingStore = {
	/** The stored ratings of these players in one game; a player with no row yet is simply absent. */
	async findForPlayers(userIds: readonly string[], game: string): Promise<IPlayerRating[]> {
		if (userIds.length === 0) return [];
		return PlayerRating.find({ userId: { $in: [...userIds] }, game }).lean<IPlayerRating[]>();
	},

	/** Every game one player holds a rating in; a game they never had a rated result in is absent. */
	async findAllForPlayer(userId: string): Promise<IPlayerRating[]> {
		return PlayerRating.find({ userId }).lean<IPlayerRating[]>();
	},

	// ── the network (2026-10 item 244 Phase 5b) ──
	/** One page of a game's ratings, best first, for the network board to look through for consenting players. */
	async findTopInGame(game: string, limit: number, skip: number): Promise<IPlayerRating[]> {
		return PlayerRating.find({ game }).sort({ displayRating: -1, userId: 1 }).skip(skip).limit(limit).lean<IPlayerRating[]>();
	},

	/** These players' ratings in every rated game, in one query, for the server ratings. */
	async findForPlayersInAllGames(userIds: readonly string[]): Promise<IPlayerRating[]> {
		if (userIds.length === 0) return [];
		return PlayerRating.find({ userId: { $in: [...userIds] } }).lean<IPlayerRating[]>();
	},

	/** Delete every rating one player holds, for /rating network leave. Answers how many games' ratings went. */
	async deleteAllForPlayer(userId: string): Promise<number> {
		const result = await PlayerRating.deleteMany({ userId });
		return result.deletedCount;
	},

	// One rated game for one player: the new estimate is SET (it was computed from the
	// row the caller read) and the game count is INCREMENTED, so the count can never
	// be written back stale.
	async applyRating(userId: string, game: string, write: IRatingWrite): Promise<void> {
		await PlayerRating.updateOne(
			{ userId, game },
			{
				$set: { mu: write.mu, sigma: write.sigma, displayRating: write.displayRating, lastRatedAt: write.ratedAt },
				$inc: { ratedGames: 1 },
			},
			{ upsert: true }
		);
	},
};
