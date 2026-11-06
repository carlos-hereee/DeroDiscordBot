// src/db/stores/ageConfirmationStore.ts
import { AgeConfirmation, type IAgeConfirmation } from "@db/models/AgeConfirmation.js";
import { ageGateDailyCountStore } from "./ageGateDailyCountStore.js";

// ── Age confirmation store ──────────────────────────────────────────────
// Every DB touch for AgeConfirmation. Thin on purpose: features/age-gate/ageGateRules.ts
// decides what counts as a current confirmation (the version). accept/decline also claim
// the daily counter in the same call, since that is the write closest to the status change.

const DUPLICATE_KEY_CODE = 11000;

export const ageConfirmationStore = {
	/** One member's row, or null when they have never answered the age gate. */
	async findByUserId(discordUserId: string): Promise<IAgeConfirmation | null> {
		return AgeConfirmation.findOne({ discordUserId }).lean<IAgeConfirmation | null>();
	},

	// ⚠️ A DECLINE IS LOCKED, enforced in this one conditional write rather than a read then a
	// write, so a second prompt left open cannot flip it. A declined row misses the filter, the
	// upsert then tries to insert, and the unique index refuses it: 11000 is the "refused" answer.
	// Answering twice otherwise stays harmless. Returns whether the confirmation was saved.
	async accept(discordUserId: string, termsVersion: number, answeredAt: Date): Promise<boolean> {
		try {
			await AgeConfirmation.updateOne({ discordUserId, status: { $ne: "declined" } }, { $set: { status: "confirmed", termsVersion, answeredAt } }, { upsert: true });
		} catch (error) {
			if ((error as { code?: number }).code === DUPLICATE_KEY_CODE) return false;
			throw error;
		}
		await ageGateDailyCountStore.increment("confirmed", answeredAt);
		return true;
	},

	async decline(discordUserId: string, termsVersion: number, answeredAt: Date): Promise<void> {
		await AgeConfirmation.updateOne({ discordUserId }, { $set: { status: "declined", termsVersion, answeredAt } }, { upsert: true });
		await ageGateDailyCountStore.increment("declined", answeredAt);
	},
};
