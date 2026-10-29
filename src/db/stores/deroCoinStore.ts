import { CoinAward, type CoinAwardSource, type ICoinAward } from "@db/models/CoinAward.js";
import { DeroCoinWallet, type IDeroCoinWallet } from "@db/models/DeroCoinWallet.js";

// ── deroCoinStore ──
// What:  every DB touch for Dero coins (2026-10 item 257, Phase 3a): the award ledger
//        and the global wallet, and 🏪dero-market's trade rows, daily buy count and
//        conditional debit (2026-10 item 267 Session 2a).
// Who:   features/economy/deroCoins.ts (awards) and coinMarket.ts (trades), which own the
//        amounts, the caps and the order of the writes; the /account card reads a balance
//        through it.
// Where: the wallet is global (no guildId); an award row names the guild it was earned
//        in. House store rules apply: no business logic, no tests (rule 6).

// Mongo's duplicate key error code.
const DUPLICATE_KEY_CODE = 11000;

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === DUPLICATE_KEY_CODE;

// The sources that pay coins into the economy. A market row is a trade, coins bought with
// chips or sold for them, so it is no coin collected and the Verse total leaves it out.
const EARNED_SOURCES: readonly CoinAwardSource[] = ["game", "claim"];

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

	/** The owner's Verse view: every coin ever paid, and the coins paid since `since` (the UTC month's start). */
	async sumAllAwards(since?: Date): Promise<number> {
		const [row] = await CoinAward.aggregate<{ total: number }>([
			{ $match: { source: { $in: [...EARNED_SOURCES] }, ...(since ? { at: { $gte: since } } : {}) } },
			{ $group: { _id: null, total: { $sum: "$amount" } } },
		]);
		return row?.total ?? 0;
	},

	/** The collection name the Verse view's union reads from, so no caller retypes it. */
	coinAwardCollectionName(): string {
		return CoinAward.collection.name;
	},

	// ── 🏪dero-market (2026-10 item 267 Session 2a) ──

	/** Write one trade's ledger row. A market row has no unique key, so every failure throws. */
	async insertTrade(trade: ICoinAward): Promise<void> {
		await CoinAward.create(trade);
	},

	/** Add bought or returned coins to a member's balance, creating the wallet. Not earned, so totalEarned stays. */
	async creditBalance(userId: string, amount: number): Promise<void> {
		await DeroCoinWallet.updateOne({ userId }, { $inc: { balance: amount } }, { upsert: true });
	},

	/** Take coins only while the balance covers them. Null when it does not, or the member has no wallet. */
	async debit(userId: string, amount: number): Promise<IDeroCoinWallet | null> {
		return DeroCoinWallet.findOneAndUpdate({ userId, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true }).lean<IDeroCoinWallet>();
	},

	/**
	 * Count `amount` bought coins against the member's day, creating the wallet when they
	 * have none. One pipeline update, like chipWalletStore.reserveVaultReceipt: a stored day
	 * other than `dayKey` starts the count at `amount`, the same day adds to it. Null when
	 * the day's count would pass `cap`, which surfaces as the upsert colliding with the
	 * unique userId index rather than as a second row.
	 */
	async reserveMarketBuy(userId: string, amount: number, dayKey: string, cap: number): Promise<IDeroCoinWallet | null> {
		const sameDay = { $eq: ["$marketDayKey", dayKey] };
		try {
			return await DeroCoinWallet.findOneAndUpdate(
				{ userId, $or: [{ marketDayKey: { $ne: dayKey } }, { marketBoughtToday: { $lte: cap - amount } }] },
				[
					{
						$set: {
							marketBoughtToday: { $cond: [sameDay, { $add: [{ $ifNull: ["$marketBoughtToday", 0] }, amount] }, amount] },
							marketDayKey: dayKey,
							balance: { $ifNull: ["$balance", 0] },
							totalEarned: { $ifNull: ["$totalEarned", 0] },
						},
					},
				],
				{ upsert: true, new: true }
			).lean<IDeroCoinWallet>();
		} catch (error) {
			if (isDuplicateKey(error)) return null;
			throw error;
		}
	},

	/** Give back a reservation of `amount` made on `dayKey`. One from a day already past has nothing to give back. */
	async releaseMarketBuy(userId: string, amount: number, dayKey: string): Promise<void> {
		await DeroCoinWallet.updateOne({ userId, marketDayKey: dayKey, marketBoughtToday: { $gte: amount } }, { $inc: { marketBoughtToday: -amount } });
	},

	/** Whether a claim award already exists under one claim key for one member. */
	async hasClaim(claimKey: string, userId: string): Promise<boolean> {
		return (await CoinAward.exists({ source: "claim", claimKey, userId })) !== null;
	},
};
