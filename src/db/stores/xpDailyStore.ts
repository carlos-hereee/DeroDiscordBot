import { XpDaily } from "@db/models/XpDaily.js";

// ── xpDailyStore ──
// What:  the thin Mongoose wrapper over XpDaily, the per day counter behind the
//        daily XP cap.
// Who:   awardXp only.
// Where: guild scoped like every other store here (invariant 2). The day key is
//        computed by @features/leveling/dailyXpCap.ts and passed in, and so is every
//        decision about what the returned count means; this store never knows the
//        cap exists. House store rules apply: no business logic, no tests (rule 6).

export const xpDailyStore = {
	// Add `amount` to one member's count for one day and return the count AFTER the
	// add. $inc with an upsert is one atomic server side operation, so two awards in
	// the same tick are serialized by Mongo and each sees its own post increment
	// value. Two concurrent upserts on a MISSING row can still race on the insert
	// and one loses with code 11000; the caller retries, as awardXp does for
	// MemberLevel.
	async incrementAndReturn(guildId: string, userId: string, day: string, amount: number): Promise<number> {
		const doc = await XpDaily.findOneAndUpdate(
			{ guildId, userId, day },
			{ $inc: { xp: amount } },
			{ upsert: true, new: true }
		).lean();
		return doc?.xp ?? amount;
	},

	// Self destruct's server data delete (post-launch plan item 10): every row this guild owns.
	async deleteGuild(guildId: string) {
		return XpDaily.deleteMany({ guildId });
	},
};
