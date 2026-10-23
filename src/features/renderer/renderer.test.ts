import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { AttachmentBuilder } from "discord.js";

// ── the S3 tier and its switch, mocked ──
// The REAL canvas library draws every card in this file (its native binary is in
// the dev install), so a PNG that comes back here was actually encoded. Only the
// network is fake: utils/aws is mocked by the same specifier renderer/s3.ts
// imports, and the DISCORD_BOT_S3_ENABLED switch is a getter over a hoisted flag
// so a case can turn S3 on.
const s3Switch = vi.hoisted(() => ({ enabled: false }));

vi.mock("@utils/config.js", () => ({
	get discordBotS3Enabled() {
		return s3Switch.enabled;
	},
}));

vi.mock("@utils/aws/index.js", () => ({
	putObject: vi.fn(async () => undefined),
	getObjectBytes: vi.fn(async () => null),
}));

// Render analytics is mocked so this file never queues a Mongo write; what it
// counts is pinned in renderAnalytics.test.ts, and here only that renderCard
// reports the right outcome and survives a reporter that throws.
vi.mock("./renderAnalytics.js", () => ({
	recordCardLookup: vi.fn(),
	recordAvatarLookup: vi.fn(),
}));

import { getObjectBytes, putObject } from "@utils/aws/index.js";
import { recordCardLookup } from "./renderAnalytics.js";
import { COLORS } from "@base/copy/brand.js";
import { canvasModule, importCanvasModule, type CanvasModule, type Image, type SKRSContext2D } from "./canvasModule.js";
import { LruCache } from "./lruCache.js";
import { AVATAR_CACHE_CAPACITY, avatarCacheKey, createAvatarCache, type AvatarRequest } from "./avatarCache.js";
import { CARD_CACHE_CAPACITY, cachedCardCount, clearCardCache, readCachedCard, storeCard } from "./cardCache.js";
import { buildRenderKey, hashRenderInput, RENDER_KEY_PREFIX, RENDER_S3_READ_TIMEOUT_MS } from "./s3.js";
import { isRenderPayload, withRenderFallback, type RenderPayload } from "./fallback.js";
import { registerRendererFonts, rendererFont, RENDERER_FONT_FAMILY } from "./fonts.js";
import { canvasColor, drawBarSegment, drawCircularImage, drawImageContained, drawPanel, drawPill, drawText, fillCircle, fillRadialGradient, withAlpha } from "./primitives.js";
import { encodeGif } from "./gif.js";
import { cardRenderKey, logCanvasRendererStatus, renderCard, type CardFrame, type CardRenderRequest, type DrawOutcome } from "./index.js";

// ── canvas renderer pipeline ─────────────────────────────────────────
// Pins the pieces every card surface of 2026-10 item 243 builds on: the two LRU
// caps (500 avatars, 100 cards), the S3 key shape and its switch, the fallback
// wrapper's two branches, the caught dynamic import, the boot line, and a smoke
// render of a real 400 by 200 PNG that is uploaded when S3 is on.

const putMock = vi.mocked(putObject);
const getMock = vi.mocked(getObjectBytes);

// Every PNG opens with these eight bytes; the IHDR chunk's width and height sit
// at byte 16 and byte 20, big endian.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;

// The loaded library, asserted once. Every drawing case below needs it, and on a
// host without the binary the first describe says so plainly.
function realCanvas(): CanvasModule {
	if (!canvasModule) throw new Error("@napi-rs/canvas did not load in the test environment");
	return canvasModule;
}

function blankContext(width: number, height: number): SKRSContext2D {
	return realCanvas().createCanvas(width, height).getContext("2d");
}

// One pixel as [red, green, blue, alpha].
function pixelAt(context: SKRSContext2D, x: number, y: number): number[] {
	return Array.from(context.getImageData(x, y, 1, 1).data);
}

