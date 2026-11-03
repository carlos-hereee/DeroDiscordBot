import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackground,
	drawImageContained,
	drawPanel,
	drawPill,
	drawText,
	fillCircle,
	renderCard,
	strokeLine,
	type DrawOutcome,
	type Rect,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { Image, SKRSContext2D } from "@features/renderer/canvasModule.js";
import type { GameAssetKey } from "./gamesAssets.js";
import { loadGameArt } from "./gamesArt.js";
import { COLUMNS, GRID_SIZE, type CellView, type Coord, type OwnCellView, type ShipName, type SunkShipView } from "./battleshipState.js";

// ── battleshipRenderer ───────────────────────────────────────────────
// The battleship cards (2026-10 item 243 Phases 3 and 3b), drawing only, on the
// owner's art: the PUBLIC board (both players' shots on each other's board art,
// hit and miss markers on the cells fired at, every sunk ship's art laid over
// its cells, and the ship just sunk outlined and named, which is the sinking
// reveal) and the PRIVATE fleet card (the viewer's own ships on the board under
// the incoming fire, the board filling the card). The admiral stands on the
// battleship challenge post instead (challengeCardRenderer), where he advertises
// the game rather than taking width from the board a player reads every turn.
// roomBattleship builds both views from
// the match and wraps each in withRenderFallback, so the emoji grid embeds post
// unchanged whenever a card does not draw.
//
// Without the board art the card draws its own grid; without a marker or a
// ship's art it draws a dot or an outline. A card that drew any stand in answers
// `{ cacheable: false }`.
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

// Bump whenever the drawing changes, or members keep seeing cached cards. The
// fleet card is never cached, so a change to it alone needs no bump.
const BATTLESHIP_CARD_VERSION = 2;
const BOARD_CARD_WIDTH = 1000;
const BOARD_CARD_HEIGHT = 666;
const LOGO_BOX: Rect = { x: 16, y: 8, width: 128, height: 112 };
const SINKING_PILL: Rect = { x: 560, y: 40, width: 420, height: 44 };
const PUBLIC_BOARD_SIZE = 464;
const PUBLIC_BOARD_TOP = 192;
const PUBLIC_BOARD_LEFTS = [24, 512];
// The fleet board spans the card's width less its margins, so the card is as
// wide as the board and nothing beside it competes for the space.
const FLEET_MARGIN = 24;
const FLEET_BOARD_TOP = 128;
const FLEET_BOARD_SIZE = 592;
const FLEET_BOARD: Rect = { x: FLEET_MARGIN, y: FLEET_BOARD_TOP, width: FLEET_BOARD_SIZE, height: FLEET_BOARD_SIZE };
const FLEET_CARD_WIDTH = FLEET_BOARD_SIZE + FLEET_MARGIN * 2;
const FLEET_CARD_HEIGHT = FLEET_BOARD_TOP + FLEET_BOARD_SIZE + FLEET_MARGIN;
const SUNK_OUTLINE = 3;
const SINKING_OUTLINE = 6;
// Marker art against the smaller side of a cell: a miss splash a little inside
// it, a hit burst filling it, and the burst shrunk on a sunk hull so the ship
// art under it still shows.
const MISS_MARKER = 0.8;
const HIT_MARKER = 0.95;
const SUNK_HIT_MARKER = 0.55;
// The fallback dot when a marker's art is missing, against the cell's smaller side.
const MARKER_DOT = 0.45;
// A ship's art is drawn across this many cell widths: the art is far stouter
// than a one cell lane (a carrier is about three fifths as wide as it is long),
// so held to one cell it would cover two of its five cells. The markers on each
// cell still say exactly which cells the ship holds.
const SHIP_BREADTH = 1.3;

// ── the board art's grid ──────────────────────────────────────────────
// The width and height of the board art the cell centres below were measured
// on (the owner's 1254 pixel export, before prepare-arcade-art scaled it). They
// are scaled by the drawn size over this, so any re-export of the SAME layout at
// another size still lines up. The centres come from the printed A to J and 1 to
// 10 labels, not from an even split: the art's rows are not evenly spaced, and
// row 10 is squeezed against the bottom edge.
const BOARD_ART_SIZE = 1254;
const ART_COLUMN_CENTERS = [264, 347, 429, 512, 595, 678, 760, 844, 926, 1008];
const ART_ROW_CENTERS = [369, 445, 523, 600, 680, 756, 834, 909, 981, 1043];

