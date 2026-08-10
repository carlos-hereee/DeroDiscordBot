import { Router, Request, Response } from "express";
import { Client } from "discord.js";
import { activityStore } from "@db/stores/activityStore.js";
import { eventStore } from "@db/stores/eventStore.js";
import { requireGuildId } from "../middleware/requireGuildId.js";
import { enrichWithNicknames } from "../utils/enrichWithNicknames.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

type PlayersRequest = Request<
	{ userId: string }, // ← Params:      req.params.userId
	any, // ← ResBody:      what res.json() sends back
	any, // ← ReqBody:      req.body shape
	{ mode?: string; occurrence?: string; guildId?: string } // ← QueryString:  req.query shape
>;

// ── PlayerSummary ─────────────────────────────────────────────
// What:  the wire shape of a single row on the GET /api/players list, one
//        warrior with their aggregate stats across every event in this guild.
// Who:   dashboard's PluginContext.fetchPlayers reads this off data.data
//        and renders the players grid.
// Where: declared because activityStore.findAllGroupedByPlayerInEvents is a
//        Mongo aggregation that returns rows shaped { _id: userId, ...sums }
//        with no `userId` field. Without normalizing, enrichWithNicknames
//        had nothing to match members against AND TypeScript inferred T
//        as the raw aggregation document where username is not assignable.
interface PlayerSummary {
	userId: string;
	username: string;
	totalScore: number;
	eventsAttended: number;
	totalVoiceMinutes: number;
	totalAcknowledged: number;
}

// ── PlayerActivityRow ─────────────────────────────────────────
// What:  one PlayerActivity record flattened to the wire. Same fields as
//        the PlayerActivity Mongoose document, but as a plain object so
//        enrichWithNicknames can spread it without TS rejecting the
//        Document subtype assignment.
// Who:   dashboard's PluginContext.fetchPlayer reads a list of these and
//        renders the activity history table.
interface PlayerActivityRow {
	userId: string;
	username: string;
	eventId: string;
	eventOccurrence: Date;
	participationScore: number;
	voiceMinutes: number;
	acknowledgedReminder: boolean;
	wasOnlineAtStart: boolean;
	joinedVoiceDuring: boolean;
	// Mongoose schema declares acknowledgedAt as optional Date and explicit null
	// shows up when the field has been written then cleared. Widening to include
	// null lets us pass the DB value through unchanged so the dashboard sees the
	// same JSON shape it would have seen calling the bot directly.
	acknowledgedAt?: Date | null;
}

// ── helper ────────────────────────────────────────────────────
// PlayerActivity does not store guildId directly (the model is keyed on
// eventId + eventOccurrence + userId). to scope player queries to a single
// guild we look up the guild's events first, collect their eventIds, and
// pass that set into the activityStore. this keeps the model unchanged
// while honoring the v1 multi-guild safety contract from spec section 3.
async function getEventIdsForGuild(guildId: string): Promise<string[]> {
	const events = await eventStore.findByGuildId(guildId);
	return events.map((e) => e.eventId);
}

// factory: like createEventsRouter, the Discord client is a dependency
// because the nickname backfill needs to resolve GuildMember objects from
// the live client cache. The pure DB read paths still work even if the
// client is missing the guild, enrichWithNicknames returns the records
// untouched in that case.
export function createPlayersRouter(client: Client): Router {
	const playersRouter = Router();

	// GET /api/players?guildId=..., all players ranked by total score across
	// the requesting guild's events only
	playersRouter.get("/", async (req: PlayersRequest, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		try {
			const eventIds = await getEventIdsForGuild(guildId);
			// Aggregation rows come back as { _id: <userId>, username, totalScore, ... }
			// because the $group stage uses _id: "$userId". Pivot _id to userId so
			// enrichWithNicknames has the field it expects AND the dashboard does
			// not have to know about the Mongo aggregation key naming.
			const aggregated = await activityStore.findAllGroupedByPlayerInEvents(eventIds);
			const records: PlayerSummary[] = aggregated.map((row: { _id: string; username: string; totalScore: number; eventsAttended: number; totalVoiceMinutes: number; totalAcknowledged: number }) => ({
				userId: row._id,
				username: row.username,
				totalScore: row.totalScore,
				eventsAttended: row.eventsAttended,
				totalVoiceMinutes: row.totalVoiceMinutes,
				totalAcknowledged: row.totalAcknowledged,
			}));
			const enriched = await enrichWithNicknames(client, guildId, records);
			res.json({ data: enriched });
		} catch (error) {
			console.log(LOG_MESSAGES.api.errorFindingPlayers, error, LOG_MESSAGES.api.errorSuffix);
			res.status(500).json({ error: "Failed to fetch players" });
		}
	});

	// GET /api/players/:userId?guildId=..., full activity history for one
	// player, scoped to the requesting guild's events
	playersRouter.get("/:userId", async (req: PlayersRequest, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		try {
			const eventIds = await getEventIdsForGuild(guildId);
			// findByUserInEvents returns hydrated Mongoose Documents. Map to the
			// plain PlayerActivityRow shape so the wire response is plain JSON
			// AND enrichWithNicknames can reassign `username` without TS
			// rejecting the spread on a Document type.
			const docs = await activityStore.findByUserInEvents(req.params.userId, eventIds);
			if (!docs.length) {
				res.status(404).json({ error: "No activity found for this player" });
				return;
			}
			const records: PlayerActivityRow[] = docs.map((d) => ({
				userId: d.userId,
				username: d.username,
				eventId: d.eventId,
				eventOccurrence: d.eventOccurrence,
				participationScore: d.participationScore,
				voiceMinutes: d.voiceMinutes,
				acknowledgedReminder: d.acknowledgedReminder,
				wasOnlineAtStart: d.wasOnlineAtStart,
				joinedVoiceDuring: d.joinedVoiceDuring,
				acknowledgedAt: d.acknowledgedAt,
			}));
			const enriched = await enrichWithNicknames(client, guildId, records);
			res.json({ data: enriched });
		} catch (error) {
			console.log(LOG_MESSAGES.api.errorFindingPlayerActivity, error, LOG_MESSAGES.api.errorSuffix);
			res.status(500).json({ error: "Failed to fetch player activity" });
		}
	});

	return playersRouter;
}
