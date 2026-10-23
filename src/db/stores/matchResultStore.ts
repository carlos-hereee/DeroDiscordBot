// src/db/stores/matchResultStore.ts
import { MatchResult, type IMatchResult } from "@db/models/MatchResult.js";

// ── Match result store ──
// Every DB touch for MatchResult. Thin on purpose: features/ratings builds the row.
// The store's one decision is reporting a duplicate roomId as "already recorded"
// rather than as a failure, because the unique roomId index IS the rating claim
// (see the model) and a second recording of one match is expected, not an error.

// Mongo's duplicate key error code.
const DUPLICATE_KEY_CODE = 11000;

export const matchResultStore = {
	/** Insert the match's result. False when this room's result was already recorded. */
	async insertOnce(result: IMatchResult): Promise<boolean> {
		try {
			await MatchResult.create(result);
			return true;
		}
		catch (error) {
			if ((error as { code?: number })?.code === DUPLICATE_KEY_CODE) return false;
			throw error;
		}
	},
};
