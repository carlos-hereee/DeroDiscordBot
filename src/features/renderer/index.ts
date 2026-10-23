import { AttachmentBuilder } from "discord.js";
import { canvasModule, type CanvasModule, type SKRSContext2D } from "./canvasModule.js";
import { readCachedCard, storeCard } from "./cardCache.js";
import type { RenderPayload } from "./fallback.js";
import { missingRendererFonts, registerRendererFonts, RENDERER_FONT_FAMILY } from "./fonts.js";
import { buildRenderKey, hashRenderInput, isRenderStoreEnabled } from "./s3.js";

// ── canvas renderer ──────────────────────────────────────────────────
// The entry point of the shared card pipeline (2026-10 item 243): renderCard
// turns a surface's input and draw function into a PNG attachment, reusing the
// copy in memory or S3 when the same input was drawn before. It draws no surface
// of its own; the account, level up, game and platform cards of Phases 2 to 4
// each bring a draw function built from primitives.ts, and wrap their call site
// in withRenderFallback. main.ts calls logCanvasRendererStatus once at boot.
//
// How renderCard runs: ① no canvas library, answer null at once; ② build the
// key from the kind, the version and a hash of the input and the canvas size;
// ③ a cached PNG (memory, then S3) skips the draw; ④ otherwise draw and encode a
// PNG; ⑤ keep it in memory and upload it in the background, unless it was drawn
// with a stand in (see DrawOutcome); ⑥ answer the attachment and its ref.

export type { RenderPayload } from "./fallback.js";
export { isRenderPayload, withRenderFallback } from "./fallback.js";
export { fetchAvatar, type AvatarRequest } from "./avatarCache.js";
export { buildRenderKey, hashRenderInput } from "./s3.js";
export * from "./primitives.js";

/**
 * What a draw function may answer. Nothing, for a card drawn exactly as meant.
 * `{ cacheable: false }` when it drew a stand in, such as an avatar placeholder
 * after fetchAvatar answered null: the card still posts, but it is never cached,
 * so the next request draws it again rather than serving the stand in from an
 * immutable S3 key for as long as the input stays the same.
 */
export type DrawOutcome = void | { cacheable: false };

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
	draw: (context: SKRSContext2D, input: Input) => DrawOutcome | Promise<DrawOutcome>;
}

// How much of the input hash names the attachment: enough to tell two cards
// apart in a log line, short enough to read there.
const ATTACHMENT_HASH_LENGTH = 12;

/** The cache key one request maps to. Exported so a test can name the exact key a render uses. */
export function cardRenderKey<Input>(request: CardRenderRequest<Input>): string {
	return buildRenderKey(request.kind, request.version, cardInputHash(request));
}

// The size is hashed with the input so one surface drawn at two sizes (a full
// card and a thumbnail, say) can never be served the other size's bytes.
function cardInputHash<Input>({ input, width, height }: CardRenderRequest<Input>): string {
	return hashRenderInput({ input, width, height });
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
		const key = buildRenderKey(request.kind, request.version, inputHash);
		const png = (await readCachedCard(key)) ?? (await drawCard(canvasModule, request, key));
		const name = `${request.kind}-${inputHash.slice(0, ATTACHMENT_HASH_LENGTH)}.png`;
		return { attachment: new AttachmentBuilder(png, { name }), ref: `attachment://${name}` };
	} catch (error) {
		console.warn(`[canvas-renderer] the ${request.kind} card failed to render, so its surface posts the text embed`, error);
		return null;
	}
}

async function drawCard<Input>(canvas: CanvasModule, request: CardRenderRequest<Input>, key: string): Promise<Buffer> {
	const fontsReady = registerRendererFonts(canvas);
	const surface = canvas.createCanvas(request.width, request.height);
	const outcome = await request.draw(surface.getContext("2d"), request.input);
	const png = await surface.encode("png");
	// A card drawn in the host's fallback font is a stand in too: caching it would
	// keep serving the off brand card after a deploy that restores the fonts.
	if (fontsReady && !isUncacheable(outcome)) {
		// Not awaited: the card is ready to post now, and the S3 upload inside
		// storeCard logs its own failure rather than rejecting.
		void storeCard(key, png);
	}
	return png;
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
