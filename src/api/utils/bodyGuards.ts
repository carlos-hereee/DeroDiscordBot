import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── bodyGuards ──────────────────────────────────────────────────────────────
// What:  the hand written checks a dashboard write body passes before any feature runs
//        (2026-11 item 388 Phase 5a). The bot has no zod, so these are the strict schema:
//        a body is a plain object holding only known keys, and each value has its type.
// Who:   api/routes/meetings.routes.ts and api/routes/todos.routes.ts.
// Does NOT: check lengths or times against the features' rules; the feature functions do,
//        so a dashboard write and a Discord press are held to one rule.

/** A JSON object body, not an array or a primitive. */
export type Body = Record<string, unknown>;

/** The body when it is a plain object whose every key is in `allowed`, else null (an extra key is a 400). */
export function strictBody(raw: unknown, allowed: readonly string[]): Body | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const body = raw as Body;
	return Object.keys(body).every((key) => allowed.includes(key)) ? body : null;
}

/** A Discord user id: the snowflake shape the brain's parser checks too. */
export function isSnowflake(value: unknown): value is string {
	return typeof value === "string" && BOT_CONSTANTS.DASHBOARD.SNOWFLAKE_PATTERN.test(value);
}

/**
 * A date sent as an ISO string. Undefined when the key is absent, null when it was sent as
 * null (cleared), and "invalid" for anything else that does not read as a date.
 */
export function readOptionalDate(body: Body, key: string): Date | null | undefined | "invalid" {
	if (!(key in body)) return undefined;
	const value = body[key];
	if (value === null) return null;
	if (typeof value !== "string") return "invalid";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "invalid" : date;
}

/** True when `at` is in the future and no further ahead than a reminder may be set. */
export function isSchedulableTime(at: Date, now: Date = new Date()): boolean {
	const ahead = at.getTime() - now.getTime();
	return ahead > 0 && ahead <= BOT_CONSTANTS.REMINDERS.MAX_AHEAD_MS;
}
