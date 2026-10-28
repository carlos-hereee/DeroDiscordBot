// ── tzParser ──────────────────────────────────────────────────
// What:  helpers for parsing flexible time-of-day strings ("7pm",
//        "9:30 am", "19:30") and converting (date + time + IANA
//        timezone) tuples to UTC Dates suitable for storage in the
//        event firstOccurrence column.
// Who:   the flows that take human-typed times from streamers
//        (/events stream weekly in features/schedule/configureStreamSchedule.ts
//        and the decree edits in features/schedule/decreeEditHandlers.ts,
//        plus any future command that wants the same input surface).
//        Never read the user's
//        Discord locale directly, we ask them to declare a timezone
//        explicitly so two streamers in different rooms don't get
//        ambiguous schedules.
// When:  at submit time of every recurring/one-time event command.
//        Conversion is one-way (input → UTC); the schedule board
//        renders <t:UNIX:F> which Discord re-localizes per viewer,
//        so we never need to convert back at render time.
// Where: pairs with dateParser.ts. dateParser handles MM/DD@HH for
//        legacy ROK events that only need hour precision; this file
//        handles "what time of day, in what zone" for streamer
//        cadences. Keep them separate so the legacy commands keep
//        their tight regex and don't grow zone awareness they don't
//        need.
// How:   parseFlexibleTime is a permissive 12h+24h regex; it returns
//        canonical { hour, minute } in the user's clock or null.
//        localTimeToUtc fixes-points its way to the UTC instant whose
//        wall-clock representation in the target timezone matches the
//        input. supportedTimezones lists IANA zones for autocomplete.

// ── parseFlexibleTime ─────────────────────────────────────────
// What:  parse a human time string into 24h { hour, minute }.
// Who:   /events stream weekly and the decree edits. Any future streamer
//        command that wants "Friday 7pm" / "Friday 19:00" semantics
//        should reuse this rather than re-rolling its own regex.
// When:  per slash command submission, before the confirmation embed.
// Where: paired with the time-utc option in the command, but no
//        longer assumes UTC, see the timezone option pattern in
//        /events stream weekly. The function itself is timezone-
//        agnostic; conversion happens in localTimeToUtc.
// How:   single regex captures (hour)(:minute)?(am|pm)?. Cases:
//          - "7pm"      → 19:00
//          - "7:30pm"   → 19:30
//          - "12am"     → 00:00 (midnight, edge case)
//          - "12pm"     → 12:00 (noon, edge case)
//          - "9"        → 09:00 (24h, no minutes)
//          - "9:30"     → 09:30 (24h)
//          - "19:30"    → 19:30 (24h)
//        Returns null on out-of-range hour/minute or unparseable
//        input so the caller can render its own validation message.
export function parseFlexibleTime(raw: string): { hour: number; minute: number } | null {
	// Trim, lowercase, then match. The regex tolerates an optional
	// space before am/pm so "7 pm" works as well as "7pm".
	const match = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
	if (!match) return null;

	const rawHour = Number(match[1]);
	const minute = match[2] !== undefined ? Number(match[2]) : 0;
	const ampm = match[3];

	if (!Number.isFinite(rawHour) || !Number.isFinite(minute)) return null;
	if (minute < 0 || minute > 59) return null;

	let hour: number;
	if (ampm) {
		// 12-hour with am/pm. Hour must be 1-12 in this branch; 0 is
		// only a valid hour in 24h notation. Map 12am → 00 and 12pm
		// → 12 explicitly because the modular arithmetic would get
		// the rest right but mishandle these two.
		if (rawHour < 1 || rawHour > 12) return null;
		if (ampm === "am") {
			hour = rawHour === 12 ? 0 : rawHour;
		} else {
			hour = rawHour === 12 ? 12 : rawHour + 12;
		}
	} else {
		// 24-hour. Accept 0-23 directly.
		if (rawHour < 0 || rawHour > 23) return null;
		hour = rawHour;
	}

	return { hour, minute };
}

// ── dateInTimezone ────────────────────────────────────────────
// What:  return the wall-clock components of a Date as they would
//        be rendered in the target IANA timezone.
// Who:   localTimeToUtc (for fixed-point convergence) and
//        nextOccurrenceInZone (for "what day of the week is it,
//        right now, where the user lives").
// When:  per call. Intl.DateTimeFormat is cheap; we don't bother
//        memoizing per-timezone formatters.
// Where: thin wrapper over Intl.DateTimeFormat.formatToParts. The
//        weekday parsing uses the short en-US labels because we
//        force locale 'en-US' to keep the part values stable
//        across runtimes.
// How:   ask Intl for year/month/day/hour/minute/second/weekday,
//        coerce strings to numbers, normalize the "hour 24"
//        edge case some Intl implementations emit at midnight.
export function dateInTimezone(
	date: Date,
	timezone: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number } {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		weekday: "short",
		hour12: false,
	});
	const parts = formatter.formatToParts(date);
	const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";
	const hourRaw = parseInt(get("hour"), 10);
	// Some Intl implementations emit "24" instead of "00" at midnight
	// when hour12 is false. Normalize to keep downstream math sane.
	const hour = hourRaw === 24 ? 0 : hourRaw;
	const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
	return {
		year: parseInt(get("year"), 10),
		month: parseInt(get("month"), 10),
		day: parseInt(get("day"), 10),
		hour,
		minute: parseInt(get("minute"), 10),
		second: parseInt(get("second"), 10),
		weekday: weekdayMap[get("weekday")] ?? 0,
	};
}

