// src/db/stores/fortuneCooldownStore.ts
import { FortuneCooldown } from "@db/models/FortuneCooldown.js";

// ── Fortune cooldown store ──
// Every DB touch for FortuneCooldown, the persisted fortune cooldown (see the
// model). Thin: what the window is and what a refusal says live in
// features/fortune/fortuneCooldown.ts.

// Mongo's duplicate key error code.
const DUPLICATE_KEY_CODE = 11000;

/** A claim that won, with the reading time it replaced (null when the member had none), or one that lost. */
export type FortuneCooldownClaim = { claimed: true; previousAt: Date | null } | { claimed: false };

export const fortuneCooldownStore = {
	/**
	 * Stamp `now` as the member's last reading when their last one is at or before
	 * `cutoff`, or they never had one. Answers whether this call won, and what it replaced.
	 *
	 * ⚠️ A CONDITIONAL UPSERT, and the duplicate key is the "no" answer. When the member's
	 * last reading is inside the window the filter matches nothing, so the upsert tries
	 * to insert a second row for the same server and member and the unique index refuses
	 * it. That refusal is the cooldown working, not a failure, so it answers claimed false.
	 */
	async claim(guildId: string, userId: string, cutoff: Date, now: Date): Promise<FortuneCooldownClaim> {
		try {
			const previous = await FortuneCooldown.findOneAndUpdate(
				{ guildId, userId, lastReadingAt: { $lte: cutoff } },
				{ $set: { lastReadingAt: now } },
				{ upsert: true, new: false }
			).lean();
			return { claimed: true, previousAt: previous?.lastReadingAt ?? null };
		}
		catch (error) {
			if ((error as { code?: number })?.code === DUPLICATE_KEY_CODE) return { claimed: false };
			throw error;
		}
	},

	/** The member's last reading in this server, or null. */
	async lastReadingAt(guildId: string, userId: string): Promise<Date | null> {
		const row = await FortuneCooldown.findOne({ guildId, userId }).lean();
		return row?.lastReadingAt ?? null;
	},

	/**
	 * Undo a claim whose reading never reached the member: put back `previousAt`, or
	 * drop the row when there was none. Conditional on the row still holding the
	 * claim's own `claimedAt`, so it can never undo a later claim.
	 */
	async restore(guildId: string, userId: string, claimedAt: Date, previousAt: Date | null): Promise<void> {
		const filter = { guildId, userId, lastReadingAt: claimedAt };
		if (previousAt === null) await FortuneCooldown.deleteOne(filter);
		else await FortuneCooldown.updateOne(filter, { $set: { lastReadingAt: previousAt } });
	},
};
