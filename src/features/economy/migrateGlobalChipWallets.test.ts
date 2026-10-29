import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

// ── migrateGlobalChipWallets ────────────────────────────────────────────────
// The boot migration that sums every per server chip wallet into its member's one global
// wallet (2026-10 item 267 Session 1a, risk R1). The store is replaced by a stateful fake
// that applies the same conditions its writes filter on (a claim matches only an
// unclaimed row, the find returns only unclaimed rows), so booting twice proves the
// second boot writes nothing. Rows are built with the real ChipWallet model's hydrate,
// because the store hands the migration hydrated documents (item 263's f9a6a74 trap),
// as well as plain objects.

const mocks = vi.hoisted(() => ({
	findUnmigratedServerRows: vi.fn(),
	claimServerRowForMigration: vi.fn(),
	mergeIntoGlobal: vi.fn(),
}));

vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: mocks }));

import { ChipWallet } from "@db/models/ChipWallet.js";
import { migrateGlobalChipWallets } from "./migrateGlobalChipWallets.js";

const NOW = new Date("2026-10-28T12:00:00Z");
const EARLY_CLAIM = new Date("2026-10-20T08:00:00Z");
const LATE_CLAIM = new Date("2026-10-27T21:00:00Z");

interface GlobalWallet {
	balance: number;
	totalClaimed: number;
	lastClaimAt: Date | null;
}

let claimedRowIds: Set<string>;
let globals: Map<string, GlobalWallet>;
let rows: Array<{ _id: unknown; guildId: string; userId: string; balance: number; lastClaimAt: Date | null; totalClaimed: number }>;

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	claimedRowIds = new Set();
	globals = new Map();
	rows = [];
	mocks.findUnmigratedServerRows.mockReset().mockImplementation(async () => rows.filter((row) => !claimedRowIds.has(String(row._id))));
	mocks.claimServerRowForMigration.mockReset().mockImplementation(async (rowId: unknown) => {
		if (claimedRowIds.has(String(rowId))) return false;
		claimedRowIds.add(String(rowId));
		return true;
	});
	mocks.mergeIntoGlobal.mockReset().mockImplementation(async (key: { userId: string }, credit: { amount: number; totalClaimed: number; lastClaimAt: Date }) => {
		const current = globals.get(key.userId) ?? { balance: 0, totalClaimed: 0, lastClaimAt: null };
		const later = current.lastClaimAt && current.lastClaimAt.getTime() > credit.lastClaimAt.getTime() ? current.lastClaimAt : credit.lastClaimAt;
		globals.set(key.userId, { balance: current.balance + credit.amount, totalClaimed: current.totalClaimed + credit.totalClaimed, lastClaimAt: later });
	});
});

describe("migrateGlobalChipWallets", () => {
	it("sums one member's two server balances into one global row, keeping the later claim, on hydrated documents", async () => {
		rows = [
			ChipWallet.hydrate({ _id: new Types.ObjectId(), guildId: "gA", userId: "u1", balance: 25_000, lastClaimAt: EARLY_CLAIM, totalClaimed: 25_000 }),
			ChipWallet.hydrate({ _id: new Types.ObjectId(), guildId: "gB", userId: "u1", balance: 3_500, lastClaimAt: LATE_CLAIM, totalClaimed: 27_000 }),
		];

		await expect(migrateGlobalChipWallets(NOW)).resolves.toEqual({ rowsMerged: 2, chipsMerged: 28_500, creditsFailed: 0 });
		expect(globals.get("u1")).toEqual({ balance: 28_500, totalClaimed: 52_000, lastClaimAt: LATE_CLAIM });
		expect(mocks.claimServerRowForMigration).toHaveBeenCalledWith(rows[0]._id, 25_000, NOW);
	});

	it("writes nothing on a second boot", async () => {
		rows = [
			ChipWallet.hydrate({ _id: new Types.ObjectId(), guildId: "gA", userId: "u1", balance: 25_000, lastClaimAt: EARLY_CLAIM, totalClaimed: 25_000 }),
			{ _id: new Types.ObjectId(), guildId: "gB", userId: "u1", balance: 1_000, lastClaimAt: LATE_CLAIM, totalClaimed: 1_000 },
			{ _id: new Types.ObjectId(), guildId: "gA", userId: "u2", balance: 400, lastClaimAt: LATE_CLAIM, totalClaimed: 26_000 },
		];

		await migrateGlobalChipWallets(NOW);
		mocks.claimServerRowForMigration.mockClear();
		mocks.mergeIntoGlobal.mockClear();
		await expect(migrateGlobalChipWallets(NOW)).resolves.toEqual({ rowsMerged: 0, chipsMerged: 0, creditsFailed: 0 });

		expect(mocks.claimServerRowForMigration).not.toHaveBeenCalled();
		expect(mocks.mergeIntoGlobal).not.toHaveBeenCalled();
		expect(globals.get("u1")?.balance).toBe(26_000);
		expect(globals.get("u2")?.balance).toBe(400);
	});

	it("credits nothing for a row another boot claimed first", async () => {
		const row = ChipWallet.hydrate({ _id: new Types.ObjectId(), guildId: "gA", userId: "u1", balance: 9_000, lastClaimAt: EARLY_CLAIM, totalClaimed: 25_000 });
		rows = [row];
		// The other boot's claim lands between this boot's read and its claim.
		claimedRowIds.add(String(row._id));
		mocks.findUnmigratedServerRows.mockResolvedValueOnce([row]);

		await expect(migrateGlobalChipWallets(NOW)).resolves.toEqual({ rowsMerged: 0, chipsMerged: 0, creditsFailed: 0 });
		expect(mocks.mergeIntoGlobal).not.toHaveBeenCalled();
	});

	it("claims each row before crediting it", async () => {
		rows = [ChipWallet.hydrate({ _id: new Types.ObjectId(), guildId: "gA", userId: "u1", balance: 9_000, lastClaimAt: EARLY_CLAIM, totalClaimed: 25_000 })];

		await migrateGlobalChipWallets(NOW);

		expect(mocks.claimServerRowForMigration.mock.invocationCallOrder[0]).toBeLessThan(mocks.mergeIntoGlobal.mock.invocationCallOrder[0]);
	});

	// The owner's decision: a member the migration gives a global row has had their first claim.
	it("marks a member who never claimed in any server as having claimed, so the first claim is spent", async () => {
		rows = [ChipWallet.hydrate({ _id: new Types.ObjectId(), guildId: "gA", userId: "u1", balance: 2_000, lastClaimAt: null, totalClaimed: 0 })];

		await migrateGlobalChipWallets(NOW);

		expect(globals.get("u1")?.lastClaimAt).toEqual(new Date(0));
	});

	it("counts a credit that failed after its claim, and keeps going with the next row", async () => {
		rows = [
			{ _id: new Types.ObjectId(), guildId: "gA", userId: "u1", balance: 5_000, lastClaimAt: EARLY_CLAIM, totalClaimed: 25_000 },
			{ _id: new Types.ObjectId(), guildId: "gB", userId: "u2", balance: 700, lastClaimAt: EARLY_CLAIM, totalClaimed: 25_000 },
		];
		mocks.mergeIntoGlobal.mockRejectedValueOnce(new Error("db down"));

		await expect(migrateGlobalChipWallets(NOW)).resolves.toEqual({ rowsMerged: 1, chipsMerged: 700, creditsFailed: 1 });
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("restore it from the row's migratedAmount"), expect.any(Error));
	});
});
