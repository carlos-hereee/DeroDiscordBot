import { describe, expect, it } from "vitest";
import { shortId } from "./shortId.js";

// ── shortId (2026-11 item 388) ──
// The id of every new meeting, todo, reminder and summary job row: 12 url safe characters.

describe("shortId", () => {
	it("is 12 characters of the base64url alphabet", () => {
		for (let index = 0; index < 50; index += 1) expect(shortId()).toMatch(/^[A-Za-z0-9_-]{12}$/);
	});

	it("does not repeat across a batch", () => {
		const ids = new Set(Array.from({ length: 500 }, () => shortId()));
		expect(ids.size).toBe(500);
	});
});
