import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DERO_IMAGE_FILE } from "@base/copy/brand.js";
import { canvasModule, type CanvasModule } from "./canvasModule.js";
import { clearDeroArtCache, DERO_ART_FILES, defaultDeroArtRoot, loadDeroArt, logDeroArtStatus } from "./deroArt.js";

// ── deroArt ──────────────────────────────────────────────────────────
// Pins the three ways a pose can stand: present with real transparency (drawn),
// missing (the stand in), and present but OPAQUE (also the stand in, because the
// first Figma export of the lineup was exactly that and would have drawn a
// checkerboard square on every card). Each case builds its own art folder in
// the OS temp dir, so nothing reads or writes the repo's assets.

function realCanvas(): CanvasModule {
	if (!canvasModule) throw new Error("@napi-rs/canvas did not load in the test environment");
	return canvasModule;
}

// A 64 pixel pose: a filled disc on a transparent sheet, or the same disc on an
// opaque white sheet (the shape of the broken export).
async function writePose(path: string, opaque: boolean): Promise<void> {
	const surface = realCanvas().createCanvas(64, 64);
	const context = surface.getContext("2d");
	if (opaque) {
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, 64, 64);
	}
	context.fillStyle = "#4f46e5";
	context.beginPath();
	context.arc(32, 32, 20, 0, Math.PI * 2);
	context.fill();
	writeFileSync(path, await surface.encode("png"));
}

let root: string;

beforeEach(() => {
	clearDeroArtCache();
	root = mkdtempSync(join(tmpdir(), "dero-art-"));
	mkdirSync(join(root, "v2"));
	// The real bundled stand in, so the fallback decodes what production decodes.
	copyFileSync(join(defaultDeroArtRoot(), DERO_IMAGE_FILE), join(root, DERO_IMAGE_FILE));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("loadDeroArt", () => {
	it("draws a pose with real transparency as itself", async () => {
		await writePose(join(root, "v2", DERO_ART_FILES.account), false);

		const art = await loadDeroArt("account", root);

		expect(art?.standIn).toBe(false);
		expect(art?.image.width).toBe(64);
	});

	it("stands in the bundled avatar for a missing pose", async () => {
		const art = await loadDeroArt("prime", root);

		expect(art?.standIn).toBe(true);
		expect(art?.image.width).toBe(512);
	});

	it("stands in the bundled avatar for an opaque pose, and says why", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await writePose(join(root, "v2", DERO_ART_FILES.board), true);

		const art = await loadDeroArt("board", root);

		expect(art?.standIn).toBe(true);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("no transparent corner"));
	});

	it("answers null without a canvas library, rather than throwing", async () => {
		expect(await loadDeroArt("account", root, null)).toBeNull();
	});

	it("stands in for a pose whose file does not decode", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		writeFileSync(join(root, "v2", DERO_ART_FILES.levelUp), "not a png");

		const art = await loadDeroArt("levelUp", root);

		expect(art?.standIn).toBe(true);
	});
});

describe("logDeroArtStatus, the boot asset check", () => {
	it("logs every pose by file name as present, missing or opaque", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await writePose(join(root, "v2", DERO_ART_FILES.account), false);
		await writePose(join(root, "v2", DERO_ART_FILES.tiers), true);

		await logDeroArtStatus(root);

		const line = String(log.mock.calls[0]?.[0]);
		expect(line).toContain(`${DERO_ART_FILES.account} present`);
		expect(line).toContain(`${DERO_ART_FILES.tiers} opaque`);
		expect(line).toContain(`${DERO_ART_FILES.prime} missing`);
		for (const file of Object.values(DERO_ART_FILES)) expect(line).toContain(file);
	});

	it("says the cards fall back when the canvas library did not load", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await logDeroArtStatus(root, null);
		expect(String(log.mock.calls[0]?.[0])).toContain("unavailable");
	});
});
