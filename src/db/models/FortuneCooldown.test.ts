import { describe, it, expect } from "vitest";
import { FortuneCooldown } from "./FortuneCooldown.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── FortuneCooldown index declarations (2026-10 item 254) ──
// SCHEMA assertions, not store tests, in the pattern TagNotice.test.ts set. The unique
// { guildId, userId } index is what turns a second claim inside the window into a no,
// and the TTL must outlive the cooldown or a row could vanish while it still holds.
// Importing the model only registers a schema and opens no connection.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexesOf = (model: { schema: { indexes(): unknown } }): DeclaredIndex[] => model.schema.indexes() as unknown as DeclaredIndex[];

describe("FortuneCooldown", () => {
	it("is unique per server and member, so two presses at once land on one row", () => {
		const unique = indexesOf(FortuneCooldown).find(([fields]) => "userId" in fields);
		expect(unique?.[0]).toEqual({ guildId: 1, userId: 1 });
		expect(unique?.[1].unique).toBe(true);
	});

	it("expires a row a little after the cooldown, never before it", () => {
		const ttl = indexesOf(FortuneCooldown).find(([fields]) => "lastReadingAt" in fields);
		const seconds = ttl?.[1].expireAfterSeconds as number;
		expect(seconds).toBeGreaterThan(BOT_CONSTANTS.FORTUNE_COOLDOWN_HOURS * 3600);
		expect(seconds).toBeLessThanOrEqual((BOT_CONSTANTS.FORTUNE_COOLDOWN_HOURS + 2) * 3600);
	});

	it("holds a server id, a user id and a date and nothing else", () => {
		expect(Object.keys(FortuneCooldown.schema.paths).sort()).toEqual(["__v", "_id", "guildId", "lastReadingAt", "userId"]);
	});
});
