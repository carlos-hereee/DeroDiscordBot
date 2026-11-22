import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IMeetingConsent } from "@db/models/MeetingConsent.js";

// The consent rule (grade note R7), the trust cache, and Stop recording me's "delete her words"
// order (D1 sub answer): her live buffer dropped first, the row revoked, the member answered,
// then her segments, her speaker entry and the summary lease reset for every open meeting.

const m = vi.hoisted(() => ({
	row: null as Partial<IMeetingConsent> | null,
	reads: 0,
	steps: [] as string[],
	openIds: ["rec1", "sum1"],
}));

vi.mock("@db/stores/meetingConsentStore.js", () => ({
	meetingConsentStore: {
		findByMember: async () => {
			m.reads += 1;
			return m.row;
		},
		findActiveRows: async (_g: string, ids: readonly string[]) => ids.map((userId) => ({ userId, version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, revokedAt: null })),
		accept: async () => m.steps.push("accept"),
		revoke: async () => {
			m.steps.push("revoke");
			return true;
		},
	},
}));
vi.mock("@db/stores/meetingStore.js", () => ({
	meetingStore: {
		findOpenIds: async () => m.openIds,
		removeSpeaker: async (_g: string, id: string) => m.steps.push(`removeSpeaker:${id}`),
	},
}));
vi.mock("@db/stores/meetingTranscriptStore.js", () => ({
	meetingTranscriptStore: {
		deleteForSpeaker: async (_g: string, ids: readonly string[]) => {
			m.steps.push(`deleteSegments:${ids.join(",")}`);
			return 3;
		},
	},
}));
vi.mock("@db/stores/meetingSummaryJobStore.js", () => ({ meetingSummaryJobStore: { resetLease: async (_g: string, id: string) => m.steps.push(`resetLease:${id}`) } }));
vi.mock("./meetingRecorder.js", () => ({
	dropSpeakerEverywhere: async () => m.steps.push("dropBuffer"),
	allowSpeakerEverywhere: () => undefined,
}));

const consent = await import("./meetingConsent.js");
const { buildConsentNotice, stopRecordingMember } = await import("./consentNotice.js");
const { getPluginCopy } = await import("@base/copy/index.js");

beforeEach(() => {
	m.row = null;
	m.reads = 0;
	m.steps = [];
	consent._resetMeetingConsentCache();
});

describe("isMeetingConsentCurrent", () => {
	const version = BOT_CONSTANTS.MEETINGS.CONSENT_VERSION;
	it.each([
		["no row", null, false],
		["current", { version, revokedAt: null }, true],
		["a later version", { version: version + 1, revokedAt: null }, true],
		["an older version", { version: version - 1, revokedAt: null }, false],
		["revoked", { version, revokedAt: new Date() }, false],
	])("%s", (_label, row, expected) => {
		expect(consent.isMeetingConsentCurrent(row as IMeetingConsent | null)).toBe(expected);
	});
});

describe("hasMeetingConsent", () => {
	it("trusts an answer for CONSENT_TRUST_MS, then reads again", async () => {
		m.row = { version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, revokedAt: null };
		expect(await consent.hasMeetingConsent("g1", "alice", 0)).toBe(true);
		expect(await consent.hasMeetingConsent("g1", "alice", BOT_CONSTANTS.MEETINGS.CONSENT_TRUST_MS - 1)).toBe(true);
		expect(m.reads).toBe(1);
		await consent.hasMeetingConsent("g1", "alice", BOT_CONSTANTS.MEETINGS.CONSENT_TRUST_MS);
		expect(m.reads).toBe(2);
	});

	it("a revoke clears the trusted yes at once", async () => {
		m.row = { version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, revokedAt: null };
		await consent.hasMeetingConsent("g1", "alice", 0);
		await consent.revokeMeetingConsent("g1", "alice");
		m.row = { version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, revokedAt: new Date() };
		expect(await consent.hasMeetingConsent("g1", "alice", 1)).toBe(false);
	});
});

describe("Stop recording me", () => {
	it("drops the buffer, revokes, answers, then deletes her words from every open meeting and resets each lease", async () => {
		await stopRecordingMember("g1", "alice", async (hadConsent) => {
			m.steps.push(`answer:${hadConsent}`);
		});
		expect(m.steps).toEqual(["dropBuffer", "revoke", "answer:true", "deleteSegments:rec1,sum1", "removeSpeaker:rec1", "resetLease:rec1", "removeSpeaker:sum1", "resetLease:sum1"]);
	});

	it("touches no meeting when none is open", async () => {
		m.openIds = [];
		expect(await consent.removeWordsFromOpenMeetings("g1", "alice")).toBe(0);
		expect(m.steps).toEqual([]);
		m.openIds = ["rec1", "sum1"];
	});
});

describe("the consent notice", () => {
	it("pings exactly the members it names, and nobody else", () => {
		const payload = buildConsentNotice(getPluginCopy(null), { meetingId: "abc", title: "@everyone sync", hostId: "host", memberIds: ["host", "carol"] });
		expect(payload.allowedMentions).toEqual({ parse: [], roles: [], users: ["host", "carol"] });
		expect(payload.content).toBe("<@host> <@carol>");
		const ids = payload.components?.flatMap((row) => ("toJSON" in row ? row.toJSON().components.map((button) => ("custom_id" in button ? button.custom_id : "")) : []));
		expect(ids).toEqual(["mcon:agree:abc", "mcon:decline:abc", "mcon:revoke:abc"]);
	});

	it("says audio is never kept and when the transcript is deleted", () => {
		const payload = buildConsentNotice(getPluginCopy(null), { meetingId: "abc", title: "Sync", hostId: "host", memberIds: ["carol"] });
		const body = JSON.stringify(payload.embeds);
		expect(body).toContain("audio is never kept");
		expect(body).toContain(`${BOT_CONSTANTS.MEETINGS.TRANSCRIPT_TTL_DAYS} days`);
	});
});
