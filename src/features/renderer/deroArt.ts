import { existsSync } from "node:fs";
import { join } from "node:path";
import { DERO_IMAGE_FILE } from "@base/copy/brand.js";
import { canvasModule, type CanvasModule, type Image } from "./canvasModule.js";

// ── deroArt ──────────────────────────────────────────────────────────
// The Dero v2 lineup every card draws its mascot from: one manifest naming the
// seven poses, and a loader that answers the pose's decoded image or, while the
// pose is not usable, the bundled Dero avatar as a stand in. It never throws and
// never draws. The leveling cards of 2026-10 item 243 Phase 2 call loadDeroArt,
// Phases 3 and 4 will too, and main.ts calls logDeroArtStatus once at boot.
//
// ⚠️ A POSE WITHOUT TRANSPARENCY COUNTS AS MISSING. The first export of this
// lineup (Figma JTsYp8bOK76ksA5YLBPHa6, 2026-10-23) came out fully opaque: five
// frames had a checkerboard painted into the pixels and two had a white sheet,
// so each would have drawn as a square on a dark card. The loader samples the
// pose's corners, and an opaque corner sends that slot to the stand in and the
// boot line names it, so a repeat of that export cannot reach a member's card.
//
// The caller decides caching: a stand in reports `standIn: true`, and the card
// answers `{ cacheable: false }` from its draw (see DrawOutcome in index.ts), so
// the real pose replaces the stand in as soon as it lands on disk and deploys.

const DERO_ART_DIR = join("assets", "dero");
const DERO_V2_DIR = "v2";

// Relative to assets/dero/v2/. The Figma frame each pose was exported from rides
// beside it, so a re-export knows which frame lands in which file.
export const DERO_ART_FILES = {
	account: "dero-v2-account.png", // frame 1:2, the /account default
	battle: "dero-v2-battle.png", // frame 2:2, arcade and battle surfaces (Phase 3)
	welcome: "dero-v2-welcome.png", // frame 3:2, the greeter's welcome card (Phase 4)
	board: "dero-v2-board.png", // frame 4:2, the levels board header
	levelUp: "dero-v2-levelup.png", // frame 5:2, an ordinary level up
	prime: "dero-v2-prime.png", // frame 7:2, a prime milestone and an achievement unlock
	tiers: "dero-v2-tiers.png", // frame 8:2, the six color rank tiers in one strip
} as const satisfies Record<string, string>;

export type DeroArtSlot = keyof typeof DERO_ART_FILES;

const ALL_SLOTS = Object.keys(DERO_ART_FILES) as DeroArtSlot[];

/** A decoded pose, and whether it is the bundled avatar standing in for the real one. */
export interface DeroArt {
	image: Image;
	standIn: boolean;
}

type PoseState = "present" | "missing" | "opaque";

// The corner sample is drawn at this size: small enough to cost nothing, large
// enough that a transparent margin of a few percent still reaches the corner pixel.
const CORNER_SAMPLE_SIZE = 16;
const FULLY_OPAQUE = 255;

// Decoded once per process, keyed by the art root and the slot. A deploy restarts
// the process, which is also how new art reaches Railway, so nothing here needs
// to notice a file changing on disk.
const poses = new Map<string, Promise<Image | null>>();
const standIns = new Map<string, Promise<Image | null>>();

/** Where the Dero art lives: the project's assets/dero, or a test's own folder. */
export function defaultDeroArtRoot(): string {
	return join(process.cwd(), DERO_ART_DIR);
}

/**
 * The pose for a slot, or the bundled avatar standing in for it while the pose
 * is missing, unreadable or opaque. Null only when the canvas library did not
 * load or even the stand in cannot be decoded. Never throws.
 */
