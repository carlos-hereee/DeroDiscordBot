// src/db/stores/fortuneBuffStore.ts
import { FortuneBuff } from "@db/models/FortuneBuff.js";

// ── per-user fortune luck store (FUTURE_PLANS item 88, v1) ──────────────────
// Owns every DB touch for the /fortune luck buff and the pity streak. Features
// never import the model directly (store layering); they call these functions.
export const fortuneBuffStore = {
	// The user's luck state for a reading: their buffed weight (undefined = the base
	// rate) and their current dry streak (0 if they have never rolled).
	async stateFor(userId: string): Promise<{ weight: number | undefined; dryStreak: number }> {
		const doc = await FortuneBuff.findOne({ userId }).lean();
		return { weight: doc?.weight, dryStreak: doc?.dryStreak ?? 0 };
	},

	// Record a reading's outcome so pity advances: reset the streak to 0 on a gold,
	// otherwise increment it. Upserts, so a code-less user gets a row on first roll.
	async recordRoll(userId: string, wasGold: boolean): Promise<void> {
		const update = wasGold ? { $set: { dryStreak: 0 } } : { $inc: { dryStreak: 1 } };
		await FortuneBuff.updateOne({ userId }, update, { upsert: true });
	},

	// Grant `weight` to `userId`, keeping the HIGHER of any existing buff and this
	// one. Returns the effective weight after the call and whether it actually rose,
	// so the command can tell a fresh blessing from "you already had one this strong".
	// $max makes two racing redeems safe: the higher weight always wins.
	async grantIfHigher(
		userId: string,
		weight: number,
		code: string
	): Promise<{ raised: boolean; weight: number }> {
		const existing = await FortuneBuff.findOne({ userId }).lean();
		const current = existing?.weight ?? 0;
		if (current >= weight) return { raised: false, weight: current };
		await FortuneBuff.updateOne({ userId }, { $max: { weight }, $set: { code } }, { upsert: true });
		return { raised: true, weight };
	},
};
