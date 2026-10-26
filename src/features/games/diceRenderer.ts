import { COLORS, DERO_VARIANTS, type DeroVariant } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackground,
	drawImageContained,
	drawPanel,
	drawPill,
	drawText,
	renderCard,
	withAlpha,
	type DrawOutcome,
	type Point,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { loadGameArt } from "./gamesArt.js";
import { gamesCopy } from "./gamesCopy.js";
import type { GameAssetKey } from "./gamesAssets.js";

// ── diceRenderer ─────────────────────────────────────────────────────
// The Dero die card (2026-10 item 250 Phase 5, item 15): both rolls of a dice roll as
// two d20s, each in the Dero color variant its face lands on, with that variant's mecha
// Dero beside it and the winner's side lit. Drawn for the room's dice match
// (roomGames) and the dice round against Dero (soloLuck), both through
// withRenderFallback, so either still posts its text and the old art when this does
// not draw.
//
// A d20 because the game is one (gamesCopy.diceRoll: highest of two d20 rolls wins).
// The plan's "one Dero color per face" was written for a six sided die, so the twenty
// faces wrap the six variants in token order: 1, 7, 13 and 19 are red, 6, 12 and 18
// purple. The variant list is brand.DERO_VARIANTS, shared with the bot seats, so the red
// die and the red Dero token are one color.

/** One side of the roll: who rolled and what. */
export interface DiceSide {
	name: string;
	roll: number;
}

export interface DiceCardView {
	left: DiceSide;
	right: DiceSide;
	winner: "left" | "right" | "tie";
}

// Bump whenever the drawing changes, or members keep seeing cached cards.
const DICE_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const CARD_HEIGHT = 400;
const PADDING = 28;
const SIDE_WIDTH = 400;
const DIE_RADIUS = 96;
const INNER_TRIANGLE_SHARE = 0.56;
const TOKEN_BOX = { width: 120, height: 160 };
const PANEL_RADIUS = 24;
const WINNER_BORDER_WIDTH = 5;
const HEXAGON_SIDES = 6;
const FULL_TURN = Math.PI * 2;
const TOP_ANGLE = -Math.PI / 2;

/** The Dero variant a die face is drawn in: faces wrap the six variants in token order. */
export function variantForFace(face: number): DeroVariant {
	const index = (((Math.trunc(face) - 1) % DERO_VARIANTS.length) + DERO_VARIANTS.length) % DERO_VARIANTS.length;
	return DERO_VARIANTS[index];
}

// The token art of a variant: token-1 is the first variant, and so on.
function tokenKeyFor(face: number): GameAssetKey {
	const index = DERO_VARIANTS.indexOf(variantForFace(face)) + 1;
	return `monopolyToken${index}` as GameAssetKey;
}

/** The dice card, or null when the text result should post alone. Never throws. */
export function renderDiceCard(view: DiceCardView): Promise<RenderPayload | null> {
	return renderCard({ kind: "dice", version: DICE_CARD_VERSION, input: view, width: CARD_WIDTH, height: CARD_HEIGHT, draw: drawDiceCard });
}

async function drawDiceCard(context: SKRSContext2D, view: DiceCardView): Promise<DrawOutcome> {
	drawCardBackground(context, COLORS.GAME_DICEROLL, CARD_WIDTH / 2, CARD_HEIGHT / 2, CARD_WIDTH * 0.55);
	const leftDrawn = await drawSide(context, view.left, PADDING, view.winner === "left");
	const rightDrawn = await drawSide(context, view.right, CARD_WIDTH - PADDING - SIDE_WIDTH, view.winner === "right");
	drawCenter(context, view);
	return leftDrawn && rightDrawn ? undefined : { cacheable: false };
}

// One player's half: a panel, the name, the die, the Dero who rolled it and the roll.
// Answers whether the token art drew, so a stand in card is never cached.
async function drawSide(context: SKRSContext2D, side: DiceSide, x: number, won: boolean): Promise<boolean> {
	const variant = variantForFace(side.roll);
	const panelFill = won ? withAlpha(variant.color, 0.22) : canvasColor(COLORS.CARD_PANEL);
	drawPanel(context, { x, y: PADDING, width: SIDE_WIDTH, height: CARD_HEIGHT - PADDING * 2, radius: PANEL_RADIUS, fill: panelFill });
	if (won) strokePanel(context, x, variant.color);
	drawText(context, side.name, {
		x: x + SIDE_WIDTH / 2,
		y: PADDING + 34,
		size: 26,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		align: "center",
		baseline: "middle",
		maxWidth: SIDE_WIDTH - 40,
	});

	const dieCenter = { x: x + 150, y: CARD_HEIGHT / 2 + 8 };
	drawD20(context, dieCenter, side.roll, variant);

	const token = await loadGameArt(tokenKeyFor(side.roll)).catch(() => null);
	if (token) drawImageContained(context, token, { x: x + SIDE_WIDTH - TOKEN_BOX.width - 18, y: CARD_HEIGHT / 2 - TOKEN_BOX.height / 2 + 8, ...TOKEN_BOX });

	drawText(context, gamesCopy.diceRoll.cardRolled(side.roll), {
		x: x + SIDE_WIDTH / 2,
		y: CARD_HEIGHT - PADDING - 30,
		size: 22,
		color: canvasColor(won ? COLORS.CARD_OUTCOME_WIN : COLORS.CARD_TEXT_SECONDARY),
		align: "center",
		baseline: "middle",
		maxWidth: SIDE_WIDTH - 40,
	});
	return token !== null;
}