// ── the drawn fallback grid ──
const CELL = 38;
const CELL_GAP = 2;
const CELL_STEP = CELL + CELL_GAP;
// The row numbers sit in this gutter left of the grid, the column letters above it.
const LABEL_GUTTER = 28;

const SHIP_ART: Record<ShipName, GameAssetKey> = {
	carrier: "battleshipCarrier",
	battleship: "battleshipBattleship",
	cruiser: "battleshipCruiser",
	submarine: "battleshipSubmarine",
	destroyer: "battleshipDestroyer",
};

// Where each cell of a board sits on the card. One shape for the board art (cells
// read from the measured label positions) and for the drawn fallback grid (an even
// grid), so every marker and ship below is drawn the same way on either.
interface BoardLayout {
	cell(coord: Coord): Rect;
}

/** The art loaded for one card: null for anything not on disk. */
interface BattleshipArt {
	board: Image | null;
	hit: Image | null;
	miss: Image | null;
	ships: Partial<Record<ShipName, Image | null>>;
}

async function loadBattleshipArt(): Promise<BattleshipArt> {
	const [board, hit, miss] = await Promise.all([loadGameArt("battleshipBoard"), loadGameArt("battleshipHit"), loadGameArt("battleshipMiss")]);
	const ships: BattleshipArt["ships"] = {};
	for (const name of Object.keys(SHIP_ART) as ShipName[]) ships[name] = await loadGameArt(SHIP_ART[name]);
	return { board, hit, miss, ships };
}

// ── the public board ──────────────────────────────────────────────────
/** The public board card, or null when the board embed should keep its emoji grids. Never throws. */
export function renderBattleshipBoardCard(view: BattleshipBoardView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "battleship-board",
		version: BATTLESHIP_CARD_VERSION,
		input: view,
		width: BOARD_CARD_WIDTH,
		height: BOARD_CARD_HEIGHT,
		draw: drawBoardCard,
	});
}

async function drawBoardCard(context: SKRSContext2D, view: BattleshipBoardView): Promise<DrawOutcome> {
	const art = await loadBattleshipArt();
	const logo = await loadGameArt("battleshipLogo");
	drawCardBackground(context, COLORS.ARCADE, BOARD_CARD_WIDTH / 2, 0, BOARD_CARD_WIDTH * 0.6);
	if (logo) drawImageContained(context, logo, LOGO_BOX);
	drawText(context, view.headline, {
		x: LOGO_BOX.x + LOGO_BOX.width + 12,
		y: 62,
		size: 30,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: (view.sinking ? SINKING_PILL.x : BOARD_CARD_WIDTH) - LOGO_BOX.x - LOGO_BOX.width - 36,
	});
	if (view.sinking) drawPill(context, { ...SINKING_PILL, fill: canvasColor(COLORS.BATTLESHIP_SUNK), label: view.sinking.line });

	let standIn = !logo;
	view.sections.forEach((section, index) => {
		const box = { x: PUBLIC_BOARD_LEFTS[index] ?? PUBLIC_BOARD_LEFTS[0], y: PUBLIC_BOARD_TOP, width: PUBLIC_BOARD_SIZE, height: PUBLIC_BOARD_SIZE };
		drawSectionHeading(context, section.title, section.shipsLeft, box);
		const layout = drawBoard(context, art.board, box);
		const sunkCells = new Set(section.sunk.flatMap((ship) => ship.cells.map((cell) => `${cell.x},${cell.y}`)));
		for (const ship of section.sunk) standIn = drawShip(context, layout, ship.name, ship.cells, art) || standIn;
		section.grid.forEach((row, y) =>
			row.forEach((cell, x) => {
				if (cell === "unknown") return;
				const onSunkHull = sunkCells.has(`${x},${y}`);
				standIn = drawMarker(context, layout.cell({ x, y }), cell === "miss" ? "miss" : "hit", onSunkHull, art) || standIn;
			})
		);
		const fresh = view.sinking?.sectionIndex === index ? section.sunk.find((ship) => ship.name === view.sinking?.ship) : undefined;
		if (fresh) outlineCells(context, layout, fresh.cells, canvasColor(COLORS.BATTLESHIP_HIT), SINKING_OUTLINE);
	});
	return standIn || !art.board ? { cacheable: false } : undefined;
}

