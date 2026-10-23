import { createRequire } from "node:module";

// ── gif ──────────────────────────────────────────────────────────────
// Encodes a run of RGBA frames into one looping GIF with gifenc. It knows
// nothing about cards or canvases; renderCard hands it the pixels of each frame
// it drew when a request asks for an animation (the prime level up card of
// 2026-10 item 243 Phase 2, the only animated card). It throws on a bad frame,
// and renderCard turns that throw into a null like any other failed render.
//
// ⚠️ gifenc IS LOADED WITH require, NOT import. It ships a CommonJS main and an
// ESM "module" build whose default export differ: the CommonJS default is the
// whole API, the ESM default is the GIFEncoder function alone, and Node's ESM
// loader cannot see the CommonJS named exports at all. require always answers
// the CommonJS object under Node and Vitest alike, so the one shape below holds
// everywhere. The package carries no types, so that shape is declared here.

interface GifFrameOptions {
	palette: number[][];
	delay: number;
	repeat: number;
	transparent: boolean;
	transparentIndex: number;
}

interface GifEncoder {
	writeFrame(index: Uint8Array, width: number, height: number, options: GifFrameOptions): void;
	finish(): void;
	bytes(): Uint8Array;
}

interface GifencModule {
	GIFEncoder: () => GifEncoder;
	quantize: (rgba: Uint8Array | Uint8ClampedArray, maxColors: number) => number[][];
	applyPalette: (rgba: Uint8Array | Uint8ClampedArray, palette: number[][]) => Uint8Array;
}

const gifenc = createRequire(import.meta.url)("gifenc") as GifencModule;

// A GIF frame holds at most 256 colors. One is kept back as the transparent slot
// (see markTransparentPixels), so the quantizer gets the other 255, built per
// frame from that frame's own pixels to keep a gradient's banding to a minimum.
const GIF_PALETTE_SIZE = 256;
const GIF_OPAQUE_COLORS = GIF_PALETTE_SIZE - 1;
// gifenc's repeat option: 0 loops forever, which is what a celebration should do.
const LOOP_FOREVER = 0;
// The RGB the transparent slot carries. Never shown, since the slot is see through.
const TRANSPARENT_SLOT_COLOR = [0, 0, 0];

export interface GifFrames {
	width: number;
	height: number;
	/** Each frame's pixels as RGBA, width times height times 4 bytes, in play order. */
	frames: readonly (Uint8Array | Uint8ClampedArray)[];
	/** How long each frame shows, in milliseconds. */
	frameDelayMs: number;
}

/** The frames as one looping GIF. Throws when there are no frames or a frame is the wrong size. */
export function encodeGif({ width, height, frames, frameDelayMs }: GifFrames): Buffer {
	if (frames.length === 0) throw new Error("encodeGif was handed no frames");
	const expectedBytes = width * height * 4;
	const encoder = gifenc.GIFEncoder();
	frames.forEach((rgba, index) => {
		if (rgba.length !== expectedBytes) {
			throw new Error(`GIF frame ${index} holds ${rgba.length} bytes, expected ${expectedBytes} for ${width} by ${height}`);
		}
		const palette = gifenc.quantize(rgba, GIF_OPAQUE_COLORS);
		const indexed = gifenc.applyPalette(rgba, palette);
		const transparentIndex = palette.length;
		markTransparentPixels(rgba, indexed, transparentIndex);
		encoder.writeFrame(indexed, width, height, {
			palette: [...palette, TRANSPARENT_SLOT_COLOR],
			delay: frameDelayMs,
			repeat: LOOP_FOREVER,
			transparent: true,
			transparentIndex,
		});
	});
	encoder.finish();
	return Buffer.from(encoder.bytes());
}

// A card's rounded corners are fully transparent. The default RGB palette has no
// alpha, so applyPalette maps them to the nearest dark color and they would show
// as black corners in Discord's grey; pointing them at the reserved slot keeps
// them see through. gifenc's alpha format would do it too, but at 4 bits a
// channel, which bands every glow on the card.
function markTransparentPixels(rgba: Uint8Array | Uint8ClampedArray, indexed: Uint8Array, transparentIndex: number): void {
	for (let pixel = 0; pixel < indexed.length; pixel += 1) {
		if (rgba[pixel * 4 + 3] === 0) indexed[pixel] = transparentIndex;
	}
}