export async function loadDeroArt(slot: DeroArtSlot, root: string = defaultDeroArtRoot(), canvas: CanvasModule | null = canvasModule): Promise<DeroArt | null> {
	if (!canvas) return null;
	const pose = await cached(poses, `${root}:${slot}`, () => decodeUsablePose(canvas, posePath(root, slot)));
	if (pose) return { image: pose, standIn: false };
	const standIn = await cached(standIns, root, () => decodeQuietly(canvas, join(root, DERO_IMAGE_FILE)));
	return standIn ? { image: standIn, standIn: true } : null;
}

/** Forget every decoded pose, so a test can swap the files between cases. */
export function clearDeroArtCache(): void {
	poses.clear();
	standIns.clear();
}

/**
 * One boot line naming every pose as present, missing or opaque, so the owner
 * can confirm an art drop landed. Fire and forget: it decodes each present file
 * to check its corners, and logs rather than throwing.
 */
export async function logDeroArtStatus(root: string = defaultDeroArtRoot(), canvas: CanvasModule | null = canvasModule): Promise<void> {
	try {
		if (!canvas) {
			console.log("[dero-art] unavailable (@napi-rs/canvas did not load); cards post their text embeds");
			return;
		}
		const states = await Promise.all(ALL_SLOTS.map(async (slot) => `${DERO_ART_FILES[slot]} ${await poseState(canvas, root, slot)}`));
		console.log(`[dero-art] v2 lineup in assets/dero/v2: ${states.join(", ")}; a pose that is not present draws the stand in ${DERO_IMAGE_FILE}`);
	} catch (error) {
		console.warn("[dero-art] the boot check of the Dero v2 lineup failed", error);
	}
}

async function poseState(canvas: CanvasModule, root: string, slot: DeroArtSlot): Promise<PoseState> {
	const path = posePath(root, slot);
	if (!existsSync(path)) return "missing";
	const image = await decodeQuietly(canvas, path);
	if (!image) return "missing";
	return hasTransparentCorner(canvas, image) ? "present" : "opaque";
}

function posePath(root: string, slot: DeroArtSlot): string {
	return join(root, DERO_V2_DIR, DERO_ART_FILES[slot]);
}

async function decodeUsablePose(canvas: CanvasModule, path: string): Promise<Image | null> {
	if (!existsSync(path)) return null;
	const image = await decodeQuietly(canvas, path);
	if (!image) return null;
	if (hasTransparentCorner(canvas, image)) return image;
	console.warn(`[dero-art] ${path} has no transparent corner, so its cards draw the stand in until it is exported with real transparency`);
	return null;
}

async function decodeQuietly(canvas: CanvasModule, path: string): Promise<Image | null> {
	if (!existsSync(path)) return null;
	try {
		return await canvas.loadImage(path);
	} catch (error) {
		console.warn(`[dero-art] ${path} did not decode, so its cards draw the stand in`, error);
		return null;
	}
}

// A mascot on a transparent sheet has see-through corners. Checking all four
// rather than one keeps a pose that touches one edge (a cape, a raised fist)
// from reading as opaque.
function hasTransparentCorner(canvas: CanvasModule, image: Image): boolean {
	const sample = canvas.createCanvas(CORNER_SAMPLE_SIZE, CORNER_SAMPLE_SIZE).getContext("2d");
	sample.drawImage(image, 0, 0, CORNER_SAMPLE_SIZE, CORNER_SAMPLE_SIZE);
	const last = CORNER_SAMPLE_SIZE - 1;
	const corners: Array<[number, number]> = [
		[0, 0],
		[last, 0],
		[0, last],
		[last, last],
	];
	return corners.some(([x, y]) => sample.getImageData(x, y, 1, 1).data[3] < FULLY_OPAQUE);
}

// A failed decode is not cached as a rejection: decodeQuietly already answers
// null for it, and that null is cached, so a bad file is logged once per process.
function cached(store: Map<string, Promise<Image | null>>, key: string, load: () => Promise<Image | null>): Promise<Image | null> {
	const existing = store.get(key);
	if (existing) return existing;
	const loading = load();
	store.set(key, loading);
	return loading;
}
