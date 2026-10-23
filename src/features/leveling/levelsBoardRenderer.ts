import { COLORS } from "@base/copy/brand.js";
import { canvasColor, drawPanel, drawPill, drawText, fetchAvatar, renderCard, type AvatarRequest, type DrawOutcome, type RenderPayload, type Rect } from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { drawCardBackground, drawDeroPose, drawMemberFace } from "./levelingCardParts.js";
import { levelingCopy } from "./levelingCopy.js";
import type { LevelsBoardEntry } from "./levelingEmbeds.js";

// ── levelsBoardRenderer ────────────────────────────────────────────────────
// The levels standings board as a card: a header naming the board and the
// question it answers, Dero's board pose, and one row per member (rank, face,
// name, level and XP). It takes the same window label and entries
// buildLevelsBoardEmbed takes and answers the PNG, or null when the text board
// should post. LevelsBoard.refreshLevelsBoard calls it through withRenderFallback.

/** The avatar size the board requests per row. Each face draws at 44 pixels. */
export const LEVELS_BOARD_AVATAR_SIZE = 64;

// Bump whenever the drawing changes, or members keep seeing cached cards.
const LEVELS_BOARD_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const MARGIN = 40;
const HEADER_HEIGHT = 150;
const ROW_HEIGHT = 60;
const ROW_GAP = 12;
const FOOTER_SPACE = 28;
const DERO_BOX: Rect = { x: 810, y: 12, width: 130, height: 130 };
const RANK_CENTER_X = MARGIN + 32;
const FACE_DIAMETER = 44;
const FACE_CENTER_X = MARGIN + 92;
const NAME_X = FACE_CENTER_X + FACE_DIAMETER / 2 + 18;
const LEVEL_PILL = { x: 590, width: 140, height: 36 };
const ROW_RADIUS = 14;
// Places one to three take the medal metals the text board shows as emoji.
const MEDAL_COLORS = [COLORS.ACHIEVEMENT_GOLD, COLORS.ACHIEVEMENT_SILVER, COLORS.ACHIEVEMENT_BRONZE];

// Only what the card draws; avatar requests are plain data already.
interface LevelsBoardCardInput {
	title: string;
	rows: Array<{ username: string; level: number; xp: number; avatar: AvatarRequest | null }>;
}

/** The levels board card, or null when the text board should post. Never throws. */
export function renderLevelsBoardCard(windowLabel: string, entries: readonly LevelsBoardEntry[]): Promise<RenderPayload | null> {
	const rows = entries.map((entry) => ({ username: entry.username, level: entry.level, xp: entry.xp, avatar: entry.avatar ?? null }));
	return renderCard({
		kind: "levels-board",
		version: LEVELS_BOARD_CARD_VERSION,
		input: { title: `${levelingCopy.board.title} • ${windowLabel}`, rows },
		width: CARD_WIDTH,
		// An empty board keeps one row's height for its empty state line.
		height: HEADER_HEIGHT + Math.max(rows.length, 1) * (ROW_HEIGHT + ROW_GAP) + FOOTER_SPACE,
		draw: drawLevelsBoardCard,
	});
}

async function drawLevelsBoardCard(context: SKRSContext2D, input: LevelsBoardCardInput): Promise<DrawOutcome> {
	drawCardBackground(context, COLORS.LEVELS_BOARD, CARD_WIDTH, 0, CARD_WIDTH * 0.7);
	let standIn = await drawDeroPose(context, "board", DERO_BOX);

	drawText(context, input.title, {
		x: MARGIN,
		y: 72,
		size: 40,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		maxWidth: DERO_BOX.x - MARGIN * 2,
	});
	drawText(context, levelingCopy.boardSubtitles.levels, {
		x: MARGIN,
		y: 110,
		size: 20,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		maxWidth: DERO_BOX.x - MARGIN * 2,
	});

	if (input.rows.length === 0) {
		drawText(context, levelingCopy.board.emptyState, {
			x: MARGIN,
			y: HEADER_HEIGHT + ROW_HEIGHT / 2,
			size: 22,
			color: canvasColor(COLORS.CARD_TEXT_MUTED),
			baseline: "middle",
			maxWidth: CARD_WIDTH - MARGIN * 2,
		});
		return standIn ? { cacheable: false } : undefined;
	}

	// Every face is fetched at once first, so a cold board waits for its slowest
	// avatar rather than for ten in a row; the rows then draw in order (a canvas
	// has one drawing state) and each face comes from the avatar cache.
	await Promise.all(input.rows.map((row) => (row.avatar ? fetchAvatar(row.avatar) : null)));
	for (const [index, row] of input.rows.entries()) {
		const faceStandIn = await drawRow(context, row, index);
		standIn = standIn || faceStandIn;
	}
	return standIn ? { cacheable: false } : undefined;
}

async function drawRow(context: SKRSContext2D, row: LevelsBoardCardInput["rows"][number], index: number): Promise<boolean> {
	const top = HEADER_HEIGHT + index * (ROW_HEIGHT + ROW_GAP);
	const middle = top + ROW_HEIGHT / 2;
	drawPanel(context, {
		x: MARGIN,
		y: top,
		width: CARD_WIDTH - MARGIN * 2,
		height: ROW_HEIGHT,
		radius: ROW_RADIUS,
		fill: canvasColor(index < MEDAL_COLORS.length ? COLORS.CARD_NESTED : COLORS.CARD_PANEL),
	});
	drawText(context, String(index + 1), {
		x: RANK_CENTER_X,
		y: middle,
		size: 26,
		weight: "bold",
		color: canvasColor(MEDAL_COLORS[index] ?? COLORS.CARD_TEXT_MUTED),
		align: "center",
		baseline: "middle",
	});
	const faceStandIn = await drawMemberFace(context, row.avatar, row.username, FACE_CENTER_X, middle, FACE_DIAMETER);
	drawText(context, row.username, {
		x: NAME_X,
		y: middle,
		size: 24,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: LEVEL_PILL.x - NAME_X - 20,
	});
	drawPill(context, {
		x: LEVEL_PILL.x,
		y: middle - LEVEL_PILL.height / 2,
		width: LEVEL_PILL.width,
		height: LEVEL_PILL.height,
		fill: canvasColor(COLORS.LEVELS_BOARD),
		label: levelingCopy.cards.levelBadge(row.level),
	});
	drawText(context, `${row.xp.toLocaleString()} ${levelingCopy.labels.xp}`, {
		x: CARD_WIDTH - MARGIN - 24,
		y: middle,
		size: 22,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		align: "right",
		baseline: "middle",
	});
	return faceStandIn;
}
