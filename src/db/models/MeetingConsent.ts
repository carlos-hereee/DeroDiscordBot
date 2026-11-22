// src/db/models/MeetingConsent.ts
import mongoose from "mongoose";

// ── MeetingConsent ──
// One row per member per server who answered the meeting consent notice with I agree
// (2026-11 item 388): that Dero may transcribe what they say in that server's Meeting Hall
// recordings. Written by the notice's buttons (Phase 3) through meetingConsentStore; read
// by the recorder before it captures anyone.
//
// ⚠️ NO ROW MEANS NO CONSENT, and so does a row with revokedAt set or a version below
// BOT_CONSTANTS.MEETINGS.CONSENT_VERSION (R7 of the plan's session notes). Stop recording me
// sets revokedAt rather than deleting the row; I agree again clears it. No thanks writes nothing.

export interface IMeetingConsent {
	guildId: string;
	userId: string;
	version: number;
	acceptedAt: Date;
	revokedAt: Date | null;
}

const meetingConsentSchema = new mongoose.Schema<IMeetingConsent>(
	{
		guildId: { type: String, required: true },
		userId: { type: String, required: true },
		version: { type: Number, required: true },
		acceptedAt: { type: Date, required: true },
		revokedAt: { type: Date, default: null },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization: I agree is an upsert, and this keeps a double press on
// one row, so one revoke always covers the member.
meetingConsentSchema.index({ guildId: 1, userId: 1 }, { unique: true });

export const MeetingConsent = mongoose.model<IMeetingConsent>("MeetingConsent", meetingConsentSchema);
