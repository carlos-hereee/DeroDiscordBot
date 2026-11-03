import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createHash, createHmac } from "crypto";

// verifySignature reads its secret and api key from @utils/config at import time via
// module-level bindings, so we mock the module before importing the middleware. Each test
// that needs a different secret/apikey uses vi.doMock + dynamic import.
//
// These tests protect the signature *contract* with the server. If a refactor changes the
// canonical string shape on either side, the format-pinning test here will catch it
// before the bot starts 401-ing every real request in production.

const SECRET = "test-secret-at-least-32-chars-long-padding";
const API_KEY = "test-api-key";

function makeRes() {
	const res = {
		status: vi.fn(),
		json: vi.fn(),
	};
	res.status.mockReturnValue(res);
	res.json.mockReturnValue(res);
	return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

function makeReq(opts: {
	method?: string;
	originalUrl?: string;
	rawBody?: string;
	headers?: Record<string, string>;
}): Request {
	return {
		method: opts.method ?? "GET",
		originalUrl: opts.originalUrl ?? "/api/events",
		url: opts.originalUrl ?? "/api/events",
		rawBody: opts.rawBody,
		headers: opts.headers ?? {},
	} as unknown as Request;
}

// Hand-compute a signature that matches what the server's signRequest would produce. We
// deliberately recreate the canonical-string construction here rather than importing the
// helper so the test reflects the wire contract, not the implementation.
function signLike(opts: {
	method: string;
	path: string;
	query: string;
	body: string;
	timestamp: string;
	secret?: string;
}): string {
	const secret = opts.secret ?? SECRET;
	const bodyHash = createHash("sha256").update(opts.body, "utf8").digest("hex");
	const params = new URLSearchParams(opts.query);
	const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const rebuilt = new URLSearchParams();
	for (const [k, v] of entries) rebuilt.append(k, v);
	const canonicalQuery = rebuilt.toString();
	const pathWithQuery = canonicalQuery ? `${opts.path}?${canonicalQuery}` : opts.path;
	const canonical = `${opts.method.toUpperCase()}\n${pathWithQuery}\n${opts.timestamp}\n${bodyHash}`;
	return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

// Loader helper: mocks config with the given values and returns a fresh middleware
// import. Must run inside tests (not at top level) so vi.resetModules() isolates each
// configuration cleanly.
async function loadMiddleware(config: { signingSecret: string; apiKey: string; requireSigned?: boolean }) {
	vi.resetModules();
	vi.doMock("@utils/config.js", () => ({
		dashboardSigningSecret: config.signingSecret,
		dashboardApiKey: config.apiKey,
		// Strict mode defaults off so existing tests exercise the rollout-era
		// fallback behavior; the strict-mode tests opt in explicitly.
		requireSignedRequests: config.requireSigned ?? false,
	}));
	const mod = await import("./verifySignature.js");
	return mod.verifySignature;
}

describe("verifySignature", () => {
	const now = 1_700_000_000_000;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.resetModules();
		vi.doUnmock("@utils/config.js");
	});

	it("calls next() when signature, timestamp, and api key are all valid", async () => {
		const verifySignature = await loadMiddleware({ signingSecret: SECRET, apiKey: API_KEY });
		const timestamp = String(now);
		const body = JSON.stringify({ name: "foo" });
		const signature = signLike({
			method: "POST",
			path: "/api/events",
			query: "",
			body,
			timestamp,
		});

		const req = makeReq({
			method: "POST",
			originalUrl: "/api/events",
			rawBody: body,
			headers: {
				"x-timestamp": timestamp,
				"x-signature": signature,
				"x-api-key": API_KEY,
			},
		});
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);

		expect(next).toHaveBeenCalledTimes(1);
		expect(res.status).not.toHaveBeenCalled();
	});

	it("verifies a request with sorted query params regardless of sent order", async () => {
		// Server sorts "a=1&b=2"; client sends "b=2&a=1". Both must sign the same canonical
		// string or every request with >1 query param fails in prod.
		const verifySignature = await loadMiddleware({ signingSecret: SECRET, apiKey: API_KEY });
		const timestamp = String(now);
		const signature = signLike({
			method: "GET",
			path: "/api/events",
			query: "b=2&a=1",
			body: "",
			timestamp,
		});

		const req = makeReq({
			method: "GET",
			originalUrl: "/api/events?b=2&a=1",
			rawBody: "",
			headers: {
				"x-timestamp": timestamp,
				"x-signature": signature,
				"x-api-key": API_KEY,
			},
		});
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("rejects when the signature was computed with a different secret", async () => {
		const verifySignature = await loadMiddleware({ signingSecret: SECRET, apiKey: API_KEY });
		const timestamp = String(now);
		const signature = signLike({
			method: "GET",
			path: "/api/events",
			query: "",
			body: "",
			timestamp,
			secret: "a-completely-different-secret-padding",
		});

		const req = makeReq({
			headers: {
				"x-timestamp": timestamp,
				"x-signature": signature,
				"x-api-key": API_KEY,
			},
		});
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("rejects when the timestamp is older than the replay window", async () => {
		const verifySignature = await loadMiddleware({ signingSecret: SECRET, apiKey: API_KEY });
		// 6 minutes in the past, past the 5 minute cutoff.
		const timestamp = String(now - 6 * 60 * 1000);
		const signature = signLike({
			method: "GET",
			path: "/api/events",
			query: "",
			body: "",
			timestamp,
		});

		const req = makeReq({
			headers: {
				"x-timestamp": timestamp,
				"x-signature": signature,
				"x-api-key": API_KEY,
			},
		});
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("rejects when the timestamp is not a number", async () => {
		const verifySignature = await loadMiddleware({ signingSecret: SECRET, apiKey: API_KEY });
		const req = makeReq({
			headers: {
				"x-timestamp": "not-a-number",
				"x-signature": "deadbeef",
				"x-api-key": API_KEY,
			},
		});
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("rejects a valid signature when the api key is wrong (defense in depth)", async () => {
		const verifySignature = await loadMiddleware({ signingSecret: SECRET, apiKey: API_KEY });
		const timestamp = String(now);
		const signature = signLike({
			method: "GET",
			path: "/api/events",
			query: "",
			body: "",
			timestamp,
		});

		const req = makeReq({
			headers: {
				"x-timestamp": timestamp,
				"x-signature": signature,
				"x-api-key": "wrong-key",
			},
		});
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("falls back to apiKeyAuth when the signing secret is not configured", async () => {
		// Rollout scenario: server started signing but the bot has not yet received the
		// secret. A request with just x-api-key must still succeed.
		const verifySignature = await loadMiddleware({ signingSecret: "", apiKey: API_KEY });
		const req = makeReq({
			headers: { "x-api-key": API_KEY },
		});
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("falls back to apiKeyAuth when signing headers are absent but api key is valid", async () => {
		// Legacy caller (curl, a script) that does not sign. The bot still has its signing
		// secret configured, but we accept plain api key auth until we harden.
		const verifySignature = await loadMiddleware({ signingSecret: SECRET, apiKey: API_KEY });
		const req = makeReq({
			headers: { "x-api-key": API_KEY },
		});
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("rejects when both signing headers and api key are absent", async () => {
		const verifySignature = await loadMiddleware({ signingSecret: SECRET, apiKey: API_KEY });
		const req = makeReq({ headers: {} });
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	// ── strict mode (REQUIRE_SIGNED_REQUESTS=true), audit item C2 ──────
	it("strict mode: rejects an unsigned request even with a valid api key", async () => {
		// The whole point of strict mode: once both sides sign, a caller holding
		// only the shared static api key can no longer pass an arbitrary ?guildId=.
		const verifySignature = await loadMiddleware({ signingSecret: SECRET, apiKey: API_KEY, requireSigned: true });
		const req = makeReq({ headers: { "x-api-key": API_KEY } });
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("strict mode with no signing secret fails closed (no api-key fallback)", async () => {
		// Misconfiguration: strict mode promises signature verification but no
		// secret is configured to verify with. Fail closed rather than silently
		// downgrade to api-key auth.
		const verifySignature = await loadMiddleware({ signingSecret: "", apiKey: API_KEY, requireSigned: true });
		const req = makeReq({ headers: { "x-api-key": API_KEY } });
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("strict mode still admits a fully valid signed request", async () => {
		const verifySignature = await loadMiddleware({ signingSecret: SECRET, apiKey: API_KEY, requireSigned: true });
		const timestamp = String(now);
		const signature = signLike({ method: "GET", path: "/api/events", query: "", body: "", timestamp });
		const req = makeReq({
			headers: { "x-timestamp": timestamp, "x-signature": signature, "x-api-key": API_KEY },
		});
		const res = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		verifySignature(req, res, next);
		expect(next).toHaveBeenCalledTimes(1);
	});
});
