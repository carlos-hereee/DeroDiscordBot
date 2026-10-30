import { IGameEvent } from "./event.types.js";
import { dateInTimezone, isValidTimezone, localTimeToUtc } from "@utils/tzParser.js";

// pure function, no DB calls, no Discord, just math
// this makes it trivially easy to unit test

const HOUR_MS = 60 * 60 * 1000;
// A weekly event repeats every 168 hours: what /events stream weekly writes.
const WEEK_HOURS = 168;
const DAYS_PER_WEEK = 7;
// The smallest step the forward walk can take. A step under one millisecond can round to
// no change when added to an epoch time (about 1.7e12 ms, whose spacing is a fraction of
// a millisecond), and a walk that cannot move never ends (2026-10 item 280).
const MIN_WALK_STEP_MS = 1;

// ── an event the walk can step through (2026-10 item 280) ──
// Every recurring walk below loops until it has collected `count` future starts, so a
// negative, NaN, infinite or vanishing interval, or an anchor that is no date, used to
// spin forever inside one reminder tick and freeze the whole bot. Such a row has no
// upcoming start; the events routes refuse to write one, and this guard covers rows
// already stored or written by another path.
function isWalkable(event: IGameEvent): boolean {
	const anchorMs = new Date(event.firstOccurrence).getTime();
	return Number.isFinite(anchorMs) && Number.isFinite(event.intervalHours) && event.intervalHours * HOUR_MS >= MIN_WALK_STEP_MS;
}

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

	if (!isWalkable(event)) return [];

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
	return openWindowStart(event, now, windowMinutes) !== null;
}

/**
 * The start of the event window open at `now`, or null when none is. A one time event's
 * window opens at its own start; a recurring event's at the occurrence before the next
 * one. ActivityTracker keys attendance by this start, so a one time event answers its
 * firstOccurrence directly: it has no upcoming occurrence to step back from once it has
 * begun, and stepping back from none threw and broke tracking for the guild (2026-10
 * item 280).
 */
export function openWindowStart(event: IGameEvent, now = new Date(), windowMinutes = 60): Date | null {
	const windowMs = windowMinutes * 60 * 1000;

	// one-time event: the window is open between firstOccurrence and firstOccurrence + windowMinutes
	if (event.intervalHours === 0) {
		const start = new Date(event.firstOccurrence);
		return now >= start && now.getTime() <= start.getTime() + windowMs ? start : null;
	}

	const [nextOccurrence] = getUpcomingOccurrences(event, 1);
	if (!nextOccurrence) return null;

	// look backwards, was the most recent occurrence within the last windowMinutes?
	const lastOccurrence = previousOccurrence(event, nextOccurrence);
	return now >= lastOccurrence && now.getTime() <= lastOccurrence.getTime() + windowMs ? lastOccurrence : null;
}
