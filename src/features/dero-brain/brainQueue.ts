import { randomUUID } from "crypto";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { BrainJob, BrainJobInput, BrainOutcome, BrainResult } from "./brainTypes.js";

// ── brainQueue ────────────────────────────────────────────────────────────
// What:  the in memory hand off between /dero tell (which enqueues a job and
//        waits) and the launcher's long poll (which takes the job and later
//        answers it). Also the brain heartbeat: a poll is the only sign of life
//        the brain gives, so "online" means "polled recently".
// Who:   /dero (enqueue, isBrainOnline) and the /brain routes (next,
//        submitResult, rejectResult, findDelivered). One shared instance,
//        `brainQueue`, exported at the bottom; tests build their own.
// When:  jobs live seconds. A restart drops every job and every waiting member
//        gets the timeout reply, which is the plan's accepted cost (jobs and
//        results are never stored in Mongo).
// Where: no Discord, no Mongo, no HTTP. The clock and the id source are
//        injectable so every timing rule is testable without real waiting.
// How:   ① enqueue stores the job and arms its 20 second timeout, then hands it
//        straight to a waiting poller or appends it to the pending line;
//        ② next records the heartbeat, cuts off any previous poller, and
//        returns the oldest pending job or waits for one; ③ a delivered job
//        accepts exactly one answer, and settling it in any way (answer,
//        rejection, timeout) deletes it, so a late or replayed answer finds
//        nothing and gets not found.
//
// ⚠️ ONE POLLER AT A TIME. Two pollers would split jobs between two brains (or a
// brain and an attacker holding a replayed signature); the newest poll wins and
// the older one returns null at once.

/** The clock the queue reads and arms timers on. Production uses the system clock. */
export interface BrainQueueClock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface BrainQueueOptions {
	clock?: BrainQueueClock;
	newId?: () => string;
}

export type SubmitStatus = "accepted" | "not_found";

export interface EnqueuedJob {
	jobId: string;
	/** Resolves once: with the brain's answer, a rejection code, or a timeout. */
	outcome: Promise<BrainOutcome>;
}

export interface BrainQueue {
	enqueue(input: BrainJobInput): EnqueuedJob;
	next(waitMs: number, signal?: AbortSignal): Promise<BrainJob | null>;
	submitResult(jobId: string, result: BrainResult): SubmitStatus;
	rejectResult(jobId: string, reason: string): SubmitStatus;
	findDelivered(jobId: string): BrainJob | null;
	isBrainOnline(now?: number): boolean;
}

interface JobRecord {
	job: BrainJob;
	delivered: boolean;
	settle: (outcome: BrainOutcome) => void;
	timer: unknown;
}

interface Poller {
	resolve: (job: BrainJob | null) => void;
	timer: unknown;
}

const systemClock: BrainQueueClock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// A missing or garbage waitMs gets the longest wait, the normal long poll; a
// negative one gets none. The upper bound is never negotiable by the caller.
function clampWait(waitMs: number): number {
	if (!Number.isFinite(waitMs)) return BOT_CONSTANTS.DERO_BRAIN_MAX_POLL_WAIT_MS;
	return Math.min(Math.max(Math.trunc(waitMs), 0), BOT_CONSTANTS.DERO_BRAIN_MAX_POLL_WAIT_MS);
}

export function createBrainQueue(options: BrainQueueOptions = {}): BrainQueue {
	const clock = options.clock ?? systemClock;
	const newId = options.newId ?? randomUUID;
	const jobs = new Map<string, JobRecord>();
	const pendingIds: string[] = [];
	let poller: Poller | null = null;
	let lastPollAt: number | null = null;

	// Every way a job ends goes through here, so the delete, the timer clear and
	// the resolve can never get out of step.
	function settle(jobId: string, outcome: BrainOutcome): boolean {
		const record = jobs.get(jobId);
		if (!record) return false;
		jobs.delete(jobId);
		clock.clearTimeout(record.timer);
		const waitingAt = pendingIds.indexOf(jobId);
		if (waitingAt !== -1) pendingIds.splice(waitingAt, 1);
		record.settle(outcome);
		return true;
	}

	function releasePoller(job: BrainJob | null): void {
		const current = poller;
		if (!current) return;
		poller = null;
		clock.clearTimeout(current.timer);
		current.resolve(job);
	}

	function enqueue(input: BrainJobInput): EnqueuedJob {
		const jobId = newId();
		const job: BrainJob = { jobId, ...input };
		let settleOutcome: (outcome: BrainOutcome) => void = () => undefined;
		const outcome = new Promise<BrainOutcome>((resolve) => {
			settleOutcome = resolve;
		});
		const timer = clock.setTimeout(() => settle(jobId, { kind: "timeout" }), BOT_CONSTANTS.DERO_BRAIN_TURN_TIMEOUT_MS);
		const record: JobRecord = { job, delivered: false, settle: settleOutcome, timer };
		jobs.set(jobId, record);

		// ① straight to a waiting poller, or into the line
		if (poller) {
			record.delivered = true;
			releasePoller(job);
		}
		else {
			pendingIds.push(jobId);
		}
		return { jobId, outcome };
	}

	function next(waitMs: number, signal?: AbortSignal): Promise<BrainJob | null> {
		// ② the heartbeat is the poll arriving, before anything else can return
		lastPollAt = clock.now();
		releasePoller(null);

		const oldestId = pendingIds.shift();
		const record = oldestId ? jobs.get(oldestId) : undefined;
		if (record) {
			record.delivered = true;
			return Promise.resolve(record.job);
		}

		const wait = clampWait(waitMs);
		if (wait === 0) return Promise.resolve(null);
		return new Promise<BrainJob | null>((resolve) => {
			const self: Poller = { resolve, timer: null };
			self.timer = clock.setTimeout(() => {
				if (poller === self) poller = null;
				resolve(null);
			}, wait);
			poller = self;
			// The HTTP client hung up: stop holding a slot that would swallow the
			// next job into a dead socket.
			signal?.addEventListener(
				"abort",
				() => {
					if (poller === self) releasePoller(null);
				},
				{ once: true },
			);
		});
	}

	// ③ a job the brain never received cannot be answered, whatever id it guesses
	function answerDelivered(jobId: string, outcome: BrainOutcome): SubmitStatus {
		const record = jobs.get(jobId);
		if (!record || !record.delivered) return "not_found";
		settle(jobId, outcome);
		return "accepted";
	}

	return {
		enqueue,
		next,
		submitResult: (jobId, result) => answerDelivered(jobId, { kind: "result", result }),
		rejectResult: (jobId, reason) => answerDelivered(jobId, { kind: "rejected", reason }),
		findDelivered: (jobId) => {
			const record = jobs.get(jobId);
			return record?.delivered ? record.job : null;
		},
		isBrainOnline: (now = clock.now()) =>
			lastPollAt !== null && now - lastPollAt <= BOT_CONSTANTS.DERO_BRAIN_ONLINE_WINDOW_MS,
	};
}

/** The process wide queue shared by /dero and the /brain routes. */
export const brainQueue = createBrainQueue();
