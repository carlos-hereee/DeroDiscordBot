import { resolveColor, type ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import type { Image, SKRSContext2D } from "./canvasModule.js";
import { rendererFont, type RendererFontWeight } from "./fonts.js";

// ── primitives ───────────────────────────────────────────────────────
// The drawing pieces every card composes from: the card's dark sheet, a circular
// crop, a filled and a stroked circle, a stroked line, a rounded panel, an aspect
// fitted image, a pill, one bar of a horizontal bar chart, a radial gradient
// wash, a playing card with its suit pips, and Inter text. Each draws
// onto the context it is handed and leaves that context's state as it found it.
// None loads an image, a font or the canvas library, and none decides layout.
// Card renderers (2026-10 item 243 Phases 2 to 4) call them inside renderCard's
// draw function, so no surface draws its own crop or bar.

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * A brand color token (a discord.js color name or hex, as `COLORS` in
 * @base/copy/brand holds them) as the `#rrggbb` string canvas wants. Cards take
 * their colors through this, never as a second hex literal, so a card and its
 * fallback embed can never disagree on a color.
 */
export function canvasColor(color: ColorResolvable): string {
	return `#${resolveColor(color).toString(16).padStart(6, "0")}`;
}

/**
 * A `#rrggbb` color at an opacity from 0 to 1, as `#rrggbbaa`: the fading stop
 * of a glow. Takes a token through canvasColor first, so a glow is always a
 * brand color made transparent, never a new hex.
 */
export function withAlpha(color: ColorResolvable, alpha: number): string {
	const byte = Math.round(clampRatio(alpha) * 255);
	return `${canvasColor(color)}${byte.toString(16).padStart(2, "0")}`;
}

// A card's corners are rounded so the dark sheet sits inside Discord's embed
// like the platform's own panels do; outside the corners stays transparent.
const CARD_CORNER_RADIUS = 28;
// How strongly the accent glows out of the background: enough to tie the card
// to its embed color, faint enough that white text on it keeps its contrast.
const ACCENT_GLOW_ALPHA = 0.35;

/**
 * Paints a card's dark sheet over the whole canvas and a soft glow of `accent`
 * centred on (glowX, glowY). Every card starts here, so the leveling cards and
 * the arcade cards share one sheet and one corner radius.
 */
export function drawCardBackground(context: SKRSContext2D, accent: ColorResolvable, glowX: number, glowY: number, glowRadius: number): void {
	const { width, height } = context.canvas;
	drawPanel(context, { x: 0, y: 0, width, height, radius: CARD_CORNER_RADIUS, fill: canvasColor(COLORS.CARD_BACKGROUND) });
	context.save();
	// The glow is clipped to the rounded sheet, or it would paint the transparent corners.
	context.beginPath();
	context.roundRect(0, 0, width, height, CARD_CORNER_RADIUS);
	context.clip();
	fillRadialGradient(context, {
		centerX: glowX,
		centerY: glowY,
		innerRadius: 0,
		outerRadius: glowRadius,
		stops: [
			{ offset: 0, color: withAlpha(accent, ACCENT_GLOW_ALPHA) },
			{ offset: 1, color: withAlpha(accent, 0) },
		],
	});
	context.restore();
}

/** Draws `image` cropped to a circle of `diameter` centred on (centerX, centerY): the avatar shape. */
export function drawCircularImage(context: SKRSContext2D, image: Image, centerX: number, centerY: number, diameter: number): void {
	const radius = diameter / 2;
	context.save();
	context.beginPath();
	context.arc(centerX, centerY, radius, 0, Math.PI * 2);
	context.closePath();
	context.clip();
	context.drawImage(image, centerX - radius, centerY - radius, diameter, diameter);
	context.restore();
}

/** A filled circle of `diameter` centred on (centerX, centerY): the avatar placeholder, a medallion, a dot. */
export function fillCircle(context: SKRSContext2D, centerX: number, centerY: number, diameter: number, fill: string): void {
	context.save();
	context.beginPath();
	context.arc(centerX, centerY, diameter / 2, 0, Math.PI * 2);
	context.closePath();
	context.fillStyle = fill;
	context.fill();
	context.restore();
}

/** A circle's outline of `diameter` centred on (centerX, centerY): a ring, or a hanged figure's head. */
export function strokeCircle(context: SKRSContext2D, centerX: number, centerY: number, diameter: number, color: string, lineWidth: number): void {
	context.save();
	context.beginPath();
	context.arc(centerX, centerY, diameter / 2, 0, Math.PI * 2);
	context.closePath();
	context.strokeStyle = color;
	context.lineWidth = lineWidth;
	context.stroke();
	context.restore();
}

export interface Point {
	x: number;
	y: number;
}

export interface LineOptions {
	color: string;
	lineWidth: number;
}

/**
 * An open line through `points` in order, with round caps and joins so a joint
 * reads as one stroke rather than two butted ends: the gallows, a limb. Fewer
 * than two points draws nothing.
 */
export function strokeLine(context: SKRSContext2D, points: readonly Point[], { color, lineWidth }: LineOptions): void {
	const [first, ...rest] = points;
	if (!first || rest.length === 0) return;
	context.save();
	context.beginPath();
	context.moveTo(first.x, first.y);
	for (const point of rest) context.lineTo(point.x, point.y);
	context.strokeStyle = color;
	context.lineWidth = lineWidth;
	context.lineCap = "round";
	context.lineJoin = "round";
	context.stroke();
	context.restore();
}

export interface PanelOptions extends Rect {
	fill: string;
	radius: number;
}

/**
 * A filled rectangle with rounded corners: a card's panel or a row inside it.
 * Separate from drawPill because a pill is always fully rounded, and a panel
 * with a radius of half its height would read as a button.
 */
export function drawPanel(context: SKRSContext2D, { x, y, width, height, fill, radius }: PanelOptions): void {
	context.save();
	context.beginPath();
	context.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
	context.fillStyle = fill;
	context.fill();
	context.restore();
}

/**
 * Draws `image` as large as fits inside `box`, keeping its aspect ratio and
 * centring it: the way a mascot or a piece of art sits in its slot. A stretched
 * Dero is the failure this exists to stop, since art arrives in more than one
 * shape (a square figure, a wide strip of tier variants).
 */
export function drawImageContained(context: SKRSContext2D, image: Image, box: Rect): void {
	if (image.width <= 0 || image.height <= 0) return;
	const scale = Math.min(box.width / image.width, box.height / image.height);
	const width = image.width * scale;
	const height = image.height * scale;
	context.drawImage(image, box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, width, height);
}

export interface PillOptions extends Rect {
	fill: string;
	label?: string;
	labelColor?: string;
	labelWeight?: RendererFontWeight;
}

// A pill's label is set at half its height: big enough to read at Discord's
// embed scale, with a quarter of the height clear above and below it.
const PILL_LABEL_SCALE = 0.5;
const PILL_LABEL_COLOR = "#ffffff";
// The least share of a pill's width its label may use. A wide pill keeps its
// label off the rounded ends (width minus height), but a round count badge has
// no straight run at all, and a zero width would draw no label; 0.7 is about the
// square inscribed in a circle (1 over the square root of 2), so the count stays
// inside the badge.
const PILL_LABEL_MIN_WIDTH_SHARE = 0.7;

/** A fully rounded rectangle, with an optional label centred inside it: a badge, a tag or a count. */
export function drawPill(context: SKRSContext2D, { x, y, width, height, fill, label, labelColor, labelWeight }: PillOptions): void {
	context.save();
	context.beginPath();
	context.roundRect(x, y, width, height, height / 2);
	context.fillStyle = fill;
	context.fill();
	context.restore();
	if (!label) return;
	drawText(context, label, {
		x: x + width / 2,
		y: y + height / 2,
		size: Math.round(height * PILL_LABEL_SCALE),
		weight: labelWeight ?? "bold",
		color: labelColor ?? PILL_LABEL_COLOR,
		align: "center",
		baseline: "middle",
		maxWidth: Math.max(width - height, width * PILL_LABEL_MIN_WIDTH_SHARE),
	});
}

export interface BarSegmentOptions extends Rect {
	/** The filled share of the bar, 0 to 1. Clamped, and NaN draws empty. */
	fillRatio: number;
	fillColor: string;
	/** The unfilled track behind the fill. Omitted, only the fill is drawn. */
	trackColor?: string;
	/** Corner radius; half the height (fully rounded ends) when omitted. */
	radius?: number;
}

/**
 * One horizontal bar: the full width track, then the filled share of it from
 * the left. The ratio is clamped so a caller's arithmetic slip draws an empty or
 * a full bar instead of spilling past the track.
 */
export function drawBarSegment(context: SKRSContext2D, options: BarSegmentOptions): void {
	const { x, y, width, height, fillColor, trackColor } = options;
	const radius = options.radius ?? height / 2;
	const filledWidth = width * clampRatio(options.fillRatio);
	context.save();
	if (trackColor) {
		context.beginPath();
		context.roundRect(x, y, width, height, radius);
		context.fillStyle = trackColor;
		context.fill();
	}
	if (filledWidth > 0) {
		context.beginPath();
		// A sliver narrower than its own rounding would draw as a blob, so the
		// corners shrink with it.
		context.roundRect(x, y, filledWidth, height, Math.min(radius, filledWidth / 2));
		context.fillStyle = fillColor;
		context.fill();
	}
	context.restore();
}

export interface GradientStop {
	/** Where the stop sits between the inner and outer radius, 0 to 1. */
	offset: number;
	color: string;
}

export interface RadialGradientOptions {
	centerX: number;
	centerY: number;
	innerRadius: number;
	outerRadius: number;
	stops: readonly GradientStop[];
	/** The area painted. The whole canvas when omitted. */
	area?: Rect;
}

/** Paints a radial gradient over an area: the glow behind an avatar, or a vignette across a panel. */
export function fillRadialGradient(context: SKRSContext2D, options: RadialGradientOptions): void {
	const { centerX, centerY, innerRadius, outerRadius, stops } = options;
	const area = options.area ?? { x: 0, y: 0, width: context.canvas.width, height: context.canvas.height };
	const gradient = context.createRadialGradient(centerX, centerY, innerRadius, centerX, centerY, outerRadius);
	for (const stop of stops) gradient.addColorStop(clampRatio(stop.offset), stop.color);
	context.save();
	context.fillStyle = gradient;
	context.fillRect(area.x, area.y, area.width, area.height);
	context.restore();
}

/** The four suits as a playing card shows them. Each game maps its own suit codes onto these. */
export type CardSuit = "spade" | "heart" | "diamond" | "club";

const RED_SUITS: ReadonlySet<CardSuit> = new Set(["heart", "diamond"]);

/** The ink a suit prints in: red for hearts and diamonds, black for spades and clubs. */
export function suitInk(suit: CardSuit): string {
	return canvasColor(RED_SUITS.has(suit) ? COLORS.PLAYING_CARD_RED : COLORS.PLAYING_CARD_BLACK);
}

/**
 * One suit pip, `size` pixels tall, centred on (centerX, centerY).
 *
 * Drawn as paths, never as the ♠ ♥ ♦ ♣ characters: Inter has no glyphs for
 * them (they measure as the missing glyph box), and a Railway container may
 * carry no fallback face that does, so a text pip would print as a box.
 */
export function drawSuitPip(context: SKRSContext2D, suit: CardSuit, centerX: number, centerY: number, size: number): void {
	context.save();
	context.fillStyle = suitInk(suit);
	context.beginPath();
	switch (suit) {
		case "diamond":
			context.moveTo(centerX, centerY - size / 2);
			context.lineTo(centerX + size * 0.38, centerY);
			context.lineTo(centerX, centerY + size / 2);
			context.lineTo(centerX - size * 0.38, centerY);
			context.closePath();
			break;
		case "heart":
			// Two mirrored curves from the bottom point to the dip between the lobes.
			context.moveTo(centerX, centerY + size * 0.5);
			context.bezierCurveTo(centerX - size * 0.6, centerY + size * 0.05, centerX - size * 0.5, centerY - size * 0.55, centerX, centerY - size * 0.25);
			context.bezierCurveTo(centerX + size * 0.5, centerY - size * 0.55, centerX + size * 0.6, centerY + size * 0.05, centerX, centerY + size * 0.5);
			context.closePath();
			break;
		case "spade":
			// The heart turned upside down, then a stem below it.
			context.moveTo(centerX, centerY - size * 0.5);
			context.bezierCurveTo(centerX - size * 0.6, centerY - size * 0.05, centerX - size * 0.5, centerY + size * 0.4, centerX, centerY + size * 0.15);
			context.bezierCurveTo(centerX + size * 0.5, centerY + size * 0.4, centerX + size * 0.6, centerY - size * 0.05, centerX, centerY - size * 0.5);
			context.closePath();
			pipStem(context, centerX, centerY, size);
			break;
		case "club":
			for (const [dx, dy] of [[0, -0.24], [-0.24, 0.06], [0.24, 0.06]]) {
				context.moveTo(centerX + size * dx + size * 0.21, centerY + size * dy);
				context.arc(centerX + size * dx, centerY + size * dy, size * 0.21, 0, Math.PI * 2);
			}
			pipStem(context, centerX, centerY, size);
			break;
	}
	context.fill();
	context.restore();
}

// The stem under a spade or a club: a narrow triangle from the pip's middle to its foot.
function pipStem(context: SKRSContext2D, centerX: number, centerY: number, size: number): void {
	context.moveTo(centerX, centerY);
	context.lineTo(centerX + size * 0.16, centerY + size * 0.5);
	context.lineTo(centerX - size * 0.16, centerY + size * 0.5);
	context.closePath();
}

/** One playing card's face as a card draws it. Each game maps its own card type onto this. */
export interface PlayingCardFace {
	/** What the corner prints: "A", "10", "K". */
	rank: string;
	suit: CardSuit;
}

export type PlayingCardOptions = Rect & PlayingCardFace;

// A playing card's proportions, measured against its width: the corner radius,
// the corner index's inset, its rank size and pip size, and the big centre pip.
const PLAYING_CARD_RADIUS = 0.1;
const PLAYING_CARD_INSET = 0.1;
const PLAYING_CARD_RANK_SIZE = 0.3;
const PLAYING_CARD_CORNER_PIP = 0.2;
const PLAYING_CARD_CENTRE_PIP = 0.5;

/**
 * A face up playing card: the white stock, the rank and a small pip in the top
 * left corner, and one large pip in the middle. One drawing for every game that
 * deals cards, so a blackjack hand and a hold em board look like one deck.
 */
export function drawPlayingCard(context: SKRSContext2D, { x, y, width, height, rank, suit }: PlayingCardOptions): void {
	drawPanel(context, { x, y, width, height, radius: width * PLAYING_CARD_RADIUS, fill: canvasColor(COLORS.PLAYING_CARD_FACE) });
	const inset = width * PLAYING_CARD_INSET;
	const rankSize = Math.round(width * PLAYING_CARD_RANK_SIZE);
	drawText(context, rank, { x: x + inset, y: y + inset, size: rankSize, weight: "bold", color: suitInk(suit), baseline: "top" });
	const cornerPip = width * PLAYING_CARD_CORNER_PIP;
	drawSuitPip(context, suit, x + inset + cornerPip / 2, y + inset + rankSize * 1.1 + cornerPip / 2, cornerPip);
	drawSuitPip(context, suit, x + width / 2, y + height * 0.58, width * PLAYING_CARD_CENTRE_PIP);
}

export interface TextOptions {
	x: number;
	y: number;
	size: number;
	color: string;
	weight?: RendererFontWeight;
	align?: SKRSContext2D["textAlign"];
	baseline?: SKRSContext2D["textBaseline"];
	/** Past this width the canvas squeezes the line to fit rather than overflowing the card. */
	maxWidth?: number;
}

/**
 * One line of text in Inter, falling back to the host's sans-serif for any
 * glyph Inter lacks (and for every glyph when the bundled fonts did not
 * register), so a name in another script still draws instead of boxes.
 */
export function drawText(context: SKRSContext2D, text: string, options: TextOptions): void {
	context.save();
	context.font = rendererFont(options.size, options.weight);
	context.fillStyle = options.color;
	context.textAlign = options.align ?? "left";
	context.textBaseline = options.baseline ?? "alphabetic";
	if (options.maxWidth === undefined) context.fillText(text, options.x, options.y);
	else context.fillText(text, options.x, options.y, options.maxWidth);
	context.restore();
}

function clampRatio(ratio: number): number {
	if (Number.isNaN(ratio)) return 0;
	return Math.min(1, Math.max(0, ratio));
}
