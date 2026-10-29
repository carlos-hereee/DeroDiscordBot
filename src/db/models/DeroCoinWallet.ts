// src/db/models/DeroCoinWallet.ts
import mongoose from "mongoose";

// ── DeroCoinWallet ──
// What:  one member's Dero coins, the Verse currency (2026-10 item 257, Phase 3a): the
//        balance and everything they ever earned.
// Who:   written ONLY by features/economy/deroCoins.ts through deroCoinStore, after a
//        CoinAward row was inserted; read by the /account card.
// Where: GLOBAL, deliberately, with no guildId (owner decision 8): coins follow a member
//        across every server, as chips (ChipWallet's global row) do since 2026-10 item 267.
//
// ⚠️ THE MONEY INVARIANT: the balance only ever moves by an $inc that follows a
// successful CoinAward insert, so the award ledger is the truth and a wallet can always
// be rebuilt from it. Nothing spends coins in 2.0.0, and `min: 0` is the guard waiting
// for the release that does.

export interface IDeroCoinWallet {
	userId: string;
	balance: number;
	totalEarned: number;
}

const deroCoinWalletSchema = new mongoose.Schema<IDeroCoinWallet>(
	{
		userId: { type: String, required: true },
		balance: { type: Number, default: 0, min: 0 },
		totalEarned: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization: the wallet is upserted on a member's first award,
// and this constraint keeps two racing first awards on ONE row.
deroCoinWalletSchema.index({ userId: 1 }, { unique: true });

export const DeroCoinWallet = mongoose.model<IDeroCoinWallet>("DeroCoinWallet", deroCoinWalletSchema);
