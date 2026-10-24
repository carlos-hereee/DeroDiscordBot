import { describe, it, expect } from "vitest";
import { NetworkBan } from "./NetworkBan.js";

// ── NetworkBan index declarations (2026-10 item 244 Phase 5b) ──
// SCHEMA assertions, not store tests, in the pattern GameRoom.test.ts set. The unique
// { kind, targetId } index keeps the owner banning the same id twice on one row.
// Importing the model only registers a schema and opens no connection.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexesOf = (model: { schema: { indexes(): unknown } }): DeclaredIndex[] => model.schema.indexes() as unknown as DeclaredIndex[];

describe("NetworkBan", () => {
	it("declares only the unique { kind, targetId } index", () => {
		const indexes = indexesOf(NetworkBan);
		expect(indexes).toHaveLength(1);
		expect(indexes[0][0]).toEqual({ kind: 1, targetId: 1 });
		expect(indexes[0][1].unique).toBe(true);
	});

	it("accepts only a member or a server as the kind", () => {
		expect(new NetworkBan({ kind: "user", targetId: "u1", createdAt: new Date() }).validateSync()).toBeUndefined();
		expect(new NetworkBan({ kind: "channel", targetId: "c1", createdAt: new Date() }).validateSync()?.errors.kind).toBeDefined();
	});
});
