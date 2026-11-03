import { describe, it, expect } from "vitest";
import { createBrainQueue, type BrainQueueClock } from "./brainQueue.js";
import type { BrainJobInput, BrainResult } from "./brainTypes.js";

// ── brainQueue ─────────────────────────────────────────────────────────────
// The queue's promises: a long poll resolves the moment a job arrives, a new
// poll cuts off the old one, a job expires after 20 seconds, a delivered job
// takes exactly one answer, and "online" means a poll inside 45 seconds. A hand
// driven clock stands in for time, so nothing here really waits.

interface ManualClock extends BrainQueueClock {
	advance(ms: number): void;
}

function manualClock(): ManualClock {
	let now = 1_000_000;
	let nextHandle = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	return {
		now: () => now,
		setTimeout: (callback, ms) => {
			nextHandle += 1;
			timers.set(nextHandle, { at: now + ms, callback });
			return nextHandle;
		},
		clearTimeout: (handle) => {
			timers.delete(handle as number);
		},
		advance(ms) {
			now += ms;
			const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
			for (const [handle, timer] of due) {
				timers.delete(handle);
				timer.callback();
			}
		},
	};
}

function setup() {
	const clock = manualClock();
	let counter = 0;
	const queue = createBrainQueue({ clock, newId: () => `job-${++counter}` });
	return { clock, queue };
}

const INPUT: BrainJobInput = {
	source: "text",
	guild: { id: "g1", name: "Guild" },
	speaker: { id: "u1", displayName: "Member" },
	text: "send hello world",
	channels: [{ id: "c1", name: "general" }],
	capabilities: ["post_message", "say", "open_holdem", "leave_voice"],
};

const resultFor = (jobId: string): BrainResult => ({ jobId, status: "ok", actions: [] });

// True when the promise has settled, after letting pending microtasks run.
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void promise.then(() => {
		settled = true;
	});
	await Promise.resolve();
	await Promise.resolve();
	return settled;
}

describe("long poll", () => {
	it("hands a waiting poller the job the moment it is enqueued", async () => {
		const { queue } = setup();
		const poll = queue.next(25_000);
		expect(await isSettled(poll)).toBe(false);

		const { jobId } = queue.enqueue(INPUT);
		expect(await poll).toEqual({ jobId, ...INPUT });
	});

	it("returns pending jobs oldest first, straight away", async () => {
		const { queue } = setup();
		const first = queue.enqueue(INPUT);
		const second = queue.enqueue({ ...INPUT, text: "second" });
		expect((await queue.next(25_000))?.jobId).toBe(first.jobId);
		expect((await queue.next(25_000))?.jobId).toBe(second.jobId);
	});

	it("answers null after the wait, capped at 25 seconds", async () => {
		const { clock, queue } = setup();
		const poll = queue.next(60_000);
		clock.advance(24_999);
		expect(await isSettled(poll)).toBe(false);
		clock.advance(1);
		expect(await poll).toBeNull();
	});

	it("answers null at once for a zero wait, and treats a garbage wait as the full one", async () => {
		const { clock, queue } = setup();
		expect(await queue.next(0)).toBeNull();
		const poll = queue.next(Number.NaN);
		clock.advance(24_999);
		expect(await isSettled(poll)).toBe(false);
		clock.advance(1);
		expect(await poll).toBeNull();
	});

	it("makes the previous poller return null when a new poll arrives", async () => {
		const { queue } = setup();
		const older = queue.next(25_000);
		const newer = queue.next(25_000);
		expect(await older).toBeNull();

		const { jobId } = queue.enqueue(INPUT);
		expect((await newer)?.jobId).toBe(jobId);
	});

	it("frees the poll slot when the caller hangs up, so the job waits for the next poll", async () => {
		const { queue } = setup();
		const hangUp = new AbortController();
		const poll = queue.next(25_000, hangUp.signal);
		hangUp.abort();
		expect(await poll).toBeNull();

		const { jobId } = queue.enqueue(INPUT);
		expect((await queue.next(25_000))?.jobId).toBe(jobId);
	});
});

describe("job lifetime", () => {
	it("times out after 20 seconds and then answers not found", async () => {
		const { clock, queue } = setup();
		const { jobId, outcome } = queue.enqueue(INPUT);
		await queue.next(0);
		clock.advance(19_999);
		expect(await isSettled(outcome)).toBe(false);
		clock.advance(1);
		expect(await outcome).toEqual({ kind: "timeout" });
		expect(queue.submitResult(jobId, resultFor(jobId))).toBe("not_found");
	});

	it("drops an expired job that was never delivered", async () => {
		const { clock, queue } = setup();
		queue.enqueue(INPUT);
		clock.advance(20_000);
		expect(await queue.next(0)).toBeNull();
	});

	it("accepts exactly one answer for a delivered job", async () => {
		const { queue } = setup();
		const { jobId, outcome } = queue.enqueue(INPUT);
		await queue.next(0);
		expect(queue.findDelivered(jobId)?.jobId).toBe(jobId);

		expect(queue.submitResult(jobId, resultFor(jobId))).toBe("accepted");
		expect(await outcome).toEqual({ kind: "result", result: resultFor(jobId) });
		expect(queue.submitResult(jobId, resultFor(jobId))).toBe("not_found");
		expect(queue.findDelivered(jobId)).toBeNull();
	});

	it("refuses an answer for an unknown job or one the brain never received", () => {
		const { queue } = setup();
		const { jobId } = queue.enqueue(INPUT);
		expect(queue.submitResult(jobId, resultFor(jobId))).toBe("not_found");
		expect(queue.findDelivered(jobId)).toBeNull();
		expect(queue.submitResult("job-999", resultFor("job-999"))).toBe("not_found");
	});

	it("settles a rejected answer once, as a rejection", async () => {
		const { queue } = setup();
		const { jobId, outcome } = queue.enqueue(INPUT);
		await queue.next(0);
		expect(queue.rejectResult(jobId, "unknown_action")).toBe("accepted");
		expect(await outcome).toEqual({ kind: "rejected", reason: "unknown_action" });
		expect(queue.submitResult(jobId, resultFor(jobId))).toBe("not_found");
	});

	it("gives every job a fresh uuid by default", () => {
		const queue = createBrainQueue({ clock: manualClock() });
		const first = queue.enqueue(INPUT).jobId;
		const second = queue.enqueue(INPUT).jobId;
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(second).not.toBe(first);
	});
});

describe("online window", () => {
	it("is offline before any poll, online for 45 seconds after one, then offline", async () => {
		const { clock, queue } = setup();
		expect(queue.isBrainOnline()).toBe(false);
		await queue.next(0);
		expect(queue.isBrainOnline()).toBe(true);
		clock.advance(45_000);
		expect(queue.isBrainOnline()).toBe(true);
		clock.advance(1);
		expect(queue.isBrainOnline()).toBe(false);
	});

	it("counts a poll as a heartbeat even while it is still waiting", () => {
		const { clock, queue } = setup();
		void queue.next(25_000);
		clock.advance(10_000);
		expect(queue.isBrainOnline()).toBe(true);
	});
});
