import { ServerVault, type IServerVault, type IVaultGrant } from "@db/models/ServerVault.js";

// ── serverVaultStore ──
// What:  every DB touch for ServerVault (2026-10 item 250 Phase 5).
// Who:   features/economy/serverVault.ts and vaultTopUp.ts, and self destruct's server
//        data delete.
// Where: each write is one atomic findOneAndUpdate with its guard in the filter: a grant
//        matches only while the balance covers it, the monthly award only while the month
//        is unpaid. The starting balance, the history cap and the award amounts are the
//        feature's. House store rules apply: no business logic, no tests (rule 6).

export const serverVaultStore = {
	/** The guild's vault, created with `startingBalance` the first time anything reads it. */
	async ensure(guildId: string, startingBalance: number): Promise<IServerVault> {
		const vault = await ServerVault.findOneAndUpdate(
			{ guildId },
			{ $setOnInsert: { balance: startingBalance, lastAwardMonth: null, grantHistory: [] } },
			{ upsert: true, new: true }
		).lean<IServerVault>();
		return vault as IServerVault;
	},

	/**
	 * Take a grant out of the vault and record it, keeping the newest `historyLimit`
	 * grants. Null when the balance does not cover it.
	 */
	async debitGrant(guildId: string, grant: IVaultGrant, historyLimit: number): Promise<IServerVault | null> {
		return ServerVault.findOneAndUpdate(
			{ guildId, balance: { $gte: grant.amount } },
			{ $inc: { balance: -grant.amount }, $push: { grantHistory: { $each: [grant], $slice: -historyLimit } } },
			{ new: true }
		).lean<IServerVault>();
	},

	/** Put chips back, for a grant whose wallet credit failed after the vault paid it. */
	async refund(guildId: string, amount: number): Promise<void> {
		await ServerVault.updateOne({ guildId }, { $inc: { balance: amount } });
	},

	/** Pay one month's award, once. Null when that month was already paid. */
	async awardMonth(guildId: string, month: string, amount: number): Promise<IServerVault | null> {
		return ServerVault.findOneAndUpdate(
			{ guildId, lastAwardMonth: { $ne: month } },
			{ $inc: { balance: amount }, $set: { lastAwardMonth: month } },
			{ new: true }
		).lean<IServerVault>();
	},

	// Self destruct's server data delete (post-launch plan item 10): every row this guild owns.
	async deleteGuild(guildId: string) {
		return ServerVault.deleteMany({ guildId });
	},
};
