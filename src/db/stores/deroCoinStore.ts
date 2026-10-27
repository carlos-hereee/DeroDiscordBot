import { CoinAward, type ICoinAward } from "@db/models/CoinAward.js";
import { DeroCoinWallet, type IDeroCoinWallet } from "@db/models/DeroCoinWallet.js";

// ── deroCoinStore ──
// What:  every DB touch for Dero coins (2026-10 item 257, Phase 3a): the award ledger
//        and the global wallet.
// Who:   features/economy/deroCoins.ts only, which owns the amounts, the cap and the
//        order of the two writes; the /account card reads a balance through it.
// Where: the wallet is global (no guildId); an award row names the guild it was earned
//        in. House store rules apply: no business logic, no tests (rule 6).

// Mongo's duplicate key error code.
const DUPLICATE_KEY_CODE = 11000;

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === DUPLICATE_KEY_CODE;

export const deroCoinStore = {
	/**
	 * Insert one award. False when its unique key already holds a row, which means the
	 * award was paid before; every other failure throws.
	 */
	async insertAward(award: ICoinAward): Promise<boolean> {
		try {
			await CoinAward.create(award);
			return true;
		} catch (error) {
			if (isDuplicateKey(error)) return false;
			throw error;
		}
	},

	/** Add coins to a member's wallet, creating it on their first award. */
	async credit(userId: string, amount: number): Promise<void> {
		await DeroCoinWallet.updateOne({ userId }, { $inc: { balance: amount, totalEarned: amount } }, { upsert: true });
	},

	async findWallet(userId: string): Promise<IDeroCoinWallet | null> {
		return DeroCoinWallet.findOne({ userId }).lean<IDeroCoinWallet>();
	},

	/** The coins one member's game awards for `games` paid since `since`. */
	async sumGameCoinsSince(userId: string, games: readonly string[], since: Date): Promise<number> {
		const [row] = await CoinAward.aggregate<{ total: number }>([
			{ $match: { userId, source: "game", game: { $in: [...games] }, at: { $gte: since } } },
			{ $group: { _id: null, total: { $sum: "$amount" } } },
		]);
		return row?.total ?? 0;
	},

	/** Whether a claim award already exists under one claim key for one member. */
	async hasClaim(claimKey: string, userId: string): Promise<boolean> {
		return (await CoinAward.exists({ source: "claim", claimKey, userId })) !== null;
	},
};
