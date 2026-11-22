import { Router, type Request } from "express";
import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { verifyBrainSignature } from "@api/middleware/verifyBrainSignature.js";
import { claimNextSummaryJob, type SummaryJobBody } from "@features/meetings/summaryJobs.js";
import { acceptSummaryResult, parseSummaryResult, type SummaryOutcome, type SummaryResult } from "@features/meetings/summaryResult.js";

// ── /brain/meeting-summary routes (2026-11 item 388 Phase 4, owner decision D9) ──
// What:  the durable twin of /brain/next and /brain/result for meeting summaries: GET
//        /next long polls for one summary job and claims it under a lease, POST /result takes
//        the launcher's summary (or its failure) for that lease.
// Who:   the launcher's meeting summary loop (dev-launcher src/dero/meetingSummary.ts), and
//        nobody else. Never dashboard traffic, never on the server's ROK_BOT_PATH_PREFIXES.
// Where: mounted in server.ts at /brain/meeting-summary BEFORE the /brain router (whose
//        catch all would answer 404 first) and before verifySignature, signed with
//        DERO_BRAIN_KEY through verifyBrainSignature, the same as the brain router. Body
//        parse errors reach brainBodyErrorHandler, mounted after both at /brain.
// Why separate from brainQueue: that queue is memory only with a 20 second job timeout,
//        built for a member waiting on a spoken answer. A summary must survive restarts and a
//        launcher that is away for days, so its jobs are Mongo rows claimed with a lease.
// How:
//   ① every request passes verifyBrainSignature first;
//   ② GET /next?waitMs= claims at once or rereads every SUMMARY_POLL_RECHECK_MS until the wait
//      (at most SUMMARY_POLL_MS) ends: 200 with the job, 204 with none. A launcher that hangs
//      up stops the wait before another claim is made;
//   ③ POST /result refuses a raw body over SUMMARY_RESULT_MAX_BYTES (413) before reading it,
//      an invalid result whole (400, the reason logged), a job unknown or no longer leased
//      under the posted leaseId (404), and answers 200 when accepted.
//
// ⚠️ PRIVACY: logs carry job ids, sizes and reason codes, never a word of the transcript or
// of the summary.

export interface MeetingSummaryRouterDeps {
	client: Client;
	claimNext?: (client: Client) => Promise<SummaryJobBody | null>;
	accept?: (client: Client, result: SummaryResult) => Promise<SummaryOutcome>;
	// Waits between rereads; injectable so a test never sleeps for real.
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	now?: () => number;
}

const MEETINGS = BOT_CONSTANTS.MEETINGS;

function readWaitMs(req: Request): number {
	const raw = req.query.waitMs;
	// Absent or unreadable means the normal long poll.
	const asked = typeof raw === "string" && raw !== "" ? Number(raw) : Number.NaN;
	if (!Number.isFinite(asked)) return MEETINGS.SUMMARY_POLL_MS;
	return Math.min(MEETINGS.SUMMARY_POLL_MS, Math.max(0, Math.floor(asked)));
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		timer.unref();
		function done(): void {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

export function createMeetingSummaryRouter({ client, claimNext = claimNextSummaryJob, accept = acceptSummaryResult, sleep = abortableSleep, now = Date.now }: MeetingSummaryRouterDeps): Router {
	const router = Router();

	// ①
	router.use(verifyBrainSignature);

	// ②
	router.get("/next", async (req, res, next) => {
		const hangUp = new AbortController();
		res.on("close", () => {
			if (!res.writableFinished) hangUp.abort();
		});
		try {
			const deadline = now() + readWaitMs(req);
			for (;;) {
				if (hangUp.signal.aborted) return;
				const job = await claimNext(client);
				if (job) {
					console.info(`[meetings] summary job delivered job=${job.jobId} bytes=${Buffer.byteLength(JSON.stringify(job), "utf8")}`);
					res.status(200).json(job);
					return;
				}
				const left = deadline - now();
				if (left <= 0) break;
				await sleep(Math.min(MEETINGS.SUMMARY_POLL_RECHECK_MS, left), hangUp.signal);
			}
			if (!hangUp.signal.aborted) res.status(204).end();
		} catch (error) {
			next(error);
		}
	});

	// ③
	router.post("/result", async (req, res, next) => {
		const bytes = Buffer.byteLength(req.rawBody ?? "", "utf8");
		if (bytes > MEETINGS.SUMMARY_RESULT_MAX_BYTES) {
			console.warn(`[meetings] summary result refused reason=too_large bytes=${bytes}`);
			res.status(413).json({ error: "Payload too large" });
			return;
		}
		const parsed = parseSummaryResult(req.body);
		if (!parsed.ok) {
			console.warn(`[meetings] summary result refused reason=${parsed.reason} bytes=${bytes}`);
			res.status(400).json({ error: "Invalid result" });
			return;
		}
		try {
			if ((await accept(client, parsed.value)) === "not_found") {
				res.status(404).json({ error: "Not found" });
				return;
			}
			res.status(200).json({ ok: true });
		} catch (error) {
			next(error);
		}
	});

	return router;
}
