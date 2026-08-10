// src/db/models/BotLog.ts
import mongoose from "mongoose";

const botLogSchema = new mongoose.Schema({
	guildId: { type: String, required: true, index: true },
	event: { type: String, required: true }, // e.g. "intro_dm_sent", "season_end_announced"
	metadata: { type: mongoose.Schema.Types.Mixed, default: {} }, // anything extra you want to store
	createdAt: { type: Date, default: Date.now },
});

// compound index, fast lookup for "did this event happen for this guild"
botLogSchema.index({ guildId: 1, event: 1 });

export const BotLog = mongoose.model("BotLog", botLogSchema);
