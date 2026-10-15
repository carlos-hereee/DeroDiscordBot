import { createHash } from "node:crypto";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { TtsClip, TtsFormat } from "./ttsProvider.js";

// ── clip cache ─────────────────────────────────────────────────────────────
// What:  a bounded, in memory, least recently used cache of rendered clips, so a
//        second Listen on the same post replays for free.
// Who:   listenHandler (and Phase 3's speaker). A hit skips the cooldowns, the
//        spend meter and the provider entirely.
// When:  lives for the process. A Railway deploy empties it, by design: it is a
//        cost saver, not a store, and NOTHING here is ever written to disk.
// Where: the key is a sha256 over the voice id, the model, the format and the
//        text, so a voice change, a model change or a format change can never
//        replay a stale clip, and the text itself is not kept as a key.
// How:   a Map iterates in insertion order, so deleting and re-inserting on every
//        read keeps the least recently used entry first. Inserts evict from the
//        front until both the entry bound and the byte bound hold.

export interface ClipCacheOptions {
	maxEntries?: number;
	maxBytes?: number;
}

// A separator no voice id, model id or format string can contain, so the four
// parts cannot run together into a colliding key ("ab" + "c" vs "a" + "bc").
const KEY_SEPARATOR = "\u0000";

export function clipKey(voiceId: string, modelId: string, format: TtsFormat, text: string): string {
	return createHash("sha256").update([voiceId, modelId, format, text].join(KEY_SEPARATOR)).digest("hex");
}

export class ClipCache {
	private readonly entries = new Map<string, TtsClip>();
	private totalBytes = 0;
	private readonly maxEntries: number;
	private readonly maxBytes: number;

	constructor(options: ClipCacheOptions = {}) {
		this.maxEntries = options.maxEntries ?? BOT_CONSTANTS.DERO_VOICE_CLIP_CACHE_MAX_ENTRIES;
		this.maxBytes = options.maxBytes ?? BOT_CONSTANTS.DERO_VOICE_CLIP_CACHE_MAX_BYTES;
	}

	get size(): number {
		return this.entries.size;
	}

	get bytes(): number {
		return this.totalBytes;
	}

	get(key: string): TtsClip | undefined {
		const clip = this.entries.get(key);
		if (!clip) return undefined;
		// Touch: move to the back of the iteration order (most recently used).
		this.entries.delete(key);
		this.entries.set(key, clip);
		return clip;
	}

	set(key: string, clip: TtsClip): void {
		// A clip bigger than the whole budget would evict everything and still not
		// fit, so it is simply not cached.
		if (clip.bytes.length > this.maxBytes) return;

		const existing = this.entries.get(key);
		if (existing) {
			this.entries.delete(key);
			this.totalBytes -= existing.bytes.length;
		}
		this.entries.set(key, clip);
		this.totalBytes += clip.bytes.length;

		for (const [oldestKey, oldest] of this.entries) {
			if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) break;
			this.entries.delete(oldestKey);
			this.totalBytes -= oldest.bytes.length;
		}
	}
}

// The process wide cache the Listen handler reads.
export const clipCache = new ClipCache();