function drawSectionHeading(context: SKRSContext2D, title: string, shipsLeft: string, box: Rect): void {
	drawText(context, title, { x: box.x + 6, y: box.y - 40, size: 22, weight: "bold", color: canvasColor(COLORS.CARD_TEXT), maxWidth: box.width - 12 });
	drawText(context, shipsLeft, { x: box.x + 6, y: box.y - 14, size: 18, color: canvasColor(COLORS.CARD_TEXT_SECONDARY), maxWidth: box.width - 12 });
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
		width: FLEET_CARD_WIDTH,
		height: FLEET_CARD_HEIGHT,
		draw: async (context, input) => {
			await drawFleetCard(context, input);
			return { cacheable: false };
		},
	});
}

async function drawFleetCard(context: SKRSContext2D, view: BattleshipFleetView): Promise<void> {
	const art = await loadBattleshipArt();
	drawCardBackground(context, COLORS.ARCADE, FLEET_CARD_WIDTH / 2, 0, FLEET_CARD_WIDTH * 0.6);
	drawText(context, view.title, { x: FLEET_BOARD.x, y: 52, size: 28, weight: "bold", color: canvasColor(COLORS.CARD_TEXT), baseline: "middle", maxWidth: FLEET_BOARD.width });
	drawText(context, view.fleetLine, { x: FLEET_BOARD.x, y: 92, size: 18, color: canvasColor(COLORS.CARD_TEXT_SECONDARY), maxWidth: FLEET_BOARD.width });

	const layout = drawBoard(context, art.board, FLEET_BOARD);
	for (const [name, cells] of shipCells(view.grid)) drawShip(context, layout, name, cells, art);
	view.grid.forEach((row, y) =>
		row.forEach((cell, x) => {
			if (cell.hit) drawMarker(context, layout.cell({ x, y }), "hit", false, art);
			else if (cell.miss) drawMarker(context, layout.cell({ x, y }), "miss", false, art);
		})
	);
}

// Each ship's cells, by name, read back off the grid it was drawn into.
function shipCells(grid: OwnCellView[][]): Map<ShipName, Coord[]> {
	const ships = new Map<ShipName, Coord[]>();
	grid.forEach((row, y) =>
		row.forEach((cell, x) => {
			if (!cell.ship) return;
			ships.set(cell.ship, [...(ships.get(cell.ship) ?? []), { x, y }]);
		})
	);
	return ships;
}

// ── boards ────────────────────────────────────────────────────────────
// The board art in `box` with its measured cells, or the drawn grid when the art
// is missing. Answers where each cell landed.
function drawBoard(context: SKRSContext2D, board: Image | null, box: Rect): BoardLayout {
	if (board) {
		context.drawImage(board, box.x, box.y, box.width, box.height);
		return artLayout(box);
	}
	const origin = { x: box.x + LABEL_GUTTER + 8, y: box.y + 30 };
	drawGridLabels(context, origin);
	const layout = drawnLayout(origin);
	for (let y = 0; y < GRID_SIZE; y += 1) {
		for (let x = 0; x < GRID_SIZE; x += 1) drawPanel(context, { ...layout.cell({ x, y }), radius: 6, fill: canvasColor(COLORS.BATTLESHIP_WATER) });
	}
	return layout;
}

// A cell on the art is as wide as the gap between its neighbours' centres, and
// an edge cell as wide as its one gap, so the squeezed bottom row stays squeezed.
function artLayout(box: Rect): BoardLayout {
	const scale = box.width / BOARD_ART_SIZE;
	const step = (centers: number[], index: number): number => {
		const before = centers[index - 1];
		const after = centers[index + 1];
		if (before === undefined) return after - centers[index];
		if (after === undefined) return centers[index] - before;
		return (after - before) / 2;
	};
	return {
		cell: ({ x, y }) => {
			const width = step(ART_COLUMN_CENTERS, x) * scale;
			const height = step(ART_ROW_CENTERS, y) * scale;
			return { x: box.x + ART_COLUMN_CENTERS[x] * scale - width / 2, y: box.y + ART_ROW_CENTERS[y] * scale - height / 2, width, height };
		},
	};
}

function drawnLayout(origin: { x: number; y: number }): BoardLayout {
	return { cell: ({ x, y }) => ({ x: origin.x + x * CELL_STEP, y: origin.y + y * CELL_STEP, width: CELL, height: CELL }) };
}

