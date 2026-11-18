// ── pendingByMember ──────────────────────────────────────────────────
// What:  one keyed store for the picks a modal Submit leaves waiting for that same
//        member's Confirm: remember, read and take, keyed guildId:userId, each entry
//        expiring after the store's own window (2026-11 item 367, owner decision D2).
//        Also the one home of MODAL_TIMEOUT_MS, how long a flow's awaitModalSubmit waits.
// Who:   onboardingChannelGap today. enableCommunity, configureOnboarding,
//        promptEditModal and dero-brain/holdemRequests still keep copies of their own,
//        logged in TECH_DEBT to move here in a later pass.
// When:  on a modal Submit (remember), a review control (read), and a Confirm (take).
// How:   a Map per store. Expired entries are swept on every write, so a store never
//        holds picks nobody will confirm and needs no timer of its own. Memory only,
//        so a restart drops every entry and the flow answers "expired".

/** How long a flow's modal waits for its Submit. A Submit after it is not heard and changes nothing. */
export const MODAL_TIMEOUT_MS = 10 * 60_000;

/** One held value and the moment it stops counting. */
export interface IPendingEntry<T> {
	value: T;
	expiresAt: number;
}

/** A store of one flow's pending picks, keyed by guild and member. */
export interface IPendingByMemberStore<T> {
	/** Hold the value for this member, replacing any earlier one. `expiresAt` keeps an entry's original deadline when picks go back after a refusal. */
	remember(guildId: string, userId: string, value: T, expiresAt?: number): void;
	/** The live value, left in place (a review control that redraws reads it). */
	read(guildId: string, userId: string): T | null;
	/** The live entry, removed: a double press of Confirm finds nothing the second time, so one set of picks writes once. */
	take(guildId: string, userId: string): IPendingEntry<T> | null;
	/** Drop the member's entry (Cancel). */
	forget(guildId: string, userId: string): void;
}

const memberKey = (guildId: string, userId: string): string => `${guildId}:${userId}`;

/** A new store whose entries live `ttlMs` from the write that made them. */
export function createPendingByMember<T>(ttlMs: number): IPendingByMemberStore<T> {
	const entries = new Map<string, IPendingEntry<T>>();

	const live = (key: string): IPendingEntry<T> | null => {
		const entry = entries.get(key);
		return entry && entry.expiresAt > Date.now() ? entry : null;
	};

	return {
		remember(guildId, userId, value, expiresAt) {
			const now = Date.now();
			for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
			entries.set(memberKey(guildId, userId), { value, expiresAt: expiresAt ?? now + ttlMs });
		},
		read(guildId, userId) {
			return live(memberKey(guildId, userId))?.value ?? null;
		},
		take(guildId, userId) {
			const key = memberKey(guildId, userId);
			const entry = live(key);
			entries.delete(key);
			return entry;
		},
		forget(guildId, userId) {
			entries.delete(memberKey(guildId, userId));
		},
	};
}
