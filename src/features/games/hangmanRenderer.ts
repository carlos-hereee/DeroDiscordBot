import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackdrop,
	drawCardBackground,
	drawImageContained,
	drawPanel,
	drawPill,
	drawText,
	renderCard,
	strokeCircle,
	strokeLine,
	withAlpha,
	type DrawOutcome,
	type Point,
	type Rect,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { Image, SKRSContext2D } from "@features/renderer/canvasModule.js";
import { gamesCopy } from "./gamesCopy.js";
import { hangmanStageKey, type GameAssetKey } from "./gamesAssets.js";
import { loadGameArt, sampleArtColor } from "./gamesArt.js";
import { HANGMAN_MAX_WRONG, revealedLetters, wrongLetters, type HangmanState } from "./hangmanState.js";

// ── hangmanRenderer ──────────────────────────────────────────────────
// The hangman card (2026-10 item 243 Phases 3 and 3b), drawn from the owner's
// art: the night scene behind it, the logo, Dero's pose, the gallows at one of
// its seven frames (the empty gallows, five stages of the figure, then the full
// scene), the word's letter tiles with only the guessed ones filled, and a
// keyboard of all 26 letters lit green for a hit and red for a miss. With an
// ending set it is the end card: the attempts count gives way to the "YOU WIN"
// or "GAME OVER" banner. hangmanHandler draws it on every board edit and at the
// end; roomHangman draws the end card only, because a room's move posts never
// carry a file (risk R8). Both call through withRenderFallback.
//
// Every element falls back to a drawing of its own when its art is not on disk
// (the plain sheet, a drawn gallows, a plain tile, a pill), and a card that drew
// any of them answers `{ cacheable: false }`, so the stand in is never stored
// under a key the real art would have used.
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
const HANGMAN_CARD_VERSION = 2;
const CARD_WIDTH = 960;
const CARD_HEIGHT = 460;
// How dark the wash over the night scene is: enough for white letters to read
// on the moonlit water, light enough that the scene still shows.
const BACKDROP_WASH = 0.45;
const LOGO_BOX: Rect = { x: 24, y: 14, width: 250, height: 110 };
const DERO_BOX: Rect = { x: 806, y: 10, width: 134, height: 140 };
const GALLOWS_BOX: Rect = { x: 30, y: 140, width: 290, height: 300 };
const STATUS_PILL: Rect = { x: 360, y: 44, width: 280, height: 46 };
const BANNER_BOX: Rect = { x: 320, y: 8, width: 420, height: 134 };
const RIGHT_LEFT = 360;
const RIGHT_RIGHT = 930;
const WORD_TOP = 168;
const KEYBOARD_TOP = 292;
const KEY_GAP = 5;
const TILE_GAP = 8;
// The tile art is 200 wide by 170 tall, so a tile drawn at any width keeps it.
const TILE_ASPECT = 170 / 200;
// The widest a word tile gets, so a four letter word does not draw four slabs.
const WORD_TILE_MAX_WIDTH = 82;
const KEYBOARD = ["abcdefghijklm", "nopqrstuvwxyz"];

// Where the sample "A" sits on the tile art, as shares of the tile: the patch
// painted over it before the real letter is printed, and a point inside the
// tile's fill (clear of the letter's apex and legs) that gives the patch its color.
const TILE_LETTER_PATCH = { x: 0.24, y: 0.2, width: 0.52, height: 0.6 };
const TILE_FILL_SAMPLE = { x: 0.27, y: 0.3 };

// The fallback gallows, drawn when the art is missing, in its own 330 tall
// frame of reference and scaled into GALLOWS_BOX: the base, the upright, the
// beam and its brace, and the rope down to where the head hangs.
const GALLOWS_STROKE = 10;
const FIGURE_STROKE = 8;
const HEAD_DIAMETER = 56;
const DRAWN_GALLOWS_TOP = 50;
const DRAWN_GALLOWS_HEIGHT = 330;
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

// An expiry is nobody's loss, so its fallback pill takes the muted ink rather
// than the red. The art has one "GAME OVER" banner for both.
const ENDING_FILL: Record<HangmanEnding, ColorResolvable> = {
	solved: COLORS.CARD_OUTCOME_WIN,
	lost: COLORS.CARD_OUTCOME_LOSE,
	expired: COLORS.CARD_TEXT_MUTED,
};

const ENDING_BANNER: Record<HangmanEnding, GameAssetKey> = { solved: "hangmanWin", lost: "hangmanLose", expired: "hangmanLose" };
const ENDING_POSE: Record<HangmanEnding, GameAssetKey> = { solved: "hangmanDeroWin", lost: "hangmanDeroLose", expired: "hangmanDeroLose" };

type KeyState = "unused" | "hit" | "miss";