function drawGridLabels(context: SKRSContext2D, origin: { x: number; y: number }): void {
	const ink = canvasColor(COLORS.CARD_TEXT_MUTED);
	COLUMNS.forEach((letter, index) => {
		drawText(context, letter, { x: origin.x + index * CELL_STEP + CELL / 2, y: origin.y - 10, size: 16, weight: "bold", color: ink, align: "center" });
	});
	for (let row = 0; row < GRID_SIZE; row += 1) {
		drawText(context, String(row + 1), { x: origin.x - 8, y: origin.y + row * CELL_STEP + CELL / 2, size: 16, weight: "bold", color: ink, align: "right", baseline: "middle" });
	}
}

// ── markers and ships ─────────────────────────────────────────────────
// A hit or miss marker centred on its cell, or a dot in the marker's color when
// its art is missing. Answers true when it drew the dot.
function drawMarker(context: SKRSContext2D, cell: Rect, kind: "hit" | "miss", onSunkHull: boolean, art: BattleshipArt): boolean {
	const side = Math.min(cell.width, cell.height);
	const centerX = cell.x + cell.width / 2;
	const centerY = cell.y + cell.height / 2;
	const image = kind === "hit" ? art.hit : art.miss;
	if (image) {
		const size = side * markerShare(kind, onSunkHull);
		drawImageContained(context, image, { x: centerX - size / 2, y: centerY - size / 2, width: size, height: size });
		return false;
	}
	fillCircle(context, centerX, centerY, side * MARKER_DOT, canvasColor(markerDotColor(kind, onSunkHull)));
	return true;
}

function markerShare(kind: "hit" | "miss", onSunkHull: boolean): number {
	if (kind === "miss") return MISS_MARKER;
	return onSunkHull ? SUNK_HIT_MARKER : HIT_MARKER;
}

function markerDotColor(kind: "hit" | "miss", onSunkHull: boolean): ColorResolvable {
	if (kind === "miss") return COLORS.BATTLESHIP_MISS;
	return onSunkHull ? COLORS.BATTLESHIP_SUNK : COLORS.BATTLESHIP_HIT;
}

// A ship's art laid along its run of cells, bow first: drawn as it was painted
// (bow up) for a ship down a column, turned a quarter for one along a row. With
// no art, an outline around its cells. Answers true when it drew the outline.
function drawShip(context: SKRSContext2D, layout: BoardLayout, name: ShipName, cells: readonly Coord[], art: BattleshipArt): boolean {
	if (cells.length === 0) return false;
	const image = art.ships[name];
	if (!image) {
		outlineCells(context, layout, cells, canvasColor(COLORS.CARD_TEXT), SUNK_OUTLINE);
		return true;
	}
	const bounds = cellsBounds(layout, cells);
	const across = cells.every((cell) => cell.y === cells[0].y) && cells.length > 1;
	const lane = across ? bounds.height : bounds.width;
	const length = across ? bounds.width : bounds.height;
	context.save();
	context.translate(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	// A quarter turn clockwise points a bow drawn upward to the right.
	if (across) context.rotate(Math.PI / 2);
	const breadth = lane * SHIP_BREADTH;
	drawImageContained(context, image, { x: -breadth / 2, y: -length / 2, width: breadth, height: length });
	context.restore();
	return false;
}

function cellsBounds(layout: BoardLayout, cells: readonly Coord[]): Rect {
	const rects = cells.map((cell) => layout.cell(cell));
	const left = Math.min(...rects.map((rect) => rect.x));
	const top = Math.min(...rects.map((rect) => rect.y));
	const right = Math.max(...rects.map((rect) => rect.x + rect.width));
	const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

// The rectangle around a run of cells, drawn just outside them.
function outlineCells(context: SKRSContext2D, layout: BoardLayout, cells: readonly Coord[], color: string, lineWidth: number): void {
	const bounds = cellsBounds(layout, cells);
	const left = bounds.x - CELL_GAP;
	const top = bounds.y - CELL_GAP;
	const right = bounds.x + bounds.width + CELL_GAP;
	const bottom = bounds.y + bounds.height + CELL_GAP;
	strokeLine(context, [
		{ x: left, y: top },
		{ x: right, y: top },
		{ x: right, y: bottom },
		{ x: left, y: bottom },
		{ x: left, y: top },
	], { color, lineWidth });
}
