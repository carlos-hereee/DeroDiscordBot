import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IServerVault } from "@db/models/ServerVault.js";
import { chipWalletStore, type WalletKey } from "@db/stores/chipWalletStore.js";
import { serverVaultStore } from "@db/stores/serverVaultStore.js";
import { utcDayKey } from "@utils/utcMonthKey.js";

// ── serverVault ──────────────────────────────────────────────────────
// What:  a server's chip reserve (2026-10 item 250 Phase 5): reading it (created at the
//        starting balance on first read), and granting from it to a member's global
//        wallet, at most VAULT_DAILY_RECEIVE_CAP chips per member per UTC day across every
//        server (2026-10 item 267 Session 1a, risk R3).
// Who:   /arcade chips status and grant (vaultGrant.ts); the monthly award credits it
//        through vaultTopUp.ts.
// Does NOT: check who is granting (the ADMIN_COMMANDS gate in main.ts already did), or
//        write the admin log line (the command does, after the grant landed).
//
// How a grant moves chips: ① the member's day is reserved, in one conditional write on
// their global wallet that matches only while the day's cap has room; ② the vault pays,
// in one write that matches only while its balance covers the grant and records the
// grant in its history; ③ the wallet is credited. A step that fails gives back every
// step before it: a short vault releases the reservation, a failed credit refunds the
// vault and releases it. There is no window where the member holds chips the vault still
// holds too, which is the direction that would mint chips; the cap is reserved before
// anything moves, so two servers granting at once cannot both pass it.

const ECONOMY = BOT_CONSTANTS.ECONOMY;

export type GrantRefusal = "invalidAmount" | "vaultShort" | "dailyCap" | "failed";

export type GrantResult =
	| { ok: true; vaultBalance: number; walletBalance: number }
	| { ok: false; reason: Exclude<GrantRefusal, "dailyCap">; vaultBalance: number }
	| { ok: false; reason: "dailyCap"; vaultBalance: number; leftToday: number };

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

/** How many more vault chips the member may receive on `dayKey`, across every server. */
export async function vaultChipsLeftToday(key: WalletKey, dayKey: string): Promise<number> {
	const wallet = await chipWalletStore.findOne(key);
	const receivedToday = wallet?.vaultDayKey === dayKey ? (wallet.vaultReceivedToday ?? 0) : 0;
	return Math.max(0, ECONOMY.VAULT_DAILY_RECEIVE_CAP - receivedToday);
}

/**
 * Grant chips from the vault to a member's wallet. A grant past the member's daily cap is
 * refused before anything moves; a failed wallet credit is refunded and answered as
 * "failed"; a vault that cannot be read or debited at all throws, and the command's own
 * catch answers it.
 */
export async function grantFromVault(input: GrantInput): Promise<GrantResult> {
	const vault = await readVault(input.guildId);
	if (!isGrantableAmount(input.amount)) return { ok: false, reason: "invalidAmount", vaultBalance: vault.balance };

	const key: WalletKey = { userId: input.toUserId };
	const now = input.now ?? new Date();
	const dayKey = utcDayKey(now);

	// ① A grant larger than the whole cap could still pass the store's filter on a fresh
	// day (the filter only guards a day already counted), so it is refused here first.
	const reserved = input.amount <= ECONOMY.VAULT_DAILY_RECEIVE_CAP && (await chipWalletStore.reserveVaultReceipt(key, input.amount, dayKey, ECONOMY.VAULT_DAILY_RECEIVE_CAP)) !== null;
	if (!reserved) return { ok: false, reason: "dailyCap", vaultBalance: vault.balance, leftToday: await vaultChipsLeftToday(key, dayKey) };

	// ②
	const grant = { userId: input.toUserId, amount: input.amount, at: now, byAdminId: input.byAdminId };
	const paid = await serverVaultStore.debitGrant(input.guildId, grant, ECONOMY.VAULT_GRANT_HISTORY_LIMIT).catch(async (error: unknown) => {
		await releaseReservation(key, input, dayKey);
		throw error;
	});
	if (!paid) {
		await releaseReservation(key, input, dayKey);
		const current = await readVault(input.guildId);
		return { ok: false, reason: "vaultShort", vaultBalance: current.balance };
	}

	// ③
	try {
		const wallet = await chipWalletStore.credit(key, input.amount);
		return { ok: true, vaultBalance: paid.balance, walletBalance: wallet.balance };
	} catch (error) {
		console.error(`[economy] crediting a ${input.amount} chip grant to ${input.toUserId} from guild ${input.guildId} failed, refunding the vault`, error);
		await serverVaultStore
			.refund(input.guildId, input.amount)
			.catch((refundError) => console.error(`[economy] refunding a failed ${input.amount} chip grant to the vault of guild ${input.guildId} failed`, refundError));
		await releaseReservation(key, input, dayKey);
		return { ok: false, reason: "failed", vaultBalance: paid.balance + input.amount };
	}
}

// Give a grant's day reservation back after a later step failed. Swallowed and logged: a
// reservation that stays only lowers what the member may receive for the rest of one UTC
// day, and never moves a chip.
async function releaseReservation(key: WalletKey, input: GrantInput, dayKey: string): Promise<void> {
	await chipWalletStore
		.releaseVaultReceipt(key, input.amount, dayKey)
		.catch((error: unknown) => console.error(`[economy] releasing a ${input.amount} chip vault reservation for ${input.toUserId} from guild ${input.guildId} failed`, error));
}
