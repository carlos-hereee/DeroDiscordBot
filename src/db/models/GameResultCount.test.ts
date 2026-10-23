import { describe, it, expect } from "vitest";
import { GameResultCount } from "./GameResultCount.js";

// ── GameResultCount index declarations ─────────────────────────────────────
// SCHEMA assertions, not store tests, in the pattern GameRoom.test.ts set. The
// unique { guildId, game, month, label } index is what keeps two racing showdowns
// on one row per label. Importing the model only registers a schema.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexes = GameResultCount.schema.indexes() as unknown as DeclaredIndex[];

describe("GameResultCount indexes", () => {
	it("declares only the unique { guildId, game, month, label } index", () => {
		expect(indexes).toHaveLength(1);
		const [fields, options] = indexes[0];
		expect(fields).toEqual({ guildId: 1, game: 1, month: 1, label: 1 });
		expect(options.unique).toBe(true);
	});
});
