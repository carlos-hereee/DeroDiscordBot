import { describe, it, expect } from "vitest";
import { MatchResult } from "./MatchResult.js";

// ── MatchResult index declarations ─────────────────────────────────────────
// SCHEMA assertions, not store tests, in the pattern GameRoom.test.ts set. The
// unique roomId is the rating claim (a second recording of one match fails on it
// before any rating moves); the { guildId, game, finishedAt: -1 } index serves every
// per server read. Importing the model only registers a schema.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexes = MatchResult.schema.indexes() as unknown as DeclaredIndex[];

const matching = (key: Record<string, unknown>): DeclaredIndex[] =>
	indexes.filter(([fields]) => JSON.stringify(fields) === JSON.stringify(key));

describe("MatchResult indexes", () => {
	it("declares the unique roomId index exactly once", () => {
		// Declared by the field level `unique: true`; declaring it again with schema.index()
		// would make Mongoose log a duplicate index warning on every boot.
		const claim = matching({ roomId: 1 });
		expect(claim).toHaveLength(1);
		expect(claim[0][1].unique).toBe(true);
	});

	it("declares the { guildId, game, finishedAt: -1 } index exactly once", () => {
		const perServer = matching({ guildId: 1, game: 1, finishedAt: -1 });
		expect(perServer).toHaveLength(1);
		expect(perServer[0][1].unique).toBeUndefined();
	});

	it("declares no other index", () => {
		expect(indexes).toHaveLength(2);
	});
});
