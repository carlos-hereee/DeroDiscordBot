import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackground,
	drawPanel,
	drawPill,
	drawText,
	fillCircle,
	renderCard,
	strokeLine,
	type Point,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { COLUMNS, GRID_SIZE, type CellView, type Coord, type OwnCellView, type SunkShipView } from "./battleshipState.js";

// ── battleshipRenderer ───────────────────────────────────────────────
// The battleship cards (2026-10 item 243 Phase 3), drawing only: the PUBLIC
// board (both players' shots on each other, with every sunk hull outlined and
// the ship just sunk called out, which is the sinking reveal) and the PRIVATE
// fleet card (the viewer's own ships under the incoming fire). roomBattleship
// builds both views from the match and wraps each in withRenderFallback, so the
// emoji grid embeds post unchanged whenever a card does not draw.
//
// ⚠️ THE PUBLIC CARD IS DRAWN FROM opponentView AND sunkShips ONLY, the two
// views battleshipState guarantees hold no unfired ship cell. The private card
// is the one drawing that shows a whole fleet, so it is never cached (see
// renderBattleshipFleetCard) and is only ever sent as an ephemeral reply.

/** One side of the public board: one player's shots on the other's waters. */
export interface BattleshipBoardSection {
	title: string;
	shipsLeft: string;
	grid: CellView[][];
	sunk: SunkShipView[];
}

/** Everything the public board card draws. Every string is already worded; nothing takes a mention. */
export interface BattleshipBoardView {
	headline: string;
	sections: BattleshipBoardSection[];
	/** The ship sunk by the shot this card follows, and the section it went down in. */
	sinking: { sectionIndex: number; ship: string; line: string } | null;
}

/** Everything the private fleet card draws: the viewer's own waters. */
export interface BattleshipFleetView {
	title: string;
	fleetLine: string;
	grid: OwnCellView[][];
}

// Bump whenever the drawing changes, or members keep seeing cached cards.
const BATTLESHIP_CARD_VERSION = 1;
const BOARD_WIDTH = 1000;
const FLEET_WIDTH = 520;
const CARD_HEIGHT = 600;
const CELL = 38;
const CELL_GAP = 2;
const CELL_STEP = CELL + CELL_GAP;
const GRID_TOP = 176;
// The row numbers sit in this gutter left of the grid, the column letters above it.
const LABEL_GUTTER = 28;
const SECTION_LEFTS = [44, 528];
const SUNK_OUTLINE = 3;
const SINKING_OUTLINE = 6;
// The miss marker is a dot this share of a cell across.
const MISS_DOT = 0.3;

const CELL_FILL: Record<CellView, string> = {
	unknown: canvasColor(COLORS.BATTLESHIP_WATER),
	miss: canvasColor(COLORS.BATTLESHIP_WATER),
	hit: canvasColor(COLORS.BATTLESHIP_HIT),
	sunk: canvasColor(COLORS.BATTLESHIP_SUNK),
};

// ── the public board ──────────────────────────────────────────────────
/** The public board card, or null when the board embed should keep its emoji grids. Never throws. */
export function renderBattleshipBoardCard(view: BattleshipBoardView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "battleship-board",
		version: BATTLESHIP_CARD_VERSION,
		input: view,
		width: BOARD_WIDTH,
		height: CARD_HEIGHT,
		draw: drawBoardCard,
	});
}

function drawBoardCard(context: SKRSContext2D, view: BattleshipBoardView): void {
	drawCardBackground(context, COLORS.ARCADE, BOARD_WIDTH / 2, 0, BOARD_WIDTH * 0.6);
	drawText(context, view.headline, {
		x: SECTION_LEFTS[0],
		y: 56,
		size: 30,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: view.sinking ? 440 : BOARD_WIDTH - SECTION_LEFTS[0] * 2,
	});
	if (view.sinking) {
		drawPill(context, {
			x: 520,
			y: 34,
			width: BOARD_WIDTH - 520 - SECTION_LEFTS[0],
			height: 44,
			fill: canvasColor(COLORS.BATTLESHIP_SUNK),
			label: view.sinking.line,
		});
	}

	view.sections.forEach((section, index) => {
		const left = SECTION_LEFTS[index] ?? SECTION_LEFTS[0];
		drawSectionHeading(context, section.title, section.shipsLeft, left);
		const origin = { x: left + LABEL_GUTTER, y: GRID_TOP };
		drawGridLabels(context, origin);
		section.grid.forEach((row, y) => row.forEach((cell, x) => drawShotCell(context, origin, { x, y }, cell)));
		for (const ship of section.sunk) {
			const fresh = view.sinking?.sectionIndex === index && view.sinking.ship === ship.name;
			outlineShip(context, origin, ship.cells, fresh ? canvasColor(COLORS.BATTLESHIP_HIT) : canvasColor(COLORS.CARD_TEXT), fresh ? SINKING_OUTLINE : SUNK_OUTLINE);
		}
	});
}

function drawSectionHeading(context: SKRSContext2D, title: string, shipsLeft: string, left: number): void {
	const width = LABEL_GUTTER + GRID_SIZE * CELL_STEP;
	drawText(context, title, { x: left, y: 112, size: 22, weight: "bold", color: canvasColor(COLORS.CARD_TEXT), maxWidth: width });
	drawText(context, shipsLeft, { x: left, y: 140, size: 18, color: canvasColor(COLORS.CARD_TEXT_SECONDARY), maxWidth: width });
}

