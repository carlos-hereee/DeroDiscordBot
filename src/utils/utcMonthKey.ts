// ── utcMonthKey ──────────────────────────────────────────────────────
// The "YYYY-MM" key for the UTC month a moment falls in, zero padded so month
// keys sort lexically, and the month before it with its bounds. Pure, and in
// the shared region so a feature that buckets rows by month never has to import
// another feature to get it. Callers: the arcade ratings recorders (luck stats
// and Hold'em hand counts), /rating luck, and the monthly arcade post.
//
// UTC rather than a guild's zone because a month row must not move when a
// server changes its timezone, and every monthly collection in the bot keys on
// UTC already.

const MONTH_DIGITS = 2;

/** A UTC month: its key and its bounds, `start` inclusive and `end` exclusive. */
export interface UtcMonth {
	key: string;
	start: Date;
	end: Date;
}

/** "YYYY-MM" for the UTC month `date` falls in. */
export function utcMonthKey(date: Date): string {
	const month = String(date.getUTCMonth() + 1).padStart(MONTH_DIGITS, "0");
	return `${date.getUTCFullYear()}-${month}`;
}

/** The whole UTC month before the one `date` falls in. Date.UTC carries month minus one back into December of the year before. */
export function previousUtcMonth(date: Date): UtcMonth {
	const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
	const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
	return { key: utcMonthKey(start), start, end };
}
