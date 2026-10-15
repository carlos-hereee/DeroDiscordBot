// src/db/stores/deroVoiceSpendStore.ts
import { DeroVoiceSpend, type IDeroVoiceSpend } from "@db/models/DeroVoiceSpend.js";

// ── Dero voice spend store ──
// Every DB touch for DeroVoiceSpend. Thin on purpose: the spend meter decides
// the month key, the cap in cents and what a refund means. The store's one job
// is to make the cap check and the increment a SINGLE atomic operation, so two
// Listen clicks racing at the cap can never both pass.

export interface ISpendUsage {
	cents: number;
	ttsChars: number;
}

export const deroVoiceSpendStore = {
	async findMonth(guildId: string, month: string): Promise<IDeroVoiceSpend | null> {
		return DeroVoiceSpend.findOne({ guildId, month }).lean<IDeroVoiceSpend>();
	},

	// Create the month's row at zero if it does not exist yet. $setOnInsert means
	// an existing row is untouched, so calling this before every reserve is safe.
	async ensureMonth(guildId: string, month: string): Promise<void> {
		await DeroVoiceSpend.updateOne({ guildId, month }, { $setOnInsert: { guildId, month } }, { upsert: true });
	},

	// The atomic reserve. The filter only matches while the month's estimate plus
	// this amount still fits under the cap, so the increment and the check are one
	// operation. Returns null when the cap would be exceeded (or the row is
	// missing, which ensureMonth rules out first).
	async reserve(guildId: string, month: string, capCents: number, usage: ISpendUsage): Promise<IDeroVoiceSpend | null> {
		return DeroVoiceSpend.findOneAndUpdate(
			{ guildId, month, estimatedCents: { $lte: capCents - usage.cents } },
			{ $inc: { estimatedCents: usage.cents, ttsChars: usage.ttsChars } },
			{ new: true }
		).lean<IDeroVoiceSpend>();
	},

	// Undo a reservation whose provider call failed: the same $inc, negated, on
	// the month the reservation was taken in.
	async refund(guildId: string, month: string, usage: ISpendUsage): Promise<void> {
		await DeroVoiceSpend.updateOne({ guildId, month }, { $inc: { estimatedCents: -usage.cents, ttsChars: -usage.ttsChars } });
	},
};
