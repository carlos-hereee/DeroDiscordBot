// src/db/models/ChipWallet.ts
import mongoose from "mongoose";

// ── ChipWallet ──
// What:  a member's chips (2026-10 item 250 Phase 5): the balance, when they last
//        claimed, and how much they have claimed in all. Since 2026-10 item 267 Session
//        1a a member holds ONE GLOBAL WALLET: the row whose guildId is
//        BOT_CONSTANTS.ECONOMY.GLOBAL_CHIP_WALLET_ID. Rows with a real guildId are the
//        per server balances from before, summed into the global row once by the boot
//        migration (features/economy/migrateGlobalChipWallets.ts) and kept, marked, so
//        the owner can restore them (risk R1).
// Who:   features/economy/ only, through chipWalletStore: the daily claim, the vault
//        grant, and the Hold'em buy in and cash out. The /account card reads the
//        balance.
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
	// A per server row only: when the boot migration claimed it, and the balance it
	// carried into the global row then. Absent on a row not yet migrated and on the global
	// row itself. migratedAmount is what the owner restores from if a credit was lost.
	migratedAt?: Date | null;
	migratedAmount?: number;
	// The global row only (risk R3): the UTC day the vault chips below were received on,
	// and how many. A grant on a new day starts the count again.
	vaultDayKey?: string;
	vaultReceivedToday?: number;
}

const chipWalletSchema = new mongoose.Schema<IChipWallet>(
	{
		guildId: { type: String, required: true },
		userId: { type: String, required: true },
		balance: { type: Number, default: 0, min: 0 },
		lastClaimAt: { type: Date, default: null },
		totalClaimed: { type: Number, default: 0 },
		migratedAt: { type: Date, required: false },
		migratedAmount: { type: Number, required: false },
		vaultDayKey: { type: String, required: false },
		vaultReceivedToday: { type: Number, required: false },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization. A wallet is upserted on a member's first claim or
// first credit, and this constraint keeps two racing first writes on ONE row. The first
// claim and the vault reservation lean on it too: their upserts collide here when the
// row exists but their conditions refused it. The global row is the one whose guildId is
// the sentinel, so it shares this index with the per server rows.
chipWalletSchema.index({ guildId: 1, userId: 1 }, { unique: true });

export const ChipWallet = mongoose.model<IChipWallet>("ChipWallet", chipWalletSchema);
