import { COLORS } from "@base/copy/brand.js";
import { canvasColor, drawBarSegment, drawCardBackground, drawDeroPose, drawMemberFace, drawPanel, drawText, renderCard, type AvatarRequest, type DrawOutcome, type Rect, type RenderPayload } from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { drawTierMedallion } from "./achievementUnlockRenderer.js";
import { levelingCopy } from "./levelingCopy.js";
import type { AchievementProgressView } from "./levelingEmbeds.js";

// ── achievementsRenderer ───────────────────────────────────────────────────
// /account view:achievements as a card (2026-10 item 254): the member's face and
// name, Dero's prime pose, one tier medallion per held achievement with its id and
// what earned it, and the two tracks closest to unlocking as progress bars. It
// takes what buildAchievementsEmbed takes and answers the PNG, or null when the
// text view should post. achievementsView calls it through withRenderFallback.
//
// The medallion is the achievement unlock card's own (drawTierMedallion), drawn
// smaller: an unlock and a held achievement are the same mark, and no new art is
// drawn for either. A hidden track never reaches this file unless it unlocked, so
// the card cannot leak one (achievementsView filters them).

/** The avatar size the card requests. The face draws at 64 pixels. */
export const ACHIEVEMENTS_AVATAR_SIZE = 128;

// Bump whenever the drawing changes, or members keep seeing cached cards.
const ACHIEVEMENTS_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const MARGIN = 40;
const HEADER_HEIGHT = 160;
const FACE_DIAMETER = 64;
const FACE_CENTER = { x: MARGIN + FACE_DIAMETER / 2, y: MARGIN + FACE_DIAMETER / 2 };
const DERO_BOX: Rect = { x: 790, y: 12, width: 150, height: 130 };
// The most recent held achievements, four to a row; the count says the rest.
const MAX_MEDALLIONS = 8;
const MEDALLIONS_PER_ROW = 4;
const MEDALLION_COLUMN_WIDTH = (CARD_WIDTH - MARGIN * 2) / MEDALLIONS_PER_ROW;
const MEDALLION_DIAMETER = 100;
const MEDALLION_ROW_HEIGHT = 200;
const CAPTION_WIDTH = MEDALLION_COLUMN_WIDTH - 20;
const EMPTY_HEIGHT = 70;
const PROGRESS_TITLE_HEIGHT = 40;
const PROGRESS_ROW_HEIGHT = 74;
const BAR_HEIGHT = 18;
const FOOTER_SPACE = 30;

// Only what the card draws, as plain strings and numbers.
interface AchievementsCardInput {
	displayName: string;
	avatar: AvatarRequest | null;
	held: number;
	shown: Array<{ id: string; tier: string; earnedBy: string }>;
	inProgress: Array<{ line: string; current: number; threshold: number }>;
}

/** What the achievements card shows: whose, what they hold, and what they are closest to. */
export interface AchievementsCardView {
	displayName: string;
	avatar: AvatarRequest | null;
	unlocked: ReadonlyArray<{ id: string; tier: string; earnedBy: string }>;
	inProgress: readonly AchievementProgressView[];
}

/** The achievements card, or null when the text view should post. Never throws. */
export function renderAchievementsCard(view: AchievementsCardView): Promise<RenderPayload | null> {
	const input: AchievementsCardInput = {
		displayName: view.displayName,
		avatar: view.avatar,
		held: view.unlocked.length,
		shown: view.unlocked.slice(-MAX_MEDALLIONS).map((unlock) => ({ id: unlock.id, tier: String(unlock.tier), earnedBy: unlock.earnedBy })),
		inProgress: view.inProgress.map((row) => ({ line: levelingCopy.cards.inProgressLine(row.label, row.nextTier), current: row.current, threshold: row.threshold })),
	};
	return renderCard({
		kind: "achievements",
		version: ACHIEVEMENTS_CARD_VERSION,
		input,
		width: CARD_WIDTH,
		height: cardHeight(input),
		draw: drawAchievementsCard,
	});
}

function medallionRows(input: AchievementsCardInput): number {
	return Math.ceil(input.shown.length / MEDALLIONS_PER_ROW);
}

function progressTop(input: AchievementsCardInput): number {
	const rows = medallionRows(input);
	return HEADER_HEIGHT + (rows === 0 ? EMPTY_HEIGHT : rows * MEDALLION_ROW_HEIGHT);
}

function cardHeight(input: AchievementsCardInput): number {
	const progress = input.inProgress.length === 0 ? 0 : PROGRESS_TITLE_HEIGHT + input.inProgress.length * PROGRESS_ROW_HEIGHT;
	return progressTop(input) + progress + FOOTER_SPACE;
}

