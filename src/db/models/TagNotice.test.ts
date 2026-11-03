import { describe, it, expect } from "vitest";
import { TagNotice } from "./TagNotice.js";

// ── TagNotice index declarations (2026-10 item 244 Phase 5b) ──
// SCHEMA assertions, not store tests, in the pattern GameRoom.test.ts set. The unique
// { userId } index is what turns a second tag notice claim inside the window into a no.
// Importing the model only registers a schema and opens no connection.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexesOf = (model: { schema: { indexes(): unknown } }): DeclaredIndex[] => model.schema.indexes() as unknown as DeclaredIndex[];

describe("TagNotice", () => {
	it("declares only the unique { userId } index, which turns a second claim in the window into a no", () => {
		const indexes = indexesOf(TagNotice);
		expect(indexes).toHaveLength(1);
		expect(indexes[0][0]).toEqual({ userId: 1 });
		expect(indexes[0][1].unique).toBe(true);
	});

	it("holds a user id and a date and nothing else", () => {
		expect(Object.keys(TagNotice.schema.paths).sort()).toEqual(["__v", "_id", "lastNoticeAt", "userId"]);
	});
});
