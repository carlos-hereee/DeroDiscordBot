// ── mapWithConcurrency ───────────────────────────────────────────────
// What:  bounded-concurrency async map. Runs `worker` over `items` with at
//        most `limit` promises in flight at once, preserving result order so
//        the returned array lines up index-for-index with the input.
// Who:   anywhere a naive Promise.all(items.map(...)) would fan out one
//        in-flight operation per item with no ceiling. The reminder scheduler
//        is the first caller: at thousands of guilds an unbounded
//        Promise.all would open thousands of simultaneous DB (or HTTP, under
//        USE_REMOTE_EVENTS) calls in a single cron tick, pile up against the
//        connection pool / Heroku, and blow the 60s tick budget.
// When:  per call. Pure utility, no Discord or DB imports.
// Where: pairs with the overlapping-tick guard in ReminderScheduler, the
//        guard stops ticks from overlapping, this keeps a single tick from
//        saturating downstream services.
// How:   spin up `limit` worker loops that pull the next index off a shared
//        cursor until the list is exhausted. A worker that throws rejects the
//        whole call (same semantics as Promise.all); callers that need
//        per-item isolation should try/catch inside their worker and return a
//        result object, which is exactly what the scheduler does.
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	if (items.length === 0) return [];
	const effectiveLimit = Math.max(1, Math.min(limit, items.length));
	const results = new Array<R>(items.length);
	let cursor = 0;
	const runners = Array.from({ length: effectiveLimit }, async () => {
		// Each runner races to claim the next index off the shared cursor.
		// The post-increment is safe without a lock because JS is single
		// threaded, only one runner observes any given value of cursor.
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}
