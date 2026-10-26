// src/db/models/ChipWallet.ts
import mongoose from "mongoose";

// ── ChipWallet ──
// What:  one member's chips in one server (2026-10 item 250 Phase 5): the balance,
//        when they last claimed, and how much they have claimed in all.
// Who:   features/economy/ only, through chipWalletStore: the /claim command, the
//        vault grant, and the Hold'em buy in and cash out. The /account card reads the
//        balance.
// Where: guild scoped like every row here (invariant 2), so a member's chips in one
//        server buy nothing in another.
//
// ⚠️ THE BALANCE NEVER GOES BELOW ZERO, AND NO READ GUARDS IT. Every debit is one
// conditional write that matches only while the balance covers the amount, so two buy
// ins racing on one wallet can never both land on chips that exist once.

export interface IChipWallet {
	guildId: string;
	userId: string;
	balance: number;
	// Null until the member's first claim, which is what makes that claim the large one.
	lastClaimAt: Date | null;
	totalClaimed: number;
}

const chipWalletSchema = new mongoose.Schema<IChipWallet>(
	{
		guildId: { type: String, required: true },
		userId: { type: String, required: true },
		balance: { type: Number, default: 0, min: 0 },
		lastClaimAt: { type: Date, default: null },
		totalClaimed: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization. A wallet is upserted on a member's first claim or
// first credit, and this constraint keeps two racing first writes on ONE row. The first
// claim also leans on it: its upsert collides here when the row already claimed once.
chipWalletSchema.index({ guildId: 1, userId: 1 }, { unique: true });

export const ChipWallet = mongoose.model<IChipWallet>("ChipWallet", chipWalletSchema);