function rgbOf(hex: string): number[] {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

// A Discord style numeric id, distinct per index, because the avatar routes the
// cache accepts carry the user id as digits.
function snowflake(index: number): string {
	return String(100_000 + index);
}

function attachmentBytes(payload: RenderPayload): Buffer {
	const bytes = payload.attachment.attachment;
	if (!Buffer.isBuffer(bytes)) throw new Error("expected the rendered card to be attached as a Buffer");
	return bytes;
}

function isPng(bytes: Buffer): boolean {
	return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("canvas module loader", () => {
	it("loaded the real library on this host", () => {
		expect(canvasModule).not.toBeNull();
	});

	it("answers the library when its loader succeeds", async () => {
		const library = { createCanvas: vi.fn() } as unknown as CanvasModule;
		await expect(importCanvasModule(async () => library)).resolves.toBe(library);
	});

	it("answers null with one warn line, never a throw, when the native binary does not load", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const missingBinary = async (): Promise<CanvasModule> => {
			throw new Error("Cannot find native binding");
		};

		await expect(importCanvasModule(missingBinary)).resolves.toBeNull();

		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain("[canvas-renderer]");
	});
});

describe("LruCache", () => {
	it("evicts the least recently used entry once past capacity", () => {
		const cache = new LruCache<string, number>(3);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		// Reading "a" makes "b" the oldest, so "b" is the one a fourth entry pushes out.
		expect(cache.get("a")).toBe(1);
		cache.set("d", 4);

		expect(cache.size).toBe(3);
		expect(cache.get("b")).toBeUndefined();
		expect([cache.get("a"), cache.get("c"), cache.get("d")]).toEqual([1, 3, 4]);
	});

	it("refreshes a key that is set again without growing", () => {
		const cache = new LruCache<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("a", 10);
		cache.set("c", 3);

		expect(cache.size).toBe(2);
		expect(cache.get("a")).toBe(10);
		expect(cache.get("b")).toBeUndefined();
	});

	it("refuses a capacity that is not a positive integer", () => {
		for (const capacity of [0, -1, 1.5, Number.NaN]) {
			expect(() => new LruCache<string, number>(capacity)).toThrow(RangeError);
		}
	});
});

describe("avatar cache", () => {
	const fakeImage = (bytes: Buffer): Image => ({ bytes }) as unknown as Image;
	const avatarRequest = (userId: string, avatarHash: string | null = "hash-a", size: AvatarRequest["size"] = 128): AvatarRequest => ({
		userId,
		avatarHash,
		size,
		url: `https://cdn.discordapp.com/avatars/${userId}/${avatarHash ?? "default"}.png?size=${size}`,
	});

	function cacheWithFakes() {
		const download = vi.fn(async (url: string): Promise<Buffer | null> => Buffer.from(url));
		const decode = vi.fn(async (bytes: Buffer) => fakeImage(bytes));
		return { cache: createAvatarCache({ download, decode }), download, decode };
	}

	it("keys an avatar on the user, the avatar hash and the size", () => {
		expect(avatarCacheKey({ userId: "123", avatarHash: "abc", size: 256 })).toBe("123:abc:256");
		expect(avatarCacheKey({ userId: "123", avatarHash: null, size: 64 })).toBe("123:default:64");
	});

	it("holds at most 500 avatars and evicts the least recently used", async () => {
		const { cache, download } = cacheWithFakes();
		for (let index = 0; index <= AVATAR_CACHE_CAPACITY; index++) await cache.fetch(avatarRequest(snowflake(index)));

		expect(AVATAR_CACHE_CAPACITY).toBe(500);
		expect(cache.size).toBe(AVATAR_CACHE_CAPACITY);
		expect(download).toHaveBeenCalledTimes(AVATAR_CACHE_CAPACITY + 1);

		// The newest is still cached; the first one in was evicted and downloads again.
		await cache.fetch(avatarRequest(snowflake(AVATAR_CACHE_CAPACITY)));
		expect(download).toHaveBeenCalledTimes(AVATAR_CACHE_CAPACITY + 1);
		await cache.fetch(avatarRequest(snowflake(0)));
		expect(download).toHaveBeenCalledTimes(AVATAR_CACHE_CAPACITY + 2);
	});

	it("downloads again for a new avatar hash or another size, and not for a repeat", async () => {
		const { cache, download } = cacheWithFakes();
		await cache.fetch(avatarRequest("101", "hash-a", 128));
		await cache.fetch(avatarRequest("101", "hash-a", 128));
		expect(download).toHaveBeenCalledTimes(1);

		await cache.fetch(avatarRequest("101", "hash-b", 128));
		await cache.fetch(avatarRequest("101", "hash-a", 256));
		expect(download).toHaveBeenCalledTimes(3);
	});

	it("shares one download between two cards asking for the same face at once", async () => {
		const { cache, download } = cacheWithFakes();
		const [first, second] = await Promise.all([cache.fetch(avatarRequest("101")), cache.fetch(avatarRequest("101"))]);

		expect(download).toHaveBeenCalledTimes(1);
		expect(first).toBe(second);
	});

	it("does not cache a miss, so a CDN blip costs one placeholder and no more", async () => {
		const { cache, download } = cacheWithFakes();
		download.mockResolvedValueOnce(null);

		await expect(cache.fetch(avatarRequest("101"))).resolves.toBeNull();
		await expect(cache.fetch(avatarRequest("101"))).resolves.not.toBeNull();
		expect(download).toHaveBeenCalledTimes(2);
	});

	it("answers null with a warn, never a throw, when the download fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { cache, download } = cacheWithFakes();
		download.mockRejectedValueOnce(new Error("socket hang up"));

		await expect(cache.fetch(avatarRequest("101"))).resolves.toBeNull();
		expect(warn).toHaveBeenCalled();
	});

	it("refuses anything but an https avatar route on Discord's CDN, without downloading it", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { cache, download } = cacheWithFakes();
		const refused = [
			"https://example.com/avatar.png",
			"http://cdn.discordapp.com/avatars/102/hash-a.png",
			// An uploaded attachment on the same host, and Discord's open media proxy.
			"https://cdn.discordapp.com/attachments/1/2/huge.png",
			"https://media.discordapp.net/avatars/102/hash-a.png",
		];

		for (const [index, url] of refused.entries()) {
			await expect(cache.fetch({ ...avatarRequest(snowflake(index)), url })).resolves.toBeNull();
		}
		expect(download).not.toHaveBeenCalled();
	});

	it("accepts a user avatar, a default avatar and a member's guild avatar", async () => {
		const { cache, download } = cacheWithFakes();
		const accepted = [
			"https://cdn.discordapp.com/avatars/103/hash-a.png?size=128",
			"https://cdn.discordapp.com/embed/avatars/2.png",
			"https://cdn.discordapp.com/guilds/910668785856413707/users/103/avatars/hash-g.png?size=128",
		];

		for (const [index, url] of accepted.entries()) {
			await expect(cache.fetch({ ...avatarRequest(snowflake(index)), url })).resolves.not.toBeNull();
		}
		expect(download).toHaveBeenCalledTimes(accepted.length);
	});

	it("answers null without downloading when the canvas library did not load", async () => {
		const download = vi.fn(async () => Buffer.from("never"));
		const cache = createAvatarCache({ download, decode: null });

		await expect(cache.fetch(avatarRequest("101"))).resolves.toBeNull();
		expect(download).not.toHaveBeenCalled();
	});
});

