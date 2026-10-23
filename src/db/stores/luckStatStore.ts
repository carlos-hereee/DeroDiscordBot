// src/db/stores/luckStatStore.ts
import { LuckStat } from "@db/models/LuckStat.js";

// ── Luck stat store ──
// Every DB touch for LuckStat. Thin on purpose: features/ratings/luckStats.ts
// decides the month key, that a tie records nothing, and who won. The store's one
// job is the atomic upsert and $inc for one player's month row.

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
};
