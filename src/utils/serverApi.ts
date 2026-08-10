import { createHmac } from "crypto";

// ── serverApi ──
// What: thin HTTP client for outbound calls from this bot to the nexious-server's
//   /api/events surface. Mirrors the server's plugin-proxy/signRequest.ts in reverse:
//   we sign every outbound request with the same shared secret and canonicalization
//   format so the server's verifyBotSignature middleware can authenticate us.
// Who: called by remoteEventStore.ts (the Future-A read path) and by any slash command
//   that needs to mutate events through the server (replaces direct eventStore writes
//   in F2). Downstream consumer is nexious-server which routes verified bot calls to
//   the same handlers the dashboard uses.
// When: every read/write to a Future-A event when USE_REMOTE_EVENTS is on. Each call
//   incurs one HTTPS round-trip to Heroku, so callers are responsible for caching when
//   appropriate (the cron tick reads through remoteEventStore which has a 60s TTL).
// Where: lives next to config.ts because it shares the same env vars (SERVER_BASE_URL,
//   DASHBOARD_SIGNING_SECRET). No Discord types, pure HTTP.
// How:
//   ① Build the canonical string: METHOD\npath?sortedQuery\ntimestamp\nsha256(body).
//      MUST match nexious-server/src/features/plugin-proxy/signRequest.ts byte-for-byte
//      because the server's verifyBotSignature recomputes the same string.
//   ② HMAC-SHA256 with DASHBOARD_SIGNING_SECRET. Hex-encode for header transport.
//   ③ fetch() the URL with x-timestamp + x-signature headers, plus the legacy
//      x-api-key for defense in depth (matches the server → bot direction).
//   ④ On non-2xx, throw a typed error so callers can distinguish "server unreachable"
//      from "validation failed" from "guild not found".

import { dashboardApiKey, dashboardSigningSecret } from "@utils/config.js";
import { buildCanonicalString, hashBody } from "@utils/canonicalRequest.js";

// Base URL of the nexious-server. Heroku in prod, localhost during dev. Empty when not
// set, every call short-circuits to a "not configured" error so we never accidentally
// leak requests to a default URL.
// Accept BOTH env names: the code historically read SERVER_BASE_URL, but both CLAUDE.md
// files document the var as NEXIOUS_BASE_URL. Reading either prevents the remote-events
// path from silently failing to configure when an operator follows the docs. Prefer
// SERVER_BASE_URL if both are set so an existing Railway value keeps winning.
const serverBaseUrl = process.env.SERVER_BASE_URL ?? process.env.NEXIOUS_BASE_URL ?? "";

// Reuse the server's exact 5-minute window. Any request the bot signs must reach the
// server within this window or it will be rejected as stale. Logging the latency would
// help tune the window if Heroku/Railway clock drift ever crosses it (not yet observed).
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
void SIGNATURE_WINDOW_MS; // exported only for documentation; runtime check happens server-side

// Default fetch timeout. The server is normally <300ms p99; 5 seconds is a generous cap
// that still keeps the cron tick (60s budget) from blocking on a single hung request.
const DEFAULT_TIMEOUT_MS = 5_000;

// canonicalizeQuery / hashBody / buildCanonicalString moved to
// @utils/canonicalRequest (audit M1) and imported above, so the inbound verifier
// and this outbound signer share one definition. The server's copy lives in a
// separate repo (nexious-server signRequest.ts) and must still be kept
// byte-identical by hand.

// ── Typed errors ──
// Callers catch these to distinguish transport failures from validation failures.
// remoteEventStore + slash commands use the discriminator to pick the right user-facing
// error message ("platform unreachable" vs "event not found").
export class ServerUnreachableError extends Error {
	constructor(cause: unknown) {
		super("nexious-server is unreachable");
		this.cause = cause;
		this.name = "ServerUnreachableError";
	}
}

export class ServerResponseError extends Error {
	status: number;
	body: unknown;
	constructor(status: number, body: unknown) {
		super(`server returned ${status}`);
		this.status = status;
		this.body = body;
		this.name = "ServerResponseError";
	}
}

export class ServerNotConfiguredError extends Error {
	constructor() {
		super("SERVER_BASE_URL or DASHBOARD_SIGNING_SECRET is not set; cannot call server");
		this.name = "ServerNotConfiguredError";
	}
}

// ── Latency tracking ──
// Per the F5 observability item: log p50/p95/p99 of outbound calls so we notice if the
// cron tick (60s budget) is at risk of overruns. The ring buffer is per-process, so
// restarts wipe it, fine for a single Railway dyno, would need shipping to a metrics
// store for multi-instance.
const LATENCY_RING_SIZE = 200;
const latencyRing: number[] = [];
const recordLatency = (ms: number): void => {
	latencyRing.push(ms);
	if (latencyRing.length > LATENCY_RING_SIZE) latencyRing.shift();
};

// Public so a /metrics endpoint or scheduled log line can read recent percentiles
// without exposing the ring directly.
export const getOutboundLatencyStats = (): { p50: number; p95: number; p99: number; samples: number } => {
	if (latencyRing.length === 0) return { p50: 0, p95: 0, p99: 0, samples: 0 };
	const sorted = [...latencyRing].sort((a, b) => a - b);
	const pick = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
	return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), samples: latencyRing.length };
};

// ── Outage state ──
// What: timestamps of the last successful call and the last failed call. The
//   outage watcher (features/observability/outageWatcher.ts) reads these to
//   decide whether the server has been unreachable long enough to warrant a
//   one-time DM to the platform owner.
// Who: written here from request(); read by outageWatcher.
// When: updated on every fetch result. Cheap.
// Where: kept module-local so callers cannot accidentally mutate them.
// How: separate timestamps (not a counter) so we can answer "is the most
//   recent event a success or a failure" by comparing the two values, and
//   "how long has the failure window been" by subtracting from now.
let lastSuccessAt: number | null = null;
let lastFailureAt: number | null = null;