// ── localTimeToUtc ────────────────────────────────────────────
// What:  given a wall-clock instant in a timezone (year, month,
//        day, hour, minute), return the UTC Date that represents
//        that instant. Inverse of dateInTimezone.
// Who:   /events stream weekly when persisting firstOccurrence to the
//        events store, and the decree edits when they move one
//        occurrence. The store column is a Date that downstream
//        scheduler/board logic treats as UTC.
// When:  once per slash command submission.
// Where: this is the timezone math the bot has avoided until now.
//        firstOccurrence stays UTC in the DB; this helper is the
//        only conversion point.
// How:   fixed-point iteration. Start with the input components
//        as if they were UTC. Format that candidate in the target
//        timezone, compare against the desired components, adjust
//        candidate by the diff. Two iterations converge in normal
//        time. DST transitions can cause a one-hour shift; a
//        third iteration catches that. After three iterations
//        we accept the candidate even if non-converged, the
//        only way to genuinely fail is to ask for a wall-clock
//        time that doesn't exist in the zone (the spring-forward
//        gap), which is rare in streamer schedules.
export function localTimeToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timezone: string
): Date {
	let candidate = Date.UTC(year, month - 1, day, hour, minute, 0);

	const targetMs = candidate;

	for (let i = 0; i < 3; i++) {
		const tz = dateInTimezone(new Date(candidate), timezone);
		const tzMs = Date.UTC(tz.year, tz.month - 1, tz.day, tz.hour, tz.minute, 0);
		const diff = targetMs - tzMs;
		if (diff === 0) break;
		candidate += diff;
	}

	return new Date(candidate);
}

// ── nextOccurrenceInZone ──────────────────────────────────────
// What:  given a target day-of-week + time-of-day + timezone,
//        compute the UTC instant of the next occurrence (now or
//        in the future).
// Who:   /events stream weekly. Replaces nextOccurrenceUtc
//        which assumed UTC for both the cadence math and the
//        clock anchor. Without this, "Friday 7pm" entered by a
//        Tokyo user would have been interpreted as Friday 7pm UTC,
//        landing in their Saturday morning.
// When:  per command submission, before confirmation embed.
// Where: pairs with parseFlexibleTime + the timezone option in
//        the slash command. Returns a Date stored as
//        firstOccurrence in the events store.
// How:   ① ask for the user's local "today" components in their
//          timezone (year, month, day, weekday).
//        ② compute dayDelta = (target weekday - today weekday + 7) % 7.
//        ③ if dayDelta is 0 (today is the target day), check
//          whether the time has already passed in the user's
//          timezone. If yes, roll forward 7 days; otherwise use
//          today.
//        ④ build the (year, month, day, hour, minute) tuple of
//          the target occurrence in the user's timezone, then
//          convert to UTC via localTimeToUtc.
export function nextOccurrenceInZone(
	targetDayIndex: number,
	hour: number,
	minute: number,
	timezone: string,
	now: Date = new Date()
): Date {
	const tzNow = dateInTimezone(now, timezone);

	let dayDelta = (targetDayIndex - tzNow.weekday + 7) % 7;

	// If today IS the target day, decide whether to use today or
	// next week. Compare today's UTC candidate against `now`. If the
	// candidate is in the past, push to next week.
	if (dayDelta === 0) {
		const todayCandidate = localTimeToUtc(tzNow.year, tzNow.month, tzNow.day, hour, minute, timezone);
		if (todayCandidate.getTime() <= now.getTime()) {
			dayDelta = 7;
		}
	}

	// Add dayDelta days to today's date IN THE USER'S TIMEZONE. We
	// do this by adding days to a UTC midnight anchored at the
	// user's local date, month/year boundaries are handled
	// correctly because Date arithmetic carries.
	const anchor = new Date(Date.UTC(tzNow.year, tzNow.month - 1, tzNow.day));
	anchor.setUTCDate(anchor.getUTCDate() + dayDelta);

	return localTimeToUtc(
		anchor.getUTCFullYear(),
		anchor.getUTCMonth() + 1,
		anchor.getUTCDate(),
		hour,
		minute,
		timezone
	);
}