// A d20 seen face on: a hexagon outline holding an upward triangle, the face the number
// sits on, with the facet lines from each corner of the triangle to the hexagon. Filled in
// the face's Dero color, the triangle a little lighter so the number reads on it.
function drawD20(context: SKRSContext2D, center: Point, face: number, variant: DeroVariant): void {
	const hexagon = polygon(center, DIE_RADIUS, HEXAGON_SIDES);
	const triangle = polygon(center, DIE_RADIUS * INNER_TRIANGLE_SHARE, 3);

	fillPath(context, hexagon, canvasColor(variant.color));
	fillPath(context, triangle, withAlpha(COLORS.CARD_TEXT, 0.22));

	context.strokeStyle = withAlpha(COLORS.CARD_BACKGROUND, 0.55);
	context.lineWidth = 3;
	// Each triangle corner meets the hexagon corner it points at and the two beside it.
	for (const [cornerIndex, corner] of triangle.entries()) {
		const facing = cornerIndex * 2;
		for (const offset of [-1, 0, 1]) {
			const target = hexagon[(facing + offset + HEXAGON_SIDES) % HEXAGON_SIDES];
			context.beginPath();
			context.moveTo(corner.x, corner.y);
			context.lineTo(target.x, target.y);
			context.stroke();
		}
	}
	strokePath(context, triangle, withAlpha(COLORS.CARD_BACKGROUND, 0.55), 3);
	strokePath(context, hexagon, withAlpha(COLORS.CARD_BACKGROUND, 0.75), 5);

	drawText(context, String(face), {
		x: center.x,
		y: center.y + 10,
		size: 44,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		align: "center",
		baseline: "middle",
	});
}

// The middle column: VS, and the result as a pill in the winner's color.
function drawCenter(context: SKRSContext2D, view: DiceCardView): void {
	const copy = gamesCopy.diceRoll;
	const centerX = CARD_WIDTH / 2;
	drawText(context, copy.cardVersus, {
		x: centerX,
		y: CARD_HEIGHT / 2 - 30,
		size: 30,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		align: "center",
		baseline: "middle",
	});
	const winnerSide = view.winner === "tie" ? null : view[view.winner];
	const pillWidth = 112;
	drawPill(context, {
		x: centerX - pillWidth / 2,
		y: CARD_HEIGHT / 2 + 10,
		width: pillWidth,
		height: 40,
		fill: winnerSide ? canvasColor(variantForFace(winnerSide.roll).color) : canvasColor(COLORS.CARD_NESTED),
		label: winnerSide ? copy.cardWin : copy.cardTie,
		labelColor: canvasColor(COLORS.CARD_TEXT),
		labelWeight: "bold",
	});
}

// The winning side's border, in its die's Dero color, so the winner reads at a glance.
function strokePanel(context: SKRSContext2D, x: number, color: DeroVariant["color"]): void {
	context.save();
	context.beginPath();
	context.roundRect(x, PADDING, SIDE_WIDTH, CARD_HEIGHT - PADDING * 2, PANEL_RADIUS);
	context.strokeStyle = canvasColor(color);
	context.lineWidth = WINNER_BORDER_WIDTH;
	context.stroke();
	context.restore();
}

// The corners of a regular polygon with one corner straight up.
function polygon(center: Point, radius: number, sides: number): Point[] {
	return Array.from({ length: sides }, (_, index) => {
		const angle = TOP_ANGLE + (FULL_TURN * index) / sides;
		return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
	});
}

function tracePath(context: SKRSContext2D, points: readonly Point[]): void {
	context.beginPath();
	points.forEach((point, index) => (index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)));
	context.closePath();
}

function fillPath(context: SKRSContext2D, points: readonly Point[], fill: string): void {
	tracePath(context, points);
	context.fillStyle = fill;
	context.fill();
}

function strokePath(context: SKRSContext2D, points: readonly Point[], color: string, lineWidth: number): void {
	tracePath(context, points);
	context.strokeStyle = color;
	context.lineWidth = lineWidth;
	context.stroke();
}
