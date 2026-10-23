// ── utcMonthKey ──────────────────────────────────────────────────────
// The "YYYY-MM" key for the UTC month a moment falls in, zero padded so month
// keys sort lexically, and the month before it with its bounds. Pure, and in
// the shared region so a feature that buckets rows by month never has to import
// another feature to get it. Callers: the arcade ratings recorders (luck stats
// and Hold'em hand counts), /rating luck, and the monthly arcade post (the month
// before on the 1st, the current month for its hand triggered preview).
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

/** The whole UTC month `date` falls in, so far and still to come. */
export function currentUtcMonth(date: Date): UtcMonth {
	return utcMonthAt(date.getUTCFullYear(), date.getUTCMonth());
}

/** The whole UTC month before the one `date` falls in. */
export function previousUtcMonth(date: Date): UtcMonth {
	return utcMonthAt(date.getUTCFullYear(), date.getUTCMonth() - 1);
}

// The UTC month starting on the 1st of a zero based month index. Date.UTC carries
// an index of -1 back into December of the year before, and 12 on into January.
function utcMonthAt(year: number, monthIndex: number): UtcMonth {
	const start = new Date(Date.UTC(year, monthIndex, 1));
	const end = new Date(Date.UTC(year, monthIndex + 1, 1));
	return { key: utcMonthKey(start), start, end };
}
