import { canvasModule, type Image } from "@features/renderer/canvasModule.js";
import { gameAssetPath, playingCardAssetPath, type GameAssetKey } from "./gamesAssets.js";
import type { CardSuit, PlayingCardFace } from "@features/renderer/primitives.js";

// ── gamesArt ─────────────────────────────────────────────────────────
// Decodes the games' art for the canvas cards: one image per manifest slot (or
// per deck face), decoded on first use and kept for the life of the process. It
// answers null for art that is not on disk, or when the canvas library did not
// load, so a card can draw its own stand in instead; it never throws. It decides
// nothing about layout. Callers are monopolyRenderer and the hangman,
// battleship, blackjack and hold em showdown cards (2026-10 item 243).
//
// Nothing here notices a file changing on disk: new art reaches Railway with a
// deploy, which restarts the process and empties the cache.

const decoded = new Map<string, Image>();

async function loadFile(path: string | null): Promise<Image | null> {
	if (!path || !canvasModule) return null;
	const cached = decoded.get(path);
	if (cached) return cached;
	const image = await canvasModule.loadImage(path);
	decoded.set(path, image);
	return image;
}

/** One manifest slot's art, decoded, or null while the file is not on disk. */
export function loadGameArt(key: GameAssetKey): Promise<Image | null> {
	return loadFile(gameAssetPath(key));
}

/** One face of the Dero deck, decoded, or null while its file is not on disk. */
export function loadPlayingCardArt(rank: string, suit: CardSuit): Promise<Image | null> {
	return loadFile(playingCardAssetPath(rank, suit));
}

/** The deck's art for a set of cards, and whether every one of them had a file. */
export interface DeckFaces {
	faceFor(card: PlayingCardFace): Image | null;
	allPresent: boolean;
}

/**
 * Loads the deck's face for every card a card is about to draw, once each. The
 * blackjack result and the hold em showdown draw through this, and read
 * `allPresent` to answer `{ cacheable: false }` when any face was a stand in.
 */
export async function loadDeckFaces(cards: readonly PlayingCardFace[]): Promise<DeckFaces> {
	const keyOf = (card: PlayingCardFace): string => `${card.rank}:${card.suit}`;
	const faces = new Map<string, Image | null>();
	for (const card of cards) {
		if (!faces.has(keyOf(card))) faces.set(keyOf(card), await loadPlayingCardArt(card.rank, card.suit));
	}
	return { faceFor: (card) => faces.get(keyOf(card)) ?? null, allPresent: [...faces.values()].every((face) => face !== null) };
}

/** Forget every decoded image, so a test can swap the art or the canvas mock between cases. */
export function clearGameArtCache(): void {
	decoded.clear();
}

// ── reading a color out of the art ──
// The hangman tiles carry a sample letter that the card paints over with the
// tile's own fill before printing the real one. The fill is read from the art
// rather than written down as a hex, so a re-export in another shade still
// matches, which is the one thing a painted over patch must do.
// Keyed by the decoded image itself, so a cleared cache takes its samples with it.
const sampledColors = new WeakMap<Image, Map<string, string>>();

/**
 * The color of `image` at a point given as shares of its width and height, as
 * `rgb(r, g, b)`, or null when the canvas library is missing. Cached per image
 * and point.
 */
export function sampleArtColor(image: Image, xShare: number, yShare: number): string | null {
	if (!canvasModule) return null;
	const samples = sampledColors.get(image) ?? new Map<string, string>();
	sampledColors.set(image, samples);
	const key = `${xShare}:${yShare}`;
	const cached = samples.get(key);
	if (cached) return cached;
	const probe = canvasModule.createCanvas(image.width, image.height);
	const context = probe.getContext("2d");
	context.drawImage(image, 0, 0);
	const x = Math.min(image.width - 1, Math.max(0, Math.round(image.width * xShare)));
	const y = Math.min(image.height - 1, Math.max(0, Math.round(image.height * yShare)));
	const [red, green, blue] = context.getImageData(x, y, 1, 1).data;
	const color = `rgb(${red}, ${green}, ${blue})`;
	samples.set(key, color);
	return color;
}
