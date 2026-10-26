import { XpPeriod, type IXpPeriod } from "@db/models/XpPeriod.js";
import type { AnyBulkWriteOperation } from "mongoose";

// ── xpPeriodStore ──
// What:  the thin Mongoose wrapper over the XpPeriod collection, the per period
//        xp aggregates behind "this week" and "this month".
// Who:   xpWriter's flush (one bulkWrite per period key), /account view:levels, /account's
//        weekly and monthly rank lines, LevelsBoard.
// When:  every flush, and every period-scoped render.
// Where: guild scoped like every other store here (invariant 2). The period key
//        itself is produced by @features/leveling/levelPeriod.ts and is passed
//        in; this store never computes a date, which is what keeps the week
//        boundary rotation in exactly one place.
// How:   house store rules apply: thin wrappers, no business logic, no tests
//        (rule 6). Note what is NOT here: there is no reset method, and there is
//        no job that would call one. A new period is a new key, so last week
//        simply stops being queried. That absence is the feature.

export const xpPeriodStore = {
	// The batched write behind every flush, one call per period key. ordered:false
	// for the same reason as memberLevelStore.bulkWrite: a duplicate key from a
	// concurrent upsert must not abandon the rest of the batch.
	async bulkWrite(operations: AnyBulkWriteOperation<IXpPeriod>[]) {
		if (operations.length === 0) return null;
		return XpPeriod.bulkWrite(operations, { ordered: false });
	},

	// One member's total inside one period. Null when they earned nothing in it,
	// which every caller renders as "not on this board" rather than as a zero.
	async findOne(guildId: string, userId: string, period: string) {
		return XpPeriod.findOne({ guildId, userId, period });
	},

	// The period board. Matches the { guildId, period, xp: -1 } index exactly, so
	// a top ten never touches a row it will not show.
	async topInPeriod(guildId: string, period: string, limit = 10) {
		return XpPeriod.find({ guildId, period }).sort({ xp: -1 }).limit(limit);
	},

	// A member's rank inside one period, as an index-only count, mirroring
	// memberLevelStore.rankOf. Never a sort of the guild.
	async rankInPeriod(guildId: string, period: string, xp: number): Promise<number> {
		return (await XpPeriod.countDocuments({ guildId, period, xp: { $gt: xp } })) + 1;
	},

	// One period's headline numbers for the streamer recent-activity summary:
	// how many members earned anything, and how much xp the guild earned in
	// total. One aggregate on the { guildId, period } index rather than two
	// queries; a period with no rows resolves to zeros, which the summary
	// renders as a quiet week rather than an error.
	async statsForPeriod(guildId: string, period: string): Promise<{ activeMembers: number; totalXp: number }> {
		const rows = await XpPeriod.aggregate<{ activeMembers: number; totalXp: number }>([
			{ $match: { guildId, period } },
			{ $group: { _id: null, activeMembers: { $sum: 1 }, totalXp: { $sum: "$xp" } } },
			{ $project: { _id: 0, activeMembers: 1, totalXp: 1 } },
		]);
		return rows[0] ?? { activeMembers: 0, totalXp: 0 };
	},

	// /leveling xp reset-member and reset-server clear a member's period history alongside
	// their lifetime row, so a reset leaves nothing behind on any board.
	async deleteMember(guildId: string, userId: string) {
		return XpPeriod.deleteMany({ guildId, userId });
	},

	async deleteGuild(guildId: string) {
		return XpPeriod.deleteMany({ guildId });
	},
};
