import { existsSync } from "node:fs";
import { join } from "node:path";
import { canvasModule, type CanvasModule } from "./canvasModule.js";

// ── fonts ────────────────────────────────────────────────────────────
// Registers the bundled Inter faces with the canvas library and builds the font
// string every card draws its text with. It never fails a render: with a font
// file or the library missing, text falls back to the host's sans-serif and the
// card still draws, only off brand. renderCard and logCanvasRendererStatus call
// registerRendererFonts, which is idempotent.
//
// Both files register under ONE family alias, so a renderer asks for
// `bold 24px Inter` and Skia picks the 700 face by the weight stored inside the
// file. The files are Google Fonts' static Inter at the 18pt optical size (the
// text cut, which suits card text), renamed on the way in. assets/fonts/OFL.txt
// is the SIL Open Font License, which must travel with the files.

export const RENDERER_FONT_FAMILY = "Inter";

// Relative to assets/fonts/. The same manifest shape as gamesAssets: one
// declaration of every file, and a resolver that answers null while a file is
// not on disk, so nothing builds a path into assets/fonts/ by hand.
export const RENDERER_FONT_FILES = {
	regular: "inter-regular.ttf",
	bold: "inter-bold.ttf",
} as const satisfies Record<string, string>;

export type RendererFontWeight = keyof typeof RENDERER_FONT_FILES;

const ALL_FONT_WEIGHTS = Object.keys(RENDERER_FONT_FILES) as RendererFontWeight[];

const CSS_FONT_WEIGHT: Record<RendererFontWeight, string> = {
	regular: "normal",
	bold: "bold",
};

// Where Skia looks for a glyph Inter does not carry (emoji, CJK), and for every
// glyph when Inter did not register. Which faces answer is up to the host.
const FALLBACK_FAMILY = "sans-serif";

// The faces already registered in this process. renderCard calls
// registerRendererFonts before every draw, and this Set is what keeps that call
// from repeating a disk stat and a native registration each time. (A repeat
// would be harmless, only wasted: the library hands back the same typeface id.)
const registeredWeights = new Set<RendererFontWeight>();

/** The absolute path of one bundled face, or null while the file is not on disk. */
export function rendererFontPath(weight: RendererFontWeight): string | null {
	const absolute = join(process.cwd(), "assets", "fonts", RENDERER_FONT_FILES[weight]);
	return existsSync(absolute) ? absolute : null;
}

/** Which bundled faces are missing from assets/fonts/, for the boot line. */
export function missingRendererFonts(): string[] {
	return ALL_FONT_WEIGHTS.filter((weight) => rendererFontPath(weight) === null).map((weight) => RENDERER_FONT_FILES[weight]);
}

/**
 * Registers every bundled Inter face not registered yet, and answers whether the
 * whole family (regular and bold) is now available. Cheap to call on every
 * render: after the first success it only reads a Set.
 */
export function registerRendererFonts(canvas: CanvasModule | null = canvasModule): boolean {
	if (!canvas) return false;
	for (const weight of ALL_FONT_WEIGHTS) {
		if (registeredWeights.has(weight)) continue;
		const path = rendererFontPath(weight);
		if (path && canvas.GlobalFonts.registerFromPath(path, RENDERER_FONT_FAMILY)) registeredWeights.add(weight);
	}
	return registeredWeights.size === ALL_FONT_WEIGHTS.length;
}

/** The canvas font shorthand for one line of text: Inter at `sizePx`, then the host's sans-serif. */
export function rendererFont(sizePx: number, weight: RendererFontWeight = "regular"): string {
	return `${CSS_FONT_WEIGHT[weight]} ${sizePx}px ${RENDERER_FONT_FAMILY}, ${FALLBACK_FAMILY}`;
}