describe("card cache", () => {
	beforeEach(() => {
		clearCardCache();
		s3Switch.enabled = false;
		putMock.mockClear();
		getMock.mockReset();
		getMock.mockResolvedValue(null);
	});

	it("keeps at most 100 cards in memory and evicts the least recently used", async () => {
		for (let index = 0; index <= CARD_CACHE_CAPACITY; index++) await storeCard(`card-${index}`, Buffer.from(`png-${index}`));

		expect(CARD_CACHE_CAPACITY).toBe(100);
		expect(cachedCardCount()).toBe(CARD_CACHE_CAPACITY);
		await expect(readCachedCard("card-0")).resolves.toBeNull();
		await expect(readCachedCard(`card-${CARD_CACHE_CAPACITY}`)).resolves.toEqual({ bytes: Buffer.from(`png-${CARD_CACHE_CAPACITY}`), tier: "memory" });
	});

	it("never calls S3 in either direction while the switch is off", async () => {
		await storeCard("card-a", Buffer.from("png"));
		await readCachedCard("card-missing");

		expect(putMock).not.toHaveBeenCalled();
		expect(getMock).not.toHaveBeenCalled();
	});

	it("with S3 on, reads a memory miss from S3 and keeps it in memory", async () => {
		s3Switch.enabled = true;
		getMock.mockResolvedValueOnce(Buffer.from("stored-png"));

		await expect(readCachedCard("card-a")).resolves.toEqual({ bytes: Buffer.from("stored-png"), tier: "s3" });
		await expect(readCachedCard("card-a")).resolves.toEqual({ bytes: Buffer.from("stored-png"), tier: "memory" });
		expect(getMock).toHaveBeenCalledTimes(1);
	});

	it("treats a failed S3 read as a miss and a failed S3 write as harmless", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		s3Switch.enabled = true;
		getMock.mockRejectedValueOnce(new Error("503 Slow Down"));
		putMock.mockRejectedValueOnce(new Error("AccessDenied"));

		await expect(readCachedCard("card-a")).resolves.toBeNull();
		await expect(storeCard("card-b", Buffer.from("png"))).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(2);
	});
});

describe("render keys", () => {
	it("builds discord-bot/renders/<kind>/<version>/<inputHash>.png", () => {
		const inputHash = hashRenderInput({ level: 7 });

		expect(RENDER_KEY_PREFIX).toBe("discord-bot/renders");
		expect(buildRenderKey("level-up", 3, inputHash)).toBe(`discord-bot/renders/level-up/3/${inputHash}.png`);
	});

	it("refuses a kind, version or hash that could escape the prefix or collide", () => {
		const inputHash = hashRenderInput({ level: 7 });
		for (const kind of ["../server", "Level", "a/b", "", "level_up", "-up"]) {
			expect(() => buildRenderKey(kind, 1, inputHash)).toThrow();
		}
		for (const version of [0, -1, 1.5, Number.NaN]) {
			expect(() => buildRenderKey("level-up", version, inputHash)).toThrow();
		}
		expect(() => buildRenderKey("level-up", 1, "abc")).toThrow();
	});

	it("hashes the same input the same way whatever order its keys were written in", () => {
		const written = { userId: "1", stats: { xp: 20, badges: ["a", "b"] }, rank: 3 };
		const reordered = { rank: 3, stats: { badges: ["a", "b"], xp: 20 }, userId: "1" };

		expect(hashRenderInput(written)).toBe(hashRenderInput(reordered));
		expect(hashRenderInput(written)).not.toBe(hashRenderInput({ ...written, rank: 4 }));
		// Array order is content, not layout, so it changes the hash.
		expect(hashRenderInput({ badges: ["a", "b"] })).not.toBe(hashRenderInput({ badges: ["b", "a"] }));
		expect(hashRenderInput({ a: 1, gone: undefined })).toBe(hashRenderInput({ a: 1 }));
		expect(hashRenderInput({ at: new Date("2026-10-23T00:00:00.000Z") })).toBe(hashRenderInput({ at: "2026-10-23T00:00:00.000Z" }));
	});

	it("throws on input a hash cannot read faithfully, instead of colliding", () => {
		class Seat {
			readonly id = "seat-1";
		}
		// Each of these would otherwise hash as {} or as null, sharing a key with a
		// different input.
		const unreadable: unknown[] = [new Map([["a", 1]]), new Set(["a"]), new Seat(), Number.NaN, Number.POSITIVE_INFINITY, () => "draw"];

		for (const value of unreadable) {
			expect(() => hashRenderInput({ guessed: value })).toThrow(TypeError);
		}
		expect(() => hashRenderInput(Object.create(null))).not.toThrow();
	});
});

