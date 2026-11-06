import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { chipGiftStore } from "@db/stores/chipGiftStore.js";
import { canonicalPhrase } from "@utils/canonicalPhrase.js";
import { payChipGift } from "./chipWallet.js";

// ── chipGift ─────────────────────────────────────────────────────────
// What:  the birthday gift: the platform owner sets chips aside for one member with
//        `/platform birthday-gift`, and that member collects them once by entering the
//        birthday code in /secret-code. The code is shared; the amount is per member.
// Who:   commands/fun/secret-code.ts redeems and economy/birthdayGiftSubcommand.ts grants.
//        Neither shows a word from here; they map the outcome to copy.
// Does NOT: treat the code as a secret. It sits in source and its value protects nothing,
//        because a member with no gift waiting collects nothing whoever told them the code.
//
// ⚠️ THE PAYMENT IS ONE WRITE, AND THE WALLET IS WHAT MAKES IT ONCE. payChipGift adds the
// chips and the gift's receipt together, so there is no moment between a claim and a credit
// for a crash to land in: a failed write changed nothing and can be entered again, and a
// repeat is refused by the receipt. The gift row is closed afterwards, so losing that second
// write only leaves a row the next entry closes.

/** What entering a phrase did. `none` is every case with nothing to collect, a wrong code and a wrong member alike. */
export type ChipGiftOutcome = { status: "none" } | { status: "paid"; amount: number } | { status: "collected" };

const BIRTHDAY_CODE = canonicalPhrase(BOT_CONSTANTS.ECONOMY.BIRTHDAY_GIFT_CODE);

/** Set chips aside for a member, or correct the amount of the gift already waiting for them. */
export async function grantChipGift(userId: string, chips: number, grantedBy: string, now: Date = new Date()): Promise<void> {
	await chipGiftStore.savePending({ userId, chips, grantedBy, grantedAt: now });
}

/**
 * Collect the member's waiting gift if `raw` is the birthday code. A member with no gift and
 * none collected gets `none`, the same as any wrong phrase, so the code names nobody's gift.
 */
export async function redeemChipGift(userId: string, raw: string, now: Date = new Date()): Promise<ChipGiftOutcome> {
	if (canonicalPhrase(raw) !== BIRTHDAY_CODE) return { status: "none" };

	const gift = await chipGiftStore.findPending(userId);
	if (!gift) return (await chipGiftStore.hasRedeemed(userId)) ? { status: "collected" } : { status: "none" };

	const paid = await payChipGift({ userId }, gift.chips, String(gift._id));
	await closeGift(gift._id, now);
	return paid ? { status: "paid", amount: gift.chips } : { status: "collected" };
}

// After the wallet write the member has their chips, so a failure here must not read to them
// as a failed redeem. Logged and left: the receipt keeps the row from paying again.
async function closeGift(giftId: unknown, now: Date): Promise<void> {
	await chipGiftStore.markRedeemed(giftId, now).catch((error: unknown) => console.error(`[economy] closing chip gift ${String(giftId)} failed after its wallet write`, error));
}
