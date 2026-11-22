import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { parseEventDateTimeMinutes } from "./dateParser.js";
import { dateInTimezone, localTimeToUtc, nextOccurrenceInZone, parseFlexibleTime } from "./tzParser.js";

// ── reminderTimeParser ──────────────────────────────────────────────────────
// What:  reads a time a member typed for a reminder or a todo's due date into one UTC
//        instant (2026-11 item 388, owner decision D16): a relative span (30m, 2h, 3d, 1w),
//        a clock time (7pm, 19:30) as its next occurrence, or MM/DD@HH:MM.
// Who:   features/reminders/personalReminders.ts, features/todos/todoHandlers.ts and
//        features/meetings/scheduledMeetings.ts, each passing the zone memberTimezone.ts
//        resolved (the member's own, else the server's).
// Does NOT: pick the zone or store anything. A pure function of the text, the zone and now.

/** Why a typed time was refused, each with its own private line in the packs. */
export type ReminderTimeRefusal = "unreadable" | "past" | "tooFar";

export type ReminderTimeResult = { ok: true; at: Date } | { ok: false; reason: ReminderTimeRefusal };

const MINUTE_MS = 60 * 1000;
const UNIT_MS: Readonly<Record<string, number>> = {
	m: MINUTE_MS,
	h: 60 * MINUTE_MS,
	d: 24 * 60 * MINUTE_MS,
	w: 7 * 24 * 60 * MINUTE_MS,
};
const RELATIVE_PATTERN = /^(\d{1,4})\s*([mhdw])$/i;
// A typed MM/DD that already passed by more than this is read as next year's date (a
// January due date typed in December); a date only just passed is refused as past, since
// that is far likelier a typo than a reminder a year away.
const NEXT_YEAR_AFTER_MS = 30 * 24 * 60 * MINUTE_MS;

/** Read `raw` in `timezone` against `now`. */
export function parseReminderTime(raw: string, timezone: string, now: Date = new Date()): ReminderTimeResult {
	const text = raw.trim();
	const at = readRelative(text, now) ?? readCalendarDate(text, timezone, now) ?? readClockTime(text, timezone, now);
	if (!at) return { ok: false, reason: "unreadable" };
	if (at.getTime() <= now.getTime()) return { ok: false, reason: "past" };
	if (at.getTime() - now.getTime() > BOT_CONSTANTS.REMINDERS.MAX_AHEAD_MS) return { ok: false, reason: "tooFar" };
	return { ok: true, at };
}

function readRelative(text: string, now: Date): Date | null {
	const match = text.match(RELATIVE_PATTERN);
	if (!match) return null;
	const amount = Number(match[1]);
	if (amount <= 0) return null;
	return new Date(now.getTime() + amount * UNIT_MS[match[2].toLowerCase()]);
}

function readCalendarDate(text: string, timezone: string, now: Date): Date | null {
	const year = dateInTimezone(now, timezone).year;
	const thisYear = parseEventDateTimeMinutes(text, year, timezone);
	if (!thisYear) return null;
	if (now.getTime() - thisYear.getTime() > NEXT_YEAR_AFTER_MS) return parseEventDateTimeMinutes(text, year + 1, timezone);
	return thisYear;
}

// A clock time is today's when it is still ahead, else tomorrow's. nextOccurrenceInZone
// alone would roll a passed time a whole week, since it answers for a weekday.
function readClockTime(text: string, timezone: string, now: Date): Date | null {
	const clock = parseFlexibleTime(text);
	if (!clock) return null;
	const today = dateInTimezone(now, timezone);
	const todayAt = localTimeToUtc(today.year, today.month, today.day, clock.hour, clock.minute, timezone);
	if (todayAt.getTime() > now.getTime()) return todayAt;
	return nextOccurrenceInZone((today.weekday + 1) % 7, clock.hour, clock.minute, timezone, now);
}
