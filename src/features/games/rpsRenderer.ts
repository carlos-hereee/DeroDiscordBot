import { COLORS } from "@base/copy/brand.js";
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
	type Rect,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { loadGameArt } from "./gamesArt.js";
import { gamesCopy } from "./gamesCopy.js";
import type { GameAssetKey } from "./gamesAssets.js";
import type { RpsChoice } from "./rpsWinner.js";

// ── rpsRenderer ──────────────────────────────────────────────────────
// The rock paper scissors reveal card (2026-10 item 254 Phase 5a, the debug
// checklist's Arcade 3): both throws as the owner's mecha hands inside choice
// frames, the winner's side lit, and, when Dero is one of the two sides, Dero's
// pose for the outcome as Dero sees it. Drawn for a room's rps match (roomGames)
// and a round against Dero (soloLuck), both through withRenderFallback, so either
// still posts what it posted before the card: the winning hand on a room's result
// card, the text result against Dero. It decides nothing about who won; the caller
// passes the scored view. Laid out like the dice card (diceRenderer), so the two
// luck cards read as one set.

/** One side of the reveal: who threw, what, and whether that side is Dero. */
export interface RpsSide {
	name: string;
	choice: RpsChoice;
	isDero: boolean;
}

export interface RpsCardView {
	left: RpsSide;
	right: RpsSide;
	winner: "left" | "right" | "tie";
}

// Bump whenever the drawing changes, or members keep seeing cached cards.
const RPS_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const CARD_HEIGHT = 400;
const PADDING = 28;
const SIDE_WIDTH = 400;
const PANEL_RADIUS = 24;
const WINNER_BORDER_WIDTH = 5;
const FRAME_SIZE = 200;
const FRAME_TOP = 92;
// The hand sits inside the frame's cream window, which is about two thirds of the
// frame's width (choice-frame.png); this share keeps it clear of the gold border.
const HAND_SHARE = 0.56;
// Dero's pose stands beside his frame, so a Dero side's frame moves to the left.
const DERO_FRAME_INSET = 16;
const POSE_BOX = { width: 160, height: 230 };
const PILL_WIDTH = 112;

const HAND_ART: Record<RpsChoice, GameAssetKey> = { rock: "rpsRock", paper: "rpsPaper", scissors: "rpsScissors" };
const CHOICE_LABELS: Record<RpsChoice, string> = {
	rock: gamesCopy.rps.rockLabel,
	paper: gamesCopy.rps.paperLabel,
	scissors: gamesCopy.rps.scissorsLabel,
};

/**
 * Dero's pose for the outcome from Dero's own view, or null when Dero is not a
 * side (a match between two members draws no pose). Pure, so the choice of pose is
 * testable without a canvas.
 */
export function deroPoseFor(view: RpsCardView): GameAssetKey | null {
	const deroSide = view.left.isDero ? "left" : view.right.isDero ? "right" : null;
	if (!deroSide) return null;
	if (view.winner === "tie") return "rpsDeroDraw";
	return view.winner === deroSide ? "rpsDeroWin" : "rpsDeroLose";
}

/** The reveal card, or null when the caller's fallback should post alone. Never throws. */
export function renderRpsCard(view: RpsCardView): Promise<RenderPayload | null> {
	return renderCard({ kind: "rps", version: RPS_CARD_VERSION, input: view, width: CARD_WIDTH, height: CARD_HEIGHT, draw: drawRpsCard });
}

async function drawRpsCard(context: SKRSContext2D, view: RpsCardView): Promise<DrawOutcome> {
	drawCardBackground(context, COLORS.GAME_RPS, CARD_WIDTH / 2, CARD_HEIGHT / 2, CARD_WIDTH * 0.55);
	const pose = deroPoseFor(view);
	const leftDrawn = await drawSide(context, view.left, PADDING, view.winner === "left", view.left.isDero ? pose : null);
	const rightDrawn = await drawSide(context, view.right, CARD_WIDTH - PADDING - SIDE_WIDTH, view.winner === "right", view.right.isDero ? pose : null);
	drawCenter(context, view);
	// A card drawn with any piece of art missing is a stand in, so it must not be
	// cached under the same key the full card will use once the art deploys.
	return leftDrawn && rightDrawn ? undefined : { cacheable: false };
}

