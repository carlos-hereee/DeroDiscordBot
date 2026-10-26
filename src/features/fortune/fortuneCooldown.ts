import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { fortuneCooldownStore } from "@db/stores/fortuneCooldownStore.js";

// ── fortuneCooldown ─────────────────────────────────────────────────────────
// What:  the fortune's 22 hour cooldown (2026-10 item 254, the owner's call): one
//        reading per member per server, shared by every entry (the 🕹️games Fortune
//        button and /mini-game fortune), surviving a deploy.
// Who:   respondWithFortune, before it rolls, and again to give a slot back when
//        the reading never reached the member.
// How:   the slot is CLAIMED atomically before the roll (a conditional upsert in the
//        store that wins only when no reading falls inside the window), so two
//        presses at once cannot both read. A reading outside a server keys on "dm",
//        as the old in memory cooldown did.

const MS_PER_HOUR = 60 * 60 * 1000;
const COOLDOWN_MS = BOT_CONSTANTS.FORTUNE_COOLDOWN_HOURS * MS_PER_HOUR;
const DM_KEY = "dm";

/** A claimed reading slot, kept so a failed reading can give it back. */
export interface FortuneSlot {
	guildKey: string;
	userId: string;
	claimedAt: Date;
	previousAt: Date | null;
}

/** The slot this reading claimed, or when the member's next reading is ready. */
export type FortuneSlotClaim = { ok: true; slot: FortuneSlot } | { ok: false; readyAt: Date };

/** Claim the member's reading slot in this server, or say when the next one is ready. */
export async function claimFortuneSlot(guildId: string | null, userId: string, now: Date = new Date()): Promise<FortuneSlotClaim> {
	const guildKey = guildId ?? DM_KEY;
	const claim = await fortuneCooldownStore.claim(guildKey, userId, new Date(now.getTime() - COOLDOWN_MS), now);
	if (claim.claimed) return { ok: true, slot: { guildKey, userId, claimedAt: now, previousAt: claim.previousAt } };
	// The claim lost to a reading inside the window. Read it for the ready time; a row
	// gone in between (the TTL, or a give back) reads as ready now, which is honest.
	const last = await fortuneCooldownStore.lastReadingAt(guildKey, userId);
	return { ok: false, readyAt: new Date((last?.getTime() ?? now.getTime() - COOLDOWN_MS) + COOLDOWN_MS) };
}

/** Give a claimed slot back after the reading failed to reach the member. Logs and never throws. */
export async function releaseFortuneSlot(slot: FortuneSlot): Promise<void> {
	try {
		await fortuneCooldownStore.restore(slot.guildKey, slot.userId, slot.claimedAt, slot.previousAt);
	} catch (error) {
		console.error(`[fortune] giving back the reading slot of ${slot.userId} in ${slot.guildKey} failed`, error);
	}
}
