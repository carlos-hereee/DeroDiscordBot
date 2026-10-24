import { describe, it, expect } from "vitest";
import { NetworkConsent } from "./NetworkConsent.js";

// ── NetworkConsent index declarations (2026-10 item 244 Phase 5b) ──
// SCHEMA assertions, not store tests, in the pattern GameRoom.test.ts set. The unique
// { userId } index keeps a member who accepts the notice twice in one tick on one row.
// Importing the model only registers a schema and opens no connection.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexesOf = (model: { schema: { indexes(): unknown } }): DeclaredIndex[] => model.schema.indexes() as unknown as DeclaredIndex[];

describe("NetworkConsent", () => {
	it("declares only the unique { userId } index", () => {
		const indexes = indexesOf(NetworkConsent);
		expect(indexes).toHaveLength(1);
		expect(indexes[0][0]).toEqual({ userId: 1 });
		expect(indexes[0][1].unique).toBe(true);
	});

	it("starts a new row with no tag notice sent", () => {
		const row = new NetworkConsent({ userId: "u1", version: 1, acceptedAt: new Date() });
		expect(row.lastTagNoticeAt).toBeNull();
	});
});
