import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Client } from "discord.js";
import type { IMeeting } from "@db/models/Meeting.js";

// /api/meetings, the dashboard's meeting reads and writes (2026-11 item 388 Phase 5a), through
// the real Express chain and the real scheduledMeetings write path: every route answers 400
// without a guildId and 404 for another guild's meeting, the list carries no summary and no
// words, the detail carries the transcript with speaker names, a schedule is refused (409)
// while 📝meeting-notes is absent, and a dashboard schedule or edit redraws the card marked
// from the dashboard. deleteMeeting is faked here; meetingLifecycle.test.ts covers it.

const SPEAKER = "123456789012345678";

const m = vi.hoisted(() => ({
	rows: new Map<string, IMeeting>(),
	segments: [] as Array<{ guildId: string; meetingId: string; speakerId: string; offsetMs: number; durationMs: number; text: string }>,
	config: { meetingNotesChannelId: "notes-ch" } as { meetingNotesChannelId: string | null } | null,
	sync: vi.fn(),
	schedule: vi.fn(),
	cancel: vi.fn(),
	deleteMeeting: vi.fn(),
}));

const key = (guildId: string, meetingId: string) => `${guildId}/${meetingId}`;

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: async () => m.config } }));
vi.mock("@db/stores/meetingStore.js", () => ({
	meetingStore: {
		insert: async (row: IMeeting) => (m.rows.set(key(row.guildId, row.meetingId), { ...row, createdAt: new Date() }), { ...row }),
		findById: async (guildId: string, meetingId: string) => (m.rows.has(key(guildId, meetingId)) ? { ...m.rows.get(key(guildId, meetingId))! } : null),
		claimTransition: async (guildId: string, meetingId: string, from: string, changes: Partial<IMeeting>) => {
			const row = m.rows.get(key(guildId, meetingId));
			if (!row || row.status !== from) return null;
			Object.assign(row, changes);
			return { ...row };
		},
		update: async (guildId: string, meetingId: string, changes: Partial<IMeeting>) => {
			const row = m.rows.get(key(guildId, meetingId));
			if (!row) return null;
			Object.assign(row, changes);
			return { ...row };
		},
		listPage: vi.fn(async (guildId: string, statuses: string[] | null, _before: unknown, limit: number) =>
			[...m.rows.values()]
				.filter((row) => row.guildId === guildId && (!statuses || statuses.includes(row.status)))
				.map(({ summary: _summary, ...row }) => row)
				.slice(0, limit)
		),
	},
}));
vi.mock("@db/stores/meetingTranscriptStore.js", () => ({
	meetingTranscriptStore: { listForMeeting: async (guildId: string, meetingId: string) => m.segments.filter((s) => s.guildId === guildId && s.meetingId === meetingId) },
}));
vi.mock("@features/reminders/dueReminders.js", () => ({ scheduleRemindersFor: m.schedule, cancelRemindersFor: m.cancel }));
vi.mock("@utils/cardMessage.js", () => ({ syncCardMessage: m.sync }));
vi.mock("@features/meetings/meetingLifecycle.js", () => ({ deleteMeeting: m.deleteMeeting }));

const { createMeetingsRouter } = await import("./meetings.routes.js");
const { apiErrorHandler } = await import("../middleware/apiErrorHandler.js");
const { meetingStore } = await import("@db/stores/meetingStore.js");

const guild = { members: { fetch: async (id: string) => (id === SPEAKER ? { displayName: "Ada", user: { username: "ada" } } : Promise.reject(new Error("unknown"))) } };
const client = { guilds: { cache: new Map([["guild-1", guild]]) }, users: { fetch: async () => null } } as unknown as Client;

function app() {
	const server = express();
	server.use(express.json());
	server.use("/api/meetings", createMeetingsRouter(client));
	server.use(apiErrorHandler);
	return request(server);
}

