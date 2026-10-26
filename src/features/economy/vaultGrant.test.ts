import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepliableInteraction, User } from "discord.js";

// ── /arcade chips grant ──────────────────────────────────────────────────────────
// A landed grant writes exactly one chip.grant line carrying the plan's payload; a
// refused grant writes none; a bot account is refused before the vault is touched.

const mocks = vi.hoisted(() => ({ grantFromVault: vi.fn(), emitFor: vi.fn() }));

vi.mock("./serverVault.js", () => ({ grantFromVault: mocks.grantFromVault }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emitFor: mocks.emitFor } }));

import { runVaultGrant } from "./vaultGrant.js";

type Reply = { embeds: Array<{ data: { description?: string } }> };

const member = { id: "u2", bot: false } as User;

function interaction() {
	const reply = vi.fn(async () => undefined);
	return { fake: { guildId: "g1", user: { id: "admin" }, client: {}, reply } as unknown as RepliableInteraction, reply };
}

const textOf = (reply: ReturnType<typeof vi.fn>): string => (reply.mock.calls[0][0] as Reply).embeds[0].data.description ?? "";

beforeEach(() => {
	mocks.grantFromVault.mockReset();
	mocks.emitFor.mockReset();
});

describe("runVaultGrant", () => {
	it("grants, answers with both balances and logs one chip.grant line", async () => {
		mocks.grantFromVault.mockResolvedValue({ ok: true, vaultBalance: 99_000, walletBalance: 1_000 });
		const { fake, reply } = interaction();

		await runVaultGrant(fake, "g1", member, 1_000);

		expect(mocks.grantFromVault).toHaveBeenCalledWith({ guildId: "g1", toUserId: "u2", amount: 1_000, byAdminId: "admin" });
		expect(textOf(reply)).toContain("Vault left: 99,000 chips");
		expect(mocks.emitFor).toHaveBeenCalledTimes(1);
		expect(mocks.emitFor).toHaveBeenCalledWith(
			fake,
			"g1",
			"chip.grant",
			expect.objectContaining({ toUserId: "u2", amount: 1_000, byAdminId: "admin", newVaultBalance: 99_000, newWalletBalance: 1_000 })
		);
	});

	it("says how much the vault holds when it is short, and logs nothing", async () => {
		mocks.grantFromVault.mockResolvedValue({ ok: false, reason: "vaultShort", vaultBalance: 400 });
		const { fake, reply } = interaction();

		await runVaultGrant(fake, "g1", member, 1_000);

		expect(textOf(reply)).toContain("**400 chips**");
		expect(mocks.emitFor).not.toHaveBeenCalled();
	});

	it("refuses a Discord bot account before touching the vault", async () => {
		const { fake, reply } = interaction();

		await runVaultGrant(fake, "g1", { id: "b1", bot: true } as User, 1_000);

		expect(textOf(reply)).toContain("Bots do not hold chips");
		expect(mocks.grantFromVault).not.toHaveBeenCalled();
	});
});
