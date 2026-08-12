// ── levelPeriod ────────────────────────────────────────────────────────────
// The leveling feature's narrow view of the repo's week and month math.
//
// What:  the two period keys an xp award is stamped with, "2026-W32" and
//        "2026-08", plus the pair of them for the common case where both are
//        written in the same flush.
// Who:   xpWriter (two bulkWrite ops per flush, one per key), /levels and
//        /account (this week's and this month's standings).
// When:  every flush, and every read of a period-scoped surface.
// Where: a THIN wrapper over periodKey in @features/leaderboard/
//        leaderboardWindow.js, which owns this repo's week boundary rotation.
//        It is deliberately not a second implementation: a guild's weekStart
//        preference drives both the participation leaderboard's window and this
//        feature's period key, and two copies of that rotation would drift.
//        This file exists only to give the leveling call sites a signature that
//        does not mention granularity strings at every site.
// How:   pure. No discord.js, no store, no clock of its own; the date is always
//        a parameter so a week boundary is testable.

import { periodKey, type WeekStart } from "@features/leaderboard/leaderboardWindow.js";

export interface PeriodKeys {
	week: string;
	month: string;
}

export function weekKey(date: Date, weekStart: WeekStart): string {
	return periodKey(date, "week", weekStart);
}

// The month key ignores weekStart entirely: a calendar month has no anchor day
// to rotate. It still takes the parameter so every call site in this feature
// reads the same, and so a caller cannot pass the arguments in the wrong order
// and get a plausible looking answer.
export function monthKey(date: Date, weekStart: WeekStart): string {
	return periodKey(date, "month", weekStart);
}

// Both keys for one moment. The flush writes an XpPeriod row per key, so taking
// them together guarantees the two rows describe the SAME instant even if a
// flush happens to straddle midnight on the first of a month.
export function periodKeysFor(date: Date, weekStart: WeekStart): PeriodKeys {
	return { week: weekKey(date, weekStart), month: monthKey(date, weekStart) };
}
