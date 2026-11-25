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
	// The meetings holding words of the member, or listing them as a speaker.
	wordsIn: new Set(["rec1", "sum1"]),
	speakerIn: new Set<string>(),
	failDeleteIn: new Set<string>(),
	// Set by a test to hold one store call open, so a press can land while it is in flight.
	holdRead: null as Promise<void> | null,
	holdAccept: null as Promise<void> | null,
}));

vi.mock("@db/stores/meetingConsentStore.js", () => ({
	meetingConsentStore: {
		findByMember: async () => {
			m.reads += 1;
			const read = m.row ? { ...m.row } : null;
			if (m.holdRead) await m.holdRead;
			return read;
		},
		findActiveRows: async (_g: string, ids: readonly string[]) => ids.map((userId) => ({ userId, version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, revokedAt: null })),
		accept: async (_g: string, _u: string, version: number) => {
			if (m.holdAccept) await m.holdAccept;
			m.steps.push("accept");
			m.row = { version, revokedAt: null };
		},
		revoke: async (_g: string, _u: string, revokedAt: Date) => {
			m.steps.push("revoke");
			if (m.row) m.row.revokedAt = revokedAt;
			return true;
		},
	},
}));
vi.mock("@db/stores/meetingStore.js", () => ({
	meetingStore: {
		findOpenIds: async () => m.openIds,
		hasSpeaker: async (_g: string, id: string) => m.speakerIn.has(id),
		removeSpeaker: async (_g: string, id: string) => m.steps.push(`removeSpeaker:${id}`),
	},
}));
vi.mock("@db/stores/meetingTranscriptStore.js", () => ({
	meetingTranscriptStore: {
		hasSpeaker: async (_g: string, id: string) => m.wordsIn.has(id),
		deleteForSpeaker: async (_g: string, ids: readonly string[]) => {
			if (ids.some((id) => m.failDeleteIn.has(id))) throw new Error("mongo down");
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
	m.holdRead = null;
	m.holdAccept = null;
	m.wordsIn = new Set(["rec1", "sum1"]);
	m.speakerIn = new Set();
	m.failDeleteIn = new Set();
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
		await stopRecordingMember("g1", "alice", async (outcome) => {
			m.steps.push(`answer:${outcome}`);
		});
		expect(m.steps).toEqual(["dropBuffer", "revoke", "answer:withdrawn", "resetLease:rec1", "deleteSegments:rec1", "removeSpeaker:rec1", "resetLease:sum1", "deleteSegments:sum1", "removeSpeaker:sum1"]);
	});

	it("touches no meeting when none is open", async () => {
		m.openIds = [];
		expect(await consent.removeWordsFromOpenMeetings("g1", "alice")).toBe(0);
		expect(m.steps).toEqual([]);
		m.openIds = ["rec1", "sum1"];
	});

	it("L10: a member with no words and no speaker entry touches no job at all", async () => {
		m.wordsIn = new Set();
		expect(await consent.removeWordsFromOpenMeetings("g1", "alice")).toBe(0);
		expect(m.steps).toEqual([]);
	});

	it("L5: a speaker entry with no words left is still cleared, since it marks a removal cut short", async () => {
		m.wordsIn = new Set();
		m.speakerIn = new Set(["sum1"]);
		await consent.removeWordsFromOpenMeetings("g1", "alice");
		expect(m.steps).toEqual(["resetLease:sum1", "deleteSegments:sum1", "removeSpeaker:sum1"]);
	});

	it("L5: one meeting's failure keeps its speaker entry, does not stop the next, and is reported", async () => {
		m.failDeleteIn = new Set(["rec1"]);
		await expect(consent.removeWordsFromOpenMeetings("g1", "alice")).rejects.toThrow();
		expect(m.steps).toEqual(["resetLease:rec1", "resetLease:sum1", "deleteSegments:sum1", "removeSpeaker:sum1"]);
	});
});

// Two presses, or a press and a read, with a store call held open between them (L6).
describe("a withdrawal beats whatever was in flight (L6)", () => {
	const gate = () => {
		let open: () => void = () => undefined;
		const held = new Promise<void>((resolve) => (open = resolve));
		return { held, open: () => open() };
	};

	it("L6: a consent read in flight when a member withdraws answers no and caches no yes", async () => {
		const read = gate();
		m.row = { version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, revokedAt: null };
		m.holdRead = read.held;
		const asked = consent.hasMeetingConsent("g1", "alice");
		const stopping = stopRecordingMember("g1", "alice", async () => undefined);
		read.open();
		expect(await asked).toBe(false);
		m.holdRead = null;
		await stopping;
		expect(await consent.hasMeetingConsent("g1", "alice")).toBe(false);
	});

	it("L6: an I agree in flight loses to a withdrawal pressed after it, in the row, the cache and the answer", async () => {
		const write = gate();
		m.holdAccept = write.held;
		const agreeing = consent.agreeToRecording("g1", "alice");
		const stopping = stopRecordingMember("g1", "alice", async () => undefined);
		write.open();
		expect(await agreeing).toBe("overtaken");
		await stopping;
		expect(m.row?.revokedAt ?? "no row").not.toBeNull();
		expect(await consent.hasMeetingConsent("g1", "alice")).toBe(false);
	});

	it("L6: an I agree already writing when a withdrawal is pressed is revoked behind it", async () => {
		const write = gate();
		m.holdAccept = write.held;
		const agreeing = consent.agreeToRecording("g1", "alice");
		// Let the accept reach the store before the withdrawal is pressed.
		await new Promise((resolve) => setImmediate(resolve));
		const stopping = stopRecordingMember("g1", "alice", async () => undefined);
		write.open();
		expect(await agreeing).toBe("overtaken");
		await stopping;
		expect(m.row?.revokedAt).toBeInstanceOf(Date);
		expect(await consent.hasMeetingConsent("g1", "alice")).toBe(false);
	});

	it("L6: an I agree pressed after a withdrawal stands, whatever was still in flight", async () => {
		m.row = { version: BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, revokedAt: null };
		const stopping = stopRecordingMember("g1", "alice", async () => undefined);
		const agreeing = consent.agreeToRecording("g1", "alice");
		expect(await agreeing).toBe("agreed");
		await stopping;
		expect(m.row?.revokedAt).toBeNull();
		expect(await consent.hasMeetingConsent("g1", "alice")).toBe(true);
	});

	it("L6: a read begun before an I agree never overwrites its yes", async () => {
		const read = gate();
		m.holdRead = read.held;
		const asked = consent.hasMeetingConsent("g1", "alice");
		m.holdRead = null;
		expect(await consent.agreeToRecording("g1", "alice")).toBe("agreed");
		read.open();
		expect(await asked).toBe(true);
		expect(await consent.hasMeetingConsent("g1", "alice")).toBe(true);
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
