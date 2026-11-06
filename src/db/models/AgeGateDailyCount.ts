// src/db/models/AgeGateDailyCount.ts
import mongoose from "mongoose";

// ── AgeGateDailyCount ──
// One row per UTC day, GLOBAL: how many members confirmed or declined the age gate that
// day (2026-11 item 302). Written by ageConfirmationStore.accept/decline right after the
// member's own row changes. Read later by hand or by a future reporting surface; no cron
// job and no scheduled summary post are built against it here.

export interface IAgeGateDailyCount {
	date: string; // "YYYY-MM-DD", UTC
	confirmed: number;
	declined: number;
}

const ageGateDailyCountSchema = new mongoose.Schema<IAgeGateDailyCount>({
	date: { type: String, required: true },
	confirmed: { type: Number, default: 0 },
	declined: { type: Number, default: 0 },
});

// ⚠️ REQUIRED, not an optimization. One row per day is what makes the increment's
// findOneAndUpdate with upsert a single atomic write rather than a read then a write.
ageGateDailyCountSchema.index({ date: 1 }, { unique: true });

export const AgeGateDailyCount = mongoose.model<IAgeGateDailyCount>("AgeGateDailyCount", ageGateDailyCountSchema);
