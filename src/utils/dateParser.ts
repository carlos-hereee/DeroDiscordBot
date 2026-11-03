import { DEFAULT_SERVER_TIMEZONE, localTimeToUtc } from "./tzParser.js";

// ── reading a typed wall clock time (2026-10 item 263 Phase 4c, R3-30) ──
// The two MM/DD @HH helpers below read a typed time in a timezone, UTC unless the
// caller passes one. The KvK season keeps UTC (the game's clock, owner decision 17);
// party games and stream announcements pass the server's zone. The calendar check
// runs on the typed date itself, so Feb 31 is refused in every zone, and a UTC read
// builds the very instant it always did, so the KvK season cannot move.
function wallClockTime(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date | null {
	const typed = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
	// catch JS date rollover e.g. Feb 31 silently becoming Mar 3
	if (typed.getUTCMonth() + 1 !== month) return null;
	if (timezone === DEFAULT_SERVER_TIMEZONE) return typed;
	return localTimeToUtc(year, month, day, hour, minute, timezone);
}

// parses "MM/DD@HH" → Date
// used for Ruins and Altar which need a specific hour
export function parseEventDateTime(input: string, year = new Date().getUTCFullYear(), timezone: string = DEFAULT_SERVER_TIMEZONE): Date | null {
	// expected format: MM/DD@HH
	const match = input.trim().match(/^(\d{1,2})\/(\d{1,2})\s*@\s*(\d{1,2})$/);
	if (!match) return null;

	const [, mm, dd, hh] = match.map(Number);

	if (mm < 1 || mm > 12) return null;
	if (dd < 1 || dd > 31) return null;
	if (hh < 0 || hh > 23) return null;

	return wallClockTime(year, mm, dd, hh, 0, timezone);
}

// parses "MM/DD @HH:MM" → Date
// used by streamer commands that need minute precision (the legacy
// parseEventDateTime above only takes hour precision because ROK events
// only ever start on the hour). Same MM/DD/year anchoring and the same
// timezone read, so the two helpers behave identically aside from the minute
// granularity.
export function parseEventDateTimeMinutes(input: string, year = new Date().getUTCFullYear(), timezone: string = DEFAULT_SERVER_TIMEZONE): Date | null {
	// expected format: MM/DD@HH:MM (the @ may have surrounding spaces)
	const match = input.trim().match(/^(\d{1,2})\/(\d{1,2})\s*@\s*(\d{1,2}):(\d{2})$/);
	if (!match) return null;

	const [, mm, dd, hh, mi] = match.map(Number);

	if (mm < 1 || mm > 12) return null;
	if (dd < 1 || dd > 31) return null;
	if (hh < 0 || hh > 23) return null;
	if (mi < 0 || mi > 59) return null;

	return wallClockTime(year, mm, dd, hh, mi, timezone);
}

// parses "MM/DD" → Date at 00:00 UTC
// used for Kau Karuak which always starts at midnight
export function parseEventDate(input: string, year = new Date().getUTCFullYear()): Date | null {
	// expected format: MM/DD
	const match = input.trim().match(/^(\d{1,2})\/(\d{1,2})$/);
	if (!match) return null;

	const [, mm, dd] = match.map(Number);

	if (mm < 1 || mm > 12) return null;
	if (dd < 1 || dd > 31) return null;

	const pad = (n: number) => String(n).padStart(2, "0");
	const date = new Date(`${year}-${pad(mm)}-${pad(dd)}T00:00:00Z`);

	if (date.getUTCMonth() + 1 !== mm) return null;

	return date;
}

// helper used in scheduler and activity tracker
export function addDays(date: Date, days: number): Date {
	const result = new Date(date);
	result.setUTCDate(result.getUTCDate() + days);
	return result;
}

export function startOfDay(date: Date): Date {
	const d = new Date(date);
	d.setUTCHours(0, 0, 0, 0);
	return d;
}
