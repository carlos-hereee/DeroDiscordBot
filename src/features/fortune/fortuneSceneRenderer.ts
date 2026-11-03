import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackground,
	drawMemberFace,
	drawPill,
	drawText,
	fillCircle,
	fillRadialGradient,
	renderCard,
	strokeCircle,
	strokeLine,
	withAlpha,
	type AvatarRequest,
	type DrawOutcome,
	type Point,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { fortuneCopy } from "./fortuneCopy.js";
import type { FortuneTier } from "./fortunes.js";

// ── fortuneSceneRenderer ─────────────────────────────────────────────
// The fortune reading as one scene (2026-10 item 243 Phase 4): the asker's face,
// the crystal orb with the verdict in its window, and Dero's hand cupped under
// it. respondWithFortune draws it through withRenderFallback and, when it draws,
// it takes the embed's image slot; otherwise the reading posts exactly as before,
// with the pre rendered orb GIF from assets/fortune/orbs.
//
// The orb is DRAWN rather than lifted from that GIF: the GIF's first frame shows
// the question mark before the reveal, so a still taken from it would never show
// the verdict. The verdict and tier come from rollFortune, so the scene can never
// print a different answer than the embed text.

/** Everything the scene draws, as plain data. */
export interface FortuneSceneView {
	tier: FortuneTier;
	/** The terse die line, "IT IS CERTAIN", already uppercase in fortunes.ts. */
	verdict: string;
	displayName: string;
	avatar: AvatarRequest | null;
}

/** The face draws at 88 pixels, so 128 is the smallest Discord size that keeps it sharp. */
export const FORTUNE_SCENE_AVATAR_SIZE = 128;

// Bump whenever the drawing changes, or members keep seeing cached cards.
const FORTUNE_SCENE_VERSION = 1;
const CARD_WIDTH = 720;
const CARD_HEIGHT = 520;
const PADDING = 32;
const FACE_DIAMETER = 88;
const FACE_CENTER = { x: PADDING + FACE_DIAMETER / 2, y: PADDING + FACE_DIAMETER / 2 };
const ORB_CENTER = { x: CARD_WIDTH / 2, y: 250 };
const ORB_DIAMETER = 260;
const WINDOW_DIAMETER = 150;
// The verdict wraps two words to a line, which keeps every die line in
// fortunes.ts (up to four words) inside the window.
const WORDS_PER_LINE = 2;
const VERDICT_LINE_HEIGHT = 30;
// Dero's cupped hands: one thick rounded stroke hugging the lower part of the
// orb, from CRADLE_START to CRADLE_END degrees (0 is the orb's right, 90 straight
// down), with a fingertip at each end. Drawn with strokeLine through points on
// the arc, so it is the gallows' primitive rather than a new shape.
const CRADLE_START_DEGREES = 15;
const CRADLE_END_DEGREES = 165;
const CRADLE_STEPS = 24;
const CRADLE_WIDTH = 40;
const CRADLE_INSET = 6;
const FINGERTIP_DIAMETER = 50;

const TIER_ACCENT: Record<FortuneTier, ColorResolvable> = {
	common: COLORS.FORTUNE,
	ultra: COLORS.FORTUNE_ULTRA,
};

/** The fortune scene for one reading, or null when the reading should post its orb GIF. Never throws. */
export function renderFortuneScene(view: FortuneSceneView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "fortune-scene",
		version: FORTUNE_SCENE_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		draw: drawFortuneScene,
	});
}

async function drawFortuneScene(context: SKRSContext2D, view: FortuneSceneView): Promise<DrawOutcome> {
	const accent = TIER_ACCENT[view.tier];
	drawCardBackground(context, accent, ORB_CENTER.x, ORB_CENTER.y, CARD_WIDTH * 0.7);
	const faceStandIn = await drawMemberFace(context, view.avatar, view.displayName, FACE_CENTER.x, FACE_CENTER.y, FACE_DIAMETER);
	drawAsker(context, view);
	drawOrb(context, accent, view.verdict);
	drawCradle(context);
	return faceStandIn ? { cacheable: false } : undefined;
}

function drawAsker(context: SKRSContext2D, view: FortuneSceneView): void {
	const textX = FACE_CENTER.x + FACE_DIAMETER / 2 + 20;
	drawText(context, fortuneCopy.scene.askedBy, {
		x: textX,
		y: FACE_CENTER.y - 16,
		size: 18,
		color: canvasColor(COLORS.CARD_TEXT_MUTED),
		baseline: "middle",
	});
	drawText(context, view.displayName, {
		x: textX,
		y: FACE_CENTER.y + 16,
		size: 26,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: CARD_WIDTH - textX - PADDING - 150,
	});
	if (view.tier !== "ultra") return;
	drawPill(context, {
		x: CARD_WIDTH - PADDING - 130,
		y: FACE_CENTER.y - 20,
		width: 130,
		height: 40,
		fill: canvasColor(COLORS.FORTUNE_ULTRA),
		label: fortuneCopy.scene.ultraBadge,
		labelColor: canvasColor(COLORS.CARD_BACKGROUND),
	});
}

