import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DERO_IMAGE_FILE, DERO_V1_DIR } from "@base/copy/brand.js";
import { canvasModule, type CanvasModule } from "./canvasModule.js";
import { clearDeroArtCache, DERO_ART_FILES, defaultDeroArtRoot, deroArtAttachment, loadDeroArt, logDeroArtStatus, standInPath } from "./deroArt.js";

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
	mkdirSync(join(root, DERO_V1_DIR));
	// The real bundled stand in, so the fallback decodes what production decodes.
	copyFileSync(standInPath(defaultDeroArtRoot()), standInPath(root));
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
	// Every card slot draws the one mecha file today, so the line names each file once.
	it.each([
		["present", false],
		["opaque", true],
		["missing", null],
	] as const)("logs the lineup's file as %s, once however many slots share it", async (state, opaque) => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		if (opaque !== null) await writePose(join(root, "v2", DERO_ART_FILES.account), opaque);

		await logDeroArtStatus(root);

		const line = String(log.mock.calls[0]?.[0]);
		expect(line).toContain(`${DERO_ART_FILES.account} ${state}`);
		expect(line.split(DERO_ART_FILES.account)).toHaveLength(2);
		expect(line).toContain(`${DERO_V1_DIR}/${DERO_IMAGE_FILE}`);
	});

	it("says the cards fall back when the canvas library did not load", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await logDeroArtStatus(root, null);
		expect(String(log.mock.calls[0]?.[0])).toContain("unavailable");
	});

	// The repo's own assets/dero/v2, read the way a dev boot reads it (2026-10
	// item 245 Phase 3b), so an opaque re-export of the lineup fails here first.
	it("finds every pose of the committed lineup present", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await logDeroArtStatus();

		const line = String(log.mock.calls[0]?.[0]);
		for (const file of Object.values(DERO_ART_FILES)) expect(line).toContain(`${file} present`);
	});
});

// The welcome alone moved to the wide banner (2026-10 item 254 Phase 5a): Discord sizes an
// embed to its large image, so a square welcome squeezed the text into a narrow column.
// The six card slots draw the square mecha, whose layout every card was measured on.
describe("DERO_ART_FILES, the slot map", () => {
	it("points only the welcome at the 3:2 banner and every card slot at the mecha", () => {
		const { welcome, ...cardSlots } = DERO_ART_FILES;
		expect(welcome).toBe("welcome-banner.png");
		expect(Object.keys(cardSlots).sort()).toEqual(["account", "battle", "board", "levelUp", "prime", "tiers"]);
		for (const file of Object.values(cardSlots)) expect(file).toBe("mecha-dero.png");
	});

	it("ships a welcome banner of 1200 by 800 with transparent corners", async () => {
		const banner = await realCanvas().loadImage(join(defaultDeroArtRoot(), "v2", DERO_ART_FILES.welcome));
		expect({ width: banner.width, height: banner.height }).toEqual({ width: 1200, height: 800 });
		const sample = realCanvas().createCanvas(banner.width, banner.height).getContext("2d");
		sample.drawImage(banner, 0, 0);
		for (const [x, y] of [[0, 0], [1199, 0], [0, 799], [1199, 799]]) expect(sample.getImageData(x, y, 1, 1).data[3]).toBe(0);
	});
});

describe("deroArtAttachment, a pose sent whole", () => {
	it("attaches a pose on disk under its own file name", async () => {
		await writePose(join(root, "v2", DERO_ART_FILES.welcome), false);

		const pose = deroArtAttachment("welcome", root);

		expect(pose?.ref).toBe(`attachment://${DERO_ART_FILES.welcome}`);
		expect(pose?.attachment.name).toBe(DERO_ART_FILES.welcome);
	});

	it("answers null for a pose that is not on disk, so the caller keeps its fallback", () => {
		expect(deroArtAttachment("welcome", root)).toBeNull();
	});
});
