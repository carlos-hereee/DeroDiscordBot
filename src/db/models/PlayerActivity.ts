// db/models/PlayerActivity.ts
import mongoose from "mongoose";
import { v4 } from "uuid";

const Schema = mongoose.Schema;

const playerActivitySchema = new Schema(
	{
		activityId: { type: String, required: true, unique: true, default: v4 },
		eventId: { type: String, required: true, ref: "Event" },
		eventOccurrence: { type: Date, required: true }, // which specific occurrence
		userId: { type: String, required: true }, // Discord user ID
		username: { type: String, required: true },

		// reminder acknowledgement
		acknowledgedReminder: { type: Boolean, default: false },
		acknowledgedAt: { type: Date, default: null },

		// presence at event start
		wasOnlineAtStart: { type: Boolean, default: false },

		// voice activity during event window
		joinedVoiceDuring: { type: Boolean, default: false },
		voiceMinutes: { type: Number, default: 0 },

		// computed, recalculated whenever any field above changes
		participationScore: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

// compound index, one record per player per event occurrence
playerActivitySchema.index({ eventId: 1, eventOccurrence: 1, userId: 1 }, { unique: true });

// ── retention NOTE (deliberately no TTL) ──────────────────────────────
// Unlike ReminderLog, PlayerActivity is NOT throwaway dedup state, it is the
// historical record the /leaderboard command and the dashboard read back
// (all-time, month, week views). A blind TTL here would silently delete a
// guild's leaderboard history, which is destructive and not ours to decide.
// The collection does grow unbounded (one row per player per event
// occurrence), so a retention policy IS eventually needed, but it has to be an
// owner decision: pick a window (e.g. keep 12 months, or roll older rows into
// a per-player aggregate) and add a guarded cleanup job. Tracked as audit item
// H7. Until then this stays append-only on purpose. The { eventId,
// eventOccurrence } prefix of the index above is what a future pruner would
// range-scan on, so no extra index is needed to support cleanup later.

const PlayerActivityModel = mongoose.model("PlayerActivity", playerActivitySchema);
export default PlayerActivityModel;
