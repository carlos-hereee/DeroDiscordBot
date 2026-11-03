import { createHmac, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { deroBrainKey } from "@utils/config.js";
import { buildCanonicalString, hashBody } from "@utils/canonicalRequest.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── verifyBrainSignature ──
// What: authenticates every request from the launcher's local Dero (the brain)
//   by recomputing the HMAC-SHA256 it stamped on the request and comparing it in
//   constant time.
// Who: every route under /brain (createBrainRouter applies it first). The caller
//   is the launcher's voice brain link in another repository, which signs with
//   the same canonical string the dashboard proxy uses.
// When: every request, with NO rollout fallback. Unlike verifySignature there is
//   no api key path and no unsigned path: the brain link is new, so there is no
//   old caller to keep alive, and a fallback would be the whole attack surface.
// Where: mounted in server.ts BEFORE verifySignature, so dashboard credentials
//   never open /brain and DERO_BRAIN_KEY never opens /api. Sits after
//   express.json({ verify }), so req.rawBody holds the exact bytes the launcher
//   signed.
// How:
//   ① A missing or short key answers 503 for everything: the routes are off,
//      not open, and the caller learns nothing about its own signature.
//   ② x-timestamp and x-signature must both be present, the timestamp a finite
//      epoch in milliseconds within 5 minutes either way of now (the same replay
//      window as the dashboard link; future timestamps are refused too).
//   ③ The canonical string is METHOD, path?sortedQuery, timestamp and the sha256
//      of the RAW body, built by the shared buildCanonicalString and hashBody.
//      Never a re-stringified parse: key order and whitespace would change the
//      hash and 401 every request.
//   ④ HMAC-SHA256 hex with DERO_BRAIN_KEY, compared with timingSafeEqual.
//   ⑤ Any problem is a bare 401 with no detail, so a prober cannot tell a stale
//      clock from a wrong key.

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
// A SHA256 HMAC as lowercase hex. Checked before the compare so a malformed
// header can never reach Buffer.from's lenient hex decoding.
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

// Constant time hex comparison. A twin of the private helper in verifySignature.ts,
// which this phase may not edit to export it (logged as a duplicate).
function safeHexEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
	}
	catch {
		// timingSafeEqual throws on a length mismatch after decoding; that is a "no".
		return false;
	}
}

/** True when DERO_BRAIN_KEY is long enough for the /brain routes to run at all. */
export function isBrainKeyConfigured(key: string = deroBrainKey): boolean {
	return key.length >= BOT_CONSTANTS.DERO_BRAIN_MIN_KEY_LENGTH;
}

function unauthorized(res: Response): void {
	res.status(401).json({ error: "Unauthorized" });
}

export function verifyBrainSignature(req: Request, res: Response, next: NextFunction): void {
	// ①
	if (!isBrainKeyConfigured()) {
		res.status(503).json({ error: "Unavailable" });
		return;
	}

	// ②
	const timestamp = req.headers["x-timestamp"];
	const signature = req.headers["x-signature"];
	if (typeof timestamp !== "string" || typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
		unauthorized(res);
		return;
	}
	const timestampMs = Number(timestamp);
	if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_SKEW_MS) {
		unauthorized(res);
		return;
	}

	// ③ originalUrl keeps the mount prefix (/brain/next) and the raw query, both
	// of which the launcher signed; req.path would drop both.
	const originalUrl = req.originalUrl || req.url;
	const queryAt = originalUrl.indexOf("?");
	const path = queryAt === -1 ? originalUrl : originalUrl.slice(0, queryAt);
	const query = queryAt === -1 ? "" : originalUrl.slice(queryAt + 1);
	const canonical = buildCanonicalString({
		method: req.method,
		path,
		query,
		timestamp,
		bodyHash: hashBody(req.rawBody ?? ""),
	});

	// ④⑤
	const expected = createHmac("sha256", deroBrainKey).update(canonical, "utf8").digest("hex");
	if (!safeHexEqual(expected, signature)) {
		unauthorized(res);
		return;
	}
	next();
}
