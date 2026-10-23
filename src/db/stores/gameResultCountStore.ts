// src/db/stores/gameResultCountStore.ts
import { GameResultCount, type IGameResultCount } from "@db/models/GameResultCount.js";

// ── Game result count store ──
// Every DB touch for GameResultCount. Thin on purpose: features/ratings/
// gameResultCounts.ts decides the month key and the label, and
// features/ratings/ratingBoards.ts phrases and ranks what it reads. The store's
// jobs are the atomic upsert and $inc for one label's month row, and reading one
// game's month in one guild.

export interface IGameResultCountKey {
	guildId: string;
	game: string;
	month: string;
	label: string;
}

export const gameResultCountStore = {
	async increment(key: IGameResultCountKey): Promise<void> {
		await GameResultCount.updateOne(key, { $inc: { count: 1 } }, { upsert: true });
	},

	/** Every label counted for one game in one guild in one UTC month, most frequent first. */
	async findForGuildMonth(guildId: string, game: string, month: string): Promise<IGameResultCount[]> {
		return GameResultCount.find({ guildId, game, month }).sort({ count: -1 }).lean<IGameResultCount[]>();
	},
};
