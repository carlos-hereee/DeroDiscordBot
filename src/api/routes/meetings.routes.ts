import { Router, type Request, type Response } from "express";
import type { Client } from "discord.js";
import { MEETING_STATUSES, type IMeeting, type MeetingStatus } from "@db/models/Meeting.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { meetingTranscriptStore } from "@db/stores/meetingTranscriptStore.js";
import { deleteMeeting, type DeleteMeetingRefusal } from "@features/meetings/meetingLifecycle.js";
import { editScheduledMeeting, scheduleMeeting, type MeetingRefusal } from "@features/meetings/scheduledMeetings.js";
import { resolveSpeakerNames } from "@features/meetings/speakerNames.js";
import { requireGuildId } from "../middleware/requireGuildId.js";
import { isSchedulableTime, readOptionalDate, strictBody, type Body } from "../utils/bodyGuards.js";
import { clampLimit, nextCursor, parseCursor } from "../utils/keysetCursor.js";
import { withoutMongoKeys } from "../utils/withoutMongoKeys.js";

// ── /api/meetings ───────────────────────────────────────────────────────────
// What:  the dashboard's Meetings tab reads and edits a server's meetings (2026-11 item 388
//        Phase 5a, owner decision D19): list, read one with its transcript while it is kept,
//        schedule, change a scheduled one, and cancel or delete.
// Who:   the Company Uno dashboard through the plugin proxy, for rok-commander and
//        general-events alike. Mounted behind verifySignature in server.ts.
// Where: guild scoping is a SECURITY BOUNDARY (invariant 2). requireGuildId runs in every
//        handler and every read and write is keyed by that guild, so another guild's
//        meetingId is simply not found and answers 404, never 403.
// How:   writes go through scheduledMeetings (schedule, edit) and meetingLifecycle (delete),
//        the paths Discord's buttons use, so cards and reminders follow. A dashboard write
//        stores hostId null (D4) and marks the card it redraws "Updated from the dashboard".
//
// ⚠️ THE LIST NEVER CARRIES WORDS. Transcripts live in their own collection and only the
// detail route reads them; the list also projects the summary away at the database, so a
// page of meetings stays small and holds nothing anyone said.

const WRITE_KEYS = ["title", "startsAt"] as const;
const STATUS_SEPARATOR = ",";

/** Each refusal's answer. The codes are what the client maps to its own message. */
const REFUSALS: Record<MeetingRefusal | DeleteMeetingRefusal, { status: number; code: string }> = {
	noChannel: { status: 409, code: "MEETING_NOTES_CHANNEL_MISSING" },
	titleInvalid: { status: 400, code: "MEETING_TITLE_INVALID" },
	notFound: { status: 404, code: "MEETING_NOT_FOUND" },
	notScheduled: { status: 409, code: "MEETING_NOT_SCHEDULED" },
	recording: { status: 409, code: "MEETING_RECORDING" },
};

type MeetingParams = { meetingId: string };

const refuse = (res: Response, status: number, code: string): void => {
	res.status(status).json({ error: code, code });
};

const answerRefusal = (res: Response, reason: MeetingRefusal | DeleteMeetingRefusal): void => refuse(res, REFUSALS[reason].status, REFUSALS[reason].code);

// `status` is one status or several joined by commas (scheduled for the upcoming list, the rest
// for the past one); absent lists every meeting.
function readStatuses(raw: unknown): MeetingStatus[] | null | "invalid" {
	if (raw === undefined) return null;
	if (typeof raw !== "string") return "invalid";
	const statuses = raw.split(STATUS_SEPARATOR).map((status) => status.trim());
	return statuses.every((status) => (MEETING_STATUSES as readonly string[]).includes(status)) ? (statuses as MeetingStatus[]) : "invalid";
}

type Parsed<T> = { ok: true; value: T } | { ok: false; code: string };

