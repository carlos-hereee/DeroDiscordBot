// ── withoutMongoKeys ──
// What:  a lean row as the dashboard reads it, without Mongo's _id and __v (2026-11 item 388
//        Phase 5a). Who: api/routes/meetings.routes.ts and api/routes/todos.routes.ts.

/** `row` without `_id` and `__v`, every other field kept. */
export function withoutMongoKeys<T extends object>(row: T): T {
	const { _id: _ignoredId, __v: _ignoredVersion, ...rest } = row as T & { _id?: unknown; __v?: unknown };
	return rest as T;
}
