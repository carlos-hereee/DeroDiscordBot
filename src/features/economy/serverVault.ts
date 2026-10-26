import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IServerVault } from "@db/models/ServerVault.js";
import { chipWalletStore } from "@db/stores/chipWalletStore.js";
import { serverVaultStore } from "@db/stores/serverVaultStore.js";

// ── serverVault ──────────────────────────────────────────────────────
// What:  a server's chip reserve (2026-10 item 250 Phase 5): reading it (created at the
//        starting balance on first read), and granting from it to a member's wallet.
// Who:   /arcade chips status and grant (vaultGrant.ts); the monthly award credits it
//        through vaultTopUp.ts.
// Does NOT: check who is granting (the ADMIN_COMMANDS gate in main.ts already did), or
//        write the admin log line (the command does, after the grant landed).
//
// How a grant moves chips: ① the vault pays, in one write that matches only while its
// balance covers the grant and records the grant in its history; ② the wallet is
// credited; ③ if the credit throws, the vault is refunded. There is no window where the
// member holds chips the vault still holds too, which is the direction that would mint
// chips; the refund covers the other direction.

const ECONOMY = BOT_CONSTANTS.ECONOMY;

export type GrantRefusal = "invalidAmount" | "vaultShort" | "failed";

export type GrantResult = { ok: true; vaultBalance: number; walletBalance: number } | { ok: false; reason: GrantRefusal; vaultBalance: number };

export interface GrantInput {
	guildId: string;
	toUserId: string;
	amount: number;
	byAdminId: string;
	now?: Date;
}

/** The server's vault, created at the starting balance the first time it is read. */
export function readVault(guildId: string): Promise<IServerVault> {
	return serverVaultStore.ensure(guildId, ECONOMY.VAULT_STARTING_CHIPS);
}

/** Whether `amount` is a grant an admin may make: a whole number of chips up to the typo guard. */
export function isGrantableAmount(amount: number): boolean {
	return Number.isSafeInteger(amount) && amount > 0 && amount <= ECONOMY.MAX_GRANT_CHIPS;
}

/**
 * Grant chips from the vault to a member's wallet. A failed wallet credit is refunded
 * and answered as "failed"; a vault that cannot be read or debited at all throws, and
 * the command's own catch answers it.
 */
export async function grantFromVault(input: GrantInput): Promise<GrantResult> {
	const vault = await readVault(input.guildId);
	if (!isGrantableAmount(input.amount)) return { ok: false, reason: "invalidAmount", vaultBalance: vault.balance };

	// ①
	const grant = { userId: input.toUserId, amount: input.amount, at: input.now ?? new Date(), byAdminId: input.byAdminId };
	const paid = await serverVaultStore.debitGrant(input.guildId, grant, ECONOMY.VAULT_GRANT_HISTORY_LIMIT);
	if (!paid) {
		const current = await readVault(input.guildId);
		return { ok: false, reason: "vaultShort", vaultBalance: current.balance };
	}

	// ② and ③
	try {
		const wallet = await chipWalletStore.credit({ guildId: input.guildId, userId: input.toUserId }, input.amount);
		return { ok: true, vaultBalance: paid.balance, walletBalance: wallet.balance };
	} catch (error) {
		console.error(`[economy] crediting a ${input.amount} chip grant to ${input.toUserId} in guild ${input.guildId} failed, refunding the vault`, error);
		await serverVaultStore
			.refund(input.guildId, input.amount)
			.catch((refundError) => console.error(`[economy] refunding a failed ${input.amount} chip grant to the vault of guild ${input.guildId} failed`, refundError));
		return { ok: false, reason: "failed", vaultBalance: paid.balance + input.amount };
	}
}
