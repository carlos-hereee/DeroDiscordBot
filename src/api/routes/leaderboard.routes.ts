import { Router, Request, Response } from "express";
import { Client } from "discord.js";
import { activityStore } from "@db/stores/activityStore.js";
import { eventStore } from "@db/stores/eventStore.js";
import { requireGuildId } from "../middleware/requireGuildId.js";
import { enrichWithNicknames } from "../utils/enrichWithNicknames.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

type LeaderboardRequest = Request<
	{ eventId: string }, // ← Params:      req.params.eventId
	any, // ← ResBody:      what res.json() sends back
	any, // ← ReqBody:      req.body shape
	{ mode?: string; occurrence?: string; guildId?: string } // ← QueryString:  req.query shape
>;

// ── LeaderboardRow ────────────────────────────────────────────
// What:  the canonical wire shape for a single leaderboard row, identical
//        across both query modes (alltime aggregate AND single occurrence).
// Who:   the dashboard's PluginContext.fetchLeaderboard reads this off
//        data.data.records and renders it directly.
// When:  used as the response shape of GET /api/leaderboard/:eventId for
//        every mode.
// Where: introduced because activityStore.findByEventAndOccurrence returns
//        hydrated Mongoose Documents while the all-time path builds plain
//        objects from a Map. Without a normalize step the two branches had
//        incompatible types and enrichWithNicknames<T> inferred T from the
//        Document branch, where username is not a settable field, that
//        broke the build with TS2345 on the spread inside the helper.
// How:   we shape both branches into LeaderboardRow before enrichment so
//        the helper's `T extends { userId; username }` constraint is met
//        and the response payload is the same regardless of mode.
interface LeaderboardRow {
	userId: string;
	username: string;
	totalScore: number;
	eventsAttended: number;
	totalVoiceMinutes: number;
	totalAcknowledged: number;
}

// factory: the Discord client is a dependency because the response is
// enriched with each warrior's CURRENT per guild nickname at read time.
// Pure DB reads still work if the client cannot resolve the guild (the
// helper returns the records untouched).
export function createLeaderboardRouter(client: Client): Router {
	const leaderboardRouter = Router();

	// GET /api/leaderboard/:eventId?guildId=...&mode=alltime|occurrence&occurrence=ISO_DATE
	// mode=alltime    → cumulative scores across all occurrences
	// mode=occurrence → scores for one specific occurrence
	leaderboardRouter.get("/:eventId", async (req: LeaderboardRequest, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		try {
			const { eventId } = req.params;
			const mode = (req.query.mode as string) ?? "alltime";
			const occurrence = req.query.occurrence as string;

			// findByIdInGuild applies the guild scope at the store layer. The 404 (not 403)
			// on cross-guild is preserved, the store returns null for either missing or
			// wrong-guild and we do not distinguish them in the public response.
			const event = await eventStore.findByIdInGuild(eventId, guildId);
			if (!event) {
				res.status(404).json({ error: "Event not found" });
				return;
			}

			let records: LeaderboardRow[];

			if (mode === "occurrence" && occurrence) {
				// scores for one specific occurrence. activityStore returns
				// hydrated Mongoose Documents here; map into the plain
				// LeaderboardRow shape so both branches return the same wire
				// type AND so enrichWithNicknames can reassign username
				// without TypeScript rejecting the spread on a Document.
				const occurrenceRecords = await activityStore.findByEventAndOccurrence(eventId, new Date(occurrence));
				records = occurrenceRecords.map((r) => ({
					userId: r.userId,
					username: r.username,
					totalScore: r.participationScore,
					// per-occurrence rows are by definition one event each, so
					// eventsAttended is always 1. We still emit the field so
					// the dashboard's leaderboard renderer does not need to
					// branch on mode to read totals.
					eventsAttended: 1,
					totalVoiceMinutes: r.voiceMinutes,
					totalAcknowledged: r.acknowledgedReminder ? 1 : 0,
				}));
			} else {
				// all time, fetch all records and aggregate per player
				const all = await activityStore.findByEvent(eventId);

				// group by userId and sum their scores
				const playerMap = new Map<string, LeaderboardRow>();

				for (const record of all) {
					const existing = playerMap.get(record.userId);
					if (existing) {
						existing.totalScore += record.participationScore;
						existing.eventsAttended += 1;
						existing.totalVoiceMinutes += record.voiceMinutes;
						existing.totalAcknowledged += record.acknowledgedReminder ? 1 : 0;
					} else {
						playerMap.set(record.userId, {
							userId: record.userId,
							username: record.username,
							totalScore: record.participationScore,
							eventsAttended: 1,
							totalVoiceMinutes: record.voiceMinutes,
							totalAcknowledged: record.acknowledgedReminder ? 1 : 0,
						});
					}
				}

				// sort by total score descending
				records = Array.from(playerMap.values()).sort((a, b) => b.totalScore - a.totalScore);
			}

			// Backfill nicknames at read time so legacy rows (written before the
			// nickname tracking change) render the warrior's current per guild
			// display name instead of the bare Discord username. Records keep
			// whatever username they had stored when the helper can not resolve
			// a member, so a row never goes blank.
			const enriched = await enrichWithNicknames(client, guildId, records);

			res.json({
				data: { event: { eventId: event.eventId, name: event.name }, mode, records: enriched },
			});
		} catch (error) {
			console.log(LOG_MESSAGES.api.errorFindingLeaderboard, error, LOG_MESSAGES.api.errorSuffix);
			res.status(500).json({ error: "Failed to fetch leaderboard" });
		}
	});

	return leaderboardRouter;
}