// The sphere is three washes clipped by their own falloff: the tier's color
// glowing out of the middle, a dark rim at the edge, and a small white highlight
// up and to the left, which is what makes a flat disc read as glass.
function drawOrb(context: SKRSContext2D, accent: ColorResolvable, verdict: string): void {
	const radius = ORB_DIAMETER / 2;
	context.save();
	context.beginPath();
	context.arc(ORB_CENTER.x, ORB_CENTER.y, radius, 0, Math.PI * 2);
	context.clip();
	fillRadialGradient(context, {
		centerX: ORB_CENTER.x,
		centerY: ORB_CENTER.y,
		innerRadius: 0,
		outerRadius: radius,
		stops: [
			{ offset: 0, color: withAlpha(accent, 0.95) },
			{ offset: 0.7, color: withAlpha(accent, 0.6) },
			{ offset: 1, color: canvasColor(COLORS.CARD_BACKGROUND) },
		],
	});
	fillRadialGradient(context, {
		centerX: ORB_CENTER.x - radius * 0.38,
		centerY: ORB_CENTER.y - radius * 0.42,
		innerRadius: 0,
		outerRadius: radius * 0.45,
		stops: [
			{ offset: 0, color: withAlpha(COLORS.CARD_TEXT, 0.55) },
			{ offset: 1, color: withAlpha(COLORS.CARD_TEXT, 0) },
		],
	});
	context.restore();
	strokeCircle(context, ORB_CENTER.x, ORB_CENTER.y, ORB_DIAMETER, withAlpha(COLORS.CARD_TEXT, 0.35), 3);
	drawVerdictWindow(context, accent, verdict);
}

function drawVerdictWindow(context: SKRSContext2D, accent: ColorResolvable, verdict: string): void {
	fillCircle(context, ORB_CENTER.x, ORB_CENTER.y, WINDOW_DIAMETER, canvasColor(COLORS.CARD_BACKGROUND));
	strokeCircle(context, ORB_CENTER.x, ORB_CENTER.y, WINDOW_DIAMETER, canvasColor(accent), 3);
	const lines = verdictLines(verdict);
	const top = ORB_CENTER.y - ((lines.length - 1) * VERDICT_LINE_HEIGHT) / 2;
	lines.forEach((line, index) => {
		drawText(context, line, {
			x: ORB_CENTER.x,
			y: top + index * VERDICT_LINE_HEIGHT,
			size: 24,
			weight: "bold",
			color: canvasColor(COLORS.CARD_TEXT),
			align: "center",
			baseline: "middle",
			maxWidth: WINDOW_DIAMETER - 24,
		});
	});
}

/** The verdict split two words to a line, as the orb window prints it. */
export function verdictLines(verdict: string): string[] {
	const words = verdict.trim().split(/\s+/).filter((word) => word.length > 0);
	const lines: string[] = [];
	for (let start = 0; start < words.length; start += WORDS_PER_LINE) lines.push(words.slice(start, start + WORDS_PER_LINE).join(" "));
	return lines;
}

// In front of the orb, so the lower rim sits inside the hands rather than on top
// of them; the verdict window stays clear, since the cradle stays below it.
function drawCradle(context: SKRSContext2D): void {
	const radius = ORB_DIAMETER / 2 + CRADLE_INSET;
	const points: Point[] = [];
	for (let step = 0; step <= CRADLE_STEPS; step += 1) {
		const degrees = CRADLE_START_DEGREES + ((CRADLE_END_DEGREES - CRADLE_START_DEGREES) * step) / CRADLE_STEPS;
		const radians = (degrees * Math.PI) / 180;
		points.push({ x: ORB_CENTER.x + radius * Math.cos(radians), y: ORB_CENTER.y + radius * Math.sin(radians) });
	}
	const fill = canvasColor(COLORS.CARD_TEXT_MUTED);
	strokeLine(context, points, { color: fill, lineWidth: CRADLE_WIDTH });
	const first = points[0];
	const last = points[points.length - 1];
	if (first) fillCircle(context, first.x, first.y, FINGERTIP_DIAMETER, fill);
	if (last) fillCircle(context, last.x, last.y, FINGERTIP_DIAMETER, fill);
}
