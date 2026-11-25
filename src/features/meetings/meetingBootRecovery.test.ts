import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IMeeting } from "@db/models/Meeting.js";
import type { IMeetingSummaryJob } from "@db/models/MeetingSummaryJob.js";

// The repair pass (2026-11 item 420, L4 L5 L7): every state a crash or a failed write can leave a
// meeting in is finished at boot or on the minute, nothing inside the grace or still ending here
// is touched, and no failure in it ever reaches the minute tick.

const m = vi.hoisted(() => ({
	meetings: [] as Array<Partial<IMeeting>>,
	jobs: new Map<string, Partial<IMeetingSummaryJob>>(),
	open: [] as Array<{ guildId: string; meetingId: string; speakerIds: string[] }>,
	openSince: null as Date | null,
	revoked: new Set<string>(),
	inFlight: new Set<string>(),
	calls: [] as string[],
	failRetry: "",
	removalFails: false,
	hold: null as Promise<void> | null,
}));

const retry = (name: string) => async () => {
	m.calls.push(name);
	if (m.hold) await m.hold;
	if (m.failRetry === name) throw new Error("mongo down");
};

vi.mock("@db/stores/meetingStore.js", () => ({
	meetingStore: {
		findAllRecording: async () => [],
		findSummarizingEndedBefore: async (before: Date) => m.meetings.filter((meeting) => meeting.status === "summarizing" && meeting.endedAt! <= before),
		findOpenWithSpeakers: async (endedAfter: Date) => {
			m.openSince = endedAfter;
			return m.open;
		},
	},
}));
vi.mock("@db/stores/meetingConsentStore.js", () => ({ meetingConsentStore: { findRevokedIds: async (_g: string, ids: readonly string[]) => ids.filter((id) => m.revoked.has(id)) } }));
vi.mock("@db/stores/meetingSummaryJobStore.js", () => ({
	meetingSummaryJobStore: {
		findForMeeting: async (_g: string, meetingId: string) => m.jobs.get(meetingId) ?? null,
		reopenDone: async (jobId: string) => {
			m.calls.push(`reopen:${jobId}`);
			return true;
		},
	},
}));
vi.mock("@features/voice/voiceSessions.js", () => ({ voiceSessions: { get: () => null } }));
vi.mock("./meetingLifecycle.js", () => ({
	endMeeting: async () => true,
	isEndInFlight: (meetingId: string) => m.inFlight.has(meetingId),
	finishEndedMeeting: async (_c: unknown, _g: string, meetingId: string) => void m.calls.push(`finish:${meetingId}`),
	retryOwedEnds: () => retry("ends")(),
	retryOwedUndos: () => retry("undos")(),
}));
vi.mock("./meetingConsent.js", () => ({
	retryOwedWithdrawals: () => retry("withdrawals")(),
	removeWithdrawnWords: async (guildId: string, userId: string) => {
		m.calls.push(`remove:${guildId}:${userId}`);
		return !m.removalFails;
	},
}));
vi.mock("./summaryResult.js", () => ({
	retryOwedTakeBacks: () => retry("takeBacks")(),
	failSummarizingMeeting: async (_c: unknown, _g: string, meetingId: string, code: string) => void m.calls.push(`fail:${meetingId}:${code}`),
}));

const { _resetMeetingRepairs, runMeetingRepairs } = await import("./meetingBootRecovery.js");

const client = {} as Client;
const NOW = new Date("2026-11-24T12:00:00Z");
const { REPAIR_GRACE_MS } = BOT_CONSTANTS.MEETINGS;
const PAST = new Date(NOW.getTime() - REPAIR_GRACE_MS);
const RETRIES = ["withdrawals", "undos", "ends", "takeBacks"];
const repaired = () => m.calls.filter((call) => !RETRIES.includes(call));

function stuck(job: Partial<IMeetingSummaryJob> | null, changes: Partial<IMeeting> = {}): void {
	m.meetings = [{ meetingId: "mtg1", guildId: "g1", status: "summarizing", endedAt: PAST, summary: null, ...changes }];
	m.jobs = new Map(job ? [["mtg1", { jobId: "job1", guildId: "g1", meetingId: "mtg1", updatedAt: PAST, ...job }]] : []);
}

