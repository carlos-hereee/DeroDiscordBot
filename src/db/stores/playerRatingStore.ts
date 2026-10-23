// src/db/stores/playerRatingStore.ts
import { PlayerRating, type IPlayerRating } from "@db/models/PlayerRating.js";

// ── Player rating store ──
// Every DB touch for PlayerRating. Thin on purpose: features/ratings decides the
// finishing order, the OpenSkill update and the display number. The store reads the
// players of one match in one query and writes one player's new rating as a single
// upsert, so a first rated game creates the row and every later one moves it.

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
