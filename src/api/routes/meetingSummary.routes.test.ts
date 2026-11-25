import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createHash, createHmac } from "crypto";
import { readFileSync } from "fs";
import type { Client } from "discord.js";
import type { IMeeting } from "@db/models/Meeting.js";
import type { IMeetingConsent } from "@db/models/MeetingConsent.js";
import type { IMeetingSummaryJob } from "@db/models/MeetingSummaryJob.js";
import type { ITodo } from "@db/models/Todo.js";

// ── /brain/meeting-summary routes ──────────────────────────────────────────
// Through supertest with the real signature middleware, the real claim and the real result
// path (summaryJobs, summaryResult, actionItemsToTodos, todoActions), over in memory stores
// that behave like the conditional writes they fake. The shared fixture pins the job body the
// launcher reads and the result it posts (2026-11 item 388 Phase 4, R6).

const { KEY, m } = vi.hoisted(() => ({
	KEY: "brain-key-for-tests-0123456789abcdef",
	m: {
		jobs: [] as IMeetingSummaryJob[],
		meetings: new Map<string, IMeeting>(),
		segments: [] as Array<{ guildId: string; meetingId: string; speakerId: string; offsetMs: number; durationMs: number; text: string }>,
		todos: [] as ITodo[],
		cards: [] as Array<{ channelId: string; messageId: string | null; description: string }>,
		config: { todosChannelId: "todos" } as Record<string, unknown> | null,
		ids: [] as string[],
		idCounter: 0,
		// Who agreed, and the moments a test makes a member withdraw or a read or a delete fail.
		consents: new Map<string, { version: number; revokedAt: Date | null }>(),
		consentReadFails: false,
		deleteFails: false,
		claims: 0,
		afterFinish: null as (() => void) | null,
		afterDone: null as (() => void) | null,
		fetches: 0,
		fetchesAtFinish: 0,
	},
}));

