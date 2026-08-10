import { serverApi, ServerUnreachableError } from "@utils/serverApi.js";

// ── remoteEventStore ──
// What: adapter that exposes the same shape as the local eventStore but reads and
//   writes from the nexious-server's /api/events surface. The bot's Future-A data
//   source; the local Mongoose-backed eventStore is the legacy source kept for
//   rollback safety.
// Who: called by db/stores/eventStore.ts when USE_REMOTE_EVENTS is on. Slash commands
//   and the scheduler still import the original eventStore module, they never see
//   the remote/local distinction.
// When: every event read or write while the remote flag is on. Reads go through a
//   60-second in-process cache so the cron tick (which scans all events every minute)
//   does not slam the Heroku server.
// Where: pure HTTP. No Mongo connection. Survives a local DB outage.
// How:
//   ① All requests carry a guildId query param so the server can scope by guild and
//      apply HMAC verification (signature alone is not enough, the server checks
//      the guild belongs to an installed app).
//   ② Reads use an in-process cache keyed by (operation, guildId, eventId). Writes
//      invalidate the cache for that guild. Cache TTL is 60s, same window the cron
//      tick uses, so a freshly-written event is visible to the next tick.
//   ③ Server failures fall through to the caller as ServerUnreachableError. Reads
//      that match a not-yet-expired cache entry succeed even when the server is down,
//      bridging brief outages without a separate fallback path.

// Wire shape returned by the server. Mirrors features/events/eventStore.ts toBotDTO.
// Keep these field names aligned with the local Event mongoose model so consumers
// (slash commands, ScheduleBoard) work unchanged.
export interface RemoteEvent {
	eventId: string;
	guildId: string;
	name: string;
	description: string;
	// public https image URL or null. Carried verbatim through hydrate (it is a
	// string, not a date) so consumers read the same imageUrl under the remote
	// path as under the local Mongoose path. RemoteEventHydrated inherits it
	// because it is not in the Omit list below.
	imageUrl: string | null;
	type: "recurring" | "one-time";
	intervalHours: number;
	firstOccurrence: string;
	seasonEnd: string | null;
	reminderOffsets: number[];
	prepSteps: { id: string; label: string; order: number }[];
	mentionRoleId: string | null;
	paused: boolean;
	pausedUntil: string | null;
	active: boolean;
	createdAt: string;
	updatedAt: string;
}

