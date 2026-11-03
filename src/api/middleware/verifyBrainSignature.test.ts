import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { createHash, createHmac } from "crypto";

// ── verifyBrainSignature ───────────────────────────────────────────────────
// The middleware reads DERO_BRAIN_KEY from @utils/config at import time, so each
// test mocks the config and imports a fresh copy, the same way
// verifySignature.test.ts does.
//
// signLike rebuilds the canonical string INLINE rather than importing
// canonicalRequest.ts, so these tests pin the wire contract the launcher signs
// against: a drift in the shared helper fails them before every brain request
// starts answering 401.

const KEY = "k".repeat(32);
const NOW = 1_700_000_000_000;

function signLike(opts: { method: string; path: string; query: string; body: string; timestamp: string; key?: string }): string {
	const bodyHash = createHash("sha256").update(opts.body, "utf8").digest("hex");
	const entries = [...new URLSearchParams(opts.query).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const rebuilt = new URLSearchParams();
	for (const [name, value] of entries) rebuilt.append(name, value);
	const sortedQuery = rebuilt.toString();
	const pathWithQuery = sortedQuery ? `${opts.path}?${sortedQuery}` : opts.path;
	const canonical = `${opts.method.toUpperCase()}\n${pathWithQuery}\n${opts.timestamp}\n${bodyHash}`;
	return createHmac("sha256", opts.key ?? KEY).update(canonical, "utf8").digest("hex");
}

function makeRes() {
	const res = { status: vi.fn(), json: vi.fn() };
	res.status.mockReturnValue(res);
	res.json.mockReturnValue(res);
	return res as unknown as Response & { status: ReturnType<typeof vi.fn> };
}

function makeReq(opts: { method?: string; originalUrl?: string; rawBody?: string; headers?: Record<string, string> }): Request {
	return {
		method: opts.method ?? "GET",
		originalUrl: opts.originalUrl ?? "/brain/next?waitMs=25000",
		url: opts.originalUrl ?? "/brain/next?waitMs=25000",
		rawBody: opts.rawBody,
		headers: opts.headers ?? {},
	} as unknown as Request;
}

async function loadMiddleware(key: string) {
	vi.resetModules();
	vi.doMock("@utils/config.js", () => ({ deroBrainKey: key }));
	return (await import("./verifyBrainSignature.js")).verifyBrainSignature;
}

// Run the middleware once and report what it did.
async function verdict(req: Request, key: string = KEY): Promise<"next" | number> {
	const verify = await loadMiddleware(key);
	const res = makeRes();
	const next = vi.fn() as unknown as NextFunction;
	verify(req, res, next);
	if ((next as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0) return "next";
	return res.status.mock.calls[0][0] as number;
}

const signedGet = (timestamp: string = String(NOW), key: string = KEY) =>
	makeReq({
		headers: {
			"x-timestamp": timestamp,
			"x-signature": signLike({ method: "GET", path: "/brain/next", query: "waitMs=25000", body: "", timestamp, key }),
		},
	});

const BODY = JSON.stringify({ jobId: "0f8fad5b-d9cb-469f-a165-70867728950e", status: "ok", actions: [] });
const signedPost = (rawBody: string = BODY) =>
	makeReq({
		method: "POST",
		originalUrl: "/brain/result",
		rawBody,
		headers: {
			"x-timestamp": String(NOW),
			"x-signature": signLike({ method: "POST", path: "/brain/result", query: "", body: BODY, timestamp: String(NOW) }),
		},
	});

describe("verifyBrainSignature", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.resetModules();
		vi.doUnmock("@utils/config.js");
	});

	it("admits a correctly signed poll and a correctly signed result", async () => {
		expect(await verdict(signedGet())).toBe("next");
		expect(await verdict(signedPost())).toBe("next");
	});

	it("signs the query sorted, whatever order the caller sent it in", async () => {
		const timestamp = String(NOW);
		const req = makeReq({
			originalUrl: "/brain/next?z=1&waitMs=25000",
			headers: {
				"x-timestamp": timestamp,
				"x-signature": signLike({ method: "GET", path: "/brain/next", query: "waitMs=25000&z=1", body: "", timestamp }),
			},
		});
		expect(await verdict(req)).toBe("next");
	});

	it("refuses a stale timestamp and a future one past five minutes", async () => {
		expect(await verdict(signedGet(String(NOW - 5 * 60 * 1000 - 1)))).toBe(401);
		expect(await verdict(signedGet(String(NOW + 5 * 60 * 1000 + 1)))).toBe(401);
		expect(await verdict(signedGet(String(NOW - 5 * 60 * 1000)))).toBe("next");
	});

	it("refuses a tampered body", async () => {
		expect(await verdict(signedPost(BODY.replace('"ok"', '"busy"')))).toBe(401);
	});

	it("refuses a signature made with another key", async () => {
		expect(await verdict(signedGet(String(NOW), "w".repeat(32)))).toBe(401);
	});

	it("refuses a request with either header missing, a non numeric timestamp or a non hex signature", async () => {
		const good = signedGet().headers as Record<string, string>;
		expect(await verdict(makeReq({ headers: {} }))).toBe(401);
		expect(await verdict(makeReq({ headers: { "x-timestamp": good["x-timestamp"] } }))).toBe(401);
		expect(await verdict(makeReq({ headers: { "x-signature": good["x-signature"] } }))).toBe(401);
		expect(await verdict(makeReq({ headers: { ...good, "x-timestamp": "soon" } }))).toBe(401);
		expect(await verdict(makeReq({ headers: { ...good, "x-signature": "z".repeat(64) } }))).toBe(401);
		expect(await verdict(makeReq({ headers: { ...good, "x-signature": good["x-signature"].toUpperCase() } }))).toBe(401);
	});

	it("answers 503 for everything when the key is missing or shorter than 32 characters", async () => {
		expect(await verdict(signedGet(String(NOW), ""), "")).toBe(503);
		const short = "s".repeat(31);
		expect(await verdict(signedGet(String(NOW), short), short)).toBe(503);
		const exact = "e".repeat(32);
		expect(await verdict(signedGet(String(NOW), exact), exact)).toBe("next");
	});

	it("pins the canonical string format the launcher signs", async () => {
		const { buildCanonicalString, hashBody } = await import("@utils/canonicalRequest.js");
		const emptyHash = createHash("sha256").update("", "utf8").digest("hex");
		expect(hashBody("")).toBe(emptyHash);
		expect(
			buildCanonicalString({ method: "get", path: "/brain/next", query: "waitMs=25000", timestamp: String(NOW), bodyHash: emptyHash }),
		).toBe(`GET\n/brain/next?waitMs=25000\n${NOW}\n${emptyHash}`);
		expect(buildCanonicalString({ method: "POST", path: "/brain/result", query: "", timestamp: "1", bodyHash: "h" })).toBe(
			"POST\n/brain/result\n1\nh",
		);
	});
});
