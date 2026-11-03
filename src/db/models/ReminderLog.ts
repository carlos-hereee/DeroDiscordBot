// db/models/ReminderLog.ts
import mongoose from "mongoose";
import { v4 } from "uuid";

const Schema = mongoose.Schema;

const reminderLogSchema = new Schema(
	{
		logId: { type: String, required: true, unique: true, default: v4 },
		eventId: { type: String, required: true, ref: "Event" },
		eventOccurrence: { type: Date, required: true }, // which occurrence this reminder was for
		offsetMinutes: { type: Number, required: true }, // was this the 30min or 15min reminder
		messageId: { type: String, required: true }, // Discord message ID for reaction tracking
		channelId: { type: String, required: true },
		firedAt: { type: Date, required: true },
	},
	{ timestamps: true }
);

// compound index, prevents duplicate reminders firing for the same event+occurrence+offset
reminderLogSchema.index({ eventId: 1, eventOccurrence: 1, offsetMinutes: 1 }, { unique: true });

// ── TTL on firedAt ────────────────────────────────────────────────────
// ReminderLog is pure dedup state: a row exists only to stop the scheduler
// re-firing an occurrence it already fired. Once an occurrence is far enough
// in the past it can never re-fire, the scheduler skips anything outside the
// 60s REMINDER_FIRE_WINDOW_MS (diff < 0 → continue) regardless of whether a
// dedup row exists. So aging out old rows is safe and stops the collection
// growing without bound (one row per fire, per season-end, per test fire,
// forever). 90 days is comfortably longer than any KvK season, so a row is
// only reaped well after its occurrence is irrelevant. Mongo's TTL monitor
// runs about once a minute; exact timing does not matter here because the
// fire-window guard, not row presence, is what prevents a stale re-fire.
const REMINDER_LOG_TTL_SECONDS = 90 * 24 * 60 * 60;
reminderLogSchema.index({ firedAt: 1 }, { expireAfterSeconds: REMINDER_LOG_TTL_SECONDS });

const ReminderLogModel = mongoose.model("ReminderLog", reminderLogSchema);
export default ReminderLogModel;
