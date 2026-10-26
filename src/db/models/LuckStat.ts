// src/db/models/LuckStat.ts
import mongoose from "mongoose";

// ── LuckStat ──
// One row per guild, player, luck game (coin flip, dice roll, rock paper scissors)
// and UTC month: how many decided games the player had and how many they won. Ties
// are not decided games and never land here. Written only by
// features/ratings/luckStats.ts through luckStatStore; read by the Phase 3b luck
// board, which ranks by wins above expected (wins minus half of decided).
//
// Luck games are never rated (they measure nothing a player did), so this is the
// whole of what they record. Magic 8 ball readings ride the same rows under the game
// "fortune" (2026-10 item 250 Phase 5): `decided` counts readings and `points` sums
// their luck above the average, and the board keeps them out of the decided games.

export interface ILuckStat {
	guildId: string;
	userId: string;
	game: string;
	// "YYYY-MM" in UTC, zero padded so months sort lexically.
	month: string;
	decided: number;
	wins: number;
	// Magic 8 ball rows only (game "fortune", 2026-10 item 250 Phase 5): the sum of each
	// reading's luck above the average reading. `decided` counts the readings there.
	points: number;
}

const luckStatSchema = new mongoose.Schema<ILuckStat>(
	{
		guildId: { type: String, required: true },
		userId: { type: String, required: true },
		game: { type: String, required: true },
		month: { type: String, required: true },
		decided: { type: Number, default: 0 },
		wins: { type: Number, default: 0 },
		points: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization. Every result is an upsert with $inc, and two
// first results of a month can race the upsert; this constraint keeps them on ONE
// row rather than two rows each holding half the month.
luckStatSchema.index({ guildId: 1, userId: 1, game: 1, month: 1 }, { unique: true });

export const LuckStat = mongoose.model<ILuckStat>("LuckStat", luckStatSchema);