vi.mock("@utils/config.js", () => ({ deroBrainKey: KEY }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn(async () => undefined) } }));
vi.mock("@utils/shortId.js", () => ({ shortId: () => m.ids.shift() ?? `id${String(++m.idCounter).padStart(10, "0")}` }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: async () => m.config } }));
vi.mock("@features/reminders/dueReminders.js", () => ({ scheduleRemindersFor: async () => undefined, cancelRemindersFor: async () => undefined }));
vi.mock("@utils/cardMessage.js", () => ({
	syncCardMessage: async (_client: unknown, channelId: string, messageId: string | null, payload: { embeds?: Array<{ data: { description?: string } }> }) => {
		m.cards.push({ channelId, messageId, description: payload.embeds?.[0]?.data.description ?? "" });
		return messageId ?? `posted${m.cards.length}`;
	},
	deleteCardMessage: async () => undefined,
}));
vi.mock("@db/stores/meetingTranscriptStore.js", () => ({
	meetingTranscriptStore: {
		listForMeeting: async (guildId: string, meetingId: string) =>
			m.segments.filter((row) => row.guildId === guildId && row.meetingId === meetingId).sort((a, b) => a.offsetMs - b.offsetMs),
		hasSpeaker: async (_g: string, meetingId: string, speakerId: string) => m.segments.some((row) => row.meetingId === meetingId && row.speakerId === speakerId),
		deleteForSpeaker: async (_g: string, meetingIds: readonly string[], speakerId: string) => {
			if (m.deleteFails) throw new Error("mongo down");
			const before = m.segments.length;
			m.segments = m.segments.filter((row) => !(meetingIds.includes(row.meetingId) && row.speakerId === speakerId));
			return before - m.segments.length;
		},
		deleteForMeeting: async (_g: string, meetingId: string) => {
			m.segments = m.segments.filter((row) => row.meetingId !== meetingId);
		},
	},
}));
vi.mock("@db/stores/meetingConsentStore.js", () => {
	const rowOf = (guildId: string, userId: string): IMeetingConsent | null => {
		if (m.consentReadFails) throw new Error("mongo down");
		const consent = m.consents.get(userId);
		return consent ? { guildId, userId, acceptedAt: new Date(0), ...consent } : null;
	};
	return {
		meetingConsentStore: {
			findByMember: async (guildId: string, userId: string) => rowOf(guildId, userId),
			findActiveRows: async (guildId: string, ids: readonly string[]) => ids.map((id) => rowOf(guildId, id)).filter((row) => row !== null && row.revokedAt === null),
			revoke: async (_g: string, userId: string, revokedAt: Date) => {
				const consent = m.consents.get(userId);
				if (!consent || consent.revokedAt) return false;
				consent.revokedAt = revokedAt;
				return true;
			},
			accept: async (_g: string, userId: string, version: number) => void m.consents.set(userId, { version, revokedAt: null }),
		},
	};
});
vi.mock("@db/stores/meetingStore.js", () => ({
	meetingStore: {
		findById: async (_g: string, id: string) => (m.meetings.has(id) ? structuredClone(m.meetings.get(id)!) : null),
		claimTransition: async (_g: string, id: string, from: string, changes: Partial<IMeeting>) => {
			const row = m.meetings.get(id);
			if (!row || row.status !== from) return null;
			Object.assign(row, changes);
			const written = structuredClone(row);
			if (changes.status === "done") m.afterDone?.();
			return written;
		},
		findOpenIds: async () => [...m.meetings.values()].filter((row) => ["recording", "summarizing", "failed"].includes(row.status)).map((row) => row.meetingId),
		hasSpeaker: async (_g: string, id: string, userId: string) => m.meetings.get(id)?.speakerIds.includes(userId) ?? false,
		removeSpeaker: async (_g: string, id: string, userId: string) => {
			const row = m.meetings.get(id);
			if (row) row.speakerIds = row.speakerIds.filter((speakerId) => speakerId !== userId);
		},
		update: async (_g: string, id: string, changes: Partial<IMeeting>) => {
			const row = m.meetings.get(id);
			if (!row) return null;
			Object.assign(row, changes);
			return structuredClone(row);
		},
	},
}));
vi.mock("@db/stores/meetingSummaryJobStore.js", () => ({
	meetingSummaryJobStore: {
		findByJobId: async (jobId: string) => structuredClone(m.jobs.find((job) => job.jobId === jobId) ?? null),
		claimJob: async (now: Date, leaseId: string, leaseUntil: Date) => {
			// A claim that would hand the same job round forever fails the test instead of hanging it.
			if (++m.claims > 50) throw new Error("claimed in a loop");
			const job = m.jobs.find((row) => row.status === "pending" || (row.status === "leased" && row.leaseUntil !== null && row.leaseUntil <= now));
			if (!job) return null;
			Object.assign(job, { status: "leased", leaseId, leaseUntil, attempts: job.attempts + 1 });
			return structuredClone(job);
		},
		finishLease: async (jobId: string, leaseId: string, outcome: { status: "done" | "failed"; failureCode: string | null }) => {
			const job = m.jobs.find((row) => row.jobId === jobId && row.status === "leased" && row.leaseId === leaseId);
			if (!job) return null;
			Object.assign(job, outcome, { leaseId: null, leaseUntil: null });
			m.fetchesAtFinish = m.fetches;
			const closed = structuredClone(job);
			m.afterFinish?.();
			return closed;
		},
		releaseLease: async (jobId: string, leaseId: string) => {
			const job = m.jobs.find((row) => row.jobId === jobId && row.status === "leased" && row.leaseId === leaseId);
			if (!job) return false;
			Object.assign(job, { status: "pending", leaseId: null, leaseUntil: null });
			return true;
		},
		resetLease: async (_g: string, meetingId: string, leaseId: string) => {
			const job = m.jobs.find((row) => row.meetingId === meetingId && row.status === "leased");
			if (job) Object.assign(job, { status: "pending", leaseId, leaseUntil: null, attempts: job.attempts - 1 });
		},
		giveBackAttempt: async (jobId: string, leaseId: string) => {
			const job = m.jobs.find((row) => row.jobId === jobId && row.status === "leased" && row.leaseId === leaseId);
			if (job) job.attempts -= 1;
		},
		reopenDone: async (jobId: string) => {
			const job = m.jobs.find((row) => row.jobId === jobId && row.status === "done");
			if (!job) return false;
			Object.assign(job, { status: "pending", attempts: job.attempts - 1 });
			return true;
		},
		markFailed: async (jobId: string, failureCode: string) => {
			const job = m.jobs.find((row) => row.jobId === jobId && (row.status === "pending" || row.status === "leased"));
			if (job) Object.assign(job, { status: "failed", failureCode, leaseId: null, leaseUntil: null });
		},
	},
}));
vi.mock("@db/stores/todoStore.js", () => ({
	todoStore: {
		findForMeeting: async (_g: string, meetingId: string) => m.todos.filter((todo) => todo.meetingId === meetingId),
		countOpen: async () => m.todos.filter((todo) => todo.status === "open").length,
		insert: async (todo: ITodo) => {
			if (m.todos.some((row) => row.meetingId !== null && row.meetingId === todo.meetingId && row.actionItemIndex === todo.actionItemIndex)) {
				throw Object.assign(new Error("duplicate key"), { code: 11000 });
			}
			m.todos.push({ ...todo });
			return { ...todo };
		},
		update: async () => null,
	},
}));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { meetingSummaryJobStore } from "@db/stores/meetingSummaryJobStore.js";
import { _resetMeetingConsentCache, removeWordsFromOpenMeetings, revokeMeetingConsent } from "@features/meetings/meetingConsent.js";
import { claimNextSummaryJob } from "@features/meetings/summaryJobs.js";
import { brainBodyErrorHandler, createBrainRouter } from "./brain.routes.js";
import { createMeetingSummaryRouter } from "./meetingSummary.routes.js";

