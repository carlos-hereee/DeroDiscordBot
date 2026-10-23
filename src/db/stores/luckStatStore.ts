// src/db/stores/luckStatStore.ts
import { LuckStat, type ILuckStat } from "@db/models/LuckStat.js";

// ── Luck stat store ──
// Every DB touch for LuckStat. Thin on purpose: features/ratings/luckStats.ts
// decides the month key, that a tie records nothing, and who won, and
// features/ratings/ratingBoards.ts adds a player's games up and ranks them. The
// store's jobs are the atomic upsert and $inc for one player's month row, and
// reading one guild's month.

export interface ILuckStatKey {
	guildId: string;
	userId: string;
	game: string;
	month: string;
}

export interface ILuckIncrements {
	decided: number;
	wins: number;
}

export const luckStatStore = {
	async increment(key: ILuckStatKey, increments: ILuckIncrements): Promise<void> {
		await LuckStat.updateOne(key, { $inc: { decided: increments.decided, wins: increments.wins } }, { upsert: true });
	},

	/** Every player's rows in one guild for one UTC month, one row per player per luck game. */
	async findForGuildMonth(guildId: string, month: string): Promise<ILuckStat[]> {
		return LuckStat.find({ guildId, month }).lean<ILuckStat[]>();
	},
};
