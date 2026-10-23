import { get as httpsGet } from "node:https";
import type { ImageSize } from "discord.js";
import { canvasModule, type Image } from "./canvasModule.js";
import { LruCache } from "./lruCache.js";

// ── avatarCache ──────────────────────────────────────────────────────
// Fetches a member's Discord avatar and decodes it into a canvas Image, keeping
// the most recent 500 in memory so a board of familiar faces is not refetched on
// every redraw. It answers null whenever the picture cannot be had (a deleted
// account's 404, a CDN outage, a canvas library that did not load) and never
// throws; the card renderer draws its placeholder instead. Card renderers call
// fetchAvatar. Nothing here touches S3: a rendered card is cached whole, by
// cardCache, so its avatars never need storing on their own.

// 2026-10 item 243 Assumptions: 500 avatar entries, which bounds memory on
// Railway's dyno. A 256 pixel avatar can decode to as much as 256 KB of pixels,
// so a full cache at that size may hold up to about 128 MB; request the
// smallest size a card actually draws.
export const AVATAR_CACHE_CAPACITY = 500;

// Long enough for a slow CDN edge, short enough that a hung socket cannot hold a
// render (and the interaction waiting on it) past Discord's reply window.
const AVATAR_FETCH_TIMEOUT_MS = 5_000;

// Discord serves at most a 4096 pixel PNG, a few MB; anything past this is not an
// avatar, and stopping the download keeps one bad response from filling memory.
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

// Only the avatar routes on Discord's CDN, the three shapes displayAvatarURL
// builds: a user's avatar, a default avatar, and a member's per guild avatar. The
// URL comes from discord.js today, but this is what stops a future caller from
// turning the renderer into a fetch of an arbitrary attachment or address.
const DISCORD_AVATAR_HOST = "cdn.discordapp.com";
const DISCORD_AVATAR_PATH = /^\/(?:avatars\/\d+\/|embed\/avatars\/|guilds\/\d+\/users\/\d+\/avatars\/)/;

export interface AvatarRequest {
	/** The member's Discord snowflake. Not PII, and the cache key's first part. */
	userId: string;
	/** `user.avatar`, or null for a member on a default avatar. A new upload changes it, which is what busts the cache. */
	avatarHash: string | null;
	size: ImageSize;
	/** The URL to fetch, from `user.displayAvatarURL({ extension: "png", size })`, so the CDN shape lives in discord.js alone. */
	url: string;
}

type AvatarDownloader = (url: string) => Promise<Buffer | null>;
type AvatarDecoder = (bytes: Buffer) => Promise<Image>;

export interface AvatarCacheOptions {
	download: AvatarDownloader;
	/** Null when the canvas library did not load: every fetch then answers null without downloading. */
	decode: AvatarDecoder | null;
	capacity?: number;
}

export interface AvatarCache {
	fetch(request: AvatarRequest): Promise<Image | null>;
	clear(): void;
	readonly size: number;
}

/** The cache key for one avatar at one size: userId, avatar hash and size. */
export function avatarCacheKey({ userId, avatarHash, size }: Pick<AvatarRequest, "userId" | "avatarHash" | "size">): string {
	return `${userId}:${avatarHash ?? "default"}:${size}`;
}

/**
 * Builds an avatar cache around a downloader and a decoder. The bot uses the one
 * instance behind fetchAvatar; a test builds its own with fakes, so it can count
 * downloads without the network.
 */
