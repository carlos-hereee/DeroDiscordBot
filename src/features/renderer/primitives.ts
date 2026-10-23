import { resolveColor, type ColorResolvable } from "discord.js";
import type { Image, SKRSContext2D } from "./canvasModule.js";
import { rendererFont, type RendererFontWeight } from "./fonts.js";

// ── primitives ───────────────────────────────────────────────────────
// The drawing pieces every card composes from: a circular crop, a filled circle,
// a rounded panel, an aspect fitted image, a pill, one bar of a horizontal bar
// chart, a radial gradient wash, and Inter text. Each draws
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
