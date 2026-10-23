import { describe, it, expect } from "vitest";
import { LuckStat } from "./LuckStat.js";

// ── LuckStat index declarations ────────────────────────────────────────────
// SCHEMA assertions, not store tests, in the pattern GameRoom.test.ts set. The
// unique { guildId, userId, game, month } index is what keeps two racing first
// results of a month on one row. Importing the model only registers a schema.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexes = LuckStat.schema.indexes() as unknown as DeclaredIndex[];

describe("LuckStat indexes", () => {
	it("declares only the unique { guildId, userId, game, month } index", () => {
		expect(indexes).toHaveLength(1);
		const [fields, options] = indexes[0];
		expect(fields).toEqual({ guildId: 1, userId: 1, game: 1, month: 1 });
		expect(options.unique).toBe(true);
	});
});
