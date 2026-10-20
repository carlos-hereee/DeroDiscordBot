import { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { verifyBrainSignature } from "@api/middleware/verifyBrainSignature.js";
import { brainQueue, type BrainQueue } from "@features/dero-brain/brainQueue.js";
import { parseBrainResult } from "@features/dero-brain/parseBrainResult.js";

// ── /brain routes (Dero voice plan, Phase 2a) ─────────────────────────────
// What:  the two endpoints the launcher's local Dero (the brain) talks to:
//        GET /brain/next, a long poll that hands out one job, and POST
//        /brain/result, where the brain answers it.
// Who:   the launcher's voice brain link (another repository), and nobody else.
//        The link is OUTBOUND from the owner's PC: the bot never calls the brain.
// When:  the launcher polls continuously while it runs; each poll is also the
//        heartbeat /dero status reads.
// Where: mounted at /brain in server.ts BEFORE verifySignature, signed with
//        DERO_BRAIN_KEY through verifyBrainSignature. NOT dashboard traffic: it
//        is not on the server's ROK_BOT_PATH_PREFIXES and must never be, so the
//        platform proxy can never reach it.
// How:
//   ① every request passes verifyBrainSignature first (503 with no key, a bare
//      401 on any signature problem);
//   ② GET /next?waitMs= answers 200 with one job, or 204 when none arrived in
//      the wait (at most 25 seconds);
//   ③ POST /result refuses a raw body over 16 KB (413) before it is parsed,
//      refuses an invalid result whole (400, reason code logged), answers 404
//      for an unknown, finished or expired job, and 200 when accepted.
//
// ⚠️ PRIVACY: logs carry job ids, guild ids, lengths and reason codes. Never the
// member's task, and never anything the brain wrote.
//
// There is deliberately no endpoint that lists guilds, members or channels.
// The brain learns about a guild only through the job the bot chose to send.

export interface BrainRouterDeps {
	queue?: BrainQueue;
}

// A JSON body that failed to parse never reaches the router, because
// express.json rejects it at the app level. These are the body-parser error
// types this handler answers for; anything else goes on to Express.
const BODY_TOO_LARGE = "entity.too.large";
const BODY_PARSE_FAILED = "entity.parse.failed";

function readWaitMs(req: Request): number {
	const raw = req.query.waitMs;
	// Absent or empty means "the normal long poll"; the queue clamps the rest.
	if (typeof raw !== "string" || raw === "") return Number.NaN;
	return Number(raw);
}

// The job id of a refused body, read only so the waiting member can be told at
// once instead of after the 20 second timeout. An own string property only.
function claimedJobId(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	if (!Object.prototype.hasOwnProperty.call(body, "jobId")) return null;
	const jobId = (body as { jobId: unknown }).jobId;
	return typeof jobId === "string" ? jobId : null;
}

// Fire and forget (house rule 7): a failed audit write never changes the
// response the brain gets.
function auditRejected(guildId: string, metadata: Record<string, unknown>): void {
	botLogStore.log(guildId, BOT_LOG_EVENTS.DERO_BRAIN_REJECTED, metadata).catch((err) => {
		console.error(`[dero-brain] audit write failed guild=${guildId}`, err);
	});
}

function sendInvalid(res: Response): void {
	res.status(400).json({ error: "Invalid result" });
}

export function createBrainRouter({ queue = brainQueue }: BrainRouterDeps = {}): Router {
	const router = Router();

	// ①
	router.use(verifyBrainSignature);

	// ②
	router.get("/next", async (req, res) => {
		// The launcher hanging up mid poll must free the poll slot, or the next
		// job would be handed to a socket nobody is reading.
		const hangUp = new AbortController();
		res.on("close", () => {
			if (!res.writableFinished) hangUp.abort();
		});

		const job = await queue.next(readWaitMs(req), hangUp.signal);
		if (!job) {
			res.status(204).end();
			return;
		}
		console.info(
			`[dero-brain] job delivered job=${job.jobId} guild=${job.guild.id} chars=${job.text.length} channels=${job.channels.length}`,
		);
		res.status(200).json(job);
	});

	// ③
	router.post("/result", (req, res) => {
		const bytes = Buffer.byteLength(req.rawBody ?? "", "utf8");
		if (bytes > BOT_CONSTANTS.DERO_BRAIN_MAX_RESULT_BYTES) {
			console.warn(`[dero-brain] result refused reason=too_large bytes=${bytes}`);
			res.status(413).json({ error: "Payload too large" });
			return;
		}

		const parsed = parseBrainResult(req.body);
		if (!parsed.ok) {
			// A refused result still settles its job (single use), as a rejection,
			// so /dero tell answers "could not understand" right away.
			const job = queue.findDelivered(claimedJobId(req.body) ?? "");
			if (job) queue.rejectResult(job.jobId, parsed.reason);
			console.warn(`[dero-brain] result refused reason=${parsed.reason} job=${job?.jobId ?? "unknown"} bytes=${bytes}`);
			if (job) auditRejected(job.guild.id, { jobId: job.jobId, reason: parsed.reason, bytes });
			sendInvalid(res);
			return;
		}

		const result = parsed.value;
		if (queue.submitResult(result.jobId, result) === "not_found") {
			res.status(404).json({ error: "Not found" });
			return;
		}
		console.info(`[dero-brain] result accepted job=${result.jobId} status=${result.status} actions=${result.actions.length}`);
		res.status(200).json({ ok: true });
	});

	// Nothing else lives under /brain. Answer here so an unknown path never falls
	// through into the dashboard middleware mounted after this router.
	router.use((_req, res) => {
		res.status(404).json({ error: "Not found" });
	});

	return router;
}

/**
 * Error handler for /brain bodies that express.json could not accept. Mounted
 * right after the router. A body that is not JSON still gets the signature
 * check first, so an unsigned caller sees the same bare 401 as everywhere else;
 * a signed one gets a bare 400.
 */
export const brainBodyErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
	const type = (err as { type?: unknown }).type;
	if (type === BODY_TOO_LARGE) {
		res.status(413).json({ error: "Payload too large" });
		return;
	}
	if (type !== BODY_PARSE_FAILED) {
		next(err);
		return;
	}
	verifyBrainSignature(req, res, () => {
		console.warn("[dero-brain] result refused reason=bad_json");
		sendInvalid(res);
	});
};