// Local document parity: hydrate string dates back into Date objects so callers see
// the same shape as `EventModel.findOne(...)`. Without this, `new Date(event.firstOccurrence)`
// would be required at every call site, which would diverge from the local-store
// behavior and make the flag-based delegation visible in business logic.
export interface RemoteEventHydrated extends Omit<RemoteEvent, "firstOccurrence" | "seasonEnd" | "pausedUntil" | "createdAt" | "updatedAt"> {
	firstOccurrence: Date;
	seasonEnd: Date | null;
	pausedUntil: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

const hydrate = (e: RemoteEvent): RemoteEventHydrated => ({
	...e,
	firstOccurrence: new Date(e.firstOccurrence),
	seasonEnd: e.seasonEnd ? new Date(e.seasonEnd) : null,
	pausedUntil: e.pausedUntil ? new Date(e.pausedUntil) : null,
	createdAt: new Date(e.createdAt),
	updatedAt: new Date(e.updatedAt),
});

// ── In-process cache ──
// Keyed by guildId for list reads, and by eventId for single-event reads. Map values
// hold both the result and the timestamp so we can age entries off without a sweeper.
const TTL_MS = 60_000;
interface CacheEntry<T> {
	value: T;
	ts: number;
}
const listCache = new Map<string, CacheEntry<RemoteEventHydrated[]>>();
const itemCache = new Map<string, CacheEntry<RemoteEventHydrated>>();

// Plain boolean (no type predicate). A predicate would narrow `cached` to
// `undefined` in the false branch, and the catch-block fallback `if (cached)`
// would then collapse to `never`. Returning a bare boolean keeps the original
// `CacheEntry<T> | undefined` type intact across the function body so the
// stale-cache fallback can still read `cached.value`.
const isFresh = <T>(entry: CacheEntry<T> | undefined): boolean => {
	if (!entry) return false;
	return Date.now() - entry.ts < TTL_MS;
};

// Invalidate the list cache for one guild after a write so the next read sees the change.
// We deliberately do NOT invalidate item caches granularly, the next request will refetch
// after TTL anyway, and stale-but-not-very-stale single-event data is acceptable for the
// 60s window (consistent with the cron-tick window).
const invalidateGuild = (guildId: string): void => {
	listCache.delete(guildId);
};

export const remoteEventStore = {
	// findAll is a global scan used by the scheduler. The local store does this in one
	// query; the remote API requires a guildId, so we cannot offer a true global findAll
	// across guilds. Callers that hit this path must be refactored to pass guildId.
	// Throws so a missed call site fails loudly instead of silently returning [].
	async findAll(): Promise<RemoteEventHydrated[]> {
		throw new Error(
			"remoteEventStore.findAll() is not supported, pass a guildId via findByGuildId(). " +
				"The scheduler must iterate guilds and call findByGuildId per guild."
		);
	},

	async findById(eventId: string): Promise<RemoteEventHydrated | null> {
		// Item cache short-circuit. Only used after a fresh write or read in the same
		// 60s window, the cache is per-event so single-event lookups don't pre-warm
		// from the list endpoint (different shape, different fields surfaced).
		const cached = itemCache.get(eventId);
		// Explicit `cached &&` narrows to non-undefined for the early return; isFresh
		// is a plain boolean now (see comment on the helper) so without this check
		// TS would complain about possibly-undefined.value.
		if (cached && isFresh(cached)) return cached.value;

		// We need a guildId to satisfy the server's HMAC + ownership checks, but the bot's
		// /admin/leaderboard.ts and /reminders/:eventId routes call findById without
		// guildId in scope. The server defends against cross-guild leakage server-side, so
		// we pass the empty guildId and let the server 400 us, caller catches and falls
		// back to local. This is a temporary bridge; the long-term fix is to thread guildId
		// through all call sites.
		try {
			// The server's allowBotOrUser requires a guildId on the bot path. Without one
			// we cannot route through the remote API; throw "unreachable" so the
			// flag-delegation in eventStore.ts falls back to the local Mongoose query.
			throw new Error("findById requires guildId; use findByIdInGuild instead");
		} catch (err) {
			throw new ServerUnreachableError(err);
		}
	},

	async findByIdInGuild(eventId: string, guildId: string): Promise<RemoteEventHydrated | null> {
		const key = `${guildId}::${eventId}`;
		const cached = itemCache.get(key);
		// Explicit `cached &&` narrows to non-undefined for the early return; isFresh
		// is a plain boolean now (see comment on the helper) so without this check
		// TS would complain about possibly-undefined.value.
		if (cached && isFresh(cached)) return cached.value;

		try {
			const result = await serverApi.get<{ event: RemoteEvent | null }>(
				`/api/events/${encodeURIComponent(eventId)}`,
				{ guildId, includeRetired: "1" }
			);
			if (!result?.event) return null;
			const hydrated = hydrate(result.event);
			itemCache.set(key, { value: hydrated, ts: Date.now() });
			return hydrated;
		} catch (err) {
			// Stale-but-cached fallback: if we still have a cached value, return it during
			// a brief outage. The scheduler (60s cadence) tolerates this; eventually the
			// cache TTL expires and the next call will surface the error.
			if (cached) return cached.value;
			throw err;
		}
	},

	async findByGuildId(guildId: string): Promise<RemoteEventHydrated[]> {
		const cached = listCache.get(guildId);
		// Explicit `cached &&` narrows to non-undefined for the early return; isFresh
		// is a plain boolean now (see comment on the helper) so without this check
		// TS would complain about possibly-undefined.value.
		if (cached && isFresh(cached)) return cached.value;

		try {
			const result = await serverApi.get<{ events: RemoteEvent[] }>("/api/events", { guildId });
			const events = (result?.events ?? []).map(hydrate);
			listCache.set(guildId, { value: events, ts: Date.now() });
			return events;
		} catch (err) {
			// Same stale-cache fallback as findByIdInGuild, let the scheduler keep firing
			// reminders during a brief Heroku blip. If the cache is empty, surface the
			// error so the caller can decide what to show the user (e.g. an embed warning
			// "the platform is unreachable, try again in a moment").
			if (cached) return cached.value;
			throw err;
		}
	},

	async create(data: {
		guildId: string;
		name: string;
		description?: string;
		type: "recurring" | "one-time";
		intervalHours?: number;
		firstOccurrence: Date | string;
		seasonEnd?: Date | string | null;
		reminderOffsets?: number[];
		prepSteps?: { id: string; label: string; order: number }[];
		mentionRoleId?: string | null;
		imageUrl?: string | null;
	}): Promise<RemoteEventHydrated> {
		// Normalize Date → ISO string so the wire payload is JSON-serializable and matches
		// the server's expected input shape.
		const body = {
			name: data.name,
			description: data.description ?? "",
			type: data.type,
			intervalHours: data.intervalHours ?? 0,
			firstOccurrence: data.firstOccurrence instanceof Date ? data.firstOccurrence.toISOString() : data.firstOccurrence,
			seasonEnd:
				data.seasonEnd === undefined || data.seasonEnd === null
					? null
					: data.seasonEnd instanceof Date
						? data.seasonEnd.toISOString()
						: data.seasonEnd,
			reminderOffsets: data.reminderOffsets ?? [30, 15],
			prepSteps: data.prepSteps ?? [],
			mentionRoleId: data.mentionRoleId ?? null,
			imageUrl: data.imageUrl ?? null,
		};
		const result = await serverApi.post<{ event: RemoteEvent }>("/api/events", body, { guildId: data.guildId });
		invalidateGuild(data.guildId);
		return hydrate(result.event);
	},

	async update(eventId: string, guildId: string, patch: Partial<{
		name: string;
		description: string;
		type: "recurring" | "one-time";
		intervalHours: number;
		firstOccurrence: Date | string;
		seasonEnd: Date | string | null;
		reminderOffsets: number[];
		prepSteps: { id: string; label: string; order: number }[];
		mentionRoleId: string | null;
		imageUrl: string | null;
		paused: boolean;
		pausedUntil: Date | string | null;
	}>): Promise<RemoteEventHydrated | null> {
		const body: Record<string, unknown> = { ...patch };
		if (patch.firstOccurrence instanceof Date) body.firstOccurrence = patch.firstOccurrence.toISOString();
		if (patch.seasonEnd instanceof Date) body.seasonEnd = patch.seasonEnd.toISOString();
		if (patch.pausedUntil instanceof Date) body.pausedUntil = patch.pausedUntil.toISOString();
		const result = await serverApi.patch<{ event: RemoteEvent }>(
			`/api/events/${encodeURIComponent(eventId)}`,
			body,
			{ guildId }
		);
		invalidateGuild(guildId);
		itemCache.delete(`${guildId}::${eventId}`);
		return result?.event ? hydrate(result.event) : null;
	},

	async delete(eventId: string, guildId: string): Promise<RemoteEventHydrated | null> {
		const result = await serverApi.delete<{ event: RemoteEvent }>(
			`/api/events/${encodeURIComponent(eventId)}`,
			{ guildId }
		);
		invalidateGuild(guildId);
		itemCache.delete(`${guildId}::${eventId}`);
		return result?.event ? hydrate(result.event) : null;
	},
};