describe("withRenderFallback", () => {
	const renderedCard = (): RenderPayload => ({
		attachment: new AttachmentBuilder(Buffer.from("png"), { name: "card.png" }),
		ref: "attachment://card.png",
	});

	it("answers the rendered card and never builds the embed", async () => {
		const card = renderedCard();
		const embedFn = vi.fn(() => "text embed");

		const result = await withRenderFallback(async () => card, embedFn);

		expect(result).toBe(card);
		expect(isRenderPayload(result)).toBe(true);
		expect(embedFn).not.toHaveBeenCalled();
	});

	it("answers the embed when the render answers null", async () => {
		await expect(withRenderFallback(async () => null, () => "text embed")).resolves.toBe("text embed");
	});

	it("answers the embed with one warn line when the render throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const result = await withRenderFallback(
			async () => {
				throw new Error("draw failed");
			},
			() => "text embed"
		);

		expect(result).toBe("text embed");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("tells a rendered card apart from anything else", () => {
		expect(isRenderPayload(renderedCard())).toBe(true);
		expect(isRenderPayload("text embed")).toBe(false);
		expect(isRenderPayload(null)).toBe(false);
		expect(isRenderPayload({ attachment: "card.png", ref: "attachment://card.png" })).toBe(false);
	});
});

describe("fonts", () => {
	it("registers Inter regular and bold under one family", () => {
		expect(registerRendererFonts()).toBe(true);
		expect(realCanvas().GlobalFonts.has(RENDERER_FONT_FAMILY)).toBe(true);
	});

	it("draws bold wider than regular, so both weights really registered", () => {
		registerRendererFonts();
		const context = blankContext(400, 100);
		context.font = rendererFont(32, "regular");
		const regularWidth = context.measureText("hello world").width;
		context.font = rendererFont(32, "bold");
		const boldWidth = context.measureText("hello world").width;

		expect(boldWidth).toBeGreaterThan(regularWidth);
	});

	it("names Inter first and the host's sans-serif after it", () => {
		expect(rendererFont(24, "bold")).toBe("bold 24px Inter, sans-serif");
		expect(rendererFont(16)).toBe("normal 16px Inter, sans-serif");
	});
});

describe("logCanvasRendererStatus", () => {
	beforeEach(() => {
		s3Switch.enabled = false;
	});

	it("prints the ready line with fonts and the S3 switch", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		logCanvasRendererStatus();
		s3Switch.enabled = true;
		logCanvasRendererStatus();

		expect(log.mock.calls.map(([line]) => line)).toEqual([
			"[canvas-renderer] ready (fonts: Inter, S3: disabled)",
			"[canvas-renderer] ready (fonts: Inter, S3: enabled)",
		]);
	});
});

