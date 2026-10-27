// src/db/models/CoinAward.ts
import mongoose from "mongoose";

// ── CoinAward ──
// What:  the append only ledger of Dero coins paid (2026-10 item 257, Phase 3a): one row
//        per member per game result, and one per member per daily claim.
// Who:   written ONLY by features/economy/deroCoins.ts through deroCoinStore; read by the
//        same module for the solo daily cap, and by the owner's Verse view (Phase 3b) for
//        coins collected and games completed.
// Where: guildId says where the coins were earned, for the counts; the wallet itself is
//        global (DeroCoinWallet).
//
// ⚠️ THE MONEY INVARIANT (risk R3 in the plan): a retry, a rematch press, two racing
// presses or a sweep finishing a finished room must never pay twice. The two partial
// unique indexes below make the SECOND insert of one award fail with a duplicate key,
// and deroCoins only moves a wallet after its own insert succeeded.

export const COIN_AWARD_SOURCES = ["game", "claim"] as const;
export type CoinAwardSource = (typeof COIN_AWARD_SOURCES)[number];

export const COIN_AWARD_OUTCOMES = ["won", "drawn", "played"] as const;
export type CoinAwardOutcome = (typeof COIN_AWARD_OUTCOMES)[number];

export interface ICoinAward {
	userId: string;
	guildId: string;
	amount: number;
	source: CoinAwardSource;
	// A game award only: the game slug (a solo round against Dero carries its solo- slug,
	// which is what the daily cap counts by), and how the result read for this member.
	game?: string;
	outcome?: CoinAwardOutcome;
	// A game award only: the result's key, the room id for a game played in a room, or the
	// stable key of its own a channel game names (deroCoins.ts lists them).
	roomId?: string;
	// A claim only: the UTC day plus the guild ("2026-10-27:<guildId>").
	claimKey?: string;
	at: Date;
}

const coinAwardSchema = new mongoose.Schema<ICoinAward>({
	userId: { type: String, required: true },
	guildId: { type: String, required: true },
	amount: { type: Number, required: true, min: 0 },
	source: { type: String, enum: COIN_AWARD_SOURCES, required: true },
	game: { type: String },
	outcome: { type: String, enum: COIN_AWARD_OUTCOMES },
	roomId: { type: String },
	claimKey: { type: String },
	at: { type: Date, required: true },
});

// ⚠️ REQUIRED, the idempotency of every payout. PARTIAL, so each index applies only to its
// own source: a claim row has no roomId and a game row no claimKey, and a plain unique
// index would treat every missing value as the same null and refuse the second member.
coinAwardSchema.index({ source: 1, roomId: 1, userId: 1 }, { unique: true, partialFilterExpression: { source: "game" } });
coinAwardSchema.index({ source: 1, claimKey: 1, userId: 1 }, { unique: true, partialFilterExpression: { source: "claim" } });
// The solo daily cap's read: one member's game awards since midnight UTC.
coinAwardSchema.index({ userId: 1, source: 1, at: -1 });

// The owner's Verse view: coins paid inside the UTC month, and members active in the last 30
// days. Without it both reads scan the whole ledger. Writes are one row per game result.
coinAwardSchema.index({ at: -1 });

export const CoinAward = mongoose.model<ICoinAward>("CoinAward", coinAwardSchema);