beforeEach(() => {
	Object.assign(m, { meetings: [], open: [], openSince: null, calls: [], failRetry: "", removalFails: false, hold: null });
	m.jobs.clear();
	m.revoked.clear();
	m.inFlight.clear();
	_resetMeetingRepairs();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("a meeting stuck summarizing (L4)", () => {
	it.each([
		["no job: made, or closed as nothing recorded", null, ["finish:mtg1"]],
		["a failed job: the meeting says so", { status: "failed", failureCode: "attempts" }, ["fail:mtg1:attempts"]],
		["a done job with no summary written: reopened", { status: "done" }, ["reopen:job1"]],
		["a waiting job: left alone", { status: "pending" }, []],
		["a leased job: left alone", { status: "leased" }, []],
	] as Array<[string, Partial<IMeetingSummaryJob> | null, string[]]>)("L4: %s", async (_label, job, expected) => {
		stuck(job);
		await runMeetingRepairs(client, NOW);
		expect(repaired()).toEqual(expected);
	});

	it("L4: is left alone inside the grace, counted from its end and from its job's last write", async () => {
		stuck(null, { endedAt: new Date(PAST.getTime() + 1) });
		await runMeetingRepairs(client, NOW);
		stuck({ status: "done", updatedAt: new Date(PAST.getTime() + 1) });
		await runMeetingRepairs(client, NOW);
		expect(repaired()).toEqual([]);
	});

	it("L4: is left alone while its end is in flight here", async () => {
		stuck(null);
		m.inFlight.add("mtg1");
		await runMeetingRepairs(client, NOW);
		expect(repaired()).toEqual([]);
	});

	it("the grace outlasts a chunk at the provider", () => {
		expect(REPAIR_GRACE_MS).toBeGreaterThan(BOT_CONSTANTS.MEETINGS.STT_TIMEOUT_MS);
	});
});

describe("what this process still owes", () => {
	it("L5 L7: retries withdrawals first, then undos, ends and summaries to take back, and one failure stops none of the rest", async () => {
		m.failRetry = "withdrawals";
		stuck(null);
		await expect(runMeetingRepairs(client, NOW)).resolves.toBeUndefined();
		expect(m.calls.filter((call) => RETRIES.includes(call))).toEqual(RETRIES);
		expect(repaired()).toEqual(["finish:mtg1"]);
	});

	it("never runs beside itself", async () => {
		let release: () => void = () => undefined;
		m.hold = new Promise<void>((resolve) => (release = resolve));
		const first = runMeetingRepairs(client, NOW);
		await runMeetingRepairs(client, NOW);
		expect(m.calls).toEqual(["withdrawals"]);
		release();
		await first;
	});
});

describe("a removal a restart cut off (L5)", () => {
	beforeEach(() => {
		m.open = [{ guildId: "g1", meetingId: "mtg1", speakerIds: ["alice", "bob"] }, { guildId: "g1", meetingId: "mtg2", speakerIds: ["alice"] }];
		m.revoked.add("alice");
	});

	it("L5: the first pass removes every revoked speaker's words once, within the transcript's life, and later passes do not", async () => {
		await runMeetingRepairs(client, NOW);
		expect(repaired()).toEqual(["remove:g1:alice"]);
		expect(m.openSince).toEqual(new Date(NOW.getTime() - BOT_CONSTANTS.MEETINGS.TRANSCRIPT_TTL_DAYS * 86_400_000));
		await runMeetingRepairs(client, NOW);
		expect(repaired()).toEqual(["remove:g1:alice"]);
	});

	it("L5: one that fails is tried again by the next pass", async () => {
		m.removalFails = true;
		await runMeetingRepairs(client, NOW);
		m.removalFails = false;
		await runMeetingRepairs(client, NOW);
		expect(repaired()).toEqual(["remove:g1:alice", "remove:g1:alice"]);
	});
});