describe("primitives", () => {
	it("turns a brand color token into the hex canvas draws with", () => {
		expect(canvasColor("Gold")).toBe("#f1c40f");
		expect(canvasColor(COLORS.DERO)).toBe("#4f46e5");
		expect(canvasColor(COLORS.ACCOUNT)).toBe("#2563eb");
	});

	it("fills a bar segment to its ratio, and never past the end of its track", () => {
		const fill = "#ff0000";
		const track = "#0000ff";
		// The canvas is wider than the 200 pixel bar, so an unclamped ratio would
		// visibly paint fill beyond the track's end.
		const bar = (fillRatio: number): SKRSContext2D => {
			const context = blankContext(300, 20);
			drawBarSegment(context, { x: 0, y: 0, width: 200, height: 20, fillRatio, fillColor: fill, trackColor: track, radius: 0 });
			return context;
		};

		const half = bar(0.5);
		expect(pixelAt(half, 50, 10).slice(0, 3)).toEqual(rgbOf(fill));
		expect(pixelAt(half, 150, 10).slice(0, 3)).toEqual(rgbOf(track));

		const overfull = bar(1.7);
		expect(pixelAt(overfull, 190, 10).slice(0, 3)).toEqual(rgbOf(fill));
		expect(pixelAt(overfull, 250, 10)[3]).toBe(0);
	});

	it("draws an empty bar, track only, for a ratio of NaN or below zero", () => {
		for (const fillRatio of [Number.NaN, -0.4]) {
			const context = blankContext(200, 20);
			drawBarSegment(context, { x: 0, y: 0, width: 200, height: 20, fillRatio, fillColor: "#ff0000", trackColor: "#0000ff", radius: 0 });
			expect(pixelAt(context, 10, 10).slice(0, 3)).toEqual(rgbOf("#0000ff"));
		}
	});

	it("crops an image to a circle, leaving the corners clear", async () => {
		const source = blankContext(50, 50);
		source.fillStyle = "#00ff00";
		source.fillRect(0, 0, 50, 50);
		const image = await realCanvas().loadImage(await source.canvas.encode("png"));
		const context = blankContext(100, 100);

		drawCircularImage(context, image, 50, 50, 100);

		expect(pixelAt(context, 50, 50)).toEqual([0, 255, 0, 255]);
		expect(pixelAt(context, 3, 3)[3]).toBe(0);
	});

	it("draws a pill with rounded ends and a label inside it", () => {
		const context = blankContext(200, 40);
		drawPill(context, { x: 0, y: 0, width: 200, height: 40, fill: "#ff0000" });

		expect(pixelAt(context, 100, 20).slice(0, 3)).toEqual(rgbOf("#ff0000"));
		expect(pixelAt(context, 1, 1)[3]).toBe(0);

		const labelled = blankContext(200, 40);
		drawPill(labelled, { x: 0, y: 0, width: 200, height: 40, fill: "#ff0000", label: "LV 12", labelColor: "#ffffff" });
		expect(whitePixelCount(labelled, 200, 40)).toBeGreaterThan(0);
	});

	it("still draws the label of a round count badge, which has no straight run", () => {
		registerRendererFonts();
		const badge = blankContext(40, 40);

		drawPill(badge, { x: 0, y: 0, width: 40, height: 40, fill: "#ff0000", label: "3", labelColor: "#ffffff" });

		expect(whitePixelCount(badge, 40, 40)).toBeGreaterThan(0);
	});

	it("paints a radial gradient from its inner color out to its outer color", () => {
		const context = blankContext(100, 100);
		fillRadialGradient(context, {
			centerX: 50,
			centerY: 50,
			innerRadius: 0,
			outerRadius: 50,
			stops: [
				{ offset: 0, color: "#ffffff" },
				{ offset: 1, color: "#000000" },
			],
		});

		expect(pixelAt(context, 50, 50)[0]).toBeGreaterThan(240);
		expect(pixelAt(context, 0, 0)[0]).toBeLessThan(15);
	});

	it("draws text and hands the context back as it found it", () => {
		registerRendererFonts();
		const context = blankContext(200, 60);
		context.fillStyle = "#123456";
		const alignBefore = context.textAlign;
		const fontBefore = context.font;

		drawText(context, "hello", { x: 100, y: 30, size: 32, weight: "bold", color: "#ffffff", align: "center", baseline: "middle" });

		expect(whitePixelCount(context, 200, 60)).toBeGreaterThan(0);
		expect(context.textAlign).toBe(alignBefore);
		expect(context.font).toBe(fontBefore);
		// The fill is checked by painting with it, not by reading it back:
		// @napi-rs/canvas 1.0.10's fillStyle getter still reports the value set
		// inside save() after restore(), although the restored fill is what paints.
		context.fillRect(0, 0, 1, 1);
		expect(pixelAt(context, 0, 0).slice(0, 3)).toEqual(rgbOf("#123456"));
	});
});