const KEY_TILE: Record<KeyState, GameAssetKey> = { unused: "hangmanTileDefault", hit: "hangmanTileCorrect", miss: "hangmanTileWrong" };
const KEY_INK: Record<KeyState, ColorResolvable> = { unused: COLORS.PLAYING_CARD_FACE, hit: COLORS.CARD_OUTCOME_WIN, miss: COLORS.CARD_OUTCOME_LOSE };

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

// Each step answers whether it drew a stand in for missing art.
async function drawHangmanCard(context: SKRSContext2D, view: HangmanCardView): Promise<DrawOutcome> {
	const standIns = [
		await drawBackdrop(context),
		await drawArtIfPresent(context, "hangmanLogo", LOGO_BOX),
		await drawArtIfPresent(context, deroPose(view), DERO_BOX),
		await drawGallows(context, view.wrong),
		await drawStatus(context, view),
		await drawWord(context, view.revealed),
		await drawKeyboard(context, view),
	];
	return standIns.some(Boolean) ? { cacheable: false } : undefined;
}

async function drawBackdrop(context: SKRSContext2D): Promise<boolean> {
	const scene = await loadGameArt("hangmanBackground");
	if (scene) {
		drawCardBackdrop(context, scene, BACKDROP_WASH);
		return false;
	}
	drawCardBackground(context, COLORS.GAME_HANGMAN, GALLOWS_BOX.x + GALLOWS_BOX.width / 2, GALLOWS_BOX.y, CARD_WIDTH * 0.45);
	return true;
}

// The logo and Dero's pose have no drawn stand in: the card reads without
// them, so a missing file only leaves its corner empty (and the card uncached).
async function drawArtIfPresent(context: SKRSContext2D, key: GameAssetKey, box: Rect): Promise<boolean> {
	const art = await loadGameArt(key);
	if (!art) return true;
	drawImageContained(context, art, box);
	return false;
}

function deroPose(view: HangmanCardView): GameAssetKey {
	if (view.ending) return ENDING_POSE[view.ending];
	return view.wrong > 0 ? "hangmanDeroThinking" : "hangmanDeroIdle";
}

// ① The gallows frame for the miss count, or the drawn gallows when it is missing.
async function drawGallows(context: SKRSContext2D, wrong: number): Promise<boolean> {
	const frame = await loadGameArt(hangmanStageKey(wrong));
	if (frame) {
		drawImageContained(context, frame, GALLOWS_BOX);
		return false;
	}
	const scale = GALLOWS_BOX.height / DRAWN_GALLOWS_HEIGHT;
	context.save();
	context.translate(GALLOWS_BOX.x, GALLOWS_BOX.y - DRAWN_GALLOWS_TOP * scale);
	context.scale(scale, scale);
	drawDrawnGallows(context, wrong);
	context.restore();
	return true;
}

// The frame is always there (stage 0 is the empty gallows), then one part of
// the figure per wrong guess, clamped so a miscount draws the full figure.
function drawDrawnGallows(context: SKRSContext2D, wrong: number): void {
	const frame = { color: canvasColor(COLORS.CARD_TEXT_SECONDARY), lineWidth: GALLOWS_STROKE };
	for (const line of [GALLOWS_BASE, GALLOWS_FRAME, GALLOWS_BRACE, ROPE]) strokeLine(context, line, frame);

	const stage = Math.min(HANGMAN_MAX_WRONG, Math.max(0, Math.floor(wrong)));
	if (stage === 0) return;
	const figureColor = canvasColor(COLORS.CARD_TEXT);
	strokeCircle(context, HEAD_CENTER.x, HEAD_CENTER.y, HEAD_DIAMETER, figureColor, FIGURE_STROKE);
	for (const limb of FIGURE_LIMBS.slice(1, stage)) strokeLine(context, limb, { color: figureColor, lineWidth: FIGURE_STROKE });
}

// ② While playing, how many attempts are left; at the end, the ending's banner
// (or a pill in the outcome's color when the banner is missing).
async function drawStatus(context: SKRSContext2D, view: HangmanCardView): Promise<boolean> {
	if (view.ending === null) {
		const remaining = Math.max(0, HANGMAN_MAX_WRONG - view.wrong);
		drawPill(context, {
			...STATUS_PILL,
			fill: withAlpha(COLORS.GAME_HANGMAN, 0.35),
			label: gamesCopy.hangman.cardAttemptsLeft(remaining),
			labelColor: canvasColor(COLORS.CARD_TEXT),
		});
		return false;
	}
	const banner = await loadGameArt(ENDING_BANNER[view.ending]);
	if (banner) {
		drawImageContained(context, banner, BANNER_BOX);
		return false;
	}
	drawPill(context, { ...STATUS_PILL, fill: canvasColor(ENDING_FILL[view.ending]), label: ENDING_LABEL[view.ending], labelColor: canvasColor(COLORS.CARD_BACKGROUND) });
	return true;
}

