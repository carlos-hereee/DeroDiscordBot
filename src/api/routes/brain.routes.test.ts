import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createHash, createHmac } from "crypto";

// ── /brain routes ──────────────────────────────────────────────────────────
// Through supertest with the real signature middleware and a real queue, so
// each test is one round trip exactly as the launcher makes it: poll then
// result, a replayed result, an oversize body, bad JSON, an invalid result, an
// unknown job. The app is assembled the way server.ts assembles it (express.json
// capturing rawBody, the router, then the body error handler).

// Hoisted because vi.mock below is moved above every top level declaration.
const { KEY } = vi.hoisted(() => ({ KEY: "brain-key-for-tests-0123456789abcdef" }));

vi.mock("@utils/config.js", () => ({ deroBrainKey: KEY }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn(async () => undefined) } }));

import { brainBodyErrorHandler, createBrainRouter } from "./brain.routes.js";
import { createBrainQueue, type BrainQueueClock } from "@features/dero-brain/brainQueue.js";
import type { BrainJobInput } from "@features/dero-brain/brainTypes.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";

const logMock = botLogStore as unknown as { log: ReturnType<typeof vi.fn> };

// Real time, but timers never hold the test process open.
const unrefClock: BrainQueueClock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const INPUT: BrainJobInput = {
	source: "text",
	guild: { id: "100000000000000001", name: "Guild" },
	speaker: { id: "300000000000000002", displayName: "Member" },
	text: "send hello world with an emoji in general",
	channels: [{ id: "200000000000000001", name: "general" }],
	capabilities: ["post_message", "say", "open_holdem", "leave_voice"],
};

function sign(method: string, path: string, query: string, body: string) {
	const timestamp = String(Date.now());
	const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
	const pathWithQuery = query ? `${path}?${query}` : path;
	const signature = createHmac("sha256", KEY).update(`${method}\n${pathWithQuery}\n${timestamp}\n${bodyHash}`, "utf8").digest("hex");
	return { "x-timestamp": timestamp, "x-signature": signature };
}

function buildApp() {
	const queue = createBrainQueue({ clock: unrefClock });
	const app = express();
	app.use(
		express.json({
			verify: (req, _res, buf) => {
				(req as express.Request).rawBody = buf.toString("utf8");
			},
		}),
	);
	app.use("/brain", createBrainRouter({ queue }));
	app.use("/brain", brainBodyErrorHandler);
	return { app, queue };
}

const poll = (app: express.Express) => request(app).get("/brain/next?waitMs=0").set(sign("GET", "/brain/next", "waitMs=0", ""));

function postResult(app: express.Express, body: string) {
	return request(app).post("/brain/result").set("Content-Type", "application/json").set(sign("POST", "/brain/result", "", body)).send(body);
}

const okResult = (jobId: string) =>
	JSON.stringify({ jobId, status: "ok", actions: [{ type: "post_message", channelId: "200000000000000001", text: "hello world 👋" }] });

beforeEach(() => {
	logMock.log.mockClear();
});

describe("GET /brain/next", () => {
	it("answers 204 when no job arrives in the wait", async () => {
		const { app } = buildApp();
		const response = await poll(app);
		expect(response.status).toBe(204);
	});

	it("refuses an unsigned poll with a bare 401", async () => {
		const { app } = buildApp();
		const response = await request(app).get("/brain/next?waitMs=0");
		expect(response.status).toBe(401);
		expect(response.body).toEqual({ error: "Unauthorized" });
	});
});

describe("poll then result", () => {
	it("hands out the job, accepts its result once, and 404s the replay", async () => {
		const { app, queue } = buildApp();
		const { jobId, outcome } = queue.enqueue(INPUT);

		const polled = await poll(app);
		expect(polled.status).toBe(200);
		expect(polled.body).toEqual({ jobId, ...INPUT });

		const body = okResult(jobId);
		const headers = sign("POST", "/brain/result", "", body);
		const accepted = await request(app).post("/brain/result").set("Content-Type", "application/json").set(headers).send(body);
		expect(accepted.status).toBe(200);
		expect(await outcome).toEqual({ kind: "result", result: JSON.parse(body) });

		// The exact same signed request again, inside the replay window: single use wins.
		const replayed = await request(app).post("/brain/result").set("Content-Type", "application/json").set(headers).send(body);
		expect(replayed.status).toBe(404);
	});

	it("404s a result for a job the brain never received", async () => {
		const { app, queue } = buildApp();
		const { jobId } = queue.enqueue(INPUT);
		expect((await postResult(app, okResult(jobId))).status).toBe(404);
		expect((await postResult(app, okResult("0f8fad5b-d9cb-469f-a165-70867728950e"))).status).toBe(404);
	});
});

describe("POST /brain/result refusals", () => {
	it("refuses a body over 16 KB before parsing it", async () => {
		const { app, queue } = buildApp();
		const { jobId } = queue.enqueue(INPUT);
		await poll(app);
		const body = JSON.stringify({ jobId, status: "ok", actions: [], padding: "x".repeat(17 * 1024) });
		const response = await postResult(app, body);
		expect(response.status).toBe(413);
		// Not parsed, so the job is still waiting for a real answer.
		expect(queue.findDelivered(jobId)).not.toBeNull();
	});

	it("answers bad JSON with a bare 400 when signed, and a bare 401 when not", async () => {
		const { app } = buildApp();
		const signed = await postResult(app, "{not json");
		expect(signed.status).toBe(400);
		expect(signed.body).toEqual({ error: "Invalid result" });

		const unsigned = await request(app).post("/brain/result").set("Content-Type", "application/json").send("{not json");
		expect(unsigned.status).toBe(401);
	});

	it("rejects an invalid result whole, settles the job as rejected, and audits codes only", async () => {
		const { app, queue } = buildApp();
		const { jobId, outcome } = queue.enqueue(INPUT);
		await poll(app);
		const body = JSON.stringify({ jobId, status: "ok", actions: [{ type: "ban_member", text: "a secret plan" }] });

		const response = await postResult(app, body);
		expect(response.status).toBe(400);
		expect(response.body).toEqual({ error: "Invalid result" });
		expect(await outcome).toEqual({ kind: "rejected", reason: "unknown_action" });
		expect(logMock.log).toHaveBeenCalledWith(INPUT.guild.id, BOT_LOG_EVENTS.DERO_BRAIN_REJECTED, {
			jobId,
			reason: "unknown_action",
			bytes: Buffer.byteLength(body),
		});
		expect(JSON.stringify(logMock.log.mock.calls)).not.toContain("a secret plan");
	});

	it("answers 404 for an unknown path under /brain", async () => {
		const { app } = buildApp();
		const response = await request(app).get("/brain/guilds").set(sign("GET", "/brain/guilds", "", ""));
		expect(response.status).toBe(404);
	});
});