describe("renderCard smoke", () => {
	type HelloInput = { text: string };

	const helloCard = (overrides: Partial<CardRenderRequest<HelloInput>> = {}): CardRenderRequest<HelloInput> => ({
		kind: "smoke",
		version: 1,
		input: { text: "hello" },
		width: 400,
		height: 200,
		draw: vi.fn((context: SKRSContext2D, input: HelloInput) => {
			context.fillStyle = canvasColor(COLORS.DERO);
			context.fillRect(0, 0, 400, 200);
			drawText(context, input.text, { x: 200, y: 100, size: 48, weight: "bold", color: "#ffffff", align: "center", baseline: "middle" });
		}),
		...overrides,
	});

	beforeEach(() => {
		clearCardCache();
		s3Switch.enabled = true;
		putMock.mockReset();
		putMock.mockResolvedValue(undefined);
		getMock.mockReset();
		getMock.mockResolvedValue(null);
	});

	it("renders a 400 by 200 hello card, uploads it to S3 and answers a valid PNG", async () => {
		const request = helloCard();
		// The key hashes the input together with the canvas size.
		const inputHash = hashRenderInput({ input: { text: "hello" }, width: 400, height: 200 });
		const key = buildRenderKey("smoke", 1, inputHash);

		const payload = await renderCard(request);

		expect(payload).not.toBeNull();
		const png = attachmentBytes(payload as RenderPayload);
		expect(isPng(png)).toBe(true);
		expect(png.readUInt32BE(PNG_WIDTH_OFFSET)).toBe(400);
		expect(png.readUInt32BE(PNG_HEIGHT_OFFSET)).toBe(200);
		expect(payload?.ref).toBe(`attachment://smoke-${inputHash.slice(0, 12)}.png`);
		expect(payload?.attachment.name).toBe(`smoke-${inputHash.slice(0, 12)}.png`);

		expect(cardRenderKey(request)).toBe(key);
		expect(getMock).toHaveBeenCalledWith(key, { timeoutMs: RENDER_S3_READ_TIMEOUT_MS });
		await vi.waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(putMock).toHaveBeenCalledWith({ key, body: png, contentType: "image/png", cacheControl: expect.stringContaining("immutable") });
	});

	it("serves a repeat of the same input from memory, without drawing or uploading again", async () => {
		const request = helloCard();

		await renderCard(request);
		await vi.waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const repeat = await renderCard(request);

		expect(repeat).not.toBeNull();
		expect(request.draw).toHaveBeenCalledTimes(1);
		expect(getMock).toHaveBeenCalledTimes(1);
		expect(putMock).toHaveBeenCalledTimes(1);
	});

	it("reuses a card stored in S3 without drawing it", async () => {
		const stored = attachmentBytes((await renderCard(helloCard())) as RenderPayload);
		clearCardCache();
		getMock.mockResolvedValueOnce(stored);
		const request = helloCard();

		const payload = await renderCard(request);

		expect(request.draw).not.toHaveBeenCalled();
		expect(attachmentBytes(payload as RenderPayload).equals(stored)).toBe(true);
	});

	it("draws again under a new key when the renderer's version is bumped", async () => {
		await renderCard(helloCard());
		const bumped = helloCard({ version: 2 });

		await renderCard(bumped);

		expect(bumped.draw).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(putMock).toHaveBeenCalledTimes(2));
		expect(putMock.mock.calls[1][0].key).toBe(cardRenderKey(bumped));
		expect(cardRenderKey(bumped)).toMatch(/^discord-bot\/renders\/smoke\/2\/[a-f0-9]{64}\.png$/);
	});

	it("draws the same input at another size as its own card under its own key", async () => {
		const full = helloCard();
		const thumbnail = helloCard({ width: 200, height: 100 });

		await renderCard(full);
		const small = await renderCard(thumbnail);

		expect(thumbnail.draw).toHaveBeenCalledTimes(1);
		expect(cardRenderKey(thumbnail)).not.toBe(cardRenderKey(full));
		expect(attachmentBytes(small as RenderPayload).readUInt32BE(PNG_WIDTH_OFFSET)).toBe(200);
	});

	it("posts but never caches a card drawn with a stand in", async () => {
		const degraded = helloCard({ draw: vi.fn(() => ({ cacheable: false as const })) });

		const first = await renderCard(degraded);
		const second = await renderCard(degraded);

		expect(isPng(attachmentBytes(first as RenderPayload))).toBe(true);
		expect(second).not.toBeNull();
		// Drawn twice, because nothing kept the first one, and never uploaded.
		expect(degraded.draw).toHaveBeenCalledTimes(2);
		expect(putMock).not.toHaveBeenCalled();
	});

	it("answers null for an input the cache key cannot hash, so the surface posts its embed", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const unhashable = { kind: "smoke", version: 1, input: { guessed: new Set(["a"]) }, width: 400, height: 200, draw: vi.fn() };

		await expect(renderCard(unhashable)).resolves.toBeNull();
		expect(unhashable.draw).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
	});

	it("records a first render as drawn and a repeat as a memory hit (2026-10 item 244)", async () => {
		const recordMock = vi.mocked(recordCardLookup);
		recordMock.mockClear();
		const request = helloCard();
		const key = cardRenderKey(request);

		const first = attachmentBytes((await renderCard(request)) as RenderPayload);
		await renderCard(request);

		expect(recordMock).toHaveBeenCalledTimes(2);
		expect(recordMock.mock.calls[0][0]).toEqual({ kind: "smoke", version: 1, key, outcome: "drawn", bytes: first.length });
		expect(recordMock.mock.calls[1][0]).toEqual({ kind: "smoke", version: 1, key, outcome: "memory", bytes: first.length });
	});

	it("records a card served from S3 as an s3 hit", async () => {
		const stored = attachmentBytes((await renderCard(helloCard())) as RenderPayload);
		clearCardCache();
		getMock.mockResolvedValueOnce(stored);
		const recordMock = vi.mocked(recordCardLookup);
		recordMock.mockClear();

		await renderCard(helloCard());

		expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "s3", bytes: stored.length }));
	});

	it("still answers the card when recording the lookup throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.mocked(recordCardLookup).mockImplementationOnce(() => {
			throw new Error("analytics exploded");
		});

		const payload = await renderCard(helloCard());

		expect(payload).not.toBeNull();
		expect(isPng(attachmentBytes(payload as RenderPayload))).toBe(true);
		expect(warn).toHaveBeenCalled();
	});

	it("still renders with S3 off, and sends nothing to S3", async () => {
		s3Switch.enabled = false;

		const payload = await renderCard(helloCard());

		expect(isPng(attachmentBytes(payload as RenderPayload))).toBe(true);
		expect(getMock).not.toHaveBeenCalled();
		expect(putMock).not.toHaveBeenCalled();
	});

	it("answers null for a draw that throws or a malformed kind, so withRenderFallback posts the embed", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const broken = helloCard({
			draw: () => {
				throw new Error("draw failed");
			},
		});

		await expect(renderCard(broken)).resolves.toBeNull();
		await expect(renderCard(helloCard({ kind: "Not A Slug" }))).resolves.toBeNull();
		await expect(withRenderFallback(() => renderCard(broken), () => "text embed")).resolves.toBe("text embed");
		expect(putMock).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
	});
});

