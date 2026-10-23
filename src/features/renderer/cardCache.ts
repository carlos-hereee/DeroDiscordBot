import { LruCache } from "./lruCache.js";
import { readStoredRender, writeStoredRender } from "./s3.js";

// ── cardCache ────────────────────────────────────────────────────────
// The two tier cache in front of every rendered card: the last 100 PNGs in
// memory, then S3 when DISCORD_BOT_S3_ENABLED is on. With S3 off the memory tier
// still runs, so a dev session repeats a card for free without any S3 traffic.
// It stores bytes and never draws; renderCard is its only caller.

// 2026-10 item 243 Assumptions: 100 card entries. A card PNG is tens to a few
// hundred KB, so a full cache stays in the tens of MB on Railway's dyno.
export const CARD_CACHE_CAPACITY = 100;

const memory = new LruCache<string, Buffer>(CARD_CACHE_CAPACITY);

/** The stored PNG for a render key, from memory first and then S3, or null when the card has to be drawn. Never throws. */
export async function readCachedCard(key: string): Promise<Buffer | null> {
	const inMemory = memory.get(key);
	if (inMemory) return inMemory;
	const stored = await readStoredRender(key);
	if (stored) memory.set(key, stored);
	return stored;
}

/**
 * Keeps a freshly drawn PNG in memory at once and writes it to S3. The write is
 * fire and forget for the caller: the card is ready to post, so a failed upload
 * only costs the next request a redraw, and the promise never rejects. It is
 * returned so a test can wait on the upload; renderCard does not.
 */
export function storeCard(key: string, png: Buffer): Promise<void> {
	memory.set(key, png);
	return writeStoredRender(key, png);
}

/** How many cards the memory tier holds, so a test can watch the cap. */
export function cachedCardCount(): number {
	return memory.size;
}

/** Forget every card in memory (S3 is untouched), so a test can start cold. */
export function clearCardCache(): void {
	memory.clear();
}
