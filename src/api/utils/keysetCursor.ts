import type { KeysetBound } from "@db/stores/keysetBound.js";

// ── keysetCursor ────────────────────────────────────────────────────────────
// What:  the dashboard list paging shared by /api/meetings and /api/todos (2026-11 item 388
//        Phase 5a): the clamped page size and the opaque cursor naming the last row shown.
// Who:   api/routes/meetings.routes.ts and api/routes/todos.routes.ts.
// How:   a cursor is "<createdAt ISO>~<id>", newest first. The id breaks a tie between rows
//        created in the same millisecond, which a date alone would skip. Keyset rather than
//        skip and limit, because skip rescans every earlier row on each page (the reason
//        gameRooms.routes.ts pages by endedAt).

/** Rows on a page when the caller asks for none, and the most it may ask for (gameRooms.routes.ts uses the same pair). */
export const LIST_DEFAULT_LIMIT = 25;
export const LIST_MAX_LIMIT = 100;
const SEPARATOR = "~";

/** The page size: clamped to 1 to LIST_MAX_LIMIT, LIST_DEFAULT_LIMIT when absent or unreadable. */
export function clampLimit(raw: unknown): number {
	const requested = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(requested) ? Math.min(Math.max(requested, 1), LIST_MAX_LIMIT) : LIST_DEFAULT_LIMIT;
}

/**
 * The bound a cursor names, or null for none. An unreadable cursor reads as none rather than
 * a 400: a stale bookmark then shows page one again instead of an error.
 */
export function parseCursor(raw: unknown): KeysetBound | null {
	if (typeof raw !== "string") return null;
	const at = raw.lastIndexOf(SEPARATOR);
	if (at <= 0 || at === raw.length - 1) return null;
	const createdAt = new Date(raw.slice(0, at));
	if (Number.isNaN(createdAt.getTime())) return null;
	return { createdAt, id: raw.slice(at + 1) };
}

/** The cursor for the page after `rows`, or null when this page was the last. */
export function nextCursor<T>(rows: readonly T[], limit: number, boundOf: (row: T) => { createdAt?: Date; id: string }): string | null {
	const last = rows.length === limit ? rows[rows.length - 1] : undefined;
	if (!last) return null;
	const { createdAt, id } = boundOf(last);
	return createdAt ? `${new Date(createdAt).toISOString()}${SEPARATOR}${id}` : null;
}