// ③ One tile per letter of the word, sized so the longest word (twelve letters)
// still fits in one row: the blank tile until a letter is guessed, then the
// green tile with it.
async function drawWord(context: SKRSContext2D, revealed: Array<string | null>): Promise<boolean> {
	const count = Math.max(1, revealed.length);
	const span = RIGHT_RIGHT - RIGHT_LEFT;
	const width = Math.min(WORD_TILE_MAX_WIDTH, (span - TILE_GAP * (count - 1)) / count);
	const height = width * TILE_ASPECT;
	const left = RIGHT_LEFT + (span - (width * count + TILE_GAP * (count - 1))) / 2;
	const top = WORD_TOP + (KEYBOARD_TOP - 24 - WORD_TOP - height) / 2;
	const [blank, correct] = await Promise.all([loadGameArt("hangmanTileBlank"), loadGameArt("hangmanTileCorrect")]);
	let standIn = false;
	revealed.forEach((letter, index) => {
		const box = { x: left + index * (width + TILE_GAP), y: top, width, height };
		const drewArt = letter === null ? drawTileArt(context, blank, box, null, COLORS.CARD_TEXT) : drawTileArt(context, correct, box, letter, COLORS.CARD_OUTCOME_WIN);
		if (!drewArt) {
			standIn = true;
			drawPlainTile(context, box, letter, COLORS.CARD_TEXT, COLORS.CARD_PANEL);
		}
	});
	return standIn;
}

// ④ All 26 letters in two rows, each on the tile for how it was played. Hits
// are read from the revealed letters, so this never needs the word either.
async function drawKeyboard(context: SKRSContext2D, view: HangmanCardView): Promise<boolean> {
	const hits = new Set(view.revealed.filter((letter): letter is string => letter !== null));
	const misses = new Set(view.misses);
	const tiles: Record<KeyState, Image | null> = {
		unused: await loadGameArt(KEY_TILE.unused),
		hit: await loadGameArt(KEY_TILE.hit),
		miss: await loadGameArt(KEY_TILE.miss),
	};
	const perRow = KEYBOARD[0].length;
	const width = (RIGHT_RIGHT - RIGHT_LEFT - KEY_GAP * (perRow - 1)) / perRow;
	const height = width * TILE_ASPECT;
	let standIn = false;
	KEYBOARD.forEach((row, rowIndex) => {
		[...row].forEach((letter, index) => {
			const state = keyState(letter, hits, misses);
			const box = { x: RIGHT_LEFT + index * (width + KEY_GAP), y: KEYBOARD_TOP + rowIndex * (height + KEY_GAP), width, height };
			if (drawTileArt(context, tiles[state], box, letter, KEY_INK[state])) return;
			standIn = true;
			drawPlainTile(context, box, letter, KEY_INK[state], COLORS.CARD_NESTED);
		});
	});
	return standIn;
}

function keyState(letter: string, hits: ReadonlySet<string>, misses: ReadonlySet<string>): KeyState {
	if (hits.has(letter)) return "hit";
	if (misses.has(letter)) return "miss";
	return "unused";
}

// One tile from the art, with `letter` printed over the tile's sample "A" on a
// patch of the tile's own fill. Answers false when there was no art to draw.
function drawTileArt(context: SKRSContext2D, art: Image | null, box: Rect, letter: string | null, ink: ColorResolvable): boolean {
	if (!art) return false;
	drawImageContained(context, art, box);
	if (letter === null) return true;
	const fill = sampleArtColor(art, TILE_FILL_SAMPLE.x, TILE_FILL_SAMPLE.y);
	if (fill) {
		drawPanel(context, {
			x: box.x + box.width * TILE_LETTER_PATCH.x,
			y: box.y + box.height * TILE_LETTER_PATCH.y,
			width: box.width * TILE_LETTER_PATCH.width,
			height: box.height * TILE_LETTER_PATCH.height,
			radius: box.width * 0.06,
			fill,
		});
	}
	drawTileLetter(context, box, letter, ink);
	return true;
}

function drawPlainTile(context: SKRSContext2D, box: Rect, letter: string | null, ink: ColorResolvable, fill: ColorResolvable): void {
	drawPanel(context, { ...box, radius: box.width * 0.15, fill: canvasColor(fill) });
	if (letter !== null) drawTileLetter(context, box, letter, ink);
}

function drawTileLetter(context: SKRSContext2D, box: Rect, letter: string, ink: ColorResolvable): void {
	drawText(context, letter.toUpperCase(), {
		x: box.x + box.width / 2,
		y: box.y + box.height / 2,
		size: Math.round(box.height * 0.5),
		weight: "bold",
		color: canvasColor(ink),
		align: "center",
		baseline: "middle",
	});
}
