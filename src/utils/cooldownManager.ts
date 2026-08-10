// ── CooldownManager ───────────────────────────────────────────────────────
// Generic in-memory per-key cooldown. The bot had per-guild and per-guild+event
// cooldowns inlined in individual route handlers but no reusable per-user
// helper; /fortune needs one, so it is extracted here for reuse. State is a
// plain Map at instance scope, fine for a single-process bot; it would only
// need Redis if the bot ever ran multiple processes.
//
// `now` is injectable so callers (and tests) control the clock; production
// passes the default Date.now().

export class CooldownManager {
	private readonly lastUsed = new Map<string, number>();

	constructor(private readonly windowMs: number) {}

	// Read-only check. It does NOT record, callers record() only AFTER the
	// guarded action succeeds, so a failed action never burns the user's window.
	check(key: string, now: number = Date.now()): { onCooldown: boolean; remainingMs: number } {
		const last = this.lastUsed.get(key);
		if (last === undefined) return { onCooldown: false, remainingMs: 0 };
		const elapsed = now - last;
		if (elapsed >= this.windowMs) return { onCooldown: false, remainingMs: 0 };
		return { onCooldown: true, remainingMs: this.windowMs - elapsed };
	}

	record(key: string, now: number = Date.now()): void {
		this.lastUsed.set(key, now);
	}
}
