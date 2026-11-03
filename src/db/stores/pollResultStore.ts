import PollResultModel from "@db/models/PollResult.js";

// Thin data-access wrapper for poll votes. Business logic (which poll is
// active, how votes are framed) lives in the polls feature, not here.
export const pollResultStore = {
	// Record (or change) a member's vote. Upsert on the unique
	// (pollId, guildId, userId) key so a re-vote updates the choice and never
	// double-counts.
	async recordVote(pollId: string, guildId: string, userId: string, choice: string) {
		return PollResultModel.findOneAndUpdate(
			{ pollId, guildId, userId },
			{ $set: { choice }, $setOnInsert: { pollId, guildId, userId } },
			{ new: true, upsert: true }
		);
	},

	// Cross-guild tally for a poll: choice key -> vote count. Used by the
	// platform-owner results log line. Returns an empty object when no votes
	// have been cast yet.
	async tally(pollId: string): Promise<Record<string, number>> {
		const rows = (await PollResultModel.aggregate([
			{ $match: { pollId } },
			{ $group: { _id: "$choice", count: { $sum: 1 } } },
		])) as { _id: string; count: number }[];

		const counts: Record<string, number> = {};
		for (const row of rows) counts[row._id] = row.count;
		return counts;
	},

	// Self destruct's server data delete (post-launch plan item 10): every row this guild owns.
	async deleteGuild(guildId: string) {
		return PollResultModel.deleteMany({ guildId });
	},
};
