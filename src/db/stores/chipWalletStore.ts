import { ChipWallet, type IChipWallet } from "@db/models/ChipWallet.js";

// ── chipWalletStore ──
// What:  every DB touch for ChipWallet (2026-10 item 250 Phase 5).
// Who:   features/economy/chipWallet.ts, and self destruct's server data delete.
// Where: every write is ONE atomic findOneAndUpdate, because the guards live in the
//        filter: a debit matches only while the balance covers it, a daily claim only
//        while its cooldown has run. The amounts, the cooldown and what a refusal means
//        are the feature's; this store only writes. House store rules apply: no
//        business logic, no tests (rule 6).

// Mongo's duplicate key error code.
const DUPLICATE_KEY_CODE = 11000;

export interface WalletKey {
	guildId: string;
	userId: string;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === DUPLICATE_KEY_CODE;

export const chipWalletStore = {
	async findOne(key: WalletKey): Promise<IChipWallet | null> {
		return ChipWallet.findOne(key).lean<IChipWallet>();
	},

	/**
	 * The first claim: matches a wallet that never claimed, or creates one. Null when the
	 * wallet already claimed once, which surfaces as the upsert colliding with the unique
	 * index rather than as a silent second row.
	 */
	async claimFirst(key: WalletKey, amount: number, now: Date): Promise<IChipWallet | null> {
		try {
			return await ChipWallet.findOneAndUpdate(
				{ ...key, lastClaimAt: null },
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
			{ ...key, lastClaimAt: { $ne: null, $lte: claimedBy } },
			{ $inc: { balance: amount, totalClaimed: amount }, $set: { lastClaimAt: now } },
			{ new: true }
		).lean<IChipWallet>();
	},

	/** Add chips, creating the wallet when the member has none yet. */
	async credit(key: WalletKey, amount: number): Promise<IChipWallet> {
		const wallet = await ChipWallet.findOneAndUpdate(key, { $inc: { balance: amount } }, { upsert: true, new: true }).lean<IChipWallet>();
		return wallet as IChipWallet;
	},

	/** Take chips only while the balance covers them. Null when it does not, or the member has no wallet. */
	async debit(key: WalletKey, amount: number): Promise<IChipWallet | null> {
		return ChipWallet.findOneAndUpdate({ ...key, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true }).lean<IChipWallet>();
	},

	// Self destruct's server data delete (post-launch plan item 10): every row this guild owns.
	async deleteGuild(guildId: string) {
		return ChipWallet.deleteMany({ guildId });
	},
};
