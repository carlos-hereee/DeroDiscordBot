// src/db/stores/gameResultCountStore.ts
import { GameResultCount } from "@db/models/GameResultCount.js";

// ── Game result count store ──
// Every DB touch for GameResultCount. Thin on purpose: features/ratings/
// gameResultCounts.ts decides the month key and the label. The store's one job is
// the atomic upsert and $inc for one label's month row.

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
};
