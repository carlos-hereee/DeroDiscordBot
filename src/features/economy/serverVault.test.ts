import { describe, it, expect, vi, beforeEach } from "vitest";

// ── serverVault ─────────────────────────────────────────────────────────────
// The vault's starting balance and the grant's order: the vault pays first (in one
// guarded write that records the grant), the wallet is credited second, and a failed
// credit refunds the vault. Stores mocked.

const mocks = vi.hoisted(() => ({
	ensure: vi.fn(),
	debitGrant: vi.fn(),
	refund: vi.fn(),
	credit: vi.fn(),
}));

vi.mock("@db/stores/serverVaultStore.js", () => ({ serverVaultStore: { ensure: mocks.ensure, debitGrant: mocks.debitGrant, refund: mocks.refund } }));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { credit: mocks.credit } }));

import { grantFromVault, isGrantableAmount, readVault } from "./serverVault.js";

const NOW = new Date("2026-10-25T12:00:00Z");
const GRANT = { guildId: "g1", toUserId: "u2", amount: 1_000, byAdminId: "admin", now: NOW };

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.ensure.mockResolvedValue({ guildId: "g1", balance: 100_000, lastAwardMonth: null, grantHistory: [] });
	mocks.refund.mockResolvedValue(undefined);
});

describe("readVault", () => {
	it("creates a new server's vault at 100,000 chips", async () => {
		await readVault("g1");
		expect(mocks.ensure).toHaveBeenCalledWith("g1", 100_000);
	});
});

describe("grantFromVault", () => {
	it("pays from the vault, records the grant, then credits the wallet", async () => {
		mocks.debitGrant.mockResolvedValue({ balance: 99_000 });
		mocks.credit.mockResolvedValue({ balance: 1_000 });

		await expect(grantFromVault(GRANT)).resolves.toEqual({ ok: true, vaultBalance: 99_000, walletBalance: 1_000 });
		expect(mocks.debitGrant).toHaveBeenCalledWith("g1", { userId: "u2", amount: 1_000, at: NOW, byAdminId: "admin" }, 50);
		expect(mocks.credit).toHaveBeenCalledWith({ guildId: "g1", userId: "u2" }, 1_000);
		expect(mocks.debitGrant.mock.invocationCallOrder[0]).toBeLessThan(mocks.credit.mock.invocationCallOrder[0]);
	});

	it("refuses a grant the vault cannot cover and credits nobody", async () => {
		mocks.debitGrant.mockResolvedValue(null);
		mocks.ensure.mockResolvedValue({ guildId: "g1", balance: 400, lastAwardMonth: null, grantHistory: [] });

		await expect(grantFromVault(GRANT)).resolves.toEqual({ ok: false, reason: "vaultShort", vaultBalance: 400 });
		expect(mocks.credit).not.toHaveBeenCalled();
	});

	it("refunds the vault when the wallet credit fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.debitGrant.mockResolvedValue({ balance: 99_000 });
		mocks.credit.mockRejectedValue(new Error("db down"));

		await expect(grantFromVault(GRANT)).resolves.toEqual({ ok: false, reason: "failed", vaultBalance: 100_000 });
		expect(mocks.refund).toHaveBeenCalledWith("g1", 1_000);
	});

	it("refuses an amount that is not a whole number of chips within the typo guard, touching nothing", async () => {
		for (const amount of [0, -5, 2.5, 1_000_001]) {
			await expect(grantFromVault({ ...GRANT, amount })).resolves.toMatchObject({ ok: false, reason: "invalidAmount" });
		}
		expect(mocks.debitGrant).not.toHaveBeenCalled();
		expect(isGrantableAmount(1_000_000)).toBe(true);
	});
});