// ── isolated module graphs ──
// Last in the file because vi.resetModules gives every later dynamic import a
// fresh copy of the renderer, while the static imports above keep theirs.

describe("when the bundled fonts are missing", () => {
	it("names the missing files at boot, and still renders cards but never caches them", async () => {
		vi.resetModules();
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		s3Switch.enabled = true;

		const isolated = await import("./index.js");
		// The S3 mock as THIS module graph sees it, which is the instance the fresh
		// renderer above calls.
		const isolatedAws = await import("@utils/aws/index.js");
		vi.mocked(isolatedAws.putObject).mockClear();
		// A fresh fonts module has registered nothing yet, and from a working
		// directory with no assets/fonts/ in it neither file resolves. Mocked only
		// after the imports, so module loading itself never sees the fake cwd.
		vi.spyOn(process, "cwd").mockReturnValue(tmpdir());
		isolated.logCanvasRendererStatus();
		const draw = vi.fn();
		const payload = await isolated.renderCard({ kind: "smoke", version: 1, input: { text: "hello" }, width: 400, height: 200, draw });

		expect(log.mock.calls[0][0]).toBe(
			"[canvas-renderer] ready (fonts: host sans-serif, missing from assets/fonts: inter-regular.ttf, inter-bold.ttf, S3: enabled)"
		);
		expect(payload).not.toBeNull();
		expect(draw).toHaveBeenCalledTimes(1);
		// storeCard would have called putObject synchronously inside renderCard,
		// so by now a cached card would already show here.
		expect(isolatedAws.putObject).not.toHaveBeenCalled();
	});
});

