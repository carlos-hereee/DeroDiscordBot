// ── drainWithin ─────────────────────────────────────────────────────────────
// What:  waits for work already under way, at most so long (2026-11 item 420).
// Who:   main.ts's shutdown (meeting ends and the reminder sweep), meetingLifecycle's delete and
//        wipe (the end they interrupt).
// Does NOT: start, cancel or fail anything. Work the bound cuts goes on, and the caller decides
//        what finishes it later (a meeting's is the repair pass).

/** True when all of `work` ended, well or badly, inside `boundMs`; false when the bound came first. */
export async function drainWithin(work: readonly (Promise<unknown> | null | undefined)[], boundMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Not unref'd: the wait is the point, and the timer is cleared the moment the work ends.
	const bound = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), boundMs)));
	const drained = Promise.allSettled(work).then(() => true);
	try {
		return await Promise.race([drained, bound]);
	}
	finally {
		clearTimeout(timer);
	}
}
