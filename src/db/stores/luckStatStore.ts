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

	/**
	 * Every row of one UTC month in every guild, for the network luck board (2026-10 item
	 * 244 Phase 5b). No index leads with month (the unique one leads with guildId), so
	 * each /rating luck scope:network scans the whole collection. That is small at
	 * today's scale, one row per player per luck game per guild per month; a { month }
	 * index is the fix once it is not, and adding one moves LuckStat.test.ts's index pin.
	 */
	async findForMonth(month: string): Promise<ILuckStat[]> {
		return LuckStat.find({ month }).lean<ILuckStat[]>();
	},

	/** Every player's rows in one guild for one UTC month, one row per player per luck game. */
	async findForGuildMonth(guildId: string, month: string): Promise<ILuckStat[]> {
		return LuckStat.find({ guildId, month }).lean<ILuckStat[]>();
	},

	// Self destruct's server data delete (post-launch plan item 10): every row this guild owns.
	async deleteGuild(guildId: string) {
		return LuckStat.deleteMany({ guildId });
	},
};