describe("when the canvas library does not load", () => {
	it("reports itself unavailable, renders nothing, and leaves every surface on its text embed", async () => {
		vi.resetModules();
		vi.doMock("@napi-rs/canvas", () => {
			throw new Error("Cannot find native binding");
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		const isolated = await import("./index.js");
		const draw = vi.fn();
		const request = { kind: "smoke", version: 1, input: { text: "hello" }, width: 400, height: 200, draw };

		await expect(isolated.renderCard(request)).resolves.toBeNull();
		await expect(isolated.withRenderFallback(() => isolated.renderCard(request), () => "text embed")).resolves.toBe("text embed");
		isolated.logCanvasRendererStatus();

		expect(draw).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
		expect(log.mock.calls[0][0]).toBe(
			"[canvas-renderer] unavailable (@napi-rs/canvas did not load); every card surface posts its text embed"
		);
		vi.doUnmock("@napi-rs/canvas");
	});
});

describe("animated cards (2026-10 item 243 Phase 2)", () => {
	type PulseInput = { level: number };
	const GIF_SIGNATURE = Buffer.from("GIF89a", "ascii");

	const pulseCard = (draw = vi.fn((_context: SKRSContext2D, _input: PulseInput, _frame: CardFrame): DrawOutcome => undefined)): CardRenderRequest<PulseInput> => ({
		kind: "pulse",
		version: 1,
		input: { level: 11 },
		width: 120,
		height: 60,
		animation: { frameCount: 4, frameDelayMs: 90 },
		draw: (context, input, frame) => {
			// A disc that moves each frame, inside a rounded sheet with see through corners.
			drawPanel(context, { x: 0, y: 0, width: 120, height: 60, radius: 20, fill: canvasColor(COLORS.CARD_BACKGROUND) });
			fillCircle(context, 20 + frame.index * 25, 30, 20, canvasColor(COLORS.LEVEL_MILESTONE));
			return draw(context, input, frame);
		},
	});

	beforeEach(() => {
		clearCardCache();
		s3Switch.enabled = true;
		putMock.mockReset();
		putMock.mockResolvedValue(undefined);
		getMock.mockReset();
		getMock.mockResolvedValue(null);
	});

	it("draws every frame, answers a looping GIF, and stores it under a .gif key as image/gif", async () => {
		const draw = vi.fn((): DrawOutcome => undefined);
		const request = pulseCard(draw);

		const payload = await renderCard(request);

		const gif = attachmentBytes(payload as RenderPayload);
		expect(gif.subarray(0, GIF_SIGNATURE.length).equals(GIF_SIGNATURE)).toBe(true);
		expect(gif.readUInt16LE(6)).toBe(120);
		expect(gif.readUInt16LE(8)).toBe(60);
		expect(draw.mock.calls.map((call) => call[2])).toEqual([0, 1, 2, 3].map((index) => ({ index, count: 4 })));
		expect(payload?.ref).toMatch(/^attachment:\/\/pulse-[a-f0-9]{12}\.gif$/);
		expect(cardRenderKey(request)).toMatch(/\.gif$/);
		await vi.waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(putMock).toHaveBeenCalledWith(expect.objectContaining({ key: cardRenderKey(request), contentType: "image/gif" }));
	});

	it("never shares a key with the same input drawn as a still PNG", () => {
		const animated = pulseCard();
		const { animation: _animation, ...still } = animated;
		expect(cardRenderKey(animated)).not.toBe(cardRenderKey(still));
		expect(cardRenderKey(still)).toMatch(/\.png$/);
	});

	it("posts but never caches a GIF when any one frame drew a stand in", async () => {
		const draw = vi.fn((_context: SKRSContext2D, _input: PulseInput, frame: CardFrame): DrawOutcome => (frame.index === 2 ? { cacheable: false } : undefined));

		const payload = await renderCard(pulseCard(draw));

		expect(payload).not.toBeNull();
		expect(cachedCardCount()).toBe(0);
		expect(putMock).not.toHaveBeenCalled();
	});

	it("keeps the rounded corners transparent in the GIF rather than black", () => {
		const context = blankContext(40, 40);
		drawPanel(context, { x: 0, y: 0, width: 40, height: 40, radius: 16, fill: "#ffffff" });
		const rgba = context.getImageData(0, 0, 40, 40).data;

		const gif = encodeGif({ width: 40, height: 40, frames: [rgba], frameDelayMs: 90 });

		// The graphic control extension (0x21 0xf9) carries the transparency flag
		// in bit 0 of its packed byte, three bytes in.
		const control = gif.indexOf(Buffer.from([0x21, 0xf9]));
		expect(control).toBeGreaterThan(0);
		expect(gif[control + 3] & 0x01).toBe(1);
	});

	it("refuses a frame of the wrong size, which renderCard turns into the text embed", () => {
		expect(() => encodeGif({ width: 10, height: 10, frames: [new Uint8ClampedArray(12)], frameDelayMs: 90 })).toThrow(/expected 400/);
		expect(() => encodeGif({ width: 10, height: 10, frames: [], frameDelayMs: 90 })).toThrow(/no frames/);
	});
});

describe("Phase 2 primitives", () => {
	it("fillCircle paints a disc and leaves the corners clear", () => {
		const context = blankContext(40, 40);
		fillCircle(context, 20, 20, 30, "#ff0000");
		expect(pixelAt(context, 20, 20)).toEqual([255, 0, 0, 255]);
		expect(pixelAt(context, 1, 1)[3]).toBe(0);
	});

	it("drawPanel rounds its corners and never past half its shorter side", () => {
		const context = blankContext(100, 40);
		drawPanel(context, { x: 0, y: 0, width: 100, height: 40, radius: 500, fill: "#00ff00" });
		expect(pixelAt(context, 50, 20)).toEqual([0, 255, 0, 255]);
		expect(pixelAt(context, 0, 0)[3]).toBe(0);
	});

	it("drawImageContained keeps the aspect ratio and centres the image in its box", () => {
		const source = blankContext(100, 50);
		source.fillStyle = "#0000ff";
		source.fillRect(0, 0, 100, 50);
		const context = blankContext(100, 100);

		drawImageContained(context, source.canvas as unknown as Image, { x: 0, y: 0, width: 100, height: 100 });

		// A 2:1 image in a square box fills the middle half, top and bottom clear.
		expect(pixelAt(context, 50, 50)).toEqual([0, 0, 255, 255]);
		expect(pixelAt(context, 50, 10)[3]).toBe(0);
		expect(pixelAt(context, 50, 90)[3]).toBe(0);
	});

	it("withAlpha turns a brand token into #rrggbbaa", () => {
		expect(withAlpha("#4f46e5", 1)).toBe("#4f46e5ff");
		expect(withAlpha("#4f46e5", 0)).toBe("#4f46e500");
		expect(withAlpha(COLORS.DERO, 2)).toBe("#4f46e5ff");
	});
});

// ── helpers ──

// How many pixels are near white and opaque: proof a white label or line of
// text actually landed, without pinning the exact glyph shapes.
function whitePixelCount(context: SKRSContext2D, width: number, height: number): number {
	const { data } = context.getImageData(0, 0, width, height);
	let count = 0;
	for (let offset = 0; offset < data.length; offset += 4) {
		if (data[offset] > 200 && data[offset + 1] > 200 && data[offset + 2] > 200 && data[offset + 3] > 200) count++;
	}
	return count;
}
