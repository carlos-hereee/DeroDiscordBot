// ── utcMonthKey ──────────────────────────────────────────────────────
// The "YYYY-MM" key for the UTC month a moment falls in, zero padded so month
// keys sort lexically. Pure, and in the shared region so a feature that buckets
// rows by month never has to import another feature to get it. Callers: the
// arcade ratings recorders (luck stats and Hold'em hand counts).
//
// UTC rather than a guild's zone because a month row must not move when a
// server changes its timezone, and every monthly collection in the bot keys on
// UTC already.

const MONTH_DIGITS = 2;

/** "YYYY-MM" for the UTC month `date` falls in. */
export function utcMonthKey(date: Date): string {
	const month = String(date.getUTCMonth() + 1).padStart(MONTH_DIGITS, "0");
	return `${date.getUTCFullYear()}-${month}`;
}
