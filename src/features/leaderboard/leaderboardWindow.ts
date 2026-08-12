// ── leaderboard time windows ──────────────────────────────────────────
// Pure date-range helpers shared by the /leaderboard command and the pinned
// LeaderboardBoard. Extracted from leaderboard.ts in v1.6 Phase 2 so the
// board reuses the exact same window math (item 13 + item 17) instead of
// forking a second copy. No Discord or DB imports, keep it pure so both the
// command and the board can call it freely and it stays trivially testable.

export type WeekStart = "sunday" | "monday";

// Compute [from, to] window for the current calendar week, anchored to the
// guild's configured weekStart (item 17). Sunday-anchored (default) runs Sun
// through Sat; Monday-anchored runs Mon through Sun. Sunday stays the default
// because the bot's existing day-of-week constants (DAYS_OF_WEEK in the
// dashboard's EventCreatePage) treat Sunday as day 0.
export function thisWeekRange(weekStart: WeekStart): { from: Date; to: Date } {
	const now = new Date();
	const dayOfWeek = now.getDay(); // 0 = Sun
	// Days elapsed since the most recent week-start day. getDay is Sunday-based,
	// so for Monday anchoring we rotate the index: Mon maps to 0, ..., Sun to 6.
	const daysSinceStart = weekStart === "monday" ? (dayOfWeek + 6) % 7 : dayOfWeek;
	const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceStart, 0, 0, 0, 0);
	const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (6 - daysSinceStart), 23, 59, 59, 999);
	return { from, to };
}

// Compute [from, to] window for the current calendar month in the server's
// local time. The bot runs in UTC on Railway so "this month" is UTC-anchored;
// good enough for v1, can revisit if streamers want timezone-aware windows
// (which probably belongs alongside FUTURE_PLANS 12b on per-user timezone).
export function thisMonthRange(): { from: Date; to: Date } {
	const now = new Date();
	const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
	// last millisecond of the last day of the month, month-end without
	// caring how many days the month has.
	const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
	return { from, to };
}

// Human-readable week boundary for the leaderboard title so "this week" is
// never ambiguous. Used by both the /leaderboard command and the board, so
// the two surfaces always state the same window.
export function weekBoundaryTitle(weekStart: WeekStart): string {
	return weekStart === "monday" ? "This week (Mon to Sun)" : "This week (Sun to Sat)";
}

// ── period keys (leveling, added 2026-08-11) ─────────────────────────────
// What:  a stable STRING label for the calendar period a timestamp falls in,
//        "2026-W32" or "2026-08". The leveling feature stores one XpPeriod row
//        per member per period keyed on this string.
// Who:   @features/leveling/levelPeriod.ts wraps it; xpWriter stamps every
//        buffered flush with the current week and month key; /levels and
//        /account query on it.
// When:  on every flush, so it stays pure arithmetic with no allocation beyond
//        the returned string.
// Where: it lives HERE, beside thisWeekRange, rather than in the leveling
//        feature, because this file already owns this repo's week boundary math
//        including the Sunday-based getDay rotation for Monday anchoring. A
//        second copy over there would drift the day a guild's weekStart
//        preference changed meaning, and the two surfaces would silently
//        disagree about which week a member's xp belongs to.
// How:   the date is a PARAMETER, unlike thisWeekRange and thisMonthRange which
//        read new Date() internally and therefore cannot be tested at a
//        boundary. New code should prefer this signature.
//
// WHY A KEY AND NOT A weekXp FIELD, because it decides the whole feature's
// shape: there is no field to zero, therefore no weekly reset job, therefore no
// reset job that can fail. Arcane, the market leader, ships a documented and
// unfixed bug in exactly this spot, where weekly and monthly leaderboards only
// reset if an unrelated notification setting happens to be enabled. A schema
// with nowhere to put that bug beats a job that has to remember to run.

export type PeriodGranularity = "week" | "month";

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

// The local-time Y/M/D of the week-start day that `date` belongs to, using the
// SAME rotation thisWeekRange uses. Returned as components rather than a Date so
// the caller can difference two of them through Date.UTC, which is immune to the
// DST shifts that would make a millisecond subtraction of local dates wrong by
// an hour twice a year.
function weekStartComponents(date: Date, weekStart: WeekStart): { year: number; month: number; day: number } {
	const dayOfWeek = date.getDay(); // 0 = Sun
	const daysSinceStart = weekStart === "monday" ? (dayOfWeek + 6) % 7 : dayOfWeek;
	const anchor = new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysSinceStart);
	return { year: anchor.getFullYear(), month: anchor.getMonth(), day: anchor.getDate() };
}

export function periodKey(date: Date, granularity: PeriodGranularity, weekStart: WeekStart): string {
	if (granularity === "month") {
		return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
	}

	// ① A week is labelled by the year its START day falls in, so a week that
	// straddles New Year gets ONE key rather than splitting a member's xp across
	// two. 2027-01-01 is a Friday, so under Sunday anchoring it belongs to the
	// week beginning 2026-12-27 and lands in that week's 2026 key.
	const anchor = weekStartComponents(date, weekStart);

	// ② Number from the first week-start that falls INSIDE that year. Anchoring
	// on the week-start before Jan 1 instead would push a year whose calendar
	// begins mid-week to start at W02 and leave it with no W01 at all.
	const firstOfYear = weekStartComponents(new Date(anchor.year, 0, 1), weekStart);
	const firstDay = new Date(Date.UTC(firstOfYear.year, firstOfYear.month, firstOfYear.day));
	if (firstOfYear.year < anchor.year) firstDay.setUTCDate(firstDay.getUTCDate() + 7);

	// ③ Both endpoints are week-starts under one rotation, so their difference is
	// always a whole number of weeks and the division is exact.
	const DAY_MS = 24 * 60 * 60 * 1000;
	const elapsedDays = (Date.UTC(anchor.year, anchor.month, anchor.day) - firstDay.getTime()) / DAY_MS;
	const weekNumber = Math.floor(elapsedDays / 7) + 1;

	return `${anchor.year}-W${pad2(weekNumber)}`;
}
