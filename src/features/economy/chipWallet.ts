import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { chipWalletStore, type WalletKey } from "@db/stores/chipWalletStore.js";

// ── chipWallet ───────────────────────────────────────────────────────
// What:  a member's chips (2026-10 item 250 Phase 5), in ONE global wallet across every
//        server (2026-10 item 267 Session 1a, owner decision 1): the claim (a large first
//        one once per member ever, then one every 24 hours wherever it is claimed), and
//        the debit and credit the Hold'em buy in and cash out move chips through.
// Who:   /claim (chipClaim.ts), the Hold'em table (game-rooms/holdemChips.ts and
//        holdemDraftBuyIn.ts) and the /account chips line. The vault grant credits
//        through chipWalletStore itself, beside its day reservation.
// Does NOT: decide whether chip games run in a server (isChipEconomyOn is the one place
//        that reads the switch, and each game asks it; the wallet and the claim work in
//        every server whatever it says), or show anything.
//
// ⚠️ EVERY CHANGE IS ONE CONDITIONAL WRITE, never a read then a write. A claim matches
// only a wallet whose cooldown has run, and a debit only a balance that covers it, so
// two presses in the same moment can neither claim twice nor spend chips twice.

const ECONOMY = BOT_CONSTANTS.ECONOMY;

/** What a claim did: paid the first claim, paid the daily one, or waits for its cooldown. */
export type ClaimResult = { kind: "first" | "daily"; amount: number; balance: number } | { kind: "cooldown"; balance: number; nextClaimAt: Date };

/** The slice of a GuildConfig row the switch is read from. */
export interface ChipEconomySetting {
	chipEconomyEnabled?: boolean | null;
}

/** Whether a server has the chip economy on. A row that never stored the switch reads as on, the schema default. */
export function isChipEconomyOn(config: ChipEconomySetting | null | undefined): boolean {
	return config?.chipEconomyEnabled ?? true;
}

/** When a member who last claimed at `lastClaimAt` may claim again. */
export function nextClaimAt(lastClaimAt: Date): Date {
	return new Date(lastClaimAt.getTime() + ECONOMY.CLAIM_COOLDOWN_MS);
}

/**
 * Claim chips. ① The first claim ever is the large one, and only a wallet that never
 * claimed can take it. ② Otherwise the daily claim, once its cooldown has run. ③
 * Otherwise nothing, and the answer says when the next claim opens. `multiplier` is the
 * daily claim round's (ECONOMY.CLAIM_ROUND_MULTIPLIERS), applied to whichever base pays,
 * the first claim's included, by owner decision (risk R11).
 */
export async function claimChips(key: WalletKey, now: Date = new Date(), multiplier: number = 1): Promise<ClaimResult> {
	const firstAmount = Math.round(ECONOMY.FIRST_CLAIM_CHIPS * multiplier);
	const first = await chipWalletStore.claimFirst(key, firstAmount, now);
	if (first) return { kind: "first", amount: firstAmount, balance: first.balance };

	const cooldownStart = new Date(now.getTime() - ECONOMY.CLAIM_COOLDOWN_MS);
	const dailyAmount = Math.round(ECONOMY.DAILY_CLAIM_CHIPS * multiplier);
	const daily = await chipWalletStore.claimDaily(key, dailyAmount, now, cooldownStart);
	if (daily) return { kind: "daily", amount: dailyAmount, balance: daily.balance };

	const wallet = await chipWalletStore.findOne(key);
	return { kind: "cooldown", balance: wallet?.balance ?? 0, nextClaimAt: nextClaimAt(wallet?.lastClaimAt ?? now) };
}

/** A member's balance and when they may claim next (null when they never claimed, so the first claim is waiting). */
export async function readWallet(key: WalletKey): Promise<{ balance: number; nextClaimAt: Date | null }> {
	const wallet = await chipWalletStore.findOne(key);
	return { balance: wallet?.balance ?? 0, nextClaimAt: wallet?.lastClaimAt ? nextClaimAt(wallet.lastClaimAt) : null };
}

/** Take chips for a buy in. False when the balance does not cover them, and then nothing was taken. */
export async function takeChips(key: WalletKey, amount: number): Promise<boolean> {
	if (!isWholeChipAmount(amount)) return false;
	return (await chipWalletStore.debit(key, amount)) !== null;
}

/**
 * Take chips for a buy in the game records in a second write (2026-10 item 276, audit P3): the
 * wallet keeps `receiptId` open until closeChipReceipt, so a crash between the charge and the
 * game's ledger leaves a receipt refundChipReceipt can give back once. False when the balance does
 * not cover the chips, and then nothing was taken.
 */
export async function takeChipsWithReceipt(key: WalletKey, amount: number, receiptId: string): Promise<boolean> {
	if (!isWholeChipAmount(amount)) return false;
	return (await chipWalletStore.debitWithReceipt(key, amount, receiptId)) !== null;
}

/** Give a receipted charge back, once: true when this call refunded it, false when it was never taken or already closed. */
export async function refundChipReceipt(key: WalletKey, amount: number, receiptId: string): Promise<boolean> {
	if (!isWholeChipAmount(amount)) return false;
	return (await chipWalletStore.refundReceipt(key, amount, receiptId)) !== null;
}

/** The game's ledger holds the charge now: close its receipt, so no refund reaches it. */
export async function closeChipReceipt(key: WalletKey, receiptId: string): Promise<void> {
	await chipWalletStore.closeReceipt(key, receiptId);
}

/** Give chips back, a cash out or a refund. Nothing to give is a no op rather than a write. */
export async function returnChips(key: WalletKey, amount: number): Promise<void> {
	if (!isWholeChipAmount(amount)) return;
	await chipWalletStore.credit(key, amount);
}

/** A positive whole number of chips: the only amount a wallet ever moves. */
export function isWholeChipAmount(amount: number): boolean {
	return Number.isSafeInteger(amount) && amount > 0;
}

// Digits with optional thousands commas, and an optional k for thousands ("2,500",
// "2.5k", "10k"). Members type amounts the way they say them.
const CHIP_AMOUNT_PATTERN = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k)?$/i;
const THOUSAND = 1000;

/** Read an amount a member typed, or null when it is not a whole number of chips. */
export function parseChipAmount(raw: string): number | null {
	const match = CHIP_AMOUNT_PATTERN.exec(raw.trim());
	if (!match) return null;
	const [, whole, fraction, thousands] = match;
	const value = Number(`${whole.replace(/,/g, "")}${fraction ? `.${fraction}` : ""}`) * (thousands ? THOUSAND : 1);
	return isWholeChipAmount(value) ? value : null;
}
