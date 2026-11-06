// src/db/models/AgeConfirmation.ts
import mongoose from "mongoose";

// ── AgeConfirmation ──
// One row per Discord user, GLOBAL (never scoped to a guild), who answered Dero's age
// check (2026-11 item 302, ElevenLabs Startup Grant compliance: grants exclude projects
// used by minors). Written by the age gate's two buttons in features/age-gate/ageGateRules.ts
// through ageConfirmationStore; read before any game or Dero voice feature runs for a
// member (features/game-rooms/joinGate.ts, challengeBoard.offerChallengeDraft,
// games/arcadeHost.openSoloRoomForMember, and the Dero voice join path as a safety net).
//
// ⚠️ NO ROW, OR A ROW BELOW BOT_CONSTANTS.AGE_GATE.CONFIRMATION_VERSION, IS NO
// CONFIRMATION. A "declined" row is NEVER current, AT ANY VERSION: a later version bump
// must never resurrect a decliner's ability to be asked again. A member with no row, or a
// stale confirmed row, simply meets the gate again on their next attempt.

export interface IAgeConfirmation {
	discordUserId: string;
	status: "confirmed" | "declined";
	answeredAt: Date;
	termsVersion: number;
}

const ageConfirmationSchema = new mongoose.Schema<IAgeConfirmation>(
	{
		discordUserId: { type: String, required: true },
		status: { type: String, enum: ["confirmed", "declined"], required: true },
		answeredAt: { type: Date, required: true },
		termsVersion: { type: Number, required: true },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization. Answering is an upsert, and this constraint is what
// keeps a member who presses a button twice in one tick on ONE row.
ageConfirmationSchema.index({ discordUserId: 1 }, { unique: true });

export const AgeConfirmation = mongoose.model<IAgeConfirmation>("AgeConfirmation", ageConfirmationSchema);
