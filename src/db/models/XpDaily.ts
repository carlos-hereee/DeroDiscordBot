// src/db/models/XpDaily.ts
import mongoose from "mongoose";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── XpDaily ──
// What:  one row per member per guild per Central calendar day, counting the XP the
//        daily capped sources (message, reaction, soloLuck) have claimed against
//        BOT_CONSTANTS.LEVELING.DAILY_XP_CAP that day. `day` is "YYYY-MM-DD",
//        produced by @features/leveling/dailyXpCap.ts.
// Who:   written and read by awardXp only, through xpDailyStore. Nothing renders it.
// When:  once per capped award, BEFORE the award is staged or written.
// Where: stored rather than held in memory so a Railway restart mid day cannot hand
//        every member a fresh 50. Disposable: MemberLevel.totalXp is the durable
//        truth, and a lost row only means a member could earn a full cap again that
//        day, which is why this collection carries a short TTL.
//
// ⚠️ `xp` IS WHAT CAPPED SOURCES ASKED FOR, NOT ONLY WHAT THEY GOT, so it can pass
// the cap. awardXp increments it by the full amount first and works out what was
// granted from the post increment value, which is what keeps two awards in the same
// tick from both reading 49 and both paying. A value at or above the cap simply
// means nothing more pays today.

export interface IXpDaily {
	guildId: string;
	userId: string;
	day: string;
	xp: number;
}

const xpDailySchema = new mongoose.Schema<IXpDaily>(
	{
		guildId: { type: String, required: true },
		userId: { type: String, required: true },
		// "2026-10-23", the Central calendar day. Zero padded, so keys sort lexically.
		day: { type: String, required: true },
		xp: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization: the claim upserts on this key, and the unique
// constraint is what turns two concurrent first awards of the day into a retryable
// duplicate key error rather than two rows splitting one member's allowance.
xpDailySchema.index({ guildId: 1, userId: 1, day: 1 }, { unique: true });

// Expiry runs on createdAt, which falls inside the row's own day, so a row outlives
// its day by the retention window and no more. Only today's row is ever read.
xpDailySchema.index({ createdAt: 1 }, { expireAfterSeconds: BOT_CONSTANTS.LEVELING.XP_DAILY_RETENTION_SECONDS });

export const XpDaily = mongoose.model<IXpDaily>("XpDaily", xpDailySchema);
