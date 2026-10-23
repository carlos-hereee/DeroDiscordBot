// src/db/models/PlayerRating.ts
import mongoose from "mongoose";

// ── PlayerRating ──
// One row per player per rated game (Hold'em, Battleship, Monopoly): the OpenSkill
// estimate, how many rated games stand behind it, and the display number members
// read. Written only by features/ratings/recordMatchRatings.ts through
// playerRatingStore; read by the Phase 3b /rating command and boards.
//
// ⚠️ NETWORK WIDE BY DESIGN: there is no guildId. A rating follows the player into
// every server they play in, which is why nothing may show it outside the player's
// own server without their network consent (2026-10 item 244, risk R9). Phase 3a
// shows it nowhere at all.

export interface IPlayerRating {
	userId: string;
	game: string;
	mu: number;
	sigma: number;
	ratedGames: number;
	// Stored rather than derived on read so the per game board can sort on an index.
	displayRating: number;
	lastRatedAt: Date;
}

const playerRatingSchema = new mongoose.Schema<IPlayerRating>(
	{
		userId: { type: String, required: true },
		game: { type: String, required: true },
		mu: { type: Number, required: true },
		sigma: { type: Number, required: true },
		ratedGames: { type: Number, default: 0 },
		displayRating: { type: Number, required: true },
		lastRatedAt: { type: Date, required: true },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization. A rating is upserted on a player's first rated
// game, and this constraint is what keeps a player on ONE row per game rather than
// two rows each holding half their history.
playerRatingSchema.index({ userId: 1, game: 1 }, { unique: true });

// Serves the per game board: the top display ratings in one game.
playerRatingSchema.index({ game: 1, displayRating: -1 });

export const PlayerRating = mongoose.model<IPlayerRating>("PlayerRating", playerRatingSchema);
