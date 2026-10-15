import { describe, it, expect } from "vitest";
import { ClipCache, clipKey } from "./clipCache.js";
import type { TtsClip } from "./ttsProvider.js";

// ── clip cache ─────────────────────────────────────────────────────────────
// A hit skips the meter and the provider, so the two things that matter are
// that the bounds hold and that the key can never replay the wrong clip.

const clipOf = (size: number): TtsClip => ({ bytes: Buffer.alloc(size), format: "mp3" });

describe("clipKey", () => {
	const base = clipKey("voiceAAAAAAAAAA", "eleven_flash_v2_5", "mp3", "Hello there.");

	it("is stable for the same inputs", () => {
		expect(clipKey("voiceAAAAAAAAAA", "eleven_flash_v2_5", "mp3", "Hello there.")).toBe(base);
	});

	it("changes with the voice, the model, the format and the text", () => {
		expect(clipKey("voiceBBBBBBBBBB", "eleven_flash_v2_5", "mp3", "Hello there.")).not.toBe(base);
		expect(clipKey("voiceAAAAAAAAAA", "eleven_multilingual_v2", "mp3", "Hello there.")).not.toBe(base);
		expect(clipKey("voiceAAAAAAAAAA", "eleven_flash_v2_5", "pcm24k", "Hello there.")).not.toBe(base);
		expect(clipKey("voiceAAAAAAAAAA", "eleven_flash_v2_5", "mp3", "Hello there!")).not.toBe(base);
	});

	it("does not let parts run together into the same key", () => {
		expect(clipKey("ab", "c", "mp3", "x")).not.toBe(clipKey("a", "bc", "mp3", "x"));
	});

	it("is a hash, so the text itself is not kept as the key", () => {
		expect(base).toMatch(/^[0-9a-f]{64}$/);
		expect(base).not.toContain("Hello");
	});
});

describe("ClipCache bounds", () => {
	it("evicts the least recently used entry when the entry bound is passed", () => {
		const cache = new ClipCache({ maxEntries: 2, maxBytes: 1000 });
		cache.set("a", clipOf(10));
		cache.set("b", clipOf(10));
		cache.set("c", clipOf(10));

		expect(cache.size).toBe(2);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBeDefined();
		expect(cache.get("c")).toBeDefined();
	});

	it("a read counts as use, so the touched entry survives the next eviction", () => {
		const cache = new ClipCache({ maxEntries: 2, maxBytes: 1000 });
		cache.set("a", clipOf(10));
		cache.set("b", clipOf(10));
		cache.get("a");
		cache.set("c", clipOf(10));

		expect(cache.get("a")).toBeDefined();
		expect(cache.get("b")).toBeUndefined();
	});

	it("evicts by bytes when the byte bound is passed before the entry bound", () => {
		const cache = new ClipCache({ maxEntries: 50, maxBytes: 100 });
		cache.set("a", clipOf(40));
		cache.set("b", clipOf(40));
		cache.set("c", clipOf(40));

		expect(cache.bytes).toBeLessThanOrEqual(100);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.size).toBe(2);
		expect(cache.bytes).toBe(80);
	});

	it("does not cache a clip larger than the whole byte budget", () => {
		const cache = new ClipCache({ maxEntries: 50, maxBytes: 100 });
		cache.set("small", clipOf(10));
		cache.set("huge", clipOf(101));

		expect(cache.get("huge")).toBeUndefined();
		expect(cache.get("small")).toBeDefined();
		expect(cache.bytes).toBe(10);
	});

	it("replacing a key keeps the byte count honest", () => {
		const cache = new ClipCache({ maxEntries: 50, maxBytes: 100 });
		cache.set("a", clipOf(30));
		cache.set("a", clipOf(50));

		expect(cache.size).toBe(1);
		expect(cache.bytes).toBe(50);
	});
});
