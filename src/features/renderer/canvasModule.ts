// ── canvasModule ─────────────────────────────────────────────────────
// The one place the bot loads @napi-rs/canvas: it answers the library, or null
// on a host whose native binary did not load, and draws nothing itself. Every
// canvas consumer (monopolyRenderer, and the card pipeline in this folder that
// 2026-10 item 243 builds its surfaces on) imports the loaded module from here.
//
// ⚠️ THE CANVAS LIBRARY IS LOADED WITH A CAUGHT DYNAMIC IMPORT, NEVER A STATIC ONE.
// @napi-rs/canvas is a native binary picked per platform from optional
// dependencies; a static import of a binary the host lacks throws at module load
// and takes the whole bot down with it (the same trap @discordjs/voice's davey
// binary sets). Caught, a missing binary costs the pictures and nothing else,
// because every surface keeps its text embed (see fallback.ts).
//
// A type only import is erased at compile time and loads no binary, so the
// library's types are re-exported from here as well, and no other module needs
// to name the package at all.

export type CanvasModule = typeof import("@napi-rs/canvas");
export type { Canvas, Image, SKRSContext2D } from "@napi-rs/canvas";

type CanvasLoader = () => Promise<CanvasModule>;

const importRealCanvas: CanvasLoader = () => import("@napi-rs/canvas");

/**
 * Loads the canvas library, answering null with one warn line when the native
 * binary is missing or broken. Never throws. Takes the loader as a parameter so
 * a test can hand it one that fails without touching the module registry.
 */
export async function importCanvasModule(load: CanvasLoader = importRealCanvas): Promise<CanvasModule | null> {
	try {
		return await load();
	} catch (error) {
		console.warn("[canvas-renderer] @napi-rs/canvas did not load, so every canvas surface falls back to its text embed", error);
		return null;
	}
}

/** The loaded library, or null when its native binary did not load. Resolved once per process, at module load. */
export const canvasModule: CanvasModule | null = await importCanvasModule();
