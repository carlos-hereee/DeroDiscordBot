import { Router, Request, Response } from "express";
import { Client } from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { fireTestReminder } from "@features/reminders/TestReminderJob.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { requireGuildId } from "../middleware/requireGuildId.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";

// fire and forget helper. the schedule board refresh is a Discord API call
// that should never block the HTTP response. errors are logged; on the
// next successful mutation or the hourly tick the board converges.
function kickScheduleRefresh(client: Client, guildId: string, trigger: string): void {
	refreshSchedule(client, guildId).catch((err) => console.error(LOG_MESSAGES.schedule.refreshAfterRouteFailed(trigger), err));
}

// ── rate limiter for POST /:eventId/test-reminder ─────────────
// in-memory map keyed by `${guildId}:${eventId}` -> last fire timestamp (ms).
// resets on bot restart, which is acceptable for a test fire feature.
// lives at module scope so the limiter is shared across all requests.
const testReminderLastFiredAt = new Map<string, number>();

// ── the schedule a write may store (2026-10 item 280) ──
// getUpcomingOccurrences walks forward one interval at a time, so a negative, NaN or
// infinite interval, or an anchor that is no date, once froze the whole bot inside a
// reminder tick. The calculator now reads such a row as having no start; these routes
// refuse to write one at all, so the dashboard hears a 400 instead of a silent event.

// The fields PATCH may write: the ones the dashboard's edit form and pause buttons send,
// matching the platform server's own PATCH body (updateEvent.ts), plus imageUrl for the
// upload flow. Anything else (active, guildId, eventId, _id) is dropped, so a PATCH can
// neither undelete an event nor rewrite its identity.
const PATCHABLE_EVENT_FIELDS = [
	"name",
	"description",
	"type",
	"intervalHours",
	"firstOccurrence",
	"seasonEnd",
	"reminderOffsets",
	"prepSteps",
	"mentionRoleId",
	"paused",
	"pausedUntil",
	"imageUrl",
] as const;

// The fields POST may write: every PATCH field plus the weekly zone a create may set. The
// route adds guildId itself, and active, eventId and _id stay the schema's own, so a create
// can neither land deleted nor pick its own id (2026-10 item 280, owner ruling).
const CREATABLE_EVENT_FIELDS = [...PATCHABLE_EVENT_FIELDS, "timezone"] as const;

/** Keep only `fields` from a write's body, so a body cannot reach any other column. */
function pickEventFields(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const field of fields) {
		if (body[field] !== undefined) picked[field] = body[field];
	}
	return picked;
}

/**
 * Why a write's schedule cannot be stored, or null when it can. `stored` is the event as
 * it stands for a PATCH, so a body naming only `type` is checked against the stored
 * interval. The recurring floor is checked only when the write touches type or interval,
 * so pausing an older event never fails on a value it was created with.
 */
function scheduleProblem(body: Record<string, unknown>, stored?: { type?: unknown; intervalHours?: unknown }): string | null {
	if (body.intervalHours !== undefined && (typeof body.intervalHours !== "number" || !Number.isFinite(body.intervalHours) || body.intervalHours < 0)) {
		return "intervalHours must be a finite number of hours, 0 or more";
	}
	if (body.firstOccurrence !== undefined && Number.isNaN(new Date(body.firstOccurrence as string | number | Date).getTime())) {
		return "firstOccurrence is not a valid date";
	}
	if (body.type === undefined && body.intervalHours === undefined) return null;
	const type = body.type ?? stored?.type;
	const intervalHours = body.intervalHours ?? stored?.intervalHours;
	if (type === "recurring" && !(typeof intervalHours === "number" && intervalHours >= BOT_CONSTANTS.MIN_RECURRING_INTERVAL_HOURS)) {
		return `a recurring event repeats every ${BOT_CONSTANTS.MIN_RECURRING_INTERVAL_HOURS} hour or more`;
	}
	return null;
}

