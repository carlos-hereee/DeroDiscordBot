// src/db/stores/memberLevelStore.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mongo-free, matching the house pattern in pendingPairingStore.test.ts: pin the UPDATE SHAPE,
// because the shape is where the defect lived. `$set: { username }` runs on EVERY award rather
// than on insert, so an unresolved caller that passed a fallback (a raw snowflake) overwrote a
// real display name on /account, /levels and LevelsBoard, and nothing errored.
vi.mock("@db/models/MemberLevel.js", () => ({
	MemberLevel: {
		findOneAndUpdate: vi.fn(),
	},
}));

import { memberLevelStore } from "./memberLevelStore.js";
import { MemberLevel } from "@db/models/MemberLevel.js";

const model = MemberLevel as unknown as { findOneAndUpdate: ReturnType<typeof vi.fn> };
const updateOf = () => model.findOneAndUpdate.mock.calls[0][1] as { $set: Record<string, unknown> };

describe("memberLevelStore.incrementAndReturn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		model.findOneAndUpdate.mockResolvedValue({ totalXp: 100 });
	});

	it("refreshes the username when the caller resolved one, so a nickname change needs no backfill", async () => {
		await memberLevelStore.incrementAndReturn("g1", "u1", "Dero", { totalXp: 5 });
		expect(updateOf().$set).toMatchObject({ username: "Dero" });
		expect(updateOf().$set.lastAwardAt).toBeInstanceOf(Date);
	});

	it("OMITS username entirely when the caller could not resolve one", async () => {
		await memberLevelStore.incrementAndReturn("g1", "u1", undefined, { totalXp: 5 });
		// Not "sets it to undefined": the key must be absent, or Mongo would still write it.
		expect(Object.keys(updateOf().$set)).toEqual(["lastAwardAt"]);
	});

	it("treats an empty string as unresolved rather than writing a blank name", async () => {
		await memberLevelStore.incrementAndReturn("g1", "u1", "", { totalXp: 5 });
		expect(Object.keys(updateOf().$set)).toEqual(["lastAwardAt"]);
	});

	it("still credits the xp when the name is unresolved, rather than skipping the award", async () => {
		await memberLevelStore.incrementAndReturn("g1", "u1", undefined, { totalXp: 5, won: 1 });
		const update = model.findOneAndUpdate.mock.calls[0][1] as { $inc: Record<string, number> };
		expect(update.$inc).toEqual({ totalXp: 5, won: 1 });
	});
});
