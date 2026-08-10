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
