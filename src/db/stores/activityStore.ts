import PlayerActivityModel from "@db/models/PlayerActivity.js";
import { IPlayerActivity } from "@features/activity-tracking/activity.types";

interface IUpsertActivity {
	eventId: string;
	eventOccurrence: Date;
	userId: string;
	username: string;
	data: Partial<Omit<IPlayerActivity, "eventId" | "eventOccurrence" | "userId" | "username">>;
}

export const activityStore = {
	// core method, creates record if it doesn't exist, updates if it does
	// this is called from multiple places so upsert is safer than create
	async upsert({ eventId, eventOccurrence, userId, username, data }: IUpsertActivity) {
		return PlayerActivityModel.findOneAndUpdate(
			// ← the unique key: one record per player per occurrence
			{ eventId, eventOccurrence, userId },
			{
				// only set username and eventId on first insert
				$setOnInsert: { eventId, eventOccurrence, userId, username },
				// merge in whatever activity data changed
				$set: data,
			},
			// new: true returns the updated doc
			// upsert: true creates it if it doesn't exist
			{ new: true, upsert: true }
		);
	},

	// used by leaderboard route for specific occurrence view
	async findByEventAndOccurrence(eventId: string, eventOccurrence: Date) {
		return PlayerActivityModel.find({ eventId, eventOccurrence }).sort({ participationScore: -1 });
	},

	// used by players route for global ranking across all events
	async findAllGroupedByPlayer() {
		return PlayerActivityModel.aggregate([
			{
				$group: {
					_id: "$userId",
					username: { $last: "$username" },
					totalScore: { $sum: "$participationScore" },
					eventsAttended: { $sum: 1 },
					totalVoiceMinutes: { $sum: "$voiceMinutes" },
					totalAcknowledged: { $sum: { $cond: ["$acknowledgedReminder", 1, 0] } },
				},
			},
			{ $sort: { totalScore: -1 } },
		]);
	},

	// same as findAllGroupedByPlayer but scoped to a fixed set of eventIds.
	// used by the dashboard's players route so a query is scoped to a single
	// guild's events. the route handler fetches the guild's events first,
	// collects their eventIds, and passes them here.
	// if eventIds is empty, returns an empty array (no matching events → no data).
	// dateRange (optional) restricts the aggregation to records whose
	// eventOccurrence falls within [from, to]. Used by /leaderboard's
	// "This month" and "This week" branches so the same primitive renders
	// the all-time, this-month, and this-week views without separate
	// queries. Omit dateRange for the all-time view (existing behavior).
	async findAllGroupedByPlayerInEvents(eventIds: string[], dateRange?: { from: Date; to: Date }) {
		if (eventIds.length === 0) return [];
		const match: Record<string, unknown> = { eventId: { $in: eventIds } };
		if (dateRange) {
			match.eventOccurrence = { $gte: dateRange.from, $lte: dateRange.to };
		}
		return PlayerActivityModel.aggregate([
			{ $match: match },
			{
				$group: {
					_id: "$userId",
					username: { $last: "$username" },
					totalScore: { $sum: "$participationScore" },
					eventsAttended: { $sum: 1 },
					totalVoiceMinutes: { $sum: "$voiceMinutes" },
					totalAcknowledged: { $sum: { $cond: ["$acknowledgedReminder", 1, 0] } },
				},
			},
			{ $sort: { totalScore: -1 } },
		]);
	},

	// same as findByUser but scoped to a fixed set of eventIds.
	// used by the dashboard's per-player history route so a player's activity
	// is only returned for events belonging to the requesting guild.
	// if eventIds is empty, returns an empty array.
	async findByUserInEvents(userId: string, eventIds: string[]) {
		if (eventIds.length === 0) return [];
		return PlayerActivityModel.find({ userId, eventId: { $in: eventIds } }).sort({ eventOccurrence: -1 });
	},

	// used by leaderboard command
	async findByEvent(eventId: string) {
		return PlayerActivityModel.find({ eventId }).sort({ participationScore: -1 });
	},

	// used to get one player's history across all events
	async findByUser(userId: string) {
		return PlayerActivityModel.find({ userId }).sort({ eventOccurrence: -1 });
	},

	// used to get one specific record, e.g. to update voiceMinutes
	async findOne(eventId: string, eventOccurrence: Date, userId: string) {
		return PlayerActivityModel.findOne({ eventId, eventOccurrence, userId });
	},

	// Retention cleanup (audit H7). Deletes rows whose occurrence is older than
	// `cutoff`. Called by the daily retention cron, which only runs when the
	// owner has set PLAYER_ACTIVITY_RETENTION_DAYS, this method never runs on
	// its own. Returns the delete count for the cron's log line.
	async deleteOlderThan(cutoff: Date): Promise<number> {
		const result = await PlayerActivityModel.deleteMany({ eventOccurrence: { $lt: cutoff } });
		return result.deletedCount ?? 0;
	},
};
