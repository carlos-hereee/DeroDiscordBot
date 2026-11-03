import { describe, it, expect, vi, beforeEach } from "vitest";

// ── serverVault ─────────────────────────────────────────────────────────────
// The vault's starting balance and the grant's order: the member's day is reserved
// against the daily cap first (2026-10 item 267, risk R3), the vault pays second (in one
// guarded write that records the grant), the wallet is credited third, and every failure
// gives back the steps before it. Stores mocked.

const mocks = vi.hoisted(() => ({
	ensure: vi.fn(),
	debitGrant: vi.fn(),
	refund: vi.fn(),
	credit: vi.fn(),
	reserveVaultReceipt: vi.fn(),
	releaseVaultReceipt: vi.fn(),
	findOne: vi.fn(),
}));

vi.mock("@db/stores/serverVaultStore.js", () => ({ serverVaultStore: { ensure: mocks.ensure, debitGrant: mocks.debitGrant, refund: mocks.refund } }));
vi.mock("@db/stores/chipWalletStore.js", () => ({
	chipWalletStore: { credit: mocks.credit, reserveVaultReceipt: mocks.reserveVaultReceipt, releaseVaultReceipt: mocks.releaseVaultReceipt, findOne: mocks.findOne },
}));

import { grantFromVault, isGrantableAmount, readVault } from "./serverVault.js";

const NOW = new Date("2026-10-25T12:00:00Z");
const DAY = "2026-10-25";
const GRANT = { guildId: "g1", toUserId: "u2", amount: 1_000, byAdminId: "admin", now: NOW };

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.ensure.mockResolvedValue({ guildId: "g1", balance: 100_000, lastAwardMonth: null, grantHistory: [] });
	mocks.refund.mockResolvedValue(undefined);
	mocks.reserveVaultReceipt.mockResolvedValue({ balance: 0, vaultDayKey: DAY, vaultReceivedToday: 1_000 });
	mocks.releaseVaultReceipt.mockResolvedValue(undefined);
});

describe("readVault", () => {
	it("creates a new server's vault at 100,000 chips", async () => {
		await readVault("g1");
		expect(mocks.ensure).toHaveBeenCalledWith("g1", 100_000);
	});
});

describe("grantFromVault", () => {
	it("reserves the member's day, pays from the vault, records the grant, then credits the global wallet", async () => {
		mocks.debitGrant.mockResolvedValue({ balance: 99_000 });
		mocks.credit.mockResolvedValue({ balance: 1_000 });

		await expect(grantFromVault(GRANT)).resolves.toEqual({ ok: true, vaultBalance: 99_000, walletBalance: 1_000 });
		expect(mocks.reserveVaultReceipt).toHaveBeenCalledWith({ userId: "u2" }, 1_000, DAY, 5_000);
		expect(mocks.debitGrant).toHaveBeenCalledWith("g1", { userId: "u2", amount: 1_000, at: NOW, byAdminId: "admin" }, 50);
		expect(mocks.credit).toHaveBeenCalledWith({ userId: "u2" }, 1_000);
		expect(mocks.reserveVaultReceipt.mock.invocationCallOrder[0]).toBeLessThan(mocks.debitGrant.mock.invocationCallOrder[0]);
		expect(mocks.debitGrant.mock.invocationCallOrder[0]).toBeLessThan(mocks.credit.mock.invocationCallOrder[0]);
		expect(mocks.releaseVaultReceipt).not.toHaveBeenCalled();
	});

	it("refuses a grant past today's 5,000 cap, naming what is left, and nothing moves", async () => {
		// 4,500 received today from any server: a 1,000 grant would pass the cap.
		mocks.reserveVaultReceipt.mockResolvedValue(null);
		mocks.findOne.mockResolvedValue({ balance: 9_000, vaultDayKey: DAY, vaultReceivedToday: 4_500 });

		await expect(grantFromVault(GRANT)).resolves.toEqual({ ok: false, reason: "dailyCap", vaultBalance: 100_000, leftToday: 500 });
		expect(mocks.debitGrant).not.toHaveBeenCalled();
		expect(mocks.credit).not.toHaveBeenCalled();
		expect(mocks.releaseVaultReceipt).not.toHaveBeenCalled();
	});

	it("refuses one grant larger than the whole cap without reserving, even on a fresh day", async () => {
		mocks.findOne.mockResolvedValue(null);

		await expect(grantFromVault({ ...GRANT, amount: 5_001 })).resolves.toEqual({ ok: false, reason: "dailyCap", vaultBalance: 100_000, leftToday: 5_000 });
		expect(mocks.reserveVaultReceipt).not.toHaveBeenCalled();
		expect(mocks.debitGrant).not.toHaveBeenCalled();
	});

	it("counts yesterday's grants as nothing toward today's room", async () => {
		mocks.reserveVaultReceipt.mockResolvedValue(null);
		mocks.findOne.mockResolvedValue({ balance: 9_000, vaultDayKey: "2026-10-24", vaultReceivedToday: 5_000 });

		await expect(grantFromVault(GRANT)).resolves.toMatchObject({ reason: "dailyCap", leftToday: 5_000 });
	});

	it("refuses a grant the vault cannot cover, gives the day's reservation back and credits nobody", async () => {
		mocks.debitGrant.mockResolvedValue(null);
		mocks.ensure.mockResolvedValue({ guildId: "g1", balance: 400, lastAwardMonth: null, grantHistory: [] });

		await expect(grantFromVault(GRANT)).resolves.toEqual({ ok: false, reason: "vaultShort", vaultBalance: 400 });
		expect(mocks.credit).not.toHaveBeenCalled();
		expect(mocks.releaseVaultReceipt).toHaveBeenCalledWith({ userId: "u2" }, 1_000, DAY);
	});

	it("refunds the vault and gives the reservation back when the wallet credit fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.debitGrant.mockResolvedValue({ balance: 99_000 });
		mocks.credit.mockRejectedValue(new Error("db down"));

		await expect(grantFromVault(GRANT)).resolves.toEqual({ ok: false, reason: "failed", vaultBalance: 100_000 });
		expect(mocks.refund).toHaveBeenCalledWith("g1", 1_000);
		expect(mocks.releaseVaultReceipt).toHaveBeenCalledWith({ userId: "u2" }, 1_000, DAY);
	});

	it("refuses an amount that is not a whole number of chips within the typo guard, touching nothing", async () => {
		for (const amount of [0, -5, 2.5, 1_000_001]) {
			await expect(grantFromVault({ ...GRANT, amount })).resolves.toMatchObject({ ok: false, reason: "invalidAmount" });
		}
		expect(mocks.reserveVaultReceipt).not.toHaveBeenCalled();
		expect(mocks.debitGrant).not.toHaveBeenCalled();
		expect(isGrantableAmount(1_000_000)).toBe(true);
	});
});
