import { createHash } from "node:crypto";
import { getObjectBytes, putObject } from "@utils/aws/index.js";
import { discordBotS3Enabled } from "@utils/config.js";

// ── renderer S3 store ────────────────────────────────────────────────
// Where rendered cards live in S3, and the read and write the card cache makes
// against them. It shapes each key, and it never throws and never draws: with
// DISCORD_BOT_S3_ENABLED off (every dev session) it sends nothing, and a call
// that fails answers a miss, so the card renders on demand either way.
// cardCache.ts is its only caller; renderCard also uses the two key helpers.

export const RENDER_KEY_PREFIX = "discord-bot/renders";

// A kind is a lowercase slug because it becomes a folder in the key: a slash or
// a dot here could climb out of discord-bot/renders/ into objects that belong
// to nexious-server on the same bucket.
const RENDER_KIND_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RENDER_HASH_PATTERN = /^[a-f0-9]{64}$/;

const RENDER_CONTENT_TYPE = "image/png";
// Every key carries its renderer's version and a hash of its input, so the bytes
// behind a key never change and may be cached for good (a year is the HTTP max).
const RENDER_CACHE_CONTROL = "public, max-age=31536000, immutable";

// The read sits on a card's render path, before the draw. A card draws in tens of
// milliseconds, so waiting on a slow S3 longer than this costs more than drawing.
export const RENDER_S3_READ_TIMEOUT_MS = 1_500;

/** Whether rendered cards are read from and written to S3 in this process. */
export function isRenderStoreEnabled(): boolean {
	return discordBotS3Enabled;
}

/**
 * The full S3 key for one rendered card: `discord-bot/renders/<kind>/<version>/<inputHash>.png`.
 * `version` is the integer each renderer bakes in and bumps whenever its drawing
 * changes, which moves every card it draws to new keys and so retires the old
 * cache without deleting anything. Throws on a malformed part, which is a bug in
 * the calling renderer rather than a runtime condition.
 */
export function buildRenderKey(kind: string, version: number, inputHash: string): string {
	if (!RENDER_KIND_PATTERN.test(kind)) throw new Error(`Render kind "${kind}" must be a lowercase slug such as "level-up"`);
	if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Render version for "${kind}" must be a positive integer, got ${version}`);
	if (!RENDER_HASH_PATTERN.test(inputHash)) throw new Error(`Render input hash for "${kind}" must be 64 lowercase hex characters`);
	return `${RENDER_KEY_PREFIX}/${kind}/${version}/${inputHash}.png`;
}

/**
 * A sha256 of a renderer's input that depends on its values, not on the order
 * its object keys were written in, so the same view model always lands on the
 * same key. Plain data only, which is what a view model is: a Date hashes as its
 * ISO string, an undefined field is skipped the way JSON.stringify skips it, and
 * anything a hash cannot read faithfully throws a TypeError rather than
 * colliding (renderCard turns that throw into the text embed).
 */
export function hashRenderInput(input: unknown): string {
	return createHash("sha256").update(stableSerialize(input)).digest("hex");
}

function stableSerialize(value: unknown): string {
	if (value === undefined || value === null) return "null";
	if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		// JSON writes NaN and Infinity as null, so they would share a key with null.
		if (!Number.isFinite(value)) throw new TypeError(`Render input holds ${value}, which hashes the same as null`);
		return JSON.stringify(value);
	}
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (isPlainObject(value)) {
		const fields = Object.entries(value)
			.filter(([, field]) => field !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : 1))
			.map(([name, field]) => `${JSON.stringify(name)}:${stableSerialize(field)}`);
		return `{${fields.join(",")}}`;
	}
	// A Map, a Set, a discord.js Collection or a class instance has no own
	// enumerable fields to read, so every one of them would hash as {} and two
	// different inputs would be served the same cached card.
	throw new TypeError(`Render input holds ${Object.prototype.toString.call(value)}, which hashRenderInput cannot read; pass plain data`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** A stored card's PNG, or null on a miss, with S3 switched off, or when the read fails or runs past its budget. Never throws. */
export async function readStoredRender(key: string): Promise<Buffer | null> {
	if (!isRenderStoreEnabled()) return null;
	try {
		return await getObjectBytes(key, { timeoutMs: RENDER_S3_READ_TIMEOUT_MS });
	} catch (error) {
		console.warn(`[canvas-renderer] the S3 read of ${key} failed, so this card renders on demand`, error);
		return null;
	}
}

/** Stores a freshly drawn card's PNG. Never throws: a failed upload only means the next request draws it again. */
export async function writeStoredRender(key: string, png: Buffer): Promise<void> {
	if (!isRenderStoreEnabled()) return;
	try {
		await putObject({ key, body: png, contentType: RENDER_CONTENT_TYPE, cacheControl: RENDER_CACHE_CONTROL });
	} catch (error) {
		console.warn(`[canvas-renderer] the S3 write of ${key} failed; the card was still posted and its next request draws it again`, error);
	}
}