function seed(guildId: string, meetingId: string, changes: Partial<IMeeting> = {}): IMeeting {
	const row = {
		meetingId,
		guildId,
		title: "Weekly council",
		status: "scheduled",
		endReason: null,
		hostId: null,
		scheduledFor: new Date(Date.now() + 86_400_000),
		rsvpIds: [],
		startedAt: null,
		endedAt: null,
		speakerIds: [],
		notesChannelId: "notes-ch",
		notesMessageId: null,
		scheduleMessageId: "card-1",
		summary: null,
		sttSeconds: 0,
		spentCents: 0,
		createdAt: new Date("2026-11-20T10:00:00Z"),
		...changes,
	} as IMeeting;
	m.rows.set(key(guildId, meetingId), row);
	return row;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();
const lastCardText = (): string => {
	const payload = m.sync.mock.calls.at(-1)?.[3] as { embeds: Array<{ data: { description?: string } }> };
	return payload.embeds[0]?.data.description ?? "";
};

beforeEach(() => {
	m.rows.clear();
	m.segments = [];
	m.config = { meetingNotesChannelId: "notes-ch" };
	m.sync.mockReset().mockResolvedValue("card-1");
	m.schedule.mockReset().mockResolvedValue(undefined);
	m.cancel.mockReset().mockResolvedValue(undefined);
	m.deleteMeeting.mockReset().mockResolvedValue({ ok: true, outcome: "deleted" });
});

describe("every meeting route needs a guildId", () => {
	it.each([
		["get", "/api/meetings"],
		["get", "/api/meetings/m1"],
		["post", "/api/meetings"],
		["patch", "/api/meetings/m1"],
		["delete", "/api/meetings/m1"],
	] as const)("%s %s answers 400 without one", async (method, path) => {
		const res = await app()[method](path).send({ title: "x" }).timeout(2_000);
		expect(res.status).toBe(400);
		expect(m.deleteMeeting).not.toHaveBeenCalled();
	});
});

describe("GET /api/meetings", () => {
	it("lists this guild's meetings only, without the summary", async () => {
		seed("guild-1", "m1", { status: "done", summary: { text: "We agreed", decisions: [], actionItems: [] } });
		seed("guild-2", "m2");
		const res = await app().get("/api/meetings").query({ guildId: "guild-1" });
		expect(res.status).toBe(200);
		expect(res.body.meetings.map((meeting: IMeeting) => meeting.meetingId)).toEqual(["m1"]);
		expect(res.body.meetings[0]).not.toHaveProperty("summary");
		expect(res.body.nextCursor).toBeNull();
	});

	it("reads several statuses, clamps the limit, and refuses an unknown status", async () => {
		await app().get("/api/meetings").query({ guildId: "guild-1", status: "done,failed", limit: "0" });
		expect(vi.mocked(meetingStore.listPage)).toHaveBeenLastCalledWith("guild-1", ["done", "failed"], null, 1);
		const res = await app().get("/api/meetings").query({ guildId: "guild-1", status: "done,lost" });
		expect(res.status).toBe(400);
		expect(res.body.code).toBe("MEETING_STATUS_INVALID");
	});

	it("passes a cursor on as a keyset bound", async () => {
		await app().get("/api/meetings").query({ guildId: "guild-1", cursor: "2026-11-20T10:00:00.000Z~m9" });
		expect(vi.mocked(meetingStore.listPage).mock.calls.at(-1)?.[2]).toEqual({ createdAt: new Date("2026-11-20T10:00:00.000Z"), id: "m9" });
	});
});

describe("GET /api/meetings/:meetingId", () => {
	it("answers the meeting with its transcript, each line named by its speaker", async () => {
		seed("guild-1", "m1", { status: "done", speakerIds: [SPEAKER] });
		m.segments = [{ guildId: "guild-1", meetingId: "m1", speakerId: SPEAKER, offsetMs: 0, durationMs: 4000, text: "Banners by Friday." }];
		const res = await app().get("/api/meetings/m1").query({ guildId: "guild-1" });
		expect(res.status).toBe(200);
		expect(res.body.meeting.meetingId).toBe("m1");
		expect(res.body.transcript).toEqual([{ speakerId: SPEAKER, speakerName: "Ada", offsetMs: 0, durationMs: 4000, text: "Banners by Friday." }]);
	});

	it("answers 404 for another guild's meeting", async () => {
		seed("guild-2", "m2");
		const res = await app().get("/api/meetings/m2").query({ guildId: "guild-1" });
		expect(res.status).toBe(404);
		expect(res.body.code).toBe("MEETING_NOT_FOUND");
	});
});

describe("POST /api/meetings", () => {
	it("schedules a meeting with no host and posts its card marked from the dashboard", async () => {
		const res = await app().post("/api/meetings").query({ guildId: "guild-1" }).send({ title: "Planning", startsAt: tomorrow() });
		expect(res.status).toBe(201);
		expect(res.body.meeting).toMatchObject({ title: "Planning", status: "scheduled", hostId: null });
		await flush();
		expect(m.schedule).toHaveBeenCalled();
		expect(lastCardText()).toContain("Updated from the dashboard.");
	});

	it.each([
		[{ title: "Planning" }, "INVALID_BODY"],
		[{ title: "Planning", startsAt: tomorrow(), room: "hall" }, "INVALID_BODY"],
		[{ title: "Planning", startsAt: "2020-01-01T00:00:00Z" }, "MEETING_TIME_INVALID"],
		[{ title: "Planning", startsAt: null }, "MEETING_TIME_INVALID"],
		[{ title: "   ", startsAt: tomorrow() }, "MEETING_TITLE_INVALID"],
	])("refuses %j with 400 %s", async (body, code) => {
		const res = await app().post("/api/meetings").query({ guildId: "guild-1" }).send(body);
		expect(res.status).toBe(400);
		expect(res.body.code).toBe(code);
		expect(m.rows.size).toBe(0);
	});

	it("answers 409 while 📝meeting-notes is absent (R8)", async () => {
		m.config = { meetingNotesChannelId: null };
		const res = await app().post("/api/meetings").query({ guildId: "guild-1" }).send({ title: "Planning", startsAt: tomorrow() });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe("MEETING_NOTES_CHANNEL_MISSING");
	});
});

describe("PATCH /api/meetings/:meetingId", () => {
	it("changes a scheduled meeting's title and time, moves its reminders and redraws its card", async () => {
		seed("guild-1", "m1");
		const startsAt = tomorrow();
		const res = await app().patch("/api/meetings/m1").query({ guildId: "guild-1" }).send({ title: "Big council", startsAt });
		expect(res.status).toBe(200);
		expect(res.body.meeting).toMatchObject({ title: "Big council", scheduledFor: startsAt });
		await flush();
		expect(m.schedule).toHaveBeenCalledTimes(1);
		expect(m.sync.mock.calls[0][2]).toBe("card-1");
		expect(lastCardText()).toContain("Updated from the dashboard.");
	});

	it("answers 409 for a meeting that is no longer scheduled, 404 for another guild's", async () => {
		seed("guild-1", "m1", { status: "done" });
		seed("guild-2", "m2");
		expect((await app().patch("/api/meetings/m1").query({ guildId: "guild-1" }).send({ title: "x" })).body.code).toBe("MEETING_NOT_SCHEDULED");
		const res = await app().patch("/api/meetings/m2").query({ guildId: "guild-1" }).send({ title: "x" });
		expect(res.status).toBe(404);
		expect(m.rows.get(key("guild-2", "m2"))?.title).toBe("Weekly council");
	});

	it("refuses an empty body", async () => {
		seed("guild-1", "m1");
		expect((await app().patch("/api/meetings/m1").query({ guildId: "guild-1" }).send({})).status).toBe(400);
	});
});

describe("DELETE /api/meetings/:meetingId", () => {
	it("deletes through meetingLifecycle in the caller's guild and answers the outcome", async () => {
		const res = await app().delete("/api/meetings/m1").query({ guildId: "guild-1" });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ outcome: "deleted" });
		expect(m.deleteMeeting).toHaveBeenCalledWith(client, "guild-1", "m1");
	});

	it.each([
		["recording", 409, "MEETING_RECORDING"],
		["notFound", 404, "MEETING_NOT_FOUND"],
		["noChannel", 409, "MEETING_NOTES_CHANNEL_MISSING"],
	] as const)("maps %s to %i %s", async (reason, status, code) => {
		m.deleteMeeting.mockResolvedValue({ ok: false, reason });
		const res = await app().delete("/api/meetings/m1").query({ guildId: "guild-1" });
		expect(res.status).toBe(status);
		expect(res.body.code).toBe(code);
	});
});
