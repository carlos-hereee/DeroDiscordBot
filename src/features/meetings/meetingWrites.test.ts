import { beforeEach, describe, expect, it, vi } from "vitest";

// The conditional writes the consent rules rest on (2026-11 item 420), read off the stores with
// their models faked. The feature tests fake whole stores, so without this file a filter that
// stopped being conditional would pass every one of them.

const m = vi.hoisted(() => ({ calls: [] as Array<{ model: string; method: string; args: unknown[] }> }));

vi.mock("@db/models/Meeting.js", () => ({ Meeting: model("Meeting") }));
vi.mock("@db/models/MeetingSummaryJob.js", () => ({ MeetingSummaryJob: model("MeetingSummaryJob") }));
vi.mock("@db/models/Reminder.js", () => ({ Reminder: model("Reminder") }));

// Every method records its arguments and answers a query that is also its own result.
function model(name: string): unknown {
	return new Proxy({}, {
		get: (_target, method: string) => (...args: unknown[]) => {
			m.calls.push({ model: name, method, args });
			const answer = { modifiedCount: 1, deletedCount: 1, lean: async () => [], sort: () => answer, limit: () => answer };
			return answer;
		},
	});
}

const { meetingStore } = await import("@db/stores/meetingStore.js");
const { meetingSummaryJobStore } = await import("@db/stores/meetingSummaryJobStore.js");
const { reminderRowStore } = await import("@db/stores/reminderRowStore.js");

const NOW = new Date("2026-11-24T12:00:00Z");
const only = (): { method: string; args: unknown[] } => {
	expect(m.calls).toHaveLength(1);
	return m.calls[0];
};

beforeEach(() => {
	m.calls = [];
});

describe("summary job writes", () => {
	it("L10: resetLease matches only a leased job and gives its attempt back in the same write", async () => {
		await meetingSummaryJobStore.resetLease("g1", "mtg1", "lease2");
		expect(only().args).toEqual([
			{ guildId: "g1", meetingId: "mtg1", status: "leased" },
			{ $set: { status: "pending", leaseId: "lease2", leaseUntil: null }, $inc: { attempts: -1 } },
		]);
	});

	it("L5: giveBackAttempt leaves the lease alone and matches only its holder", async () => {
		await meetingSummaryJobStore.giveBackAttempt("job1", "lease1");
		expect(only().args).toEqual([{ jobId: "job1", status: "leased", leaseId: "lease1" }, { $inc: { attempts: -1 } }]);
	});

	it("L5: reopenDone matches only a done job and gives its attempt back", async () => {
		await meetingSummaryJobStore.reopenDone("job1");
		expect(only().args).toEqual([
			{ jobId: "job1", status: "done" },
			{ $set: { status: "pending", failureCode: null, leaseId: null, leaseUntil: null }, $inc: { attempts: -1 } },
		]);
	});
});

describe("meeting reads", () => {
	it("L16: a failed meeting counts as open for a removal", async () => {
		await meetingStore.findOpenIds("g1").catch(() => undefined);
		expect(only().args[0]).toEqual({ guildId: "g1", status: { $in: ["recording", "summarizing", "failed"] } });
	});
});

describe("reminder writes", () => {
	it("L9: a cancelled personal reminder loses its text and gains the date its expiry counts from", async () => {
		await reminderRowStore.cancelPersonal("g1", "u1", "r1", NOW);
		expect(only().args).toEqual([
			{ guildId: "g1", userId: "u1", reminderId: "r1", kind: "personal", status: "pending" },
			{ $set: { status: "cancelled", firedAt: NOW, text: null } },
		]);
	});

	it("L8 L9: a row left firing is closed as missed in one conditional write, with its text gone and its expiry set", async () => {
		const before = new Date(NOW.getTime() - 1);
		await reminderRowStore.closeStaleFiring(before, NOW);
		expect(only().args.slice(0, 2)).toEqual([
			{ status: "firing", updatedAt: { $lte: before } },
			{ $set: { status: "missed", firedAt: NOW, text: null } },
		]);
	});
});