// The title and start time a schedule and an edit share. The time must be ahead and inside the
// reminders' horizon, the rule the Discord modal's time parser holds a typed time to.
function readMeetingFields(body: Body): Parsed<{ title?: string; startsAt?: Date }> {
	const fields: { title?: string; startsAt?: Date } = {};
	if ("title" in body) {
		if (typeof body.title !== "string") return { ok: false, code: "MEETING_TITLE_INVALID" };
		fields.title = body.title;
	}
	const startsAt = readOptionalDate(body, "startsAt");
	if (startsAt === null || startsAt === "invalid" || (startsAt instanceof Date && !isSchedulableTime(startsAt))) return { ok: false, code: "MEETING_TIME_INVALID" };
	if (startsAt) fields.startsAt = startsAt;
	return { ok: true, value: fields };
}

// The meeting's words while they are kept, each line named as its speaker is known in the
// server (speakerNames.ts, the resolver the summary job uses). Empty once the TTL took them.
async function readTranscript(client: Client, meeting: IMeeting) {
	const segments = await meetingTranscriptStore.listForMeeting(meeting.guildId, meeting.meetingId);
	if (segments.length === 0) return [];
	const names = await resolveSpeakerNames(client, meeting.guildId, [...new Set(segments.map((segment) => segment.speakerId))]);
	return segments.map((segment) => ({
		speakerId: segment.speakerId,
		speakerName: names.get(segment.speakerId)?.displayName ?? null,
		offsetMs: segment.offsetMs,
		durationMs: segment.durationMs,
		text: segment.text,
	}));
}

export function createMeetingsRouter(client: Client): Router {
	const router = Router();

	router.get("/", async (req: Request, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		const statuses = readStatuses(req.query.status);
		if (statuses === "invalid") return refuse(res, 400, "MEETING_STATUS_INVALID");
		const limit = clampLimit(req.query.limit);
		const meetings = await meetingStore.listPage(guildId, statuses, parseCursor(req.query.cursor), limit);
		res.json({ meetings, nextCursor: nextCursor(meetings, limit, (meeting) => ({ createdAt: meeting.createdAt, id: meeting.meetingId })) });
	});

	router.get("/:meetingId", async (req: Request<MeetingParams>, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		const meeting = await meetingStore.findById(guildId, req.params.meetingId);
		if (!meeting) return answerRefusal(res, "notFound");
		res.json({ meeting: withoutMongoKeys(meeting), transcript: await readTranscript(client, meeting) });
	});

	router.post("/", async (req: Request, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		const body = strictBody(req.body, WRITE_KEYS);
		if (!body || typeof body.title !== "string" || !("startsAt" in body)) return refuse(res, 400, "INVALID_BODY");
		const fields = readMeetingFields(body);
		if (!fields.ok) return refuse(res, 400, fields.code);
		const { title = "", startsAt } = fields.value;
		if (!startsAt) return refuse(res, 400, "MEETING_TIME_INVALID");
		const result = await scheduleMeeting(client, guildId, { title, startsAt, hostId: null }, { fromDashboard: true });
		if (!result.ok) return answerRefusal(res, result.reason);
		res.status(201).json({ meeting: withoutMongoKeys(result.meeting) });
	});

	router.patch("/:meetingId", async (req: Request<MeetingParams>, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		const body = strictBody(req.body, WRITE_KEYS);
		if (!body || Object.keys(body).length === 0) return refuse(res, 400, "INVALID_BODY");
		const fields = readMeetingFields(body);
		if (!fields.ok) return refuse(res, 400, fields.code);
		const result = await editScheduledMeeting(client, guildId, req.params.meetingId, fields.value, { fromDashboard: true });
		if (!result.ok) return answerRefusal(res, result.reason);
		res.json({ meeting: withoutMongoKeys(result.meeting) });
	});

	router.delete("/:meetingId", async (req: Request<MeetingParams>, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		const result = await deleteMeeting(client, guildId, req.params.meetingId);
		if (!result.ok) return answerRefusal(res, result.reason);
		res.json({ outcome: result.outcome });
	});

	return router;
}
