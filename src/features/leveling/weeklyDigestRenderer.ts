import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackground,
	drawDeroPose,
	drawMemberFace,
	drawPanel,
	drawText,
	renderCard,
	strokeCircle,
	type DrawOutcome,
	type Rect,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { levelingCopy } from "./levelingCopy.js";
import type { WeeklyDigestView } from "./levelingEmbeds.js";

// ── weeklyDigestRenderer ─────────────────────────────────────────────
// The weekly digest card (2026-10 item 243 Phase 4): one member's own week in
// one server, their face, the server's name, and three tiles (XP earned this
// week, their standing this week, their level), with Dero beside them.
// weeklyDigest draws it for each member it DMs, through withRenderFallback, so
// the digest embed posts on its own when the card does not draw. It reads the
// same WeeklyDigestView the embed does, so the two can never show different numbers.

/** The face draws at 120 pixels, so 128 is the smallest Discord size that keeps it sharp. */
export const WEEKLY_DIGEST_AVATAR_SIZE = 128;

// Bump whenever the drawing changes, or members keep seeing cached cards.
const WEEKLY_DIGEST_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const CARD_HEIGHT = 380;
const PADDING = 36;
const FACE_CENTER = { x: PADDING + 60, y: PADDING + 60 };
const FACE_DIAMETER = 120;
const HEADER_X = FACE_CENTER.x + FACE_DIAMETER / 2 + 28;
const DERO_BOX: Rect = { x: CARD_WIDTH - 200, y: 20, width: 180, height: 170 };
const TILE_TOP = 210;
const TILE_HEIGHT = 132;
const TILE_GAP = 20;

/** The digest card for one member's week, or null when the embed should post alone. Never throws. */
export function renderWeeklyDigestCard(view: WeeklyDigestView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "weekly-digest",
		version: WEEKLY_DIGEST_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		draw: drawWeeklyDigestCard,
	});
}

async function drawWeeklyDigestCard(context: SKRSContext2D, view: WeeklyDigestView): Promise<DrawOutcome> {
	drawCardBackground(context, COLORS.ACCOUNT, FACE_CENTER.x, FACE_CENTER.y, CARD_WIDTH * 0.6);
	const deroStandIn = await drawDeroPose(context, "account", DERO_BOX);
	const faceStandIn = await drawMemberFace(context, view.avatar, view.displayName, FACE_CENTER.x, FACE_CENTER.y, FACE_DIAMETER);
	strokeCircle(context, FACE_CENTER.x, FACE_CENTER.y, FACE_DIAMETER + 14, canvasColor(COLORS.ACCOUNT), 5);
	drawHeader(context, view);
	drawTiles(context, view);
	return deroStandIn || faceStandIn ? { cacheable: false } : undefined;
}

function drawHeader(context: SKRSContext2D, view: WeeklyDigestView): void {
	const maxWidth = DERO_BOX.x - HEADER_X - 16;
	drawText(context, levelingCopy.cards.weekRecap, {
		x: HEADER_X,
		y: FACE_CENTER.y - 34,
		size: 20,
		weight: "bold",
		color: canvasColor(COLORS.ACCOUNT),
		baseline: "middle",
		maxWidth,
	});
	drawText(context, view.displayName, {
		x: HEADER_X,
		y: FACE_CENTER.y + 4,
		size: 36,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth,
	});
	drawText(context, view.guildName, {
		x: HEADER_X,
		y: FACE_CENTER.y + 44,
		size: 22,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		baseline: "middle",
		maxWidth,
	});
}

function drawTiles(context: SKRSContext2D, view: WeeklyDigestView): void {
	const copy = levelingCopy.cards;
	const tiles = [
		{ value: copy.weekXp(view.weekXp), label: copy.weekXpLabel },
		{ value: copy.weekRank(view.weekRank, view.activeMembers), label: copy.weekRankLabel },
		{ value: copy.levelBadge(view.level), label: copy.levelLabel },
	];
	const width = (CARD_WIDTH - PADDING * 2 - TILE_GAP * (tiles.length - 1)) / tiles.length;
	tiles.forEach((tile, index) => {
		const x = PADDING + index * (width + TILE_GAP);
		drawPanel(context, { x, y: TILE_TOP, width, height: TILE_HEIGHT, radius: 20, fill: canvasColor(COLORS.CARD_PANEL) });
		drawText(context, tile.value, {
			x: x + width / 2,
			y: TILE_TOP + 54,
			size: 34,
			weight: "bold",
			color: canvasColor(COLORS.CARD_TEXT),
			align: "center",
			baseline: "middle",
			maxWidth: width - 24,
		});
		drawText(context, tile.label, {
			x: x + width / 2,
			y: TILE_TOP + 98,
			size: 20,
			color: canvasColor(COLORS.CARD_TEXT_MUTED),
			align: "center",
			baseline: "middle",
			maxWidth: width - 24,
		});
	});
}
