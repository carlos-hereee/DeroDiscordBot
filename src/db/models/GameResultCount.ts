// src/db/models/GameResultCount.ts
import mongoose from "mongoose";

// ── GameResultCount ──
// One row per guild, game, UTC month and result label: how many times that result
// happened. Hold'em is the first game to write it, one count per contested showdown
// for the winning hand. Written only by features/ratings/gameResultCounts.ts through
// gameResultCountStore; read by the Phase 3b monthly post ("top winning hands").
//
// The label is a stable key ("pair:A", "full house:K"), not member facing words, so
// a copy edit never splits one month's counts across two spellings; the copy pack
// phrases it on read (phraseHoldemHandLabel).

export interface IGameResultCount {
	guildId: string;
	game: string;
	// "YYYY-MM" in UTC, zero padded so months sort lexically.
	month: string;
	label: string;
	count: number;
}

const gameResultCountSchema = new mongoose.Schema<IGameResultCount>(
	{
		guildId: { type: String, required: true },
		game: { type: String, required: true },
		month: { type: String, required: true },
		label: { type: String, required: true },
		count: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization. Every showdown is an upsert with $inc, and two
// showdowns in one guild can race the first upsert of a label; this constraint
// keeps them on ONE row.
gameResultCountSchema.index({ guildId: 1, game: 1, month: 1, label: 1 }, { unique: true });

export const GameResultCount = mongoose.model<IGameResultCount>("GameResultCount", gameResultCountSchema);
