import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@db/models/GuildConfig.js", () => ({ default: { updateMany: vi.fn() } }));

import { migrateArcadeChannelFields } from "./migrateArcadeChannelFields.js";
import GuildConfigModel from "@db/models/GuildConfig.js";

const modelMock = GuildConfigModel as unknown as { updateMany: ReturnType<typeof vi.fn> };

// Every call the sweep makes, as [filter, update] pairs, so an assertion can name the field
// it cares about instead of an index into the call list.
const callsByOldField = () =>
	Object.fromEntries(
		modelMock.updateMany.mock.calls.map(([filter, update]) => [
			Object.keys(filter as Record<string, unknown>)[0],
			update as { $rename: Record<string, string> },
		])
	);

beforeEach(() => {
	vi.clearAllMocks();
	modelMock.updateMany.mockResolvedValue({ modifiedCount: 0 });
});

describe("migrateArcadeChannelFields", () => {
	// ⚠️ THE NESTED PAIR IS HALF THE BUG. A stranded introMessageIds entry makes
	// refreshIntroEmbeds repost the intro rather than edit it, which is a second visible
	// symptom on the same stale row, and it is the half a hand-written rename forgets.
	it("renames the top-level fields AND their introMessageIds copies", () => {
		return migrateArcadeChannelFields().then(() => {
			const calls = callsByOldField();
			expect(calls.gamesRulesChannelId.$rename).toEqual({ gamesRulesChannelId: "arcadeRulesChannelId" });
			expect(calls.gamesChallengesChannelId.$rename).toEqual({
				gamesChallengesChannelId: "arcadeChallengesChannelId",
			});
			expect(calls["introMessageIds.gamesRulesChannelId"].$rename).toEqual({
				"introMessageIds.gamesRulesChannelId": "introMessageIds.arcadeRulesChannelId",
			});
			expect(calls["introMessageIds.gamesChallengesChannelId"].$rename).toEqual({
				"introMessageIds.gamesChallengesChannelId": "introMessageIds.arcadeChallengesChannelId",
			});
		});
	});

	// ⚠️ $rename ERRORS ON A DOCUMENT THAT LACKS THE FIELD, so a blanket updateMany would
	// throw the moment it reached a row that had already migrated. The $exists filter is what
	// makes the sweep safe to run on every boot forever.
	it("filters every write on the OLD field existing, so a migrated row is untouched", async () => {
		await migrateArcadeChannelFields();

		for (const [filter] of modelMock.updateMany.mock.calls) {
			const [field, condition] = Object.entries(filter as Record<string, unknown>)[0];
			expect(condition).toEqual({ $exists: true });
			// The filter must name the OLD field. Filtering on the new one would match
			// exactly the rows that do not need the write.
			expect(field).toMatch(/^(introMessageIds\.)?games(Rules|Challenges)ChannelId$/);
		}
	});

	it("reports nothing renamed when every row is already current", async () => {
		const result = await migrateArcadeChannelFields();

		expect(result.total).toBe(0);
		expect(result.renamed).toEqual({});
	});

	it("counts only the fields that actually moved", async () => {
		modelMock.updateMany
			.mockResolvedValueOnce({ modifiedCount: 2 })
			.mockResolvedValueOnce({ modifiedCount: 2 })
			.mockResolvedValueOnce({ modifiedCount: 1 })
			.mockResolvedValueOnce({ modifiedCount: 0 });

		const result = await migrateArcadeChannelFields();

		expect(result.total).toBe(5);
		expect(result.renamed).toEqual({
			gamesRulesChannelId: 2,
			gamesChallengesChannelId: 2,
			"introMessageIds.gamesRulesChannelId": 1,
		});
	});

	// One field failing must not strand the other three. A half-migrated row is the state
	// this whole module exists to get out of, so the sweep keeps going and the next boot
	// retries whatever failed.
	it("keeps going when one field's write throws", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		modelMock.updateMany
			.mockRejectedValueOnce(new Error("write conflict"))
			.mockResolvedValue({ modifiedCount: 1 });

		const result = await migrateArcadeChannelFields();

		expect(modelMock.updateMany).toHaveBeenCalledTimes(4);
		expect(result.total).toBe(3);
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});
