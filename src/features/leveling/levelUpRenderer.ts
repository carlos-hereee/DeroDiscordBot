import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawPill,
	drawText,
	fillCircle,
	renderCard,
	type AvatarRequest,
	type CardAnimation,
	type CardFrame,
	type CardRenderRequest,
	type DrawOutcome,
	type RenderPayload,
	type Rect,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { drawCardBackground, drawDeroPose, drawMemberFace } from "./levelingCardParts.js";
import { levelingCopy } from "./levelingCopy.js";
import type { LevelUpView } from "./levelingEmbeds.js";
import { isMilestone } from "./primeLevels.js";

// ── levelUpRenderer ────────────────────────────────────────────────────────
// The milestone level up as a card: Dero's pose, the level in large type, a tag
// saying what kind of milestone it is, and the member's face and name. A PRIME
// level is a short looping GIF (the glow breathes and sparks circle Dero); a
// milestone that is not prime (a guild on the "every N levels" mode) is a still
// PNG. The ordinary level up never reaches here: it stays one compact line.
// levelUpAnnouncer's milestone card calls renderLevelUpCard through
// withRenderFallback, and the embed it wraps carries the rendered image.

/** The avatar size the level up card requests. The face draws at 72 pixels. */
export const LEVEL_UP_AVATAR_SIZE = 128;

// Bump whenever the drawing changes, or members keep seeing cached cards.
const LEVEL_UP_CARD_VERSION = 1;
const CARD_WIDTH = 900;
const CARD_HEIGHT = 360;
const DERO_BOX: Rect = { x: 30, y: 20, width: 320, height: 320 };
const DERO_CENTER = { x: DERO_BOX.x + DERO_BOX.width / 2, y: DERO_BOX.y + DERO_BOX.height / 2 };
const TEXT_X = 380;
const FACE_DIAMETER = 72;
// GIF encoding costs roughly ten times a PNG per frame, so the loop is short:
// twelve frames at 90 ms is about a second, long enough to read as alive.
const PRIME_ANIMATION: CardAnimation = { frameCount: 12, frameDelayMs: 90 };
const GLOW_RADIUS = 260;
// How far the glow swells and settles across one loop, as a share of its radius.
const GLOW_PULSE = 0.18;
const SPARK_COUNT = 8;
const SPARK_DIAMETER = 10;
const SPARK_ORBIT = { radiusX: 175, radiusY: 150 };

// Only what the card draws. The description is left out on purpose: it holds
// mentions a card cannot draw, and hashing it would split the cache per guild
// template for no visible difference.
interface LevelUpCardInput {
	level: number;
	prime: boolean;
	displayName: string;
	avatar: AvatarRequest | null;
}

/**
 * The milestone level up card, or null when the embed with Dero's still art
 * should post. A prime level is tried as a GIF first and falls back to the PNG
 * if the GIF cannot be made, so an encoder failure costs the motion, not the card.
 */
export async function renderLevelUpCard(view: LevelUpView): Promise<RenderPayload | null> {
	const input: LevelUpCardInput = {
		level: view.level,
		prime: isMilestone(view.level),
		displayName: view.displayName ?? "",
		avatar: view.avatar ?? null,
	};
	if (input.prime) {
		const animated = await renderCard({ ...cardRequest(input), animation: PRIME_ANIMATION });
		if (animated) return animated;
	}
	return renderCard(cardRequest(input));
}

function cardRequest(input: LevelUpCardInput): CardRenderRequest<LevelUpCardInput> {
	return {
		kind: "level-up",
		version: LEVEL_UP_CARD_VERSION,
		input,
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		draw: drawLevelUpCard,
	};
}

async function drawLevelUpCard(context: SKRSContext2D, input: LevelUpCardInput, frame: CardFrame): Promise<DrawOutcome> {
	const phase = (frame.index / frame.count) * Math.PI * 2;
	const glow = GLOW_RADIUS * (1 + GLOW_PULSE * Math.sin(phase));
	drawCardBackground(context, COLORS.LEVEL_MILESTONE, DERO_CENTER.x, DERO_CENTER.y, glow);
	if (input.prime) drawSparks(context, phase);

	const deroStandIn = await drawDeroPose(context, input.prime ? "prime" : "levelUp", DERO_BOX);
	drawPill(context, {
		x: TEXT_X,
		y: 56,
		width: 250,
		height: 40,
		fill: canvasColor(COLORS.LEVEL_MILESTONE),
		label: input.prime ? levelingCopy.cards.primeLevel : levelingCopy.cards.milestoneLevel,
	});
	drawText(context, levelingCopy.cards.levelBadge(input.level), {
		x: TEXT_X,
		y: 190,
		size: 88,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		maxWidth: CARD_WIDTH - TEXT_X - 40,
	});

	const faceCenter = { x: TEXT_X + FACE_DIAMETER / 2, y: 268 };
	const faceStandIn = await drawMemberFace(context, input.avatar, input.displayName, faceCenter.x, faceCenter.y, FACE_DIAMETER);
	drawText(context, input.displayName, {
		x: TEXT_X + FACE_DIAMETER + 20,
		y: faceCenter.y,
		size: 30,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		baseline: "middle",
		maxWidth: CARD_WIDTH - TEXT_X - FACE_DIAMETER - 60,
	});

	return deroStandIn || faceStandIn ? { cacheable: false } : undefined;
}

// Sparks orbit Dero on an ellipse, each a step further round per frame, so the
// loop closes seamlessly when the last frame hands back to the first.
function drawSparks(context: SKRSContext2D, phase: number): void {
	const spark = canvasColor(COLORS.ACHIEVEMENT_GOLD);
	for (let index = 0; index < SPARK_COUNT; index += 1) {
		const angle = phase / 2 + (index / SPARK_COUNT) * Math.PI * 2;
		const x = DERO_CENTER.x + Math.cos(angle) * SPARK_ORBIT.radiusX;
		const y = DERO_CENTER.y + Math.sin(angle) * SPARK_ORBIT.radiusY;
		fillCircle(context, x, y, SPARK_DIAMETER, spark);
	}
}
