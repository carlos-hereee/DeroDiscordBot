// src/db/models/MemberTimezone.ts
import mongoose from "mongoose";

// ── MemberTimezone ──
// One member's own timezone in one server (2026-11 item 388, owner decisions D16 and D17),
// set from the member timezone modal (utils/timezoneModal.ts, target "member"). Every time a
// member types for a todo or a reminder is read in it first, then in the server's timezone.
// Per server, because a member of two servers may keep a different zone in each.

export interface IMemberTimezone {
	guildId: string;
	userId: string;
	// An IANA zone, checked with isValidTimezone before it is stored.
	timezone: string;
}

const memberTimezoneSchema = new mongoose.Schema<IMemberTimezone>(
	{
		guildId: { type: String, required: true },
		userId: { type: String, required: true },
		timezone: { type: String, required: true },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED: setting a zone is an upsert, and this keeps one row per member per server.
memberTimezoneSchema.index({ guildId: 1, userId: 1 }, { unique: true });

export const MemberTimezone = mongoose.model<IMemberTimezone>("MemberTimezone", memberTimezoneSchema);
