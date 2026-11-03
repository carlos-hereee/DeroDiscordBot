import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { dateInTimezone } from "@utils/tzParser.js";
import type { XpSource } from "./levelingTypes.js";

// ── dailyXpCap ─────────────────────────────────────────────────────────────
// The arithmetic of the daily XP cap, kept PURE the way xpRules is: no store, no
// discord.js, no clock of its own (the date is always a parameter).
//
// What:  which sources the cap covers, which Central day an award lands on, and how
//        much of an award still fits once the day's counter has been moved.
// Who:   awardXp, the only caller, which owns the XpDaily read and write.
// Where: the rule is "50 XP a member a server a day from messages, reactions and
//        solo luck combined" (the 1.7.0 test fixes, item 5). Every number comes from
//        BOT_CONSTANTS.LEVELING so the cap and its sources change in one place.
// How:   awardXp adds the FULL amount to the day's counter first, atomically, and
//        reads the count back. grantedUnderCap then works out what this award was
//        allowed from that post increment count. Reading first and writing after
//        would let two awards in the same tick both read 49 and both pay.

const CAPPED_SOURCES: readonly XpSource[] = BOT_CONSTANTS.LEVELING.DAILY_CAPPED_SOURCES;

/** True for the sources the daily cap covers: message, reaction and soloLuck. */
export function isDailyCappedSource(source: XpSource): boolean {
	return CAPPED_SOURCES.includes(source);
}

/**
 * The calendar day `date` falls on in the cap's zone (Central time), as
 * "YYYY-MM-DD". Midnight Central is when every member's allowance resets.
 */
export function dailyCapDayKey(date: Date, timeZone: string = BOT_CONSTANTS.LEVELING.DAILY_CAP_TIME_ZONE): string {
	const { year, month, day } = dateInTimezone(date, timeZone);
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * How much of `amount` this award may pay, given the day's counter AFTER `amount`
 * was added to it. Whatever the counter held before this award is `totalAfter`
 * minus `amount`, and the award gets whatever room the cap still had, from zero
 * up to the whole amount.
 */
export function grantedUnderCap(amount: number, totalAfter: number, cap: number = BOT_CONSTANTS.LEVELING.DAILY_XP_CAP): number {
	const before = totalAfter - amount;
	return Math.min(amount, Math.max(0, cap - before));
}
