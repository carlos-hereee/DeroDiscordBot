import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createHmac } from "crypto";

// ── /api/platform/render-analytics route tests (2026-10 item 244, Phase 2a) ──
// Unlike pairing.routes.test.ts this mounts the REAL verifySignature in front of
// the router, the same order server.ts uses, because the signature is this
// route's whole gate: it takes no guildId, so nothing else stands between a
// caller and platform wide totals. Strict mode is on, so an unsigned request
// cannot fall back to the shared api key. The report builder is mocked; its
// math is pinned in renderAnalytics.test.ts.

// Hoisted because vi.mock below is lifted above every plain const, and its factory reads both.
const { SECRET, API_KEY } = vi.hoisted(() => ({
	SECRET: "test-secret-at-least-32-chars-long-padding",
	API_KEY: "test-api-key",
}));
const MOUNT = "/api/platform/render-analytics";

vi.mock("@utils/config.js", () => ({
	dashboardSigningSecret: SECRET,
	dashboardApiKey: API_KEY,
	requireSignedRequests: true,
}));

vi.mock("@features/renderer/renderAnalytics.js", () => ({
	RENDER_ANALYTICS_PERIODS: ["this-month", "last-month", "all-time"],
	buildRenderAnalyticsReport: vi.fn(),
}));

import { buildCanonicalString, hashBody } from "@utils/canonicalRequest.js";
import { verifySignature } from "@api/middleware/verifySignature.js";
import { buildRenderAnalyticsReport, type RenderAnalyticsReport } from "@features/renderer/renderAnalytics.js";
import { createPlatformAnalyticsRouter } from "./platformAnalytics.routes.js";

const buildMock = vi.mocked(buildRenderAnalyticsReport);

const REPORT: RenderAnalyticsReport = {
	period: "last-month",
	months: ["2026-09"],
	surface: null,
	surfaces: [{ surface: "account", rows: 4, bytes: 2048, hits: 30, memoryHits: 20, s3Hits: 10, draws: 10, hitRate: 0.75, hint: "none" }],
	memory: { cards: 3, cardCapacity: 100, avatars: 7, avatarCapacity: 500, growMemoryTier: false },
	top: [{ surface: "account", version: 1, keyHash: "abc123def456", hits: 12 }],
	droppedWrites: 0,
};

// Mirrors server.ts: raw body capture, then the signature gate, then the router.
function buildApp() {
	const app = express();
	app.use(
		express.json({
			verify: (req, _res, buf) => {
				(req as express.Request).rawBody = buf.toString("utf8");
			},
		})
	);
	app.use(verifySignature);
	app.use(MOUNT, createPlatformAnalyticsRouter());
	return app;
}

function signedHeaders(query: string): Record<string, string> {
	const timestamp = String(Date.now());
	const canonical = buildCanonicalString({ method: "GET", path: MOUNT, query, timestamp, bodyHash: hashBody("") });
	return {
		"x-api-key": API_KEY,
		"x-timestamp": timestamp,
		"x-signature": createHmac("sha256", SECRET).update(canonical, "utf8").digest("hex"),
	};
}

function signedGet(query: string) {
	const url = query ? `${MOUNT}?${query}` : MOUNT;
	return request(buildApp()).get(url).set(signedHeaders(query));
}

beforeEach(() => {
	buildMock.mockReset();
	buildMock.mockResolvedValue(REPORT);
});

describe("GET /api/platform/render-analytics", () => {
	it("refuses an unsigned request, even one carrying the shared api key", async () => {
		const res = await request(buildApp()).get(`${MOUNT}?period=this-month`).set("x-api-key", API_KEY);
		expect(res.status).toBe(401);
		expect(buildMock).not.toHaveBeenCalled();
	});

	it("refuses a request whose signature does not match", async () => {
		const headers = { ...signedHeaders("period=this-month"), "x-signature": "0".repeat(64) };
		const res = await request(buildApp()).get(`${MOUNT}?period=this-month`).set(headers);
		expect(res.status).toBe(401);
		expect(buildMock).not.toHaveBeenCalled();
	});

	it("answers 400 on a period that is not one of the three", async () => {
		const res = await signedGet("period=last-week");
		expect(res.status).toBe(400);
		expect(buildMock).not.toHaveBeenCalled();
	});

	it("answers 400 on a repeated period, which Express hands over as an array", async () => {
		const res = await signedGet("period=this-month&period=all-time");
		expect(res.status).toBe(400);
		expect(buildMock).not.toHaveBeenCalled();
	});

	it("answers the report for a valid period inside the data envelope", async () => {
		const res = await signedGet("period=last-month");
		expect(res.status).toBe(200);
		expect(buildMock).toHaveBeenCalledWith({ period: "last-month" });
		expect(res.body).toEqual({ data: REPORT });
	});

	it("reads this month when no period is given", async () => {
		const res = await signedGet("");
		expect(res.status).toBe(200);
		expect(buildMock).toHaveBeenCalledWith({ period: "this-month" });
	});

	it("answers a sparse 500 when the report read fails", async () => {
		buildMock.mockRejectedValue(new Error("atlas unreachable"));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const res = await signedGet("period=all-time");
		expect(res.status).toBe(500);
		expect(JSON.stringify(res.body)).not.toContain("atlas");
		consoleError.mockRestore();
	});
});
