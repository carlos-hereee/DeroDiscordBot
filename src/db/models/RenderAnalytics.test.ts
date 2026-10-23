import { describe, it, expect } from "vitest";
import { RenderAnalytics } from "./RenderAnalytics.js";

// ── RenderAnalytics index declarations ─────────────────────────────────────
// SCHEMA assertions, not store tests, in the pattern GameRoom.test.ts set: the
// three guarantees this collection rests on are declarative and fail silently
// when wrong. The unique { cacheKey, month } index is what keeps two racing
// first lookups on one row; the compound index serves the top N read; the TTL
// index is what stops the long tail growing forever. Importing the model only
// registers a schema and opens no connection.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexes = RenderAnalytics.schema.indexes() as unknown as DeclaredIndex[];

const matching = (key: Record<string, unknown>): DeclaredIndex[] =>
	indexes.filter(([fields]) => JSON.stringify(fields) === JSON.stringify(key));

// 13 months, the owner's retention decision for 2026-10 item 244.
const THIRTEEN_MONTHS_SECONDS = 395 * 24 * 60 * 60;

describe("RenderAnalytics indexes", () => {
	it("declares the unique { cacheKey, month } index exactly once", () => {
		const unique = matching({ cacheKey: 1, month: 1 });
		expect(unique).toHaveLength(1);
		expect(unique[0][1].unique).toBe(true);
	});

	it("declares the { month, surface, hits: -1 } top N index exactly once", () => {
		const topN = matching({ month: 1, surface: 1, hits: -1 });
		expect(topN).toHaveLength(1);
		expect(topN[0][1].unique).toBeUndefined();
	});

	it("declares the lastSeenAt TTL index exactly once, at 13 months", () => {
		const ttl = matching({ lastSeenAt: 1 });
		expect(ttl).toHaveLength(1);
		expect(ttl[0][1].expireAfterSeconds).toBe(THIRTEEN_MONTHS_SECONDS);
	});

	it("declares no other index", () => {
		expect(indexes).toHaveLength(3);
	});

	it("has no field that could hold a user, guild or avatar identity", () => {
		const paths = Object.keys(RenderAnalytics.schema.paths);
		for (const forbidden of ["userId", "guildId", "username", "avatarHash", "avatarKey"]) {
			expect(paths).not.toContain(forbidden);
		}
	});
});
