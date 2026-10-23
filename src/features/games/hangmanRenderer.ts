import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackground,
	drawPanel,
	drawPill,
	drawText,
	renderCard,
	strokeCircle,
	strokeLine,
	withAlpha,
	type Point,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { gamesCopy } from "./gamesCopy.js";
import { HANGMAN_MAX_WRONG, revealedLetters, wrongLetters, type HangmanState } from "./hangmanState.js";

// ── hangmanRenderer ──────────────────────────────────────────────────
// The hangman card (2026-10 item 243 Phase 3): the gallows drawn at one of its
// seven states (an empty frame, then head, body, two arms and two legs, one per
// wrong guess), the word's letter tiles with only the guessed ones filled in,
// and the misses. The same card with an ending set is the end card, which
// swaps the attempts count for how the round ended.
// hangmanHandler draws it on every board edit and at the end; roomHangman draws
// the end card only, because a room's move posts never carry a file (risk R8).
// Both call through withRenderFallback, so the gallows art or the Dero still
// takes the image slot whenever the card does not draw.
//
// ⚠️ THE CARD NEVER RECEIVES THE WORD, only revealedLetters. The input is hashed
// into the attachment name and the cache key, and the word bank is small enough
// to hash every entry, so a word in the input could be read back from a file
// name while the round is still live. A solved round's tiles are the whole
// word, which by then the room has already seen.

/** How a round ended, or null while it is still being played. */
export type HangmanEnding = "solved" | "lost" | "expired";

/** Everything the hangman card draws, and nothing a guesser has not already seen. */
export interface HangmanCardView {
	/** One entry per letter of the word: the letter once guessed, null until then. */
	revealed: Array<string | null>;
	/** Wrong letters in guess order. */
	misses: string[];
	/** Wrong guesses so far, which is the gallows stage (0 to 6). */
	wrong: number;
	ending: HangmanEnding | null;
}

/** The card's view of a round, built from the state the board text is built from. */
export function hangmanCardView(state: HangmanState, ending: HangmanEnding | null = null): HangmanCardView {
	return { revealed: revealedLetters(state), misses: wrongLetters(state), wrong: state.wrong, ending };
}

// Bump whenever the drawing changes, or members keep seeing cached cards.
const HANGMAN_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const CARD_HEIGHT = 420;
const GALLOWS_STROKE = 10;
const FIGURE_STROKE = 8;
const HEAD_DIAMETER = 56;
const TILES_LEFT = 400;
const TILES_RIGHT = 920;
const TILES_TOP = 150;
const TILE_GAP = 8;
// The widest a tile gets, so a four letter word does not draw four slabs.
const TILE_MAX_WIDTH = 60;
const TILE_HEIGHT = 74;

// The gallows frame in card pixels, in drawing order: the base, the upright, the
// beam and its brace, and the rope down to where the head hangs.
const GALLOWS_BASE: readonly Point[] = [{ x: 60, y: 380 }, { x: 300, y: 380 }];
const GALLOWS_FRAME: readonly Point[] = [{ x: 110, y: 380 }, { x: 110, y: 50 }, { x: 260, y: 50 }];
const GALLOWS_BRACE: readonly Point[] = [{ x: 110, y: 110 }, { x: 170, y: 50 }];
const ROPE: readonly Point[] = [{ x: 260, y: 50 }, { x: 260, y: 100 }];
const HEAD_CENTER: Point = { x: 260, y: 100 + HEAD_DIAMETER / 2 };
const NECK: Point = { x: 260, y: 100 + HEAD_DIAMETER };
const HIP: Point = { x: 260, y: 250 };
const SHOULDER: Point = { x: 260, y: 185 };

// One part per wrong guess, in the order classic hangman adds them. The head is
// a circle and drawn on its own, so its slot here is empty.
const FIGURE_LIMBS: ReadonlyArray<readonly Point[]> = [
	[],
	[NECK, HIP],
	[SHOULDER, { x: 212, y: 225 }],
	[SHOULDER, { x: 308, y: 225 }],
	[HIP, { x: 220, y: 320 }],
	[HIP, { x: 300, y: 320 }],
];

const ENDING_LABEL: Record<HangmanEnding, string> = {
	solved: gamesCopy.hangman.cardSolved,
	lost: gamesCopy.hangman.cardLost,
	expired: gamesCopy.hangman.cardExpired,
};

// An expiry is nobody's loss, so it takes the muted ink rather than the red.
const ENDING_FILL: Record<HangmanEnding, ColorResolvable> = {
	solved: COLORS.CARD_OUTCOME_WIN,
	lost: COLORS.CARD_OUTCOME_LOSE,
	expired: COLORS.CARD_TEXT_MUTED,
};

