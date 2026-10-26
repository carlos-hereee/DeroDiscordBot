// src/db/models/FortuneCooldown.ts
import mongoose from "mongoose";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── FortuneCooldown ──
// When a member last read their fortune in one server (2026-10 item 254): the
// persisted 22 hour cooldown, shared by the 🕹️games Fortune button and
// /mini-game fortune. Persisted rather than held in memory because a Railway
// deploy restarts the process, and an in memory cooldown would hand every member a
// fresh reading on every deploy. Written and read only by features/fortune
// through fortuneCooldownStore.
//
// It holds a server id, a user id and a date and nothing else.

export interface IFortuneCooldown {
	guildId: string;
	userId: string;
	lastReadingAt: Date;
}

// The row outlives the cooldown by an hour, so the TTL monitor (which runs about
// once a minute and may lag) can never drop a row while its cooldown still holds.
const TTL_SECONDS = (BOT_CONSTANTS.FORTUNE_COOLDOWN_HOURS + 1) * 60 * 60;

const fortuneCooldownSchema = new mongoose.Schema<IFortuneCooldown>({
	guildId: { type: String, required: true },
	userId: { type: String, required: true },
	lastReadingAt: { type: Date, required: true },
});

// ⚠️ REQUIRED. The cooldown claim is a conditional upsert, and this constraint is
// what makes two presses at once land on one row: the second claim collides with the
// first and reads nothing, instead of inserting a second row and a second reading.
fortuneCooldownSchema.index({ guildId: 1, userId: 1 }, { unique: true });
fortuneCooldownSchema.index({ lastReadingAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

export const FortuneCooldown = mongoose.model<IFortuneCooldown>("FortuneCooldown", fortuneCooldownSchema);