async function drawAchievementsCard(context: SKRSContext2D, input: AchievementsCardInput): Promise<DrawOutcome> {
	drawCardBackground(context, COLORS.ACHIEVEMENT, CARD_WIDTH / 2, HEADER_HEIGHT, CARD_WIDTH * 0.6);
	const deroStandIn = await drawDeroPose(context, "prime", DERO_BOX);
	const faceStandIn = await drawMemberFace(context, input.avatar, input.displayName, FACE_CENTER.x, FACE_CENTER.y, FACE_DIAMETER);
	drawHeader(context, input);

	if (input.shown.length === 0) {
		drawText(context, levelingCopy.labels.noAchievementsYet, {
			x: MARGIN,
			y: HEADER_HEIGHT + EMPTY_HEIGHT / 2,
			size: 22,
			color: canvasColor(COLORS.CARD_TEXT_MUTED),
			baseline: "middle",
			maxWidth: CARD_WIDTH - MARGIN * 2,
		});
	}
	input.shown.forEach((unlock, index) => drawHeld(context, unlock, index));
	drawInProgress(context, input);

	return deroStandIn || faceStandIn ? { cacheable: false } : undefined;
}

function drawHeader(context: SKRSContext2D, input: AchievementsCardInput): void {
	const textX = FACE_CENTER.x + FACE_DIAMETER / 2 + 18;
	const maxWidth = DERO_BOX.x - textX - 20;
	drawText(context, input.displayName, { x: textX, y: FACE_CENTER.y - 4, size: 30, weight: "bold", color: canvasColor(COLORS.CARD_TEXT), maxWidth });
	drawText(context, `${levelingCopy.cards.achievementsTitle} • ${levelingCopy.cards.heldCount(input.held)}`, {
		x: textX,
		y: FACE_CENTER.y + 28,
		size: 20,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		maxWidth,
	});
	const hidden = input.held - input.shown.length;
	if (hidden > 0) {
		drawText(context, levelingCopy.cards.moreUnlocks(hidden), { x: CARD_WIDTH - MARGIN, y: HEADER_HEIGHT - 12, size: 18, color: canvasColor(COLORS.CARD_TEXT_MUTED), align: "right" });
	}
}

function drawHeld(context: SKRSContext2D, unlock: AchievementsCardInput["shown"][number], index: number): void {
	const row = Math.floor(index / MEDALLIONS_PER_ROW);
	const column = index % MEDALLIONS_PER_ROW;
	const centerX = MARGIN + MEDALLION_COLUMN_WIDTH * column + MEDALLION_COLUMN_WIDTH / 2;
	const centerY = HEADER_HEIGHT + row * MEDALLION_ROW_HEIGHT + MEDALLION_DIAMETER / 2 + 10;
	drawTierMedallion(context, unlock.tier, centerX, centerY, MEDALLION_DIAMETER);
	const captionTop = centerY + MEDALLION_DIAMETER / 2;
	drawText(context, unlock.id, { x: centerX, y: captionTop + 28, size: 18, weight: "bold", color: canvasColor(COLORS.CARD_TEXT), align: "center", maxWidth: CAPTION_WIDTH });
	drawText(context, unlock.earnedBy, { x: centerX, y: captionTop + 52, size: 14, color: canvasColor(COLORS.CARD_TEXT_SECONDARY), align: "center", maxWidth: CAPTION_WIDTH });
}

function drawInProgress(context: SKRSContext2D, input: AchievementsCardInput): void {
	if (input.inProgress.length === 0) return;
	const top = progressTop(input);
	drawText(context, levelingCopy.labels.inProgress, { x: MARGIN, y: top + 28, size: 20, weight: "bold", color: canvasColor(COLORS.CARD_TEXT_SECONDARY) });
	input.inProgress.forEach((row, index) => {
		const box: Rect = { x: MARGIN, y: top + PROGRESS_TITLE_HEIGHT + index * PROGRESS_ROW_HEIGHT, width: CARD_WIDTH - MARGIN * 2, height: PROGRESS_ROW_HEIGHT - 10 };
		drawPanel(context, { ...box, radius: 14, fill: canvasColor(COLORS.CARD_PANEL) });
		drawText(context, row.line, { x: box.x + 20, y: box.y + 26, size: 18, weight: "bold", color: canvasColor(COLORS.CARD_TEXT), maxWidth: box.width - 220 });
		drawText(context, levelingCopy.cards.progressOf(row.current, row.threshold), {
			x: box.x + box.width - 20,
			y: box.y + 26,
			size: 16,
			color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
			align: "right",
		});
		drawBarSegment(context, {
			x: box.x + 20,
			y: box.y + 38,
			width: box.width - 40,
			height: BAR_HEIGHT,
			fillRatio: row.threshold > 0 ? row.current / row.threshold : 1,
			fillColor: canvasColor(COLORS.ACHIEVEMENT),
			trackColor: canvasColor(COLORS.CARD_NESTED),
		});
	});
}
