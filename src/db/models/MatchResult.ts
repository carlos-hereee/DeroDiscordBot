// src/db/models/MatchResult.ts
import mongoose from "mongoose";

// ── MatchResult ──
// One row per finished Hold'em, Battleship or Monopoly match: who finished where,
// who was excluded, and each rated player's display rating before and after.
// Written only by features/ratings/recordMatchRatings.ts through matchResultStore;
// it is the source the Phase 3b server boards and monthly post read ("players who
// played rated games in this server").
//
// An unrated match is still recorded (a Hold'em session under 10 hands, or one with
// fewer than two rated players), with `rated: false` and no display numbers, so the
// record of play survives even when the rating did not move.

export interface IMatchResultEntry {
	userId: string;
	// 1 is the winner. Null for an excluded player, who has no place in the order.
	rank: number | null;
	// A kicked player: written here, left out of the rating update.
	excluded: boolean;
	// Null when this entry's rating did not move (an unrated match, an excluded player).
	displayBefore: number | null;
	displayAfter: number | null;
}

export interface IMatchResult {
	roomId: string;
	guildId: string;
	game: string;
	finishedAt: Date;
	rated: boolean;
	entries: IMatchResultEntry[];
}

// _id disabled for the same reason GameRoom's moves disable it: entries are a record
// inside the row, never looked up on their own.
const matchResultEntrySchema = new mongoose.Schema<IMatchResultEntry>(
	{
		userId: { type: String, required: true },
		rank: { type: Number, default: null },
		excluded: { type: Boolean, default: false },
		displayBefore: { type: Number, default: null },
		displayAfter: { type: Number, default: null },
	},
	{ _id: false }
);

const matchResultSchema = new mongoose.Schema<IMatchResult>(
	{
		// ⚠️ UNIQUE, AND IT IS THE RATING CLAIM. A room's uuid names exactly one match, and
		// recordMatchRatings inserts this row BEFORE it touches any rating, so a second
		// recording of the same match (a retry, a racing finish path) fails on the
		// duplicate key and moves nobody's rating twice. Declared at the field so Mongoose
		// does not log a duplicate index warning, exactly as GameRoom declares roomId.
		roomId: { type: String, required: true, unique: true },
		guildId: { type: String, required: true },
		game: { type: String, required: true },
		finishedAt: { type: Date, required: true },
		rated: { type: Boolean, required: true },
		entries: { type: [matchResultEntrySchema], default: [] },
	},
	{ timestamps: true }
);

// Serves every per server read: one game's results in one guild, newest first.
matchResultSchema.index({ guildId: 1, game: 1, finishedAt: -1 });

export const MatchResult = mongoose.model<IMatchResult>("MatchResult", matchResultSchema);
