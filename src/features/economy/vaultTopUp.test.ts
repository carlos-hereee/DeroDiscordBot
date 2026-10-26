import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

// ── vaultTopUp ──────────────────────────────────────────────────────────────
// The monthly network award: the tiers by rank, the two gates (chips on, one rated
// match in the month being paid) with the servers below moving up, the once a month
// claim, and the 🗒️admin-log line. The board, the stores and the emitter are mocked.

const mocks = vi.hoisted(() => ({
	serverBoard: vi.fn(),
	findConfig: vi.fn(),
	hasRated: vi.fn(),
	ensure: vi.fn(),
	awardMonth: vi.fn(),
	emit: vi.fn(),
}));

vi.mock("@features/ratings/serverRatings.js", () => ({ serverBoard: mocks.serverBoard }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
vi.mock("@db/stores/matchResultStore.js", () => ({ matchResultStore: { hasRatedMatchInGuild: mocks.hasRated } }));
vi.mock("@db/stores/serverVaultStore.js", () => ({ serverVaultStore: { ensure: mocks.ensure, awardMonth: mocks.awardMonth } }));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: {} }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emit: mocks.emit } }));

import { runVaultTopUp, topUpAwards } from "./vaultTopUp.js";

const client = {} as Client;
const NOV_FIRST = new Date("2026-11-01T00:05:00Z");
const row = (guildId: string) => ({ guildId, name: guildId, tag: null, rating: 1500, members: 3 });

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	mocks.findConfig.mockResolvedValue({ chipEconomyEnabled: true });
	mocks.hasRated.mockResolvedValue(true);
	mocks.ensure.mockResolvedValue({ balance: 100_000 });
	mocks.awardMonth.mockImplementation(async (_guildId: string, _month: string, amount: number) => ({ balance: 100_000 + amount }));
});

describe("topUpAwards", () => {
	it("pays rank 1 100,000, ranks 2 to 5 50,000 and ranks 6 to 10 25,000, and nobody past 10", () => {
		const awards = topUpAwards(Array.from({ length: 12 }, (_, index) => ({ guildId: `g${index + 1}` })));
		expect(awards).toHaveLength(10);
		expect(awards.map((award) => award.amount)).toEqual([100_000, 50_000, 50_000, 50_000, 50_000, 25_000, 25_000, 25_000, 25_000, 25_000]);
		expect(awards[9]).toEqual({ guildId: "g10", rank: 10, amount: 25_000 });
	});
});

describe("runVaultTopUp", () => {
	it("pays October on November 1st, gated on a rated October match, and logs the award", async () => {
		mocks.serverBoard.mockResolvedValue([row("g1")]);

		const outcomes = await runVaultTopUp(client, NOV_FIRST);

		expect(outcomes).toEqual([{ guildId: "g1", rank: 1, amount: 100_000, status: "paid" }]);
		expect(mocks.hasRated).toHaveBeenCalledWith("g1", expect.objectContaining({ key: "2026-10" }));
		expect(mocks.awardMonth).toHaveBeenCalledWith("g1", "2026-10", 100_000);
		expect(mocks.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				guild: { id: "g1", client },
				kind: "vault.topup",
				actor: { source: "dero" },
				payload: expect.objectContaining({ tier: 1, amount: 100_000, newVaultBalance: 200_000, networkRatingPeriod: "2026-10" }),
			})
		);
	});

	it("drops a dormant server and one with chips off, moving the next server up to rank 1", async () => {
		mocks.serverBoard.mockResolvedValue([row("dormant"), row("chipsOff"), row("active")]);
		mocks.hasRated.mockImplementation(async (guildId: string) => guildId !== "dormant");
		mocks.findConfig.mockImplementation(async (guildId: string) => ({ chipEconomyEnabled: guildId !== "chipsOff" }));

		const outcomes = await runVaultTopUp(client, NOV_FIRST);

		expect(outcomes).toEqual([{ guildId: "active", rank: 1, amount: 100_000, status: "paid" }]);
	});

	it("pays a month once: an already paid vault logs nothing", async () => {
		mocks.serverBoard.mockResolvedValue([row("g1")]);
		mocks.awardMonth.mockResolvedValue(null);

		await expect(runVaultTopUp(client, NOV_FIRST)).resolves.toEqual([{ guildId: "g1", rank: 1, amount: 100_000, status: "already-paid" }]);
		expect(mocks.emit).not.toHaveBeenCalled();
	});

	it("never throws: a failed board read pays nobody", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.serverBoard.mockRejectedValue(new Error("discord down"));
		await expect(runVaultTopUp(client, NOV_FIRST)).resolves.toEqual([]);
		expect(mocks.awardMonth).not.toHaveBeenCalled();
	});
});