const fixture = JSON.parse(readFileSync(new URL("../../features/meetings/meetingSummary.fixture.json", import.meta.url), "utf8")) as {
	job: { jobId: string; leaseId: string; segments: unknown[] };
	result: Record<string, unknown>;
};

const GUILD = "100000000000000001";
const MEETING = "meetingFix01";
const STARTED = new Date("2026-11-21T18:00:00.000Z");
const NAMES: Record<string, { displayName: string; username: string }> = {
	"300000000000000001": { displayName: "Ava", username: "ava_k" },
	"300000000000000002": { displayName: "Ben", username: "ben_r" },
};
const [AVA, BEN] = Object.keys(NAMES);

const fakeClient = {
	guilds: {
		cache: {
			get: () => ({
				members: {
					fetch: async (id: string) => {
						m.fetches += 1;
						return NAMES[id] ? { displayName: NAMES[id].displayName, user: { username: NAMES[id].username } } : null;
					},
				},
			}),
		},
	},
	users: { fetch: async () => null },
} as unknown as Client;

let clockMs = Date.parse("2026-11-21T19:00:00.000Z");

function sign(method: string, pathWithQuery: string, body: string) {
	const timestamp = String(Date.now());
	const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
	const signature = createHmac("sha256", KEY).update(`${method}\n${pathWithQuery}\n${timestamp}\n${bodyHash}`, "utf8").digest("hex");
	return { "x-timestamp": timestamp, "x-signature": signature };
}

function buildApp(overrides: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {
	const app = express();
	app.use(express.json({ verify: (req, _res, buf) => void ((req as express.Request).rawBody = buf.toString("utf8")) }));
	app.use(
		"/brain/meeting-summary",
		createMeetingSummaryRouter({ client: fakeClient, claimNext: (client) => claimNextSummaryJob(client, new Date(clockMs)), sleep: overrides.sleep, now: overrides.now })
	);
	app.use("/brain", createBrainRouter());
	app.use("/brain", brainBodyErrorHandler);
	return app;
}

const NEXT = "/brain/meeting-summary/next?waitMs=0";
const RESULT = "/brain/meeting-summary/result";
const poll = (app: express.Express, path = NEXT) => request(app).get(path).set(sign("GET", path, ""));
const post = (app: express.Express, body: string) => request(app).post(RESULT).set("Content-Type", "application/json").set(sign("POST", RESULT, body)).send(body);
const resultFor = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...fixture.result, ...overrides });

function seedMeeting(overrides: Partial<IMeeting> = {}): void {
	m.meetings.set(MEETING, {
		meetingId: MEETING,
		guildId: GUILD,
		title: "Weekly planning",
		status: "summarizing",
		endReason: "host",
		hostId: AVA,
		scheduledFor: null,
		rsvpIds: [],
		startedAt: STARTED,
		endedAt: new Date(STARTED.getTime() + 1_800_000),
		speakerIds: [AVA, BEN],
		notesChannelId: "notes",
		notesMessageId: "notesCard1",
		scheduleMessageId: null,
		summary: null,
		sttSeconds: 0,
		spentCents: 0,
		...overrides,
	});
	const lines = fixture.job.segments as Array<{ label: string; offsetMs: number; text: string }>;
	m.segments = lines.map((line) => ({ guildId: GUILD, meetingId: MEETING, speakerId: line.label === "S1" ? AVA : BEN, offsetMs: line.offsetMs, durationMs: 1000, text: line.text }));
	m.jobs = [{ jobId: fixture.job.jobId, guildId: GUILD, meetingId: MEETING, status: "pending", leaseId: null, leaseUntil: null, attempts: 0, failureCode: null }];
}

