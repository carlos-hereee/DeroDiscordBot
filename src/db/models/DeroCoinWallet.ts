// src/db/models/DeroCoinWallet.ts
import mongoose from "mongoose";

// ── DeroCoinWallet ──
// What:  one member's Dero coins, the Verse currency (2026-10 item 257, Phase 3a): the
//        balance and everything they ever earned.
// Who:   written ONLY through deroCoinStore, by features/economy/deroCoins.ts (awards)
//        and features/economy/coinMarket.ts (🏪dero-market trades, 2026-10 item 267
//        Session 2a); read by the /account card and the market's modal.
// Where: GLOBAL, deliberately, with no guildId (owner decision 8): coins follow a member
//        across every server, as chips (ChipWallet's global row) do since 2026-10 item 267.
//
// ⚠️ THE MONEY INVARIANT: every balance change has its CoinAward row, so the ledger is
// the truth and a wallet can always be rebuilt from it. An award or a buy writes its row
// and then adds; a sell is the one spend, a conditional debit that matches only while
// the balance covers it, followed at once by its row (and given back if the row fails).

export interface IDeroCoinWallet {
	userId: string;
	balance: number;
	totalEarned: number;
	// 🏪dero-market's daily buy cap (risk R4): the UTC day the coins below were bought on,
	// and how many. A buy on a new day starts the count again. Absent until a first buy.
	marketDayKey?: string;
	marketBoughtToday?: number;
}

const deroCoinWalletSchema = new mongoose.Schema<IDeroCoinWallet>(
	{
		userId: { type: String, required: true },
		balance: { type: Number, default: 0, min: 0 },
		totalEarned: { type: Number, default: 0 },
		marketDayKey: { type: String, required: false },
		marketBoughtToday: { type: Number, required: false },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization: the wallet is upserted on a member's first award,
// and this constraint keeps two racing first awards on ONE row. The market's day
// reservation leans on it too: its upsert collides here when the row exists but the cap
// refused it.
deroCoinWalletSchema.index({ userId: 1 }, { unique: true });

export const DeroCoinWallet = mongoose.model<IDeroCoinWallet>("DeroCoinWallet", deroCoinWalletSchema);
