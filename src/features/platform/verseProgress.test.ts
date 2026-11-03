import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	countDistinctMembers: vi.fn(),
	countMembersActiveSince: vi.fn(),
	countSetUp: vi.fn(),
	countSetUpOnNetwork: vi.fn(),
	countCompletedByGame: vi.fn(),
	sumAllAwards: vi.fn(),
	coinAwardCollectionName: vi.fn(),
}));
vi.mock("@db/stores/memberLevelStore.js", () => ({ memberLevelStore: { countDistinctMembers: mocks.countDistinctMembers } }));
vi.mock("@db/stores/xpPeriodStore.js", () => ({ xpPeriodStore: { countMembersActiveSince: mocks.countMembersActiveSince } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { countSetUp: mocks.countSetUp, countSetUpOnNetwork: mocks.countSetUpOnNetwork } }));
vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { countCompletedByGame: mocks.countCompletedByGame } }));
vi.mock("@db/stores/deroCoinStore.js", () => ({ deroCoinStore: { sumAllAwards: mocks.sumAllAwards, coinAwardCollectionName: mocks.coinAwardCollectionName } }));

import { ACTIVE_WINDOW_DAYS, buildVerseProgress } from "./verseProgress.js";
import { verseCopy } from "./verseCopy.js";

// ── verseProgress (2026-10 item 257 Phase 3b) ────────────────────────────────
// The counting only: the stores hold the aggregations (and are not tested, rule 6), so
// what is pinned here is which reads feed which figure and the windows they are given.

const NOW = new Date("2026-10-27T15:00:00Z");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.countDistinctMembers.mockResolvedValue(1234);
	mocks.countMembersActiveSince.mockResolvedValue(210);
	mocks.countSetUp.mockResolvedValue(9);
	mocks.countSetUpOnNetwork.mockResolvedValue(4);
	mocks.countCompletedByGame.mockResolvedValue([
		{ game: "hangman", count: 40 },
		{ game: "holdem", count: 75 },
		{ game: "rps", count: 40 },
	]);
	mocks.sumAllAwards.mockImplementation(async (since?: Date) => (since ? 300 : 9000));
	mocks.coinAwardCollectionName.mockReturnValue("coinawards");
});

describe("buildVerseProgress", () => {
	it("returns the four counts from the reads that feed them", async () => {
		const progress = await buildVerseProgress(NOW);

		expect(progress).toEqual({
			players: 1234,
			monthlyActivePlayers: 210,
			servers: { setUp: 9, onNetwork: 4 },
			gamesCompleted: {
				total: 155,
				byGame: [
					{ game: "holdem", count: 75 },
					{ game: "hangman", count: 40 },
					{ game: "rps", count: 40 },
				],
			},
			coins: { total: 9000, thisMonth: 300 },
		});
	});

	it("counts activity over the last 30 days, and hands the coin collection to the union", async () => {
		await buildVerseProgress(NOW);

		const [since, collection] = mocks.countMembersActiveSince.mock.calls[0] as [Date, string];
		expect(ACTIVE_WINDOW_DAYS).toBe(30);
		expect(since.toISOString()).toBe("2026-09-27T15:00:00.000Z");
		expect(collection).toBe("coinawards");
	});

	it("sums this month's coins from the first of the UTC month, and all coins from the start", async () => {
		await buildVerseProgress(NOW);

		const calls = mocks.sumAllAwards.mock.calls as [Date | undefined][];
		const windows = calls.map(([since]) => since?.toISOString() ?? "all time").sort();
		expect(windows).toEqual(["2026-10-01T00:00:00.000Z", "all time"]);
	});

	it("rejects when any read fails, so the owner never reads a partial count as the whole", async () => {
		mocks.countSetUp.mockRejectedValue(new Error("Atlas down"));
		await expect(buildVerseProgress(NOW)).rejects.toThrow("Atlas down");
	});
});

describe("verseCopy.describe", () => {
	it("words the four counts and names each game by its label", async () => {
		const text = verseCopy.describe(await buildVerseProgress(NOW));

		expect(text).toContain("**Players:** 1,234 (210 active in the last 30 days)");
		expect(text).toContain("**Servers:** 9 set up, 4 on the network");
		expect(text).toContain("**Games completed:** 155");
		expect(text).toContain("• Texas hold em: 75");
		expect(text).toContain("**Dero coins collected:** 9,000 in total, 300 this month (UTC)");
		expect(text).toContain("never posted");
	});
});