beforeEach(() => {
	m.meetings.clear();
	m.segments = [];
	m.jobs = [];
	m.todos = [];
	m.cards = [];
	m.config = { todosChannelId: "todos" };
	m.ids = [];
	m.idCounter = 0;
	Object.assign(m, { consentReadFails: false, deleteFails: false, claims: 0, afterFinish: null, afterDone: null, fetches: 0, fetchesAtFinish: 0 });
	m.consents = new Map([AVA, BEN].map((id) => [id, { version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, revokedAt: null }]));
	_resetMeetingConsentCache();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	clockMs = Date.parse("2026-11-21T19:00:00.000Z");
});

describe("signature", () => {
	it("refuses an unsigned poll and an unsigned result with a bare 401", async () => {
		const app = buildApp();
		expect((await request(app).get(NEXT)).status).toBe(401);
		expect((await request(app).post(RESULT).set("Content-Type", "application/json").send(resultFor())).status).toBe(401);
	});
});

describe("GET /brain/meeting-summary/next", () => {
	it("answers 204 when no job waits", async () => {
		expect((await poll(buildApp())).status).toBe(204);
	});

	it("claims the job under a fresh lease and answers the fixture's body exactly", async () => {
		seedMeeting();
		m.ids = [fixture.job.leaseId];
		const res = await poll(buildApp());
		expect(res.status).toBe(200);
		expect(res.body).toEqual(fixture.job);
		expect(m.jobs[0]).toMatchObject({ status: "leased", leaseId: fixture.job.leaseId, attempts: 1 });
		expect(m.jobs[0].leaseUntil?.getTime()).toBe(clockMs + BOT_CONSTANTS.MEETINGS.SUMMARY_LEASE_MS);
	});

	it("keeps rereading through the wait and hands out a job queued while it waits", async () => {
		let fakeNow = 0;
		let sleeps = 0;
		const app = buildApp({
			now: () => fakeNow,
			sleep: async (ms) => {
				fakeNow += ms;
				sleeps += 1;
				if (sleeps === 2) seedMeeting();
			},
		});
		const path = "/brain/meeting-summary/next?waitMs=20000";
		const res = await poll(app, path);
		expect(res.status).toBe(200);
		expect(sleeps).toBe(2);
	});

	it("does not hand out a job leased to a live launcher, and reclaims it once the lease runs out", async () => {
		seedMeeting();
		m.ids = ["leaseFirst01"];
		const app = buildApp();
		expect((await poll(app)).status).toBe(200);
		expect((await poll(app)).status).toBe(204);

		// The first launcher died mid job: past the lease the next claim takes it, one attempt more.
		clockMs += BOT_CONSTANTS.MEETINGS.SUMMARY_LEASE_MS + 1;
		m.ids = ["leaseSecond1"];
		const again = await poll(app);
		expect(again.status).toBe(200);
		expect(again.body.leaseId).toBe("leaseSecond1");
		expect(m.jobs[0].attempts).toBe(2);

		// The dead launcher's late result is refused; the live lease's result lands.
		expect((await post(app, resultFor({ leaseId: "leaseFirst01" }))).status).toBe(404);
		expect((await post(app, resultFor({ leaseId: "leaseSecond1" }))).status).toBe(200);
	});

	it("fails a job past its attempts with an honest card line instead of handing it out", async () => {
		seedMeeting();
		Object.assign(m.jobs[0], { status: "leased", leaseId: "leaseOld0001", leaseUntil: new Date(clockMs - 1), attempts: BOT_CONSTANTS.MEETINGS.SUMMARY_MAX_ATTEMPTS });
		expect((await poll(buildApp())).status).toBe(204);
		expect(m.jobs[0]).toMatchObject({ status: "failed", failureCode: "attempts" });
		expect(m.meetings.get(MEETING)?.status).toBe("failed");
		expect(m.cards).toEqual([{ channelId: "notes", messageId: "notesCard1", description: expect.stringContaining("could not write the summary") }]);
	});

	it("fails a job whose words were all removed, and one whose transcript expired", async () => {
		seedMeeting();
		m.segments = [];
		expect((await poll(buildApp())).status).toBe(204);
		expect(m.jobs[0]).toMatchObject({ status: "failed", failureCode: "transcript_empty" });
		expect(m.cards[0].description).toContain("asked to stop being recorded");

		seedMeeting({ endedAt: new Date(clockMs - (BOT_CONSTANTS.MEETINGS.TRANSCRIPT_TTL_DAYS + 1) * 86_400_000) });
		m.segments = [];
		m.cards = [];
		expect((await poll(buildApp())).status).toBe(204);
		expect(m.jobs[0]).toMatchObject({ status: "failed", failureCode: "transcript_expired" });
		expect(m.cards[0].description).toContain("deleted when it expired");
	});
});

