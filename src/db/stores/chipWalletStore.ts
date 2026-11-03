import type { HydratedDocument } from "mongoose";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { ChipWallet, type IChipWallet } from "@db/models/ChipWallet.js";

// ── chipWalletStore ──
// What:  every DB touch for ChipWallet (2026-10 item 250 Phase 5), on a member's one
//        global wallet (2026-10 item 267 Session 1a), plus the reads and marks the boot
//        migration needs on the per server rows it sums.
// Who:   features/economy/chipWallet.ts, serverVault.ts (the vault day reservation) and
//        migrateGlobalChipWallets.ts.
// Where: every write is ONE atomic findOneAndUpdate, because the guards live in the
//        filter: a debit matches only while the balance covers it, a daily claim only
//        while its cooldown has run, a vault reservation only while the day's cap has
//        room. The amounts, the cooldown, the cap and what a refusal means are the
//        feature's; this store only writes. House store rules apply: no business logic,
//        no tests (rule 6).

// Mongo's duplicate key error code.
const DUPLICATE_KEY_CODE = 11000;

/** A member's wallet. There is one per member, global across every server. */
export interface WalletKey {
	userId: string;
}

/** What one per server row carries into the global row. */
export interface MigratedCredit {
	amount: number;
	totalClaimed: number;
	/** The row's last claim, or null when the member never claimed in that server. */
	lastClaimAt: Date | null;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === DUPLICATE_KEY_CODE;

// The filter for a member's global row: the sentinel guildId and the member.
const globalRow = (key: WalletKey) => ({ guildId: BOT_CONSTANTS.ECONOMY.GLOBAL_CHIP_WALLET_ID, userId: key.userId });

export const chipWalletStore = {
	async findOne(key: WalletKey): Promise<IChipWallet | null> {
		return ChipWallet.findOne(globalRow(key)).lean<IChipWallet>();
	},

	/**
	 * The first claim: matches a wallet that never claimed, or creates one. Null when the
	 * wallet already claimed once, which surfaces as the upsert colliding with the unique
	 * index rather than as a silent second row.
	 */
	async claimFirst(key: WalletKey, amount: number, now: Date): Promise<IChipWallet | null> {
		try {
			return await ChipWallet.findOneAndUpdate(
				{ ...globalRow(key), lastClaimAt: null },
				{ $inc: { balance: amount, totalClaimed: amount }, $set: { lastClaimAt: now } },
				{ upsert: true, new: true }
			).lean<IChipWallet>();
		} catch (error) {
			if (isDuplicateKey(error)) return null;
			throw error;
		}
	},

	/** A later claim: matches only a wallet whose last claim is at or before `claimedBy`. Null while the cooldown runs. */
	async claimDaily(key: WalletKey, amount: number, now: Date, claimedBy: Date): Promise<IChipWallet | null> {
		return ChipWallet.findOneAndUpdate(
			{ ...globalRow(key), lastClaimAt: { $ne: null, $lte: claimedBy } },
			{ $inc: { balance: amount, totalClaimed: amount }, $set: { lastClaimAt: now } },
			{ new: true }
		).lean<IChipWallet>();
	},

	/** Add chips, creating the wallet when the member has none yet. */
	async credit(key: WalletKey, amount: number): Promise<IChipWallet> {
		const wallet = await ChipWallet.findOneAndUpdate(globalRow(key), { $inc: { balance: amount } }, { upsert: true, new: true }).lean<IChipWallet>();
		return wallet as IChipWallet;
	},

	/**
	 * Take chips with a receipt (2026-10 item 276): the debit and the receipt in ONE write, so a
	 * receipt exists exactly when the chips were taken. Null when the balance does not cover them,
	 * or this receipt is already open. The receipt list keeps the newest CHIP_RECEIPT_CAP.
	 */
	async debitWithReceipt(key: WalletKey, amount: number, receiptId: string): Promise<IChipWallet | null> {
		return ChipWallet.findOneAndUpdate(
			{ ...globalRow(key), balance: { $gte: amount }, openReceipts: { $ne: receiptId } },
			{ $inc: { balance: -amount }, $push: { openReceipts: { $each: [receiptId], $slice: -BOT_CONSTANTS.ECONOMY.CHIP_RECEIPT_CAP } } },
			{ new: true }
		).lean<IChipWallet>();
	},

	/** Give a receipted charge back: the credit and the receipt's removal in ONE write. Null when the receipt is not open. */
	async refundReceipt(key: WalletKey, amount: number, receiptId: string): Promise<IChipWallet | null> {
		return ChipWallet.findOneAndUpdate({ ...globalRow(key), openReceipts: receiptId }, { $inc: { balance: amount }, $pull: { openReceipts: receiptId } }, { new: true }).lean<IChipWallet>();
	},

	/** Close a receipt once the game's ledger holds the charge, so no refund can reach it. */
	async closeReceipt(key: WalletKey, receiptId: string): Promise<void> {
		await ChipWallet.updateOne(globalRow(key), { $pull: { openReceipts: receiptId } });
	},

	/** Take chips only while the balance covers them. Null when it does not, or the member has no wallet. */
	async debit(key: WalletKey, amount: number): Promise<IChipWallet | null> {
		return ChipWallet.findOneAndUpdate({ ...globalRow(key), balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true }).lean<IChipWallet>();
	},

	/**
	 * Count `amount` vault chips against the member's day, creating the wallet when they
	 * have none. One pipeline update: a stored day other than `dayKey` starts the count at
	 * `amount`, the same day adds to it. Null when the day's count would pass `cap`, which
	 * surfaces as the upsert colliding with the unique index, like claimFirst.
	 */
	async reserveVaultReceipt(key: WalletKey, amount: number, dayKey: string, cap: number): Promise<IChipWallet | null> {
		const sameDay = { $eq: ["$vaultDayKey", dayKey] };
		try {
			return await ChipWallet.findOneAndUpdate(
				{ ...globalRow(key), $or: [{ vaultDayKey: { $ne: dayKey } }, { vaultReceivedToday: { $lte: cap - amount } }] },
				[
					{
						$set: {
							vaultReceivedToday: { $cond: [sameDay, { $add: [{ $ifNull: ["$vaultReceivedToday", 0] }, amount] }, amount] },
							vaultDayKey: dayKey,
							balance: { $ifNull: ["$balance", 0] },
							lastClaimAt: { $ifNull: ["$lastClaimAt", null] },
							totalClaimed: { $ifNull: ["$totalClaimed", 0] },
						},
					},
				],
				{ upsert: true, new: true }
			).lean<IChipWallet>();
		} catch (error) {
			if (isDuplicateKey(error)) return null;
			throw error;
		}
	},

	/** Give back a reservation of `amount` made on `dayKey`. A reservation from a day already past has nothing to give back. */
	async releaseVaultReceipt(key: WalletKey, amount: number, dayKey: string): Promise<void> {
		await ChipWallet.updateOne({ ...globalRow(key), vaultDayKey: dayKey, vaultReceivedToday: { $gte: amount } }, { $inc: { vaultReceivedToday: -amount } });
	},

	// ── the boot migration ──

	/** Every per server row the migration has not claimed yet, as hydrated documents. */
	async findUnmigratedServerRows(): Promise<HydratedDocument<IChipWallet>[]> {
		return ChipWallet.find({ guildId: { $ne: BOT_CONSTANTS.ECONOMY.GLOBAL_CHIP_WALLET_ID }, migratedAt: null });
	},

	/**
	 * Claim one per server row for the migration: stamp it migrated with the balance it
	 * carries. Matches only while it is unclaimed and still holds `balance`, so two boots
	 * racing claim it once. True when this call claimed it.
	 */
	async claimServerRowForMigration(rowId: unknown, balance: number, now: Date): Promise<boolean> {
		const claimed = await ChipWallet.findOneAndUpdate({ _id: rowId, migratedAt: null, balance }, { $set: { migratedAt: now, migratedAmount: balance } }, { new: true }).lean<IChipWallet>();
		return claimed !== null;
	},

	/** Add one claimed row to the member's global wallet: its chips, its claimed total, and its last claim when later. */
	async mergeIntoGlobal(key: WalletKey, credit: MigratedCredit): Promise<void> {
		// A row that never held a claim adds no last claim: leaving the field unset (null) keeps
		// the member's first claim owed, which claimFirst matches on lastClaimAt null.
		const update = credit.lastClaimAt
			? { $inc: { balance: credit.amount, totalClaimed: credit.totalClaimed }, $max: { lastClaimAt: credit.lastClaimAt } }
			: { $inc: { balance: credit.amount, totalClaimed: credit.totalClaimed } };
		await ChipWallet.updateOne(globalRow(key), update, { upsert: true });
	},
};
