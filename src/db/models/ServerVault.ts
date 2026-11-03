// src/db/models/ServerVault.ts
import mongoose from "mongoose";

// ── ServerVault ──
// What:  one server's chip reserve (2026-10 item 250 Phase 5): the balance admins grant
//        from, the last month the network award paid it, and its most recent grants.
// Who:   features/economy/ only, through serverVaultStore: /arcade chips grant debits it,
//        the monthly top up credits it, /arcade chips status reads it.
// Where: one row per guild, created with the starting balance the first time anything
//        reads it, so an existing server needs no backfill.
//
// ⚠️ lastAwardMonth IS THE MONTHLY AWARD'S CLAIM. The award matches only a row whose
// lastAwardMonth is not the month being paid, and sets it in the same write, so a second
// process on a deploy, or a cron that fires twice, can never pay one month twice.

export interface IVaultGrant {
	userId: string;
	amount: number;
	at: Date;
	byAdminId: string;
}

export interface IServerVault {
	guildId: string;
	balance: number;
	// "YYYY-MM" in UTC of the last month the network award paid, or null.
	lastAwardMonth: string | null;
	// Newest last, capped at BOT_CONSTANTS.ECONOMY.VAULT_GRANT_HISTORY_LIMIT by the store's $slice.
	grantHistory: IVaultGrant[];
}

const vaultGrantSchema = new mongoose.Schema<IVaultGrant>(
	{
		userId: { type: String, required: true },
		amount: { type: Number, required: true },
		at: { type: Date, required: true },
		byAdminId: { type: String, required: true },
	},
	{ _id: false }
);

const serverVaultSchema = new mongoose.Schema<IServerVault>(
	{
		guildId: { type: String, required: true, unique: true },
		balance: { type: Number, required: true, min: 0 },
		lastAwardMonth: { type: String, default: null },
		grantHistory: { type: [vaultGrantSchema], default: [] },
	},
	{ timestamps: true }
);

export const ServerVault = mongoose.model<IServerVault>("ServerVault", serverVaultSchema);