describe("POST /brain/meeting-summary/result", () => {
	async function claimed(): Promise<express.Express> {
		seedMeeting();
		m.ids = [fixture.job.leaseId];
		const app = buildApp();
		expect((await poll(app)).status).toBe(200);
		return app;
	}

	it("takes the fixture meeting from summarizing to done with a filled card and one todo card per action item", async () => {
		const app = await claimed();
		const res = await post(app, resultFor());
		expect(res.status).toBe(200);

		const meeting = m.meetings.get(MEETING)!;
		expect(meeting.status).toBe("done");
		expect(meeting.summary?.actionItems).toEqual([
			{ text: "Book the voice rooms for the tournament", assigneeName: "Ben", assigneeId: BEN },
			{ text: "Update the member guide", assigneeName: null, assigneeId: null },
		]);
		expect(m.jobs[0]).toMatchObject({ status: "done", leaseId: null });
		expect(m.todos.map((todo) => [todo.actionItemIndex, todo.assigneeId, todo.createdBy, todo.meetingId])).toEqual([
			[0, BEN, AVA, MEETING],
			[1, null, AVA, MEETING],
		]);
		await vi.waitFor(() => expect(m.cards.filter((card) => card.channelId === "todos")).toHaveLength(2));
		const notes = m.cards.find((card) => card.channelId === "notes")!;
		expect(notes.messageId).toBe("notesCard1");
		expect(notes.description).toContain("The team planned the spring tournament");
		expect(notes.description).toContain(`<@${BEN}>`);
		expect(notes.description).toContain("<#todos>");
	});

	it("refuses a second result for the same job", async () => {
		const app = await claimed();
		expect((await post(app, resultFor())).status).toBe(200);
		expect((await post(app, resultFor())).status).toBe(404);
		expect(m.todos).toHaveLength(2);
	});

	it("refuses a result built before a member's Stop recording me reset the lease", async () => {
		const app = await claimed();
		await meetingSummaryJobStore.resetLease(GUILD, MEETING, "leaseRevoked");
		expect((await post(app, resultFor())).status).toBe(404);
		expect(m.meetings.get(MEETING)?.summary).toBeNull();
		expect(m.todos).toHaveLength(0);
	});

	it("answers 404 for an unknown job", async () => {
		const app = await claimed();
		expect((await post(app, resultFor({ jobId: "unknownJob01" }))).status).toBe(404);
	});

	it.each([
		["an extra key", { extra: true }],
		["an extra key on an action item", { actionItems: [{ text: "Do it", assignee: null, due: "soon" }] }],
		["a missing leaseId", { leaseId: undefined }],
		["too many decisions", { decisions: Array.from({ length: BOT_CONSTANTS.MEETINGS.MAX_DECISIONS + 1 }, (_, i) => `Decision ${i}`) }],
		["too many action items", { actionItems: Array.from({ length: BOT_CONSTANTS.MEETINGS.MAX_ACTION_ITEMS + 1 }, (_, i) => ({ text: `Item ${i}`, assignee: null })) }],
		["a summary over its cap", { summary: "x".repeat(BOT_CONSTANTS.MEETINGS.SUMMARY_MAX_CHARS + 1) }],
		["an empty summary", { summary: "   " }],
		["a failure with a summary", { ok: false, code: "model_error" }],
	])("refuses %s with 400 and writes nothing", async (_name, overrides) => {
		const app = await claimed();
		expect((await post(app, resultFor(overrides))).status).toBe(400);
		expect(m.jobs[0].status).toBe("leased");
	});

	it("refuses a body over the result cap with 413 before reading it", async () => {
		const app = await claimed();
		const body = resultFor({ summary: "x".repeat(BOT_CONSTANTS.MEETINGS.SUMMARY_RESULT_MAX_BYTES) });
		expect((await post(app, body)).status).toBe(413);
		expect(m.jobs[0].status).toBe("leased");
	});

	it("hands a model failure back for another attempt, then fails the meeting at the cap", async () => {
		const app = await claimed();
		const failure = (leaseId: string) => JSON.stringify({ jobId: fixture.job.jobId, leaseId, ok: false, code: "model_error" });
		expect((await post(app, failure(fixture.job.leaseId))).status).toBe(200);
		expect(m.jobs[0]).toMatchObject({ status: "pending", attempts: 1 });

		Object.assign(m.jobs[0], { attempts: BOT_CONSTANTS.MEETINGS.SUMMARY_MAX_ATTEMPTS - 1 });
		m.ids = ["leaseLast001"];
		expect((await poll(app)).status).toBe(200);
		expect((await post(app, failure("leaseLast001"))).status).toBe(200);
		expect(m.jobs[0]).toMatchObject({ status: "failed", failureCode: "model_error" });
		expect(m.meetings.get(MEETING)?.status).toBe("failed");
	});

	it("keeps the action items on the card when the server has no ✅todos", async () => {
		const app = await claimed();
		m.config = {};
		expect((await post(app, resultFor())).status).toBe(200);
		expect(m.todos).toHaveLength(0);
		expect(m.cards.find((card) => card.channelId === "notes")?.description).toContain("no ✅todos channel");
	});
});

