// src/db/models/DeroVoiceSpend.ts
import mongoose from "mongoose";

// ── DeroVoiceSpend ──
// What:  one row per guild per UTC month, metering speech spend: characters sent
//        to text to speech, seconds sent to speech to text (Phase 3), and the
//        running cost estimate in whole cents that the monthly cap is checked
//        against.
// Who:   written only by features/voice/spendMeter.ts through
//        deroVoiceSpendStore. Read by /dero-config status.
// When:  the row for a month is created on the first reservation of that month,
//        so a new month starts at zero with no reset job.
// Where: an ESTIMATE from pricing.ts, not the provider's invoice. It exists to
//        stop spend before the call, which the invoice cannot do.
//
// ⚠️ NO TEXT AND NO AUDIO EVER LAND HERE. Counts only. A column holding what was
// spoken would turn a cost meter into a transcript store.

export interface IDeroVoiceSpend {
	guildId: string;
	// "YYYY-MM" in UTC, zero padded so months sort lexically.
	month: string;
	ttsChars: number;
	sttSeconds: number;
	estimatedCents: number;
}

const deroVoiceSpendSchema = new mongoose.Schema<IDeroVoiceSpend>(
	{
		guildId: { type: String, required: true },
		month: { type: String, required: true },
		ttsChars: { type: Number, default: 0 },
		sttSeconds: { type: Number, default: 0 },
		estimatedCents: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization. The meter upserts the month row and then
// increments it conditionally; two first reservations of a month can race the
// upsert, and this constraint is what keeps them on ONE row rather than two rows
// each holding half the month's spend under the cap.
deroVoiceSpendSchema.index({ guildId: 1, month: 1 }, { unique: true });

export const DeroVoiceSpend = mongoose.model<IDeroVoiceSpend>("DeroVoiceSpend", deroVoiceSpendSchema);
