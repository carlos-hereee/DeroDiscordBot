// ── lruCache ─────────────────────────────────────────────────────────
// A capped least recently used cache over a plain Map, shared by the avatar
// cache and the card cache so the renderer's memory stays bounded on Railway's
// dyno (2026-10 item 243, risk R5). It only holds values; fetching, decoding and
// S3 belong to its callers.
//
// A Map iterates in insertion order, so moving a key to the back on every read
// keeps the least recently used key at the front, where eviction takes it. That
// is the whole algorithm, which is why no third party package is needed.

export class LruCache<Key, Value> {
	private readonly entries = new Map<Key, Value>();

	constructor(readonly capacity: number) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) {
			throw new RangeError(`LruCache capacity must be a positive integer, got ${capacity}`);
		}
	}

	get size(): number {
		return this.entries.size;
	}

	/**
	 * The value stored for `key`, now marked most recently used, or undefined on
	 * a miss. Callers never store undefined, so undefined always means a miss.
	 */
	get(key: Key): Value | undefined {
		const value = this.entries.get(key);
		if (value === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	/** Stores `value` as the most recently used entry, evicting the least recently used one once past capacity. */
	set(key: Key, value: Value): void {
		this.entries.delete(key);
		this.entries.set(key, value);
		if (this.entries.size <= this.capacity) return;
		const oldest = this.entries.keys().next();
		if (!oldest.done) this.entries.delete(oldest.value);
	}

	delete(key: Key): boolean {
		return this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}
}
