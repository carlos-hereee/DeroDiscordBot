import { EmbedBuilder, type ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import type { SKRSContext2D } from "./canvasModule.js";
import type { RenderPayload } from "./fallback.js";
import { renderCard } from "./index.js";
import { canvasColor, drawCardBackground, drawPanel, drawPill, drawText } from "./primitives.js";

// ── settingsChartRenderer ───────────────────────────────────────────────────
// What:  the drawn settings chart of one 🏰 DERO HEADQUARTERS config channel (2026-10
//        item 257, owner item 7): a title, then one row per switch or setting, each a
//        label beside an ON or OFF pill or a short value. It draws rows it is handed
//        and knows nothing about any setting; features/setup/headquartersCards.ts
//        reads each domain's stored state into rows.
// Who:   headquartersCards, through withRenderFallback, posts it under each config
//        channel's steps card and redraws it after every change in that domain.
// How:   one still PNG through renderCard, so an unchanged chart is served from the
//        card cache. The text embed beside it carries the same rows as fields, and it
//        is the whole answer when the canvas does not draw.

/** One row of a settings chart: a switch drawn as a pill, or a setting drawn as its value. */
export type SettingsChartRow = { label: string; kind: "switch"; on: boolean } | { label: string; kind: "value"; value: string };

/** Everything one chart draws, as plain data. */
export interface SettingsChartView {
	title: string;
	subtitle: string;
	rows: SettingsChartRow[];
	onLabel: string;
	offLabel: string;
}

// Bump whenever the drawing changes, or admins keep seeing cached charts.
const SETTINGS_CHART_VERSION = 1;
const CARD_WIDTH = 900;
const PADDING = 32;
const HEADER_HEIGHT = 116;
const ROW_HEIGHT = 56;
const ROW_GAP = 10;
const ROW_RADIUS = 14;
const PILL_WIDTH = 104;
const PILL_HEIGHT = 34;
// A value sits in the right part of its row; past this share of the width it is squeezed
// rather than running into the label.
const VALUE_WIDTH_SHARE = 0.5;
const ACCENT: ColorResolvable = COLORS.ADMIN;

/** The chart's height for this many rows, so a short domain draws a short card. */
export function settingsChartHeight(rowCount: number): number {
	return HEADER_HEIGHT + rowCount * (ROW_HEIGHT + ROW_GAP) + PADDING - ROW_GAP;
}

/** The drawn chart, or null when the text embed should post alone. Never throws. */
export function renderSettingsChart(view: SettingsChartView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "settings-chart",
		version: SETTINGS_CHART_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: settingsChartHeight(view.rows.length),
		draw: drawSettingsChart,
	});
}

/** The text twin of a chart: every row as an inline field, the same words the card draws. */
export function settingsChartEmbed(view: SettingsChartView): EmbedBuilder {
	return new EmbedBuilder()
		.setTitle(view.title)
		.setDescription(view.subtitle)
		.setColor(ACCENT)
		.addFields(view.rows.map((row) => ({ name: row.label, value: rowValueText(row, view), inline: true })));
}

function rowValueText(row: SettingsChartRow, view: SettingsChartView): string {
	if (row.kind === "value") return row.value;
	return row.on ? view.onLabel : view.offLabel;
}

function drawSettingsChart(context: SKRSContext2D, view: SettingsChartView): void {
	const height = settingsChartHeight(view.rows.length);
	drawCardBackground(context, ACCENT, CARD_WIDTH, 0, height);
	drawText(context, view.title, { x: PADDING, y: 52, size: 34, weight: "bold", color: canvasColor(COLORS.CARD_TEXT), baseline: "middle", maxWidth: CARD_WIDTH - PADDING * 2 });
	drawText(context, view.subtitle, { x: PADDING, y: 92, size: 20, color: canvasColor(COLORS.CARD_TEXT_SECONDARY), baseline: "middle", maxWidth: CARD_WIDTH - PADDING * 2 });
	view.rows.forEach((row, index) => drawRow(context, row, view, HEADER_HEIGHT + index * (ROW_HEIGHT + ROW_GAP)));
}

function drawRow(context: SKRSContext2D, row: SettingsChartRow, view: SettingsChartView, top: number): void {
	const rowWidth = CARD_WIDTH - PADDING * 2;
	const middle = top + ROW_HEIGHT / 2;
	const right = PADDING + rowWidth - 16;
	drawPanel(context, { x: PADDING, y: top, width: rowWidth, height: ROW_HEIGHT, fill: canvasColor(COLORS.CARD_PANEL), radius: ROW_RADIUS });
	drawText(context, row.label, {
		x: PADDING + 20,
		y: middle,
		size: 22,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: rowWidth * (1 - VALUE_WIDTH_SHARE) - 24,
	});
	if (row.kind === "switch") {
		drawPill(context, {
			x: right - PILL_WIDTH,
			y: middle - PILL_HEIGHT / 2,
			width: PILL_WIDTH,
			height: PILL_HEIGHT,
			fill: canvasColor(row.on ? COLORS.CARD_OUTCOME_WIN : COLORS.CARD_NESTED),
			label: row.on ? view.onLabel : view.offLabel,
			labelColor: canvasColor(row.on ? COLORS.CARD_BACKGROUND : COLORS.CARD_TEXT_SECONDARY),
		});
		return;
	}
	drawText(context, row.value, {
		x: right,
		y: middle,
		size: 22,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		align: "right",
		baseline: "middle",
		maxWidth: rowWidth * VALUE_WIDTH_SHARE,
	});
}
