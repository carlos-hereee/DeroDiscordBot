// src/db/stores/ageConfirmationStore.ts
import { AgeConfirmation, type IAgeConfirmation } from "@db/models/AgeConfirmation.js";
import { ageGateDailyCountStore } from "./ageGateDailyCountStore.js";

// ── Age confirmation store ──────────────────────────────────────────────
// Every DB touch for AgeConfirmation. Thin on purpose: features/age-gate/ageGateRules.ts
// decides what counts as a current confirmation (the version). accept/decline also claim
// the daily counter in the same call, since that is the write closest to the status change.

export const ageConfirmationStore = {
	/** One member's row, or null when they have never answered the age gate. */
	async findByUserId(discordUserId: string): Promise<IAgeConfirmation | null> {
		return AgeConfirmation.findOne({ discordUserId }).lean<IAgeConfirmation | null>();
	},

	// Answering twice is harmless: the status, version and date just move to the latest press.
	async accept(discordUserId: string, termsVersion: number, answeredAt: Date): Promise<void> {
		await AgeConfirmation.updateOne({ discordUserId }, { $set: { status: "confirmed", termsVersion, answeredAt } }, { upsert: true });
		await ageGateDailyCountStore.increment("confirmed", answeredAt);
	},

	async decline(discordUserId: string, termsVersion: number, answeredAt: Date): Promise<void> {
		await AgeConfirmation.updateOne({ discordUserId }, { $set: { status: "declined", termsVersion, answeredAt } }, { upsert: true });
		await ageGateDailyCountStore.increment("declined", answeredAt);
	},
};