export function createAvatarCache({ download, decode, capacity = AVATAR_CACHE_CAPACITY }: AvatarCacheOptions): AvatarCache {
	const images = new LruCache<string, Image>(capacity);
	// Two cards asking for the same face at once share one download rather than
	// racing two. Bounded by how many renders are in flight, so it needs no cap.
	const inFlight = new Map<string, Promise<Image | null>>();

	return {
		get size() {
			return images.size;
		},
		clear() {
			images.clear();
		},
		fetch(request) {
			if (!decode) return Promise.resolve(null);
			const key = avatarCacheKey(request);
			const cached = images.get(key);
			if (cached) return Promise.resolve(cached);
			const pending = inFlight.get(key);
			if (pending) return pending;

			// A miss (null) is not cached: a CDN blip should cost one placeholder,
			// not a placeholder until this entry happens to be evicted.
			const loading = loadAvatar(request, download, decode)
				.then((image) => {
					if (image) images.set(key, image);
					return image;
				})
				.finally(() => inFlight.delete(key));
			inFlight.set(key, loading);
			return loading;
		},
	};
}

async function loadAvatar(request: AvatarRequest, download: AvatarDownloader, decode: AvatarDecoder): Promise<Image | null> {
	if (!isDiscordAvatarUrl(request.url)) {
		console.warn(`[canvas-renderer] refused the avatar URL for user ${request.userId}: it is not an avatar route on Discord's CDN`);
		return null;
	}
	try {
		const bytes = await download(request.url);
		return bytes ? await decode(bytes) : null;
	} catch (error) {
		console.warn(`[canvas-renderer] the avatar for user ${request.userId} did not load, so the card draws its placeholder`, error);
		return null;
	}
}

function isDiscordAvatarUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" && parsed.hostname === DISCORD_AVATAR_HOST && DISCORD_AVATAR_PATH.test(parsed.pathname);
	} catch {
		return false;
	}
}

// Answers the body of a 200, or null for any other status (a deleted member's
// avatar is a 404). Rejects on a network error, a timeout or an oversized body,
// which loadAvatar turns into null.
function downloadOverHttps(url: string): Promise<Buffer | null> {
	return new Promise((resolve, reject) => {
		const request = httpsGet(url, { timeout: AVATAR_FETCH_TIMEOUT_MS }, (response) => {
			if (response.statusCode !== 200) {
				// Drain the body so the socket goes back to the pool instead of leaking.
				response.resume();
				resolve(null);
				return;
			}
			const chunks: Buffer[] = [];
			let received = 0;
			response.on("data", (chunk: Buffer) => {
				received += chunk.length;
				if (received > MAX_AVATAR_BYTES) {
					request.destroy(new Error(`avatar download passed ${MAX_AVATAR_BYTES} bytes`));
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => resolve(Buffer.concat(chunks)));
			response.on("error", reject);
		});
		request.on("timeout", () => request.destroy(new Error(`avatar download timed out after ${AVATAR_FETCH_TIMEOUT_MS} ms`)));
		request.on("error", reject);
	});
}

// Read once at module load, so the decoder below closes over a value that can
// no longer change (the import binding itself is not narrowed inside a closure).
const loadedCanvas = canvasModule;

const sharedAvatarCache = createAvatarCache({
	download: downloadOverHttps,
	decode: loadedCanvas ? (bytes) => loadedCanvas.loadImage(bytes) : null,
});

/**
 * The avatar request for one Discord user at one size, as a card's view model
 * carries it: plain data, so it hashes into the card key and a new upload (a new
 * avatar hash, a new URL) draws a new card. The CDN shape stays in discord.js.
 */
export function avatarRequestFor(
	user: { id: string; avatar: string | null; displayAvatarURL(options: { extension: "png"; size: ImageSize }): string },
	size: ImageSize
): AvatarRequest {
	return { userId: user.id, avatarHash: user.avatar, size, url: user.displayAvatarURL({ extension: "png", size }) };
}

/** A member's avatar as a canvas Image, from memory when it was fetched before, or null when it cannot be had. Never throws. */
export function fetchAvatar(request: AvatarRequest): Promise<Image | null> {
	return sharedAvatarCache.fetch(request);
}

/** Forget every cached avatar, so a test can start from an empty cache. */
export function clearAvatarCache(): void {
	sharedAvatarCache.clear();
}
