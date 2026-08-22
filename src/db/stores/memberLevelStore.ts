import { MemberLevel, type IMemberLevel } from "@db/models/MemberLevel.js";
import type { AnyBulkWriteOperation } from "mongoose";

// ── memberLevelStore ──
// What:  the thin Mongoose wrapper over the MemberLevel collection. Query shapes
//        only; every decision about WHEN xp is awarded, whether a cooldown
//        passed, and what a level up means lives in features/leveling.
// Who:   awardXp and xpWriter (writes), /account, /levels, LevelsBoard,
//        roleRewards and the achievement engine (reads), /xp (admin correction).
// When:  on every flush and on every profile or board render.
// Where: guild scoping is a security boundary (invariant 2), so every method
//        here takes guildId and filters on it. A userId that belongs to another
//        guild therefore reads as NOT FOUND rather than forbidden.
// How:   house store rules apply: thin wrappers, no business logic, no tests
//        (rule 6). Two properties are load bearing and are the reason the method
//        list looks the way it does:
//        ① every mutation is ATOMIC and server side ($inc, never a read then a
//          write), because message xp arrives faster than a round trip and a
//          read-modify-write would silently drop concurrent awards,
//        ② rank is an index-only COUNT, never a sort of the guild.

export const memberLevelStore = {
	// One member's row. Returns null before their first award, which every caller
	// renders as "level 1, no xp yet" rather than treating as an error.
	async findOne(guildId: string, userId: string) {
		return MemberLevel.findOne({ guildId, userId });
	},

	// The batched write behind every flush. The caller composes the ops, because
	// only it knows which deltas accumulated; this store just issues them.
	//
	// ordered:false is deliberate and not a default worth overriding: one failing
	// op (a duplicate key from a concurrent upsert) must not abandon the rest of
	// the batch, which would silently drop every later member's xp in that flush.
	async bulkWrite(operations: AnyBulkWriteOperation<IMemberLevel>[]) {
		if (operations.length === 0) return null;
		return MemberLevel.bulkWrite(operations, { ordered: false });
	},

	// Read back a set of members in one query, which is what lets the flush detect
	// level crossings without a findOneAndUpdate per member. Matches the unique
	// { guildId, userId } index. Guild scoped like everything else here, so a
	// userId from another guild simply does not come back.
	async findManyInGuild(guildId: string, userIds: string[]) {
		if (userIds.length === 0) return [];
		return MemberLevel.find({ guildId, userId: { $in: userIds } });
	},

	// The write-through path for a single award (a game result, an admin
	// correction), and the upsert every new member's row is born from.
	//
	// Returns the POST-increment document, which is what makes level up detection
	// work without a second read: $inc is server side and atomic, so the returned
	// totalXp is the truth and the previous total is exactly it minus the amount
	// awarded. Callers derive both levels from that.
	async incrementAndReturn(
		guildId: string,
		userId: string,
		username: string | undefined,
		increments: Record<string, number>
	) {
		return MemberLevel.findOneAndUpdate(
			{ guildId, userId },
			{
				$inc: increments,
				// username is refreshed on every award so a nickname change is picked
				// up without a backfill; guildId and userId only matter on insert.
				//
				// ⚠️ ONLY WHEN THE CALLER ACTUALLY RESOLVED ONE. Because this is a WRITE on every
				// award rather than a hint used on insert, an unresolved caller that passed a
				// fallback would overwrite a real display name on /account, /levels and
				// LevelsBoard, and it would STAY overwritten until that member's next award from
				// a path that could resolve a name. Nothing errors and no test fails, which is
				// why the fix belongs here rather than at each call site: a caller that cannot
				// resolve a name passes undefined and still gets its xp credited.
				$set: username ? { username, lastAwardAt: new Date() } : { lastAwardAt: new Date() },
				$setOnInsert: { guildId, userId },
			},
			{ new: true, upsert: true }
		);
	},

	// ── the announcement claim ──
	// Atomically raise the high water mark, and report whether THIS caller was the
	// one who raised it. The filter is the whole mechanism: a concurrent flush that
	// already announced this level leaves announcedLevel at or above newLevel, the
	// filter no longer matches, modifiedCount comes back 0, and the loser skips
	// silently. Without it, two flushes crossing the same boundary both announce.
	async claimAnnouncement(guildId: string, userId: string, newLevel: number): Promise<boolean> {
		const result = await MemberLevel.updateOne(
			{ guildId, userId, announcedLevel: { $lt: newLevel } },
			{ $set: { announcedLevel: newLevel } }
		);
		return result.modifiedCount > 0;
	},

	// Append unlocked achievement tiers. $addToSet rather than $push so a replayed
	// unlock cannot duplicate an entry, and never a read-modify-write so two
	// unlocks landing together cannot overwrite each other.
	async addUnlocked(guildId: string, userId: string, entries: IMemberLevel["unlocked"]) {
		if (entries.length === 0) return null;
		return MemberLevel.findOneAndUpdate(
			{ guildId, userId },
			{ $addToSet: { unlocked: { $each: entries } } },
			{ new: true }
		);
	},

	// ── rank, as an index-only count ──
	// Exactly the query the { guildId, totalXp: -1 } index exists for. Counting
	// the members ahead of you is O(index scan of that prefix) and exact, and it
	// stays fast one to two orders of magnitude past this bot's size. Do NOT
	// replace this with a find().sort(): fetching a guild to number one member is
	// the mistake this method exists to prevent.
	async rankOf(guildId: string, totalXp: number): Promise<number> {
		return (await MemberLevel.countDocuments({ guildId, totalXp: { $gt: totalXp } })) + 1;
	},

	// The all-time board and /levels all-time. Sorted by the same index rank
	// counts against, so the two surfaces can never disagree about the order.
	async topByTotalXp(guildId: string, limit = 10) {
		return MemberLevel.find({ guildId }).sort({ totalXp: -1 }).limit(limit);
	},

	async countInGuild(guildId: string): Promise<number> {
		return MemberLevel.countDocuments({ guildId });
	},

	// ── admin correction ──
	// /xp set-xp writes an absolute value, unlike every other path here. It also
	// resets announcedLevel, because lowering a member's xp below a level they
	// already reached must let that level announce again if they climb back.
	async setTotalXp(guildId: string, userId: string, username: string, totalXp: number, announcedLevel: number) {
		return MemberLevel.findOneAndUpdate(
			{ guildId, userId },
			{ $set: { totalXp, announcedLevel, lastAwardAt: new Date() }, $setOnInsert: { guildId, userId, username } },
			{ new: true, upsert: true }
		);
	},

	// /xp reset-member. Guild scoped, and the row is removed rather than zeroed so
	// a reset member is genuinely absent from every board rather than sitting at
	// the bottom of it.
	async deleteMember(guildId: string, userId: string) {
		return MemberLevel.deleteOne({ guildId, userId });
	},

	// /xp reset-server. The single destructive operation in the feature: admin
	// gated, confirm-button guarded at the command layer, and scoped to the
	// guild's own data.
	async deleteGuild(guildId: string) {
		return MemberLevel.deleteMany({ guildId });
	},
};
