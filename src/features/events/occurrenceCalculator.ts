import { IGameEvent } from "./event.types.js";
import { dateInTimezone, isValidTimezone, localTimeToUtc } from "@utils/tzParser.js";

// pure function, no DB calls, no Discord, just math
// this makes it trivially easy to unit test

const HOUR_MS = 60 * 60 * 1000;
// A weekly event repeats every 168 hours: what /events stream weekly writes.
const WEEK_HOURS = 168;
const DAYS_PER_WEEK = 7;

// ── a weekly event that holds its local time (2026-10 item 263 Phase 4c, R3-30) ──
// An event that stores a zone and repeats weekly fires on the same local weekday and
// time in that zone every week, so a 7 PM stream stays 7 PM through each daylight
// saving change instead of drifting an hour with plain 168 hour steps. Every other
// event, every event created before 4c among them, has no zone and keeps the exact
// 168 hour walk below (risk R12); a stored value that is no real zone reads as none,
// so a bad row can never make Intl throw inside the reminder tick.
function weeklyZoneOf(event: IGameEvent): string | null {
	if (event.intervalHours !== WEEK_HOURS) return null;
	const zone = event.timezone;
	if (typeof zone !== "string" || zone.length === 0 || !isValidTimezone(zone)) return null;
	return zone;
}

// The instant of the event's `weeks`th occurrence after its anchor, read as the
// anchor's local date plus whole weeks at the anchor's local time of day.
function weeklyLocalOccurrence(anchor: Date, zone: string, weeks: number): Date {
	const local = dateInTimezone(anchor, zone);
	// Date.UTC carries a day past the month's end into the next month, so this is
	// plain calendar arithmetic on the local date with no zone involved.
	const day = new Date(Date.UTC(local.year, local.month - 1, local.day + weeks * DAYS_PER_WEEK));
	return localTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), local.hour, local.minute, zone);
}

function zonedWeeklyOccurrences(event: IGameEvent, zone: string, count: number, now: number): Date[] {
	const anchor = new Date(event.firstOccurrence);
	const weekMs = WEEK_HOURS * HOUR_MS;
	// Skip whole weeks the same way the plain walk does, one week short, because a
	// local week can be an hour shorter or longer than 168 hours across a change.
	let weeks = anchor.getTime() < now ? Math.max(0, Math.floor((now - anchor.getTime()) / weekMs) - 1) : 0;
	const occurrences: Date[] = [];
	while (occurrences.length < count) {
		const occurrence = weeklyLocalOccurrence(anchor, zone, weeks);
		if (occurrence.getTime() > now) occurrences.push(occurrence);
		weeks += 1;
	}
	return occurrences;
}

export function getUpcomingOccurrences(event: IGameEvent, count: number): Date[] {
	// if intervalHours is 0, it's a one-time event  either it hasn't happened yet (return the single occurrence)
	// or it has already passed (return an empty array)
	if (event.intervalHours === 0) {
		const t = new Date(event.firstOccurrence).getTime();
		return t > Date.now() ? [new Date(t)] : [];
	}

	const zone = weeklyZoneOf(event);
	if (zone) return zonedWeeklyOccurrences(event, zone, count, Date.now());

	const occurrences: Date[] = [];
	const intervalMs = event.intervalHours * HOUR_MS;
	const now = Date.now();

	// start from the anchor point and walk forward
	// until we've collected enough future occurrences
	let t = new Date(event.firstOccurrence).getTime();

	// skip past occurrences efficiently instead of looping one by one
	if (t < now) {
		const elapsed = now - t;
		const intervalsPassed = Math.floor(elapsed / intervalMs);
		t += intervalsPassed * intervalMs;
	}

	// collect the next `count` occurrences
	while (occurrences.length < count) {
		if (t > now) occurrences.push(new Date(t));
		t += intervalMs;
	}

	return occurrences;
}

/**
 * The occurrence just before `next`, a recurring event's most recent start once `next`
 * is its upcoming one. A weekly event with a zone steps back one local week, so the
 * start it names is the one its reminders fired for; every other event steps back one
 * interval, as it always did. Read by isEventWindowOpen and ActivityTracker, which key
 * attendance by this start.
 */
export function previousOccurrence(event: IGameEvent, next: Date): Date {
	const zone = weeklyZoneOf(event);
	if (zone) return weeklyLocalOccurrence(next, zone, -1);
	return new Date(next.getTime() - event.intervalHours * HOUR_MS);
}

// separate helper used by ActivityTracker to know if an
// event window is currently open (for voice/presence tracking)
export function isEventWindowOpen(event: IGameEvent, now = new Date(), windowMinutes = 60): boolean {
	// one-time event: the window is open if we're between firstOccurrence and firstOccurrence + windowMinutes
	if (event.intervalHours === 0) {
		const start = new Date(event.firstOccurrence);
		const windowEnd = new Date(start.getTime() + windowMinutes * 60 * 1000);
		return now >= start && now <= windowEnd;
	}

	const occurrences = getUpcomingOccurrences(event, 1);
	if (!occurrences.length) return false;

	const nextOccurrence = occurrences[0];

	// look backwards, was the most recent occurrence within the last EVENT_WINDOW_MINUTES?
	const lastOccurrence = previousOccurrence(event, nextOccurrence);
	const windowEnd = new Date(
		lastOccurrence.getTime() + windowMinutes * 60 * 1000 // windowMinutes window after start
	);

	return now >= lastOccurrence && now <= windowEnd;
}