type EventsRequest = Request<
	{ eventId: string }, // ← Params:      req.params.eventId
	any, // ← ResBody:      what res.json() sends back
	any, // ← ReqBody:      req.body shape
	{ mode?: string; occurrence?: string; guildId?: string } // ← QueryString:  req.query shape
>;

// factory: the Discord client is a dependency because POST /:eventId/test-reminder
// needs to post to a channel. the rest of the routes do not use it.
export function createEventsRouter(client: Client): Router {
	const eventsRouter = Router();

	// GET /api/events?guildId=..., list all active events for one guild
	eventsRouter.get("/", async (req: EventsRequest, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		try {
			const events = await eventStore.findByGuildId(guildId);
			res.json({ data: events });
		} catch (error) {
			console.log(LOG_MESSAGES.api.errorFindingEvents, error, LOG_MESSAGES.api.errorSuffix);
			res.status(500).json({ error: "Failed to fetch events" });
		}
	});

	// GET /api/events/:eventId?guildId=..., get one event, scoped to guild
	eventsRouter.get("/:eventId", async (req: EventsRequest, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		try {
			// findByIdInGuild applies the guild scope at the store layer, same shape
			// under the local-DB path and the remote-API path. The redundant guildId
			// check that used to follow has been removed.
			const event = await eventStore.findByIdInGuild(req.params.eventId, guildId);
			if (!event) {
				res.status(404).json({ error: "Event not found" });
				return;
			}
			res.json({ data: event });
		} catch (error) {
			console.log(LOG_MESSAGES.api.errorFindingEvent, error, LOG_MESSAGES.api.errorSuffix);
			res.status(500).json({ error: "Failed to fetch event" });
		}
	});

	// POST /api/events?guildId=..., create a new event. body.guildId must
	// match the query guildId. if the body omits guildId, we inject it from
	// the query so the dashboard can post a slimmer payload.
	eventsRouter.post("/", async (req: EventsRequest, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		try {
			const body = { ...(req.body ?? {}) };
			if (body.guildId && body.guildId !== guildId) {
				res.status(400).json({
					error: "Body guildId does not match query guildId",
					detail: "These must match or the body guildId must be omitted.",
				});
				return;
			}
			body.guildId = guildId;
			const problem = scheduleProblem(body);
			if (problem) {
				res.status(400).json({ error: "Invalid event schedule", detail: problem });
				return;
			}
			// defensive strip: the Event schema has no channelId field and
			// mongoose strict mode would silently drop it anyway, but we
			// remove it here too so an older dashboard build sending the old
			// shape does not get a confusing silent success. the single source
			// of truth for where a reminder posts is guildConfig.announcementsChannelId.
			delete body.channelId;

			// ── announcement type → seasonEnd derivation ──────────────
			// What:  the dashboard form picks "kvk" or "regular" up front.
			//        kvk inherits seasonEnd from GuildConfig.kvkSeasonEnd
			//        (single source of truth per guild). regular has no
			//        season scope and stores null.
			// Who:   EventCreatePage on the dashboard sends announcementType.
			//        Legacy clients that omit the field fall through to the
			//        backward-compatible path: if body.seasonEnd is present
			//        we honor it as before (covers the slash command's
			//        in-process create call too).
			// When:  every POST /api/events. Pure validation step before
			//        eventStore.create touches Mongo.
			// Where: announcementType never lands in the document, it is
			//        the form's choice, the persisted value is seasonEnd
			//        (Date or null). Stripped after derivation so mongoose
			//        strict mode does not drop it as a silent no-op.
			// How:   ① if announcementType is "kvk" we look up the guild's
			//        kvkSeasonEnd; missing → 400 with a hint pointing to
			//        /events kvk-season. ② "regular" forces seasonEnd
			//        to null even if the body sent a stale date. ③ unset
			//        keeps body.seasonEnd as the caller passed it (legacy
			//        and slash command paths both supply it directly).
			const announcementType = body.announcementType as "kvk" | "regular" | undefined;
			if (announcementType === "kvk") {
				const config = await guildConfigStore.findByGuildId(guildId);
				const seasonEnd = config?.kvkSeasonEnd ?? null;
				if (!seasonEnd) {
					res.status(400).json({
						error: "No active KvK season",
						detail: "Run /events kvk-season in Discord before creating KvK events.",
					});
					return;
				}
				body.seasonEnd = seasonEnd;
			} else if (announcementType === "regular") {
				body.seasonEnd = null;
			}
			delete body.announcementType;

			// The cast only restates what the body always was: the Event schema's required fields
			// are what refuse a create missing a name, type or start, as before the allowlist.
			const fields = { ...pickEventFields(body, CREATABLE_EVENT_FIELDS), guildId } as Parameters<typeof eventStore.create>[0];
			const event = await eventStore.create(fields);
			res.status(201).json({ data: event });
			adminLog.emit({ guild: { id: guildId, client }, kind: "event.create", actor: { source: "dashboard" }, payload: { subject: String(body.name ?? ""), detail: setupCopy.adminLog.created } });
			kickScheduleRefresh(client, guildId, "POST /api/events");
		} catch (error) {
			console.log(LOG_MESSAGES.api.errorCreatingEvent, error, LOG_MESSAGES.api.errorSuffix);
			res.status(500).json({ error: "Failed to create event" });
		}
	});

	// PATCH /api/events/:eventId?guildId=..., update an event the guild owns
	eventsRouter.patch("/:eventId", async (req: EventsRequest, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		try {
			const existing = await eventStore.findByIdInGuild(req.params.eventId, guildId);
			if (!existing) {
				res.status(404).json({ error: "Event not found" });
				return;
			}
			// disallow moving an event between guilds via PATCH. if the body
			// contains guildId it must match, otherwise the allowlist below drops it.
			const body = { ...(req.body ?? {}) };
			if (body.guildId && body.guildId !== guildId) {
				res.status(400).json({ error: "Cannot change guildId via PATCH" });
				return;
			}
			const patch = pickEventFields(body, PATCHABLE_EVENT_FIELDS);
			const problem = scheduleProblem(patch, existing);
			if (problem) {
				res.status(400).json({ error: "Invalid event schedule", detail: problem });
				return;
			}
			const updated = await eventStore.updateInGuild(req.params.eventId, guildId, patch);
			res.json({ data: updated });
			adminLog.emit({ guild: { id: guildId, client }, kind: "event.update", actor: { source: "dashboard" }, payload: { subject: existing.name, detail: setupCopy.adminLog.updated } });
			kickScheduleRefresh(client, guildId, "PATCH /api/events/:eventId");
		} catch (error) {
			console.log(LOG_MESSAGES.api.errorUpdatingEvent, error, LOG_MESSAGES.api.errorSuffix);
			res.status(500).json({ error: "Failed to update event" });
		}
	});

	// DELETE /api/events/:eventId?guildId=..., soft delete an event the guild owns
	eventsRouter.delete("/:eventId", async (req: EventsRequest, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		try {
			const existing = await eventStore.findByIdInGuild(req.params.eventId, guildId);
			if (!existing) {
				res.status(404).json({ error: "Event not found" });
				return;
			}
			await eventStore.deleteInGuild(req.params.eventId, guildId);
			res.json({ message: "Event deactivated" });
			adminLog.emit({ guild: { id: guildId, client }, kind: "event.delete", actor: { source: "dashboard" }, payload: { subject: existing.name, detail: setupCopy.adminLog.deleted } });
			kickScheduleRefresh(client, guildId, "DELETE /api/events/:eventId");
		} catch (error) {
			console.log(LOG_MESSAGES.api.errorDeletingEvent, error, LOG_MESSAGES.api.errorSuffix);
			res.status(500).json({ error: "Failed to delete event" });
		}
	});

	// ── POST /api/events/:eventId/test-reminder?guildId=... ────────
	// fires a TEST reminder embed to the event's configured channel.
	// this is the only route on eventsRouter that depends on the Discord client.
	// see features/reminders/TestReminderJob.ts for the invariants this route upholds.
	eventsRouter.post("/:eventId/test-reminder", async (req: EventsRequest, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		try {
			// ① look up the event. 404 if missing, soft-deleted, or owned by
			// a different guild. returning 404 (not 403) for the wrong-guild
			// case is deliberate: do not leak the existence of events belonging
			// to other guilds.
			//
			// Diagnostic logging: the public response stays a generic 404 (no
			// existence leak), but we log the discriminating reason server-side
			// so the next time a user reports "test reminder 404s on this
			// event" we can read the bot console and see whether the doc is
			// missing entirely or whether the requesting guildId does not match
			// the doc's guildId. The wrong-guild branch is the most likely
			// real-world cause: it fires when an admin's pluginConfig.guildId
			// on companyuno was changed after events were created under the
			// previous guildId, and the dashboard's stale cached event list
			// still references those orphaned eventIds.
			// findByIdInGuild collapses "missing" and "wrong-guild" into a single null at
			// the store layer. We lose the diagnostic split that distinguished them in
			// the warn log, but production triage almost always lands on the same root
			// cause anyway (stale dashboard list after a guildId swap), so a single
			// missing-or-mismatch line is sufficient.
			const event = await eventStore.findByIdInGuild(req.params.eventId, guildId);
			if (!event) {
				console.warn(
					`[test-reminder] 404 reason=missing-or-guild-mismatch eventId=${req.params.eventId} guildId=${guildId}`
				);
				res.status(404).json({
					error: "Event not found",
					detail: "This event no longer exists. Refresh the page to load the current list.",
				});
				return;
			}

			// ② enforce the per-event cooldown. keyed on guildId + eventId so
			// two different guilds testing two different events never block each
			// other, and two different events in the same guild never block each
			// other. this is the only client-visible rate limit.
			const key = `${event.guildId}:${event.eventId}`;
			const now = Date.now();
			const last = testReminderLastFiredAt.get(key);
			if (last && now - last < BOT_CONSTANTS.TEST_REMINDER_COOLDOWN_MS) {
				const retryAfterMs = BOT_CONSTANTS.TEST_REMINDER_COOLDOWN_MS - (now - last);
				res.status(429).json({
					error: "Test reminder cooldown in effect",
					retryAfterMs,
					retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
				});
				return;
			}

			// ③ dispatch the fire. fireTestReminder is responsible for the
			// [TEST] prefix, skipping the dedup guard via the sentinel offset,
			// and never writing to PlayerActivity.
			const result = await fireTestReminder(client, event);

			if (!result.ok) {
				// map the known reasons to readable 409s so the dashboard can
				// surface them through LogMessages. the explicit union keeps the
				// record exhaustive: adding a new reason to TestReminderJob
				// without updating this mapping is a compile time error.
				const detailByReason: Record<
					"guild_not_configured" | "channel_not_found" | "channel_wrong_type" | "post_failed",
					string
				> = {
					guild_not_configured: "This guild has not finished /setup yet. Run /setup in Discord first.",
					channel_not_found: "The herald cannot reach that channel. Verify bot permissions in Discord.",
					channel_wrong_type: "The configured channel is not a text channel.",
					post_failed: "The decree could not be delivered to the channel.",
				};
				res.status(409).json({
					error: detailByReason[result.reason],
					reason: result.reason,
					detail: result.detail,
				});
				return;
			}

			// ④ record the successful fire for the cooldown tracker only AFTER
			// the post succeeds. failed posts do not count against the cooldown.
			testReminderLastFiredAt.set(key, now);

			res.json({
				data: {
					ok: true,
					messageId: result.messageId,
					channelId: result.channelId,
					firedAt: result.firedAt,
					cooldownMs: BOT_CONSTANTS.TEST_REMINDER_COOLDOWN_MS,
				},
			});
		} catch (error) {
			console.log(LOG_MESSAGES.api.errorTestReminder, error, LOG_MESSAGES.api.errorSuffix);
			res.status(500).json({ error: "Failed to fire test reminder" });
		}
	});

	return eventsRouter;
}
