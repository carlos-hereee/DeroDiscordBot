// src/db/stores/tagNoticeStore.ts
import { TagNotice } from "@db/models/TagNotice.js";

// ── Tag notice store ──
// Every DB touch for TagNotice, the 30 day throttle of a member with no network
// consent (see the model). One method: claim the notice atomically.

// Mongo's duplicate key error code.
const DUPLICATE_KEY_CODE = 11000;

export const tagNoticeStore = {
	/**
	 * Claim the tag notice for a member with no consent row: stamp `now` when their last
	 * notice is older than `cutoff` or they never had one. True when this call won.
	 *
	 * ⚠️ A CONDITIONAL UPSERT, and the duplicate key is the "no" answer. When the member's
	 * row is inside the window the filter matches nothing, so the upsert tries to insert a
	 * second row for the same userId and the unique index refuses it. That refusal is the
	 * throttle working, not a failure, so it answers false instead of throwing.
	 */
	async claim(userId: string, cutoff: Date, now: Date): Promise<boolean> {
		try {
			await TagNotice.updateOne({ userId, lastNoticeAt: { $lte: cutoff } }, { $set: { lastNoticeAt: now } }, { upsert: true });
			return true;
		}
		catch (error) {
			if ((error as { code?: number })?.code === DUPLICATE_KEY_CODE) return false;
			throw error;
		}
	},
};