export const getServerReachabilityState = (): {
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	currentlyFailing: boolean;
	failureDurationMs: number;
} => {
	const now = Date.now();
	// "currently failing" is defined as: the last failure happened more recently
	// than the last success. If we have no signal at all (cold boot, no calls
	// yet), we are NOT currently failing, there is nothing to notify about.
	const currentlyFailing =
		lastFailureAt !== null && (lastSuccessAt === null || lastFailureAt > lastSuccessAt);
	// failureDurationMs is how long we have been in the failing state. Zero
	// when not failing or when the failure happened literally now.
	const failureDurationMs =
		currentlyFailing && lastFailureAt !== null
			? now - lastFailureAt
			: 0;
	return { lastSuccessAt, lastFailureAt, currentlyFailing, failureDurationMs };
};

// ── Core request function ──
// Called by every helper below. Centralizes signing, timeout, and error mapping so the
// helpers stay one-liners.
interface RequestArgs {
	method: "GET" | "POST" | "PATCH" | "DELETE";
	// Path under serverBaseUrl, e.g. "/api/events". Leading slash required.
	path: string;
	// Optional query parameters as a record; serialized into the URL.
	query?: Record<string, string>;
	// Optional JSON body, serialized once so signing and transmission see the same bytes.
	body?: unknown;
	// Per-call timeout override. Defaults to DEFAULT_TIMEOUT_MS.
	timeoutMs?: number;
}

const request = async <T>({ method, path, query, body, timeoutMs }: RequestArgs): Promise<T> => {
	if (!serverBaseUrl || !dashboardSigningSecret) {
		throw new ServerNotConfiguredError();
	}

	// Build URL with sorted query for predictable signing input. The server canonicalizes
	// again on its side, so any equivalent ordering would verify, but we sort here too so
	// log lines match between the two services.
	const url = new URL(path, serverBaseUrl);
	if (query) {
		const entries = Object.entries(query)
			.filter(([, v]) => v !== undefined && v !== null && v !== "")
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		for (const [k, v] of entries) url.searchParams.set(k, v);
	}

	// Serialize the body exactly once. Both the signature input AND the wire payload must
	// be the SAME bytes, re-stringifying could drift on key order or whitespace.
	const hasBody = method === "POST" || method === "PATCH";
	const bodyText = hasBody ? JSON.stringify(body ?? {}) : "";

	const timestamp = `${Date.now()}`;
	const bodyHash = hashBody(bodyText);
	const canonical = buildCanonicalString({
		method,
		path: url.pathname,
		query: url.search.replace(/^\?/, ""),
		timestamp,
		bodyHash,
	});
	const signature = createHmac("sha256", dashboardSigningSecret).update(canonical, "utf8").digest("hex");

	// AbortController gives us a per-call timeout that the cron tick relies on. Without
	// it, a hung Heroku response could block the scheduler past its 60s budget.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);

	const startedAt = Date.now();
	let response: Response;
	try {
		response = await fetch(url.toString(), {
			method,
			headers: {
				"content-type": "application/json",
				"x-timestamp": timestamp,
				"x-signature": signature,
				// Defense in depth, server's allowBotOrUser only checks the signature, but
				// the legacy api key is forwarded in case the server tightens auth later.
				...(dashboardApiKey ? { "x-api-key": dashboardApiKey } : {}),
			},
			body: hasBody ? bodyText : undefined,
			signal: controller.signal,
		});
	} catch (err) {
		// AbortError, ECONNREFUSED, DNS failures, everything that prevents a response.
		// Surface as a single "unreachable" error so the caller can decide whether to
		// fall back to the local DB or error the user.
		// Mark the failure timestamp BEFORE throwing so the outage watcher sees it
		// on its next tick. We classify only TRANSPORT failures as "unreachable",
		// a 4xx/5xx response counts as reachable-but-erroring and is tracked below.
		lastFailureAt = Date.now();
		throw new ServerUnreachableError(err);
	} finally {
		clearTimeout(timer);
		recordLatency(Date.now() - startedAt);
	}

	// Try to parse JSON regardless of status, error responses also come as JSON. Falls
	// back to text on parse failure so we don't lose the diagnostic message.
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}

	if (!response.ok) {
		// 5xx is server-side trouble; we count it as "currently failing" because the
		// outage watcher cares about "can the server actually serve us." 4xx is a
		// caller bug (bad request, unauthorized, not found) and does NOT indicate
		// the server is down, only 5xx flips the failure timestamp.
		if (response.status >= 500) {
			lastFailureAt = Date.now();
		} else {
			// 4xx still counts as a successful round-trip from the reachability
			// perspective: the server received our bytes and replied.
			lastSuccessAt = Date.now();
		}
		throw new ServerResponseError(response.status, parsed);
	}
	// 2xx, server is reachable and happy.
	lastSuccessAt = Date.now();
	return parsed as T;
};

// ── High-level helpers ──
// Each helper just narrows the request signature for a specific HTTP verb so call sites
// read like serverApi.get("/api/events", { guildId }).

export const serverApi = {
	get: <T>(path: string, query?: Record<string, string>): Promise<T> => request<T>({ method: "GET", path, query }),
	post: <T>(path: string, body?: unknown, query?: Record<string, string>): Promise<T> =>
		request<T>({ method: "POST", path, body, query }),
	patch: <T>(path: string, body?: unknown, query?: Record<string, string>): Promise<T> =>
		request<T>({ method: "PATCH", path, body, query }),
	delete: <T>(path: string, query?: Record<string, string>): Promise<T> =>
		request<T>({ method: "DELETE", path, query }),
};