/** The hangman card, or null when the board should keep its art. Never throws. */
export function renderHangmanCard(view: HangmanCardView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "hangman",
		version: HANGMAN_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		draw: drawHangmanCard,
	});
}

function drawHangmanCard(context: SKRSContext2D, view: HangmanCardView): void {
	drawCardBackground(context, COLORS.GAME_HANGMAN, HEAD_CENTER.x, HEAD_CENTER.y, CARD_WIDTH * 0.45);
	drawGallows(context, view.wrong);
	drawLetterTiles(context, view.revealed);
	drawMisses(context, view.misses);
	drawStatusPill(context, view);
}

// ① The frame is always there (stage 0 is the empty gallows), then one part of
// the figure per wrong guess, clamped so a miscount draws the full figure.
function drawGallows(context: SKRSContext2D, wrong: number): void {
	const frame = { color: canvasColor(COLORS.CARD_TEXT_SECONDARY), lineWidth: GALLOWS_STROKE };
	for (const line of [GALLOWS_BASE, GALLOWS_FRAME, GALLOWS_BRACE, ROPE]) strokeLine(context, line, frame);

	const stage = Math.min(HANGMAN_MAX_WRONG, Math.max(0, Math.floor(wrong)));
	if (stage === 0) return;
	const figureColor = canvasColor(COLORS.CARD_TEXT);
	strokeCircle(context, HEAD_CENTER.x, HEAD_CENTER.y, HEAD_DIAMETER, figureColor, FIGURE_STROKE);
	for (const limb of FIGURE_LIMBS.slice(1, stage)) strokeLine(context, limb, { color: figureColor, lineWidth: FIGURE_STROKE });
}

// ② One tile per letter, sized so the longest word (twelve letters) still fits
// the right hand side of the card in a single row.
function drawLetterTiles(context: SKRSContext2D, revealed: Array<string | null>): void {
	const count = Math.max(1, revealed.length);
	const span = TILES_RIGHT - TILES_LEFT;
	const tileWidth = Math.min(TILE_MAX_WIDTH, (span - TILE_GAP * (count - 1)) / count);
	const rowWidth = tileWidth * count + TILE_GAP * (count - 1);
	const left = TILES_LEFT + (span - rowWidth) / 2;

	revealed.forEach((letter, index) => {
		const x = left + index * (tileWidth + TILE_GAP);
		drawPanel(context, { x, y: TILES_TOP, width: tileWidth, height: TILE_HEIGHT, radius: 10, fill: canvasColor(COLORS.CARD_PANEL) });
		if (letter === null) return;
		drawText(context, letter.toUpperCase(), {
			x: x + tileWidth / 2,
			y: TILES_TOP + TILE_HEIGHT / 2,
			size: Math.round(Math.min(TILE_HEIGHT * 0.55, tileWidth * 0.8)),
			weight: "bold",
			color: canvasColor(COLORS.CARD_TEXT),
			align: "center",
			baseline: "middle",
		});
	});
}

function drawMisses(context: SKRSContext2D, misses: string[]): void {
	drawText(context, gamesCopy.hangman.cardMisses, {
		x: TILES_LEFT,
		y: 290,
		size: 18,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT_MUTED),
	});
	drawText(context, misses.length > 0 ? misses.map((letter) => letter.toUpperCase()).join("  ") : gamesCopy.hangman.noMisses, {
		x: TILES_LEFT,
		y: 330,
		size: 30,
		weight: "bold",
		color: canvasColor(misses.length > 0 ? COLORS.CARD_OUTCOME_LOSE : COLORS.CARD_TEXT_SECONDARY),
		maxWidth: TILES_RIGHT - TILES_LEFT,
	});
}

// ③ While playing, how many attempts are left; at the end, how it ended, in the
// outcome's color so a solved card and a hanged one differ before a word is read.
function drawStatusPill(context: SKRSContext2D, view: HangmanCardView): void {
	const box = { x: TILES_LEFT, y: 60, width: 300, height: 48 };
	if (view.ending === null) {
		const remaining = Math.max(0, HANGMAN_MAX_WRONG - view.wrong);
		drawPill(context, { ...box, fill: withAlpha(COLORS.GAME_HANGMAN, 0.25), label: gamesCopy.hangman.cardAttemptsLeft(remaining), labelColor: canvasColor(COLORS.CARD_TEXT) });
		return;
	}
	drawPill(context, { ...box, fill: canvasColor(ENDING_FILL[view.ending]), label: ENDING_LABEL[view.ending], labelColor: canvasColor(COLORS.CARD_BACKGROUND) });
}