// Consent is current when the body is built and when a result lands (2026-11 item 420): L5, L10, L16.
describe("a withdrawn member's words reach no summary", () => {
	const withdrawNow = (userId: string): void => void m.consents.set(userId, { version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, revokedAt: new Date() });
	const speakersLeft = (): string[] => [...new Set(m.segments.map((segment) => segment.speakerId))];

	async function claimed(): Promise<express.Express> {
		seedMeeting();
		m.ids = [fixture.job.leaseId];
		const app = buildApp();
		expect((await poll(app)).status).toBe(200);
		return app;
	}

	/** The result was refused and nothing it said is anywhere: no summary, no todo, no card. */
	function expectRefused(): void {
		expect(m.meetings.get(MEETING)).toMatchObject({ status: "summarizing", summary: null });
		expect(m.todos).toEqual([]);
		expect(m.cards).toEqual([]);
	}

	it("L5: words a failed delete or a restart left behind are kept out of the body", async () => {
		seedMeeting();
		withdrawNow(AVA);
		const res = await poll(buildApp());
		expect(res.status).toBe(200);
		expect(res.body.speakers).toEqual([{ label: "S1", name: "Ben" }]);
	});

	it("L5: a job whose every word is withdrawn fails as transcript_empty", async () => {
		seedMeeting();
		[AVA, BEN].forEach(withdrawNow);
		expect((await poll(buildApp())).status).toBe(204);
		expect(m.jobs[0]).toMatchObject({ status: "failed", failureCode: "transcript_empty" });
	});

	it("L5: words under a consent below the version are left out of the body and not deleted", async () => {
		seedMeeting();
		m.consents.set(AVA, { version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION - 1, revokedAt: null });
		const res = await poll(buildApp());
		expect(res.body.speakers).toEqual([{ label: "S1", name: "Ben" }]);
		expect(speakersLeft()).toContain(AVA);
	});

	it("L5: an unreadable consent sends nothing, answers instead of looping, and costs the job no attempt", async () => {
		seedMeeting();
		m.consentReadFails = true;
		expect((await poll(buildApp())).status).toBe(204);
		expect(m.claims).toBe(1);
		expect(m.jobs[0]).toMatchObject({ status: "leased", attempts: 0 });
		expect(m.jobs[0].leaseUntil).not.toBeNull();
	});

	it("L11: a job whose meeting is gone deletes the words left under it", async () => {
		seedMeeting();
		m.meetings.clear();
		expect((await poll(buildApp())).status).toBe(204);
		expect(m.jobs[0]).toMatchObject({ status: "failed", failureCode: "meeting_gone" });
		expect(m.segments).toEqual([]);
	});

	it("L5: a withdrawal after the lease closed refuses the result, removes the words, and reopens the job without its attempt", async () => {
		const app = await claimed();
		m.afterFinish = () => withdrawNow(AVA);
		expect((await post(app, resultFor())).status).toBe(404);
		expectRefused();
		expect(speakersLeft()).toEqual([BEN]);
		expect(m.meetings.get(MEETING)?.speakerIds).toEqual([BEN]);
		expect(m.jobs[0]).toMatchObject({ status: "pending", attempts: 0 });
	});

	it("L5: a withdrawal after the summary was written takes the summary back before any todo or card", async () => {
		const app = await claimed();
		m.afterDone = () => withdrawNow(AVA);
		expect((await post(app, resultFor())).status).toBe(404);
		expectRefused();
		expect(speakersLeft()).toEqual([BEN]);
		expect(m.jobs[0]).toMatchObject({ status: "pending", attempts: 0 });
	});

	it("L5: a speaker whose consent row is missing refuses the result too", async () => {
		const app = await claimed();
		m.afterFinish = () => void m.consents.delete(AVA);
		expect((await post(app, resultFor())).status).toBe(404);
		expectRefused();
	});

	it("L5: an unreadable consent after the lease closed writes no summary and reopens the job", async () => {
		const app = await claimed();
		m.afterFinish = () => (m.consentReadFails = true);
		expect((await post(app, resultFor())).status).toBe(404);
		expectRefused();
		expect(m.jobs[0]).toMatchObject({ status: "pending", attempts: 0 });
		expect(speakersLeft()).toContain(AVA);
	});

	it("L5: a removal that fails leaves the job closed and the summary unwritten for the repair pass", async () => {
		const app = await claimed();
		m.afterFinish = () => {
			withdrawNow(AVA);
			m.deleteFails = true;
		};
		expect((await post(app, resultFor())).status).toBe(404);
		expectRefused();
		expect(m.jobs[0].status).toBe("done");
		expect(m.meetings.get(MEETING)?.speakerIds).toContain(AVA);
	});

	it("a consent row below the version never refuses a result", async () => {
		const app = await claimed();
		m.afterFinish = () => void m.consents.set(AVA, { version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION - 1, revokedAt: null });
		expect((await post(app, resultFor())).status).toBe(200);
		expect(m.meetings.get(MEETING)?.status).toBe("done");
	});

	it("L5: the speaker names are read before the lease closes, so no Discord call sits in the window", async () => {
		const app = await claimed();
		m.fetches = 0;
		expect((await post(app, resultFor())).status).toBe(200);
		expect(m.fetchesAtFinish).toBeGreaterThan(0);
		expect(m.fetches).toBe(m.fetchesAtFinish);
	});

	it("L10: three presses by a member with no words leave the job, its lease and its attempts unchanged", async () => {
		await claimed();
		const before = structuredClone(m.jobs[0]);
		for (let press = 0; press < 3; press += 1) {
			const withdrawal = revokeMeetingConsent(GUILD, "400000000000000009");
			await withdrawal.outcome;
			await withdrawal.finish();
		}
		expect(m.jobs[0]).toEqual(before);
	});

	it("L10: three honest withdrawals, each after a claim, never fail the job", async () => {
		seedMeeting();
		const app = buildApp();
		for (const userId of ["u1", "u2", "u3"]) {
			m.consents.set(userId, { version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, revokedAt: null });
			m.segments.push({ guildId: GUILD, meetingId: MEETING, speakerId: userId, offsetMs: 1, durationMs: 1000, text: "said" });
		}
		for (const userId of ["u1", "u2", "u3"]) {
			expect((await poll(app)).status).toBe(200);
			const withdrawal = revokeMeetingConsent(GUILD, userId);
			await withdrawal.outcome;
			await withdrawal.finish();
			expect(m.jobs[0]).toMatchObject({ status: "pending", attempts: 0 });
		}
		expect((await poll(app)).status).toBe(200);
		expect(speakersLeft().sort()).toEqual([AVA, BEN]);
	});

	it("L16: a withdrawal after a failed summary deletes the member's words and leaves the job failed", async () => {
		seedMeeting({ status: "failed" });
		Object.assign(m.jobs[0], { status: "failed", failureCode: "attempts", attempts: 4 });
		expect(await removeWordsFromOpenMeetings(GUILD, AVA)).toBeGreaterThan(0);
		expect(speakersLeft()).toEqual([BEN]);
		expect(m.jobs[0]).toMatchObject({ status: "failed", attempts: 4 });
		expect(m.meetings.get(MEETING)?.status).toBe("failed");
	});
});