function drawShotCell(context: SKRSContext2D, origin: Point, coord: Coord, cell: CellView): void {
	const box = cellBox(origin, coord);
	drawPanel(context, { ...box, radius: 6, fill: CELL_FILL[cell] });
	if (cell === "miss") fillCircle(context, box.x + CELL / 2, box.y + CELL / 2, CELL * MISS_DOT, canvasColor(COLORS.BATTLESHIP_MISS));
}

// ── the private fleet ─────────────────────────────────────────────────
/**
 * The viewer's own waters, or null when the private board should keep its emoji
 * grid. Never throws. ⚠️ NEVER CACHED, because it draws a whole fleet: a cached
 * card would sit under a content addressed S3 key long after the match, and the
 * one copy it is meant for is the ephemeral reply to its owner.
 */
export function renderBattleshipFleetCard(view: BattleshipFleetView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "battleship-fleet",
		version: BATTLESHIP_CARD_VERSION,
		input: view,
		width: FLEET_WIDTH,
		height: CARD_HEIGHT,
		draw: (context, input) => {
			drawFleetCard(context, input);
			return { cacheable: false };
		},
	});
}

function drawFleetCard(context: SKRSContext2D, view: BattleshipFleetView): void {
	drawCardBackground(context, COLORS.ARCADE, FLEET_WIDTH / 2, 0, FLEET_WIDTH * 0.7);
	const left = SECTION_LEFTS[0];
	drawText(context, view.title, { x: left, y: 64, size: 28, weight: "bold", color: canvasColor(COLORS.CARD_TEXT), baseline: "middle" });
	drawText(context, view.fleetLine, {
		x: left,
		y: 116,
		size: 18,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		maxWidth: FLEET_WIDTH - left * 2,
	});
	const origin = { x: left + LABEL_GUTTER, y: GRID_TOP };
	drawGridLabels(context, origin);
	view.grid.forEach((row, y) => row.forEach((cell, x) => drawOwnCell(context, origin, { x, y }, cell)));
	for (const [, cells] of shipCells(view.grid)) outlineShip(context, origin, cells, canvasColor(COLORS.CARD_TEXT_SECONDARY), SUNK_OUTLINE);
}

function drawOwnCell(context: SKRSContext2D, origin: Point, coord: Coord, cell: OwnCellView): void {
	const box = cellBox(origin, coord);
	drawPanel(context, { ...box, radius: 6, fill: canvasColor(ownCellFill(cell)) });
	if (cell.miss) fillCircle(context, box.x + CELL / 2, box.y + CELL / 2, CELL * MISS_DOT, canvasColor(COLORS.BATTLESHIP_MISS));
}

// A hit shows over the hull it struck, so a damaged ship reads as damaged.
function ownCellFill(cell: OwnCellView): ColorResolvable {
	if (cell.hit) return COLORS.BATTLESHIP_HIT;
	if (cell.ship) return COLORS.CARD_TEXT_MUTED;
	return COLORS.BATTLESHIP_WATER;
}

// Each ship's cells, by name, read back off the grid it was drawn into.
function shipCells(grid: OwnCellView[][]): Map<string, Coord[]> {
	const ships = new Map<string, Coord[]>();
	grid.forEach((row, y) =>
		row.forEach((cell, x) => {
			if (!cell.ship) return;
			ships.set(cell.ship, [...(ships.get(cell.ship) ?? []), { x, y }]);
		})
	);
	return ships;
}

// ── grid geometry ─────────────────────────────────────────────────────
function cellBox(origin: Point, { x, y }: Coord): { x: number; y: number; width: number; height: number } {
	return { x: origin.x + x * CELL_STEP, y: origin.y + y * CELL_STEP, width: CELL, height: CELL };
}

function drawGridLabels(context: SKRSContext2D, origin: Point): void {
	const ink = canvasColor(COLORS.CARD_TEXT_MUTED);
	COLUMNS.forEach((letter, index) => {
		drawText(context, letter, { x: origin.x + index * CELL_STEP + CELL / 2, y: origin.y - 10, size: 16, weight: "bold", color: ink, align: "center" });
	});
	for (let row = 0; row < GRID_SIZE; row += 1) {
		drawText(context, String(row + 1), {
			x: origin.x - 8,
			y: origin.y + row * CELL_STEP + CELL / 2,
			size: 16,
			weight: "bold",
			color: ink,
			align: "right",
			baseline: "middle",
		});
	}
}

// A ship is a straight run of cells, so its outline is the rectangle around the
// first and last of them, drawn just outside the cells so the fills stay visible.
function outlineShip(context: SKRSContext2D, origin: Point, cells: readonly Coord[], color: string, lineWidth: number): void {
	if (cells.length === 0) return;
	const xs = cells.map((cell) => cell.x);
	const ys = cells.map((cell) => cell.y);
	const left = origin.x + Math.min(...xs) * CELL_STEP - CELL_GAP;
	const top = origin.y + Math.min(...ys) * CELL_STEP - CELL_GAP;
	const right = origin.x + Math.max(...xs) * CELL_STEP + CELL + CELL_GAP;
	const bottom = origin.y + Math.max(...ys) * CELL_STEP + CELL + CELL_GAP;
	strokeLine(context, [
		{ x: left, y: top },
		{ x: right, y: top },
		{ x: right, y: bottom },
		{ x: left, y: bottom },
		{ x: left, y: top },
	], { color, lineWidth });
}