// ── isValidTimezone ───────────────────────────────────────────
// What:  validate that a string names a real IANA timezone.
// Who:   slash command validation paths. We never trust a string
//        from a user, autocomplete narrows the choice but a
//        determined user can still type anything they want into a
//        Discord autocomplete option.
// When:  per command submission, before localTimeToUtc.
// How:   try to construct an Intl.DateTimeFormat with the given
//        timeZone. Invalid zones throw RangeError. We swallow and
//        return false. No allocations stick around.
export function isValidTimezone(timezone: string): boolean {
	try {
		// Side-effect-free probe. The constructor throws on invalid
		// zone names; catching is the documented validation path.
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}

// ── the server's timezone (2026-10 item 263 Phase 4c, R3-30) ─────────────────
// GuildConfig.timezone is the zone a server's typed times are read in, picked in
// 🛠️server-config. UTC is the default so nothing moves on a server until an admin
// picks a zone, and it is what the bot read every typed time in before.
export const DEFAULT_SERVER_TIMEZONE = "UTC";

/**
 * The zone a stored GuildConfig.timezone names, or UTC when it is missing or no
 * real IANA zone. Every reader goes through this, because the row is written by a
 * select today but a hand edited or older row could hold anything, and a bad zone
 * would make Intl throw in the middle of a scheduler.
 */
export function resolveServerTimezone(stored: unknown): string {
	if (typeof stored !== "string" || stored.length === 0) return DEFAULT_SERVER_TIMEZONE;
	return isValidTimezone(stored) ? stored : DEFAULT_SERVER_TIMEZONE;
}

// ── COMMON_TIMEZONES ──────────────────────────────────────────
// What:  curated short-list of timezone names surfaced first in
//        autocomplete. Players cluster heavily in NA + EU + a few
//        APAC zones; the long tail of Intl.supportedValuesOf is
//        too noisy to be the default ranking.
// Who:   /events stream weekly's timezone autocomplete. Falls through to
//        Intl.supportedValuesOf for users who type something not
//        in this list.
// Where: "UTC" first because it's the safe default if a streamer
//        doesn't care, and several KvK alliance leads run their
//        schedules in UTC anyway.
export const COMMON_TIMEZONES = [
	"UTC",
	"America/New_York",
	"America/Chicago",
	"America/Denver",
	"America/Los_Angeles",
	"America/Phoenix",
	"America/Anchorage",
	"Pacific/Honolulu",
	"America/Toronto",
	"America/Vancouver",
	"America/Mexico_City",
	"America/Sao_Paulo",
	"America/Argentina/Buenos_Aires",
	"Europe/London",
	"Europe/Dublin",
	"Europe/Paris",
	"Europe/Berlin",
	"Europe/Madrid",
	"Europe/Rome",
	"Europe/Amsterdam",
	"Europe/Stockholm",
	"Europe/Athens",
	"Europe/Moscow",
	"Asia/Tokyo",
	"Asia/Shanghai",
	"Asia/Hong_Kong",
	"Asia/Singapore",
	"Asia/Seoul",
	"Asia/Manila",
	"Asia/Bangkok",
	"Asia/Kolkata",
	"Asia/Dubai",
	"Asia/Jerusalem",
	"Australia/Sydney",
	"Australia/Melbourne",
	"Australia/Perth",
	"Pacific/Auckland",
	"Africa/Cairo",
	"Africa/Lagos",
	"Africa/Johannesburg",
] as const;

// ── timezone select options ─────────────────────────────────────────
// What:  the curated 25 IANA zones surfaced in the post-modal timezone
//        dropdown. Discord caps StringSelectMenu at 25 options, so this
//        list is the entire surface, no "Other" fallback. UTC sits
//        first as the safe default for editors who do not want to think
//        about zones; the rest are ranked by ROK player concentration
//        (heavy NA + EU, plus the major APAC and one each Mexico /
//        Brazil / Sydney for the long tail).
// Who:   the decree editor's timezone prompt (features/schedule/
//        decreeEditHandlers.ts, after a time of day was typed in its
//        modal) and 🛠️server-config's Server timezone step (features/setup/
//        headquartersSteps.ts, 2026-10 item 263 Phase 4c). Each option's
//        `value` MUST be a valid IANA name because both pass it straight
//        to localTimeToUtc, which trusts the input.
// When:  static. If a future ROK community adds a zone we do not cover,
//        edit this list AND the same change in tzParser COMMON_TIMEZONES
//        so the autocomplete and the dropdown stay in sync.
// Where: here beside COMMON_TIMEZONES since its second use (platform rule
//        17), so both dropdowns offer one list. Its order may still differ
//        from the autocomplete ranking: a dropdown sees only 25 options,
//        autocomplete can page through the full set.
// How:   `label` is what Discord shows the user (max 100 chars, friendly
//        names). `value` is the IANA identifier sent back to the bot.
//        `description` repeats the IANA name as a small subtitle so users
//        can verify the zone they picked.
export const TIMEZONE_OPTIONS: ReadonlyArray<{ label: string; value: string; description: string }> = [
	{ label: "UTC", value: "UTC", description: "Coordinated Universal Time" },
	{ label: "Eastern Time (US)", value: "America/New_York", description: "America/New_York" },
	{ label: "Central Time (US)", value: "America/Chicago", description: "America/Chicago" },
	{ label: "Mountain Time (US)", value: "America/Denver", description: "America/Denver" },
	{ label: "Pacific Time (US)", value: "America/Los_Angeles", description: "America/Los_Angeles" },
	{ label: "Arizona", value: "America/Phoenix", description: "America/Phoenix" },
	{ label: "Alaska", value: "America/Anchorage", description: "America/Anchorage" },
	{ label: "Hawaii", value: "Pacific/Honolulu", description: "Pacific/Honolulu" },
	{ label: "Toronto", value: "America/Toronto", description: "America/Toronto" },
	{ label: "Mexico City", value: "America/Mexico_City", description: "America/Mexico_City" },
	{ label: "São Paulo", value: "America/Sao_Paulo", description: "America/Sao_Paulo" },
	{ label: "London", value: "Europe/London", description: "Europe/London" },
	{ label: "Paris", value: "Europe/Paris", description: "Europe/Paris" },
	{ label: "Berlin", value: "Europe/Berlin", description: "Europe/Berlin" },
	{ label: "Madrid", value: "Europe/Madrid", description: "Europe/Madrid" },
	{ label: "Rome", value: "Europe/Rome", description: "Europe/Rome" },
	{ label: "Athens", value: "Europe/Athens", description: "Europe/Athens" },
	{ label: "Moscow", value: "Europe/Moscow", description: "Europe/Moscow" },
	{ label: "Tokyo", value: "Asia/Tokyo", description: "Asia/Tokyo" },
	{ label: "Shanghai", value: "Asia/Shanghai", description: "Asia/Shanghai" },
	{ label: "Hong Kong", value: "Asia/Hong_Kong", description: "Asia/Hong_Kong" },
	{ label: "Singapore", value: "Asia/Singapore", description: "Asia/Singapore" },
	{ label: "Manila", value: "Asia/Manila", description: "Asia/Manila" },
	{ label: "Kolkata (IST)", value: "Asia/Kolkata", description: "Asia/Kolkata" },
	{ label: "Sydney", value: "Australia/Sydney", description: "Australia/Sydney" },
];

// ── searchTimezones ───────────────────────────────────────────
// What:  return up to `limit` timezone names matching the user's
//        typed-so-far string, ranked by COMMON_TIMEZONES first
//        then the full Intl.supportedValuesOf list.
// Who:   timezoneChoices in features/schedule/configureStreamSchedule.ts,
//        which answers /events stream weekly's timezone autocomplete.
// When:  per keystroke, Discord's autocomplete fires every time
//        the user changes the input.
// Where: keep the full-list fallback inside this helper so the
//        command file stays terse. Uses Intl.supportedValuesOf
//        when available (Node 18+); otherwise just the curated
//        list. Match is case-insensitive and tests substring,
//        not prefix, so a user typing "york" finds
//        "America/New_York".
// How:   ① lowercase the query.
//        ② filter the curated common list.
//        ③ if result count < limit and a full list is available,
//          append matching tail entries (deduped) up to limit.
//        ④ slice to limit. Discord caps autocomplete responses at
//          25 entries; pass limit=25 from the caller.
export function searchTimezones(query: string, limit: number): string[] {
	const q = query.toLowerCase().trim();
	const matchesCommon = COMMON_TIMEZONES.filter((tz) => tz.toLowerCase().includes(q));

	if (matchesCommon.length >= limit) {
		return matchesCommon.slice(0, limit);
	}

	// Pull from the full Intl list for the long tail. supportedValuesOf
	// is Node 18+; older runtimes return undefined and we just stick
	// with the curated list.
	let allZones: readonly string[] = [];
	if (typeof Intl.supportedValuesOf === "function") {
		allZones = Intl.supportedValuesOf("timeZone");
	}

	const seen = new Set<string>(matchesCommon);
	const tail: string[] = [];
	for (const tz of allZones) {
		if (seen.has(tz)) continue;
		if (tz.toLowerCase().includes(q)) {
			tail.push(tz);
			if (matchesCommon.length + tail.length >= limit) break;
		}
	}

	return [...matchesCommon, ...tail].slice(0, limit);
}