// One side's half: a panel, the name, the throw in its frame, Dero's pose when this
// side is Dero, and the throw named underneath. Answers whether every piece of art drew.
async function drawSide(context: SKRSContext2D, side: RpsSide, x: number, won: boolean, pose: GameAssetKey | null): Promise<boolean> {
	const panelFill = won ? withAlpha(COLORS.GAME_RPS, 0.22) : canvasColor(COLORS.CARD_PANEL);
	drawPanel(context, { x, y: PADDING, width: SIDE_WIDTH, height: CARD_HEIGHT - PADDING * 2, radius: PANEL_RADIUS, fill: panelFill });
	if (won) strokePanel(context, x);
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

	const frameX = pose ? x + DERO_FRAME_INSET : x + (SIDE_WIDTH - FRAME_SIZE) / 2;
	const frameDrawn = await drawThrow(context, side.choice, { x: frameX, y: FRAME_TOP, width: FRAME_SIZE, height: FRAME_SIZE });
	const poseDrawn = pose ? await drawPose(context, pose, x) : true;

	drawText(context, gamesCopy.rps.cardThrew(CHOICE_LABELS[side.choice]), {
		x: x + SIDE_WIDTH / 2,
		y: CARD_HEIGHT - PADDING - 30,
		size: 22,
		color: canvasColor(won ? COLORS.CARD_OUTCOME_WIN : COLORS.CARD_TEXT_SECONDARY),
		align: "center",
		baseline: "middle",
		maxWidth: SIDE_WIDTH - 40,
	});
	return frameDrawn && poseDrawn;
}

// The choice frame with the hand inside it. A missing frame draws a plain nested
// panel and a missing hand draws the throw's name, so the card still says what was
// thrown while the art is not on disk.
async function drawThrow(context: SKRSContext2D, choice: RpsChoice, frame: Rect): Promise<boolean> {
	const [frameArt, hand] = await Promise.all([loadGameArt("rpsChoiceFrame").catch(() => null), loadGameArt(HAND_ART[choice]).catch(() => null)]);
	if (frameArt) drawImageContained(context, frameArt, frame);
	else drawPanel(context, { ...frame, radius: PANEL_RADIUS, fill: canvasColor(COLORS.CARD_NESTED) });

	const handSize = frame.width * HAND_SHARE;
	const handBox = { x: frame.x + (frame.width - handSize) / 2, y: frame.y + (frame.height - handSize) / 2, width: handSize, height: handSize };
	if (hand) drawImageContained(context, hand, handBox);
	else
		drawText(context, CHOICE_LABELS[choice], {
			x: frame.x + frame.width / 2,
			y: frame.y + frame.height / 2,
			size: 28,
			weight: "bold",
			color: canvasColor(COLORS.CARD_TEXT),
			align: "center",
			baseline: "middle",
			maxWidth: handSize,
		});
	return frameArt !== null && hand !== null;
}

// Dero's pose, standing at the side's right edge beside his frame.
async function drawPose(context: SKRSContext2D, pose: GameAssetKey, sideX: number): Promise<boolean> {
	const art = await loadGameArt(pose).catch(() => null);
	if (!art) return false;
	drawImageContained(context, art, { x: sideX + SIDE_WIDTH - POSE_BOX.width - DERO_FRAME_INSET, y: FRAME_TOP - 8, ...POSE_BOX });
	return true;
}

// The middle column: VS, and the result as a pill lit for a winner or muted for a tie.
function drawCenter(context: SKRSContext2D, view: RpsCardView): void {
	const copy = gamesCopy.rps;
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
	const tie = view.winner === "tie";
	drawPill(context, {
		x: centerX - PILL_WIDTH / 2,
		y: CARD_HEIGHT / 2 + 10,
		width: PILL_WIDTH,
		height: 40,
		fill: canvasColor(tie ? COLORS.CARD_NESTED : COLORS.GAME_RPS),
		label: tie ? copy.cardTie : copy.cardWin,
		labelColor: canvasColor(COLORS.CARD_TEXT),
		labelWeight: "bold",
	});
}

// The winning side's border, so the winner reads at a glance.
function strokePanel(context: SKRSContext2D, x: number): void {
	context.save();
	context.beginPath();
	context.roundRect(x, PADDING, SIDE_WIDTH, CARD_HEIGHT - PADDING * 2, PANEL_RADIUS);
	context.strokeStyle = canvasColor(COLORS.GAME_RPS);
	context.lineWidth = WINNER_BORDER_WIDTH;
	context.stroke();
	context.restore();
}
