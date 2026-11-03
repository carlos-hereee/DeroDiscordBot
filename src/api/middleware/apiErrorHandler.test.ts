import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { apiErrorHandler, statusForApiError } from "./apiErrorHandler.js";

// The handler sits where startApiServer mounts it: after a JSON body parser and the routes.
function appWith(route?: express.RequestHandler) {
	const app = express();
	app.use(express.json());
	if (route) app.post("/api/thing", route);
	app.use(apiErrorHandler);
	return app;
}

describe("apiErrorHandler", () => {
	it("answers a malformed body with a bare 400 and no stack trace, before any auth runs", async () => {
		const response = await request(appWith()).post("/api/anything").set("Content-Type", "application/json").send("{bad");
		expect(response.status).toBe(400);
		expect(response.body).toEqual({ error: "Bad request" });
		expect(response.text).not.toMatch(/at |SyntaxError|node_modules/);
	});

	it("answers a route that throws with a bare 500 and logs it", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const response = await request(
			appWith(() => {
				throw new Error("a secret detail");
			})
		)
			.post("/api/thing")
			.send({ ok: true });
		expect(response.status).toBe(500);
		expect(response.body).toEqual({ error: "Internal error" });
		expect(response.text).not.toContain("a secret detail");
		expect(log).toHaveBeenCalled();
		log.mockRestore();
	});
});

describe("statusForApiError", () => {
	it("keeps a client error status and turns anything else into 500", () => {
		expect(statusForApiError({ status: 413 })).toBe(413);
		expect(statusForApiError({ statusCode: 400 })).toBe(400);
		expect(statusForApiError({ status: 302 })).toBe(500);
		expect(statusForApiError(new Error("boom"))).toBe(500);
		expect(statusForApiError(null)).toBe(500);
	});
});
