import { AttachmentBuilder } from "discord.js";
import { canvasModule, type Canvas, type CanvasModule, type SKRSContext2D } from "./canvasModule.js";
import { readCachedCard, storeCard } from "./cardCache.js";
import type { RenderPayload } from "./fallback.js";
import { encodeGif } from "./gif.js";
import { missingRendererFonts, registerRendererFonts, RENDERER_FONT_FAMILY } from "./fonts.js";
import { recordCardLookup, type CardLookup } from "./renderAnalytics.js";
import { buildRenderKey, hashRenderInput, isRenderStoreEnabled, type RenderFormat } from "./s3.js";

// ── canvas renderer ──────────────────────────────────────────────────
// The entry point of the shared card pipeline (2026-10 item 243): renderCard
// turns a surface's input and draw function into a PNG (or, animated, a GIF) attachment, reusing the
// copy in memory or S3 when the same input was drawn before. It draws no surface
// of its own; the account, level up, game and platform cards of Phases 2 to 4
// each bring a draw function built from primitives.ts, and wrap their call site
// in withRenderFallback. main.ts calls logCanvasRendererStatus once at boot.
//
// How renderCard runs: ① no canvas library, answer null at once; ② build the
// key from the kind, the version and a hash of the input and the canvas size;
// ③ a cached card (memory, then S3) skips the draw; ④ otherwise draw and encode a
// PNG, or every frame and one GIF for a request with an animation; ⑤ keep it in memory and upload it in the background, unless it was drawn
// with a stand in (see DrawOutcome); ⑥ count the lookup for render analytics,
// never awaited (2026-10 item 244); ⑦ answer the attachment and its ref.

export type { RenderPayload } from "./fallback.js";
export { isRenderPayload, withRenderFallback } from "./fallback.js";
export { avatarRequestFor, fetchAvatar, type AvatarRequest } from "./avatarCache.js";
export { buildRenderKey, hashRenderInput, type RenderFormat } from "./s3.js";
export { loadDeroArt, logDeroArtStatus, DERO_ART_FILES, type DeroArt, type DeroArtSlot } from "./deroArt.js";
export * from "./primitives.js";
export { drawDeroPose, drawMemberFace } from "./cardParts.js";

/**
 * What a draw function may answer. Nothing, for a card drawn exactly as meant.
 * `{ cacheable: false }` when it drew a stand in, such as an avatar placeholder
 * after fetchAvatar answered null: the card still posts, but it is never cached,
 * so the next request draws it again rather than serving the stand in from an
 * immutable S3 key for as long as the input stays the same.
 */
export type DrawOutcome = void | { cacheable: false };

/**
 * Asks for a looping GIF instead of a PNG. The draw function then runs once per
 * frame on a cleared canvas and reads `frame.index` to move what moves. GIF
 * encoding costs roughly ten times a PNG, so 2026-10 item 243 keeps it to the
 * prime level up card.
 */
export interface CardAnimation {
	frameCount: number;
	frameDelayMs: number;
}

/** Which frame a draw call is painting. A still card is always frame 0 of 1. */
export interface CardFrame {
	index: number;
	count: number;
}

const STILL_FRAME: CardFrame = { index: 0, count: 1 };

export interface CardRenderRequest<Input> {
	/** Lowercase slug naming the surface, and the S3 folder its cards live in (`account`, `level-up`). */
	kind: string;
	/** The renderer's drawing version. Bump it whenever the drawing changes, or members keep seeing cards cached from the old drawing. */
	version: number;
	/**
	 * Everything the card depends on, and nothing else. It is hashed into the
	 * cache key with the width and height, so a value the drawing reads from
	 * anywhere else can change while the cached card does not. Plain data only,
	 * as a view model already is: hashRenderInput throws on anything else.
	 */
	input: Input;
	width: number;
	height: number;
	/** Omitted for a still PNG card, which is every card but the prime level up. */
	animation?: CardAnimation;
	draw: (context: SKRSContext2D, input: Input, frame: CardFrame) => DrawOutcome | Promise<DrawOutcome>;
}

// How much of the input hash names the attachment: enough to tell two cards
// apart in a log line, short enough to read there.
const ATTACHMENT_HASH_LENGTH = 12;

/** The cache key one request maps to. Exported so a test can name the exact key a render uses. */
export function cardRenderKey<Input>(request: CardRenderRequest<Input>): string {
	return buildRenderKey(request.kind, request.version, cardInputHash(request), cardFormat(request));
}

// The size is hashed with the input so one surface drawn at two sizes (a full
// card and a thumbnail, say) can never be served the other size's bytes, and the
// animation is hashed so a GIF and its PNG fallback never share a key either.
function cardInputHash<Input>({ input, width, height, animation }: CardRenderRequest<Input>): string {
	return hashRenderInput({ input, width, height, animation });
}

function cardFormat<Input>(request: CardRenderRequest<Input>): RenderFormat {
	return request.animation ? "gif" : "png";
}

