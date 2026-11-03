import { COLORS } from "@base/copy/brand.js";
import { canvasColor, drawCardBackground, drawDeroPose, drawPanel, drawText, renderCard, type DrawOutcome, type Rect, type RenderPayload } from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";

// ── arcadeMonthlyRenderer ────────────────────────────────────────────
// The monthly arcade post as a card (2026-10 item 244 Phase 3b): a header naming
// the month and the server, Dero's battle pose, and one panel per section (top
// winning hands, top rated, luckiest), each a heading and its rows. It draws only
// words it is handed, already in the guild's pack voice, so a pack edit changes the
// input and therefore the cache key. monthlyArcadePost renders it through
// withRenderFallback, and the text embed it falls back to reads the SAME view, so
// the card and the embed can never show different numbers.

/** One line of a section: a bold lead (a hand, a player) and its muted detail. */
export interface ArcadeMonthlyRow {
	lead: string;
	detail: string;
}

/** One section of the post. `emptyLine` stands in when `rows` is empty. */
export interface ArcadeMonthlySection {
	heading: string;
	rows: ArcadeMonthlyRow[];
	emptyLine: string;
}

/** Everything the post shows, in the guild's words. Plain data, so it hashes into the card's cache key. */
export interface ArcadeMonthlyView {
	title: string;
	guildName: string;
	sections: ArcadeMonthlySection[];
	/** The provisional mark's explanation, or empty when no rating on the post carries the mark. */
	note: string;
	footer: string;
}

// Bump whenever the drawing changes, or servers keep seeing cards cached from the old drawing.
const ARCADE_MONTHLY_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const MARGIN = 40;
const HEADER_HEIGHT = 150;
const DERO_BOX: Rect = { x: 810, y: 12, width: 130, height: 130 };
const TITLE_MAX_WIDTH = DERO_BOX.x - MARGIN - 16;
const PANEL_GAP = 16;
const PANEL_PADDING_Y = 18;
const PANEL_PADDING_X = 24;
const PANEL_RADIUS = 18;
const HEADING_HEIGHT = 34;
const ROW_HEIGHT = 40;
const FOOTER_LINE_HEIGHT = 28;
const FOOTER_SPACE = 20;
const PANEL_WIDTH = CARD_WIDTH - MARGIN * 2;
// The lead takes the left half of a row and the detail the right, so a long name
// squeezes inside its own half rather than running into the number beside it.
const ROW_HALF_WIDTH = PANEL_WIDTH / 2 - PANEL_PADDING_X;

/** The monthly arcade card, or null when the text embed should post. Never throws. */
export function renderArcadeMonthlyCard(view: ArcadeMonthlyView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "arcade-monthly",
		version: ARCADE_MONTHLY_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: arcadeMonthlyCardHeight(view),
		draw: drawArcadeMonthlyCard,
	});
}

/** The card's height for a view: the header, every panel and its gap, and one line per footer line. Exported for the tests. */
export function arcadeMonthlyCardHeight(view: ArcadeMonthlyView): number {
	const panels = view.sections.reduce((total, section) => total + panelHeight(section) + PANEL_GAP, 0);
	return HEADER_HEIGHT + panels + footerLines(view).length * FOOTER_LINE_HEIGHT + FOOTER_SPACE;
}

// An empty section keeps one row's height for its empty line.
function panelHeight(section: ArcadeMonthlySection): number {
	return PANEL_PADDING_Y * 2 + HEADING_HEIGHT + Math.max(section.rows.length, 1) * ROW_HEIGHT;
}

function footerLines(view: ArcadeMonthlyView): string[] {
	return [view.note, view.footer].filter((line) => line.length > 0);
}

async function drawArcadeMonthlyCard(context: SKRSContext2D, view: ArcadeMonthlyView): Promise<DrawOutcome> {
	drawCardBackground(context, COLORS.ARCADE, CARD_WIDTH, 0, CARD_WIDTH * 0.7);
	const deroStandIn = await drawDeroPose(context, "battle", DERO_BOX);
	drawHeader(context, view);

	let top = HEADER_HEIGHT;
	for (const section of view.sections) {
		drawSection(context, section, top);
		top += panelHeight(section) + PANEL_GAP;
	}

	footerLines(view).forEach((line, index) => {
		drawText(context, line, {
			x: MARGIN,
			y: top + index * FOOTER_LINE_HEIGHT + FOOTER_LINE_HEIGHT / 2,
			size: 18,
			color: canvasColor(COLORS.CARD_TEXT_MUTED),
			baseline: "middle",
			maxWidth: PANEL_WIDTH,
		});
	});
	return deroStandIn ? { cacheable: false } : undefined;
}

function drawHeader(context: SKRSContext2D, view: ArcadeMonthlyView): void {
	drawText(context, view.title, {
		x: MARGIN,
		y: 66,
		size: 36,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: TITLE_MAX_WIDTH,
	});
	drawText(context, view.guildName, {
		x: MARGIN,
		y: 110,
		size: 22,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		baseline: "middle",
		maxWidth: TITLE_MAX_WIDTH,
	});
}

function drawSection(context: SKRSContext2D, section: ArcadeMonthlySection, top: number): void {
	drawPanel(context, { x: MARGIN, y: top, width: PANEL_WIDTH, height: panelHeight(section), radius: PANEL_RADIUS, fill: canvasColor(COLORS.CARD_PANEL) });
	const left = MARGIN + PANEL_PADDING_X;
	const right = CARD_WIDTH - MARGIN - PANEL_PADDING_X;
	drawText(context, section.heading, {
		x: left,
		y: top + PANEL_PADDING_Y + HEADING_HEIGHT / 2,
		size: 20,
		weight: "bold",
		color: canvasColor(COLORS.ARCADE),
		baseline: "middle",
		maxWidth: PANEL_WIDTH - PANEL_PADDING_X * 2,
	});

	const rowCenter = (index: number): number => top + PANEL_PADDING_Y + HEADING_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
	if (section.rows.length === 0) {
		drawText(context, section.emptyLine, {
			x: left,
			y: rowCenter(0),
			size: 20,
			color: canvasColor(COLORS.CARD_TEXT_MUTED),
			baseline: "middle",
			maxWidth: PANEL_WIDTH - PANEL_PADDING_X * 2,
		});
		return;
	}

	section.rows.forEach((row, index) => {
		drawText(context, row.lead, {
			x: left,
			y: rowCenter(index),
			size: 24,
			weight: "bold",
			color: canvasColor(COLORS.CARD_TEXT),
			baseline: "middle",
			maxWidth: ROW_HALF_WIDTH,
		});
		drawText(context, row.detail, {
			x: right,
			y: rowCenter(index),
			size: 20,
			color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
			align: "right",
			baseline: "middle",
			maxWidth: ROW_HALF_WIDTH,
		});
	});
}