/**
 * One card as an attachment plus the `attachment://` ref an embed's setImage
 * points at, or null whenever the surface should post its text embed instead
 * (no canvas library, a malformed request, or a draw that threw). Never throws.
 */
export async function renderCard<Input>(request: CardRenderRequest<Input>): Promise<RenderPayload | null> {
	if (!canvasModule) return null;
	try {
		const inputHash = cardInputHash(request);
		const format = cardFormat(request);
		const key = buildRenderKey(request.kind, request.version, inputHash, format);
		const cached = await readCachedCard(key);
		const bytes = cached ? cached.bytes : await drawCard(canvasModule, request, key);
		// A stand in that was drawn but not cached still counts as drawn: it cost a draw.
		countLookup({ kind: request.kind, version: request.version, key, outcome: cached ? cached.tier : "drawn", bytes: bytes.length });
		const name = `${request.kind}-${inputHash.slice(0, ATTACHMENT_HASH_LENGTH)}.${format}`;
		return { attachment: new AttachmentBuilder(bytes, { name }), ref: `attachment://${name}` };
	} catch (error) {
		console.warn(`[canvas-renderer] the ${request.kind} card failed to render, so its surface posts the text embed`, error);
		return null;
	}
}

// recordCardLookup already catches everything and defers its write; this guard
// is the second wall, because the card is ready by now and a counting bug must
// never turn it into a text embed (bot rule 7, 2026-10 item 244 risk R1).
function countLookup(lookup: CardLookup): void {
	try {
		recordCardLookup(lookup);
	}
	catch (error) {
		console.warn(`[render-analytics] counting the ${lookup.kind} card failed; the card still posts`, error);
	}
}

async function drawCard<Input>(canvas: CanvasModule, request: CardRenderRequest<Input>, key: string): Promise<Buffer> {
	const fontsReady = registerRendererFonts(canvas);
	const surface = canvas.createCanvas(request.width, request.height);
	const context = surface.getContext("2d");
	const { bytes, cacheable } = request.animation
		? await drawAnimatedCard(context, request, request.animation)
		: await drawStillCard(surface, context, request);
	// A card drawn in the host's fallback font is a stand in too: caching it would
	// keep serving the off brand card after a deploy that restores the fonts.
	if (fontsReady && cacheable) {
		// Not awaited: the card is ready to post now, and the S3 upload inside
		// storeCard logs its own failure rather than rejecting.
		void storeCard(key, bytes);
	}
	return bytes;
}

interface DrawnCard {
	bytes: Buffer;
	cacheable: boolean;
}

async function drawStillCard<Input>(
	surface: Canvas,
	context: SKRSContext2D,
	request: CardRenderRequest<Input>
): Promise<DrawnCard> {
	const outcome = await request.draw(context, request.input, STILL_FRAME);
	return { bytes: await surface.encode("png"), cacheable: !isUncacheable(outcome) };
}

// Each frame is drawn on a cleared canvas and read back as RGBA, so a draw
// function paints a whole frame and never has to undo the previous one. One
// stand in on any frame makes the whole GIF uncacheable, since they all share a key.
async function drawAnimatedCard<Input>(context: SKRSContext2D, request: CardRenderRequest<Input>, animation: CardAnimation): Promise<DrawnCard> {
	const { width, height } = request;
	const frames: Uint8ClampedArray[] = [];
	let cacheable = true;
	for (let index = 0; index < animation.frameCount; index += 1) {
		context.clearRect(0, 0, width, height);
		const outcome = await request.draw(context, request.input, { index, count: animation.frameCount });
		if (isUncacheable(outcome)) cacheable = false;
		frames.push(context.getImageData(0, 0, width, height).data);
	}
	return { bytes: encodeGif({ width, height, frames, frameDelayMs: animation.frameDelayMs }), cacheable };
}

function isUncacheable(outcome: unknown): boolean {
	return typeof outcome === "object" && outcome !== null && "cacheable" in outcome && outcome.cacheable === false;
}

/**
 * The card pipeline's boot line, `[canvas-renderer] ready (fonts: Inter, S3:
 * enabled)` on a healthy host. Registers the bundled fonts first (idempotent),
 * so the line reports exactly what the first card will draw with.
 */
export function logCanvasRendererStatus(): void {
	if (!canvasModule) {
		console.log("[canvas-renderer] unavailable (@napi-rs/canvas did not load); every card surface posts its text embed");
		return;
	}
	const fonts = describeFonts(registerRendererFonts(canvasModule));
	const store = isRenderStoreEnabled() ? "enabled" : "disabled";
	console.log(`[canvas-renderer] ready (fonts: ${fonts}, S3: ${store})`);
}

function describeFonts(registered: boolean): string {
	if (registered) return RENDERER_FONT_FAMILY;
	const missing = missingRendererFonts();
	if (missing.length > 0) return `host sans-serif, missing from assets/fonts: ${missing.join(", ")}`;
	return `host sans-serif, ${RENDERER_FONT_FAMILY} did not register`;
}
