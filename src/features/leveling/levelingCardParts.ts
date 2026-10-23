import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCircularImage,
	drawImageContained,
	drawPanel,
	drawText,
	fetchAvatar,
	fillCircle,
	fillRadialGradient,
	loadDeroArt,
	withAlpha,
	type AvatarRequest,
	type DeroArtSlot,
	type Rect,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";

// ── leveling card parts ────────────────────────────────────────────────────
// The pieces the four leveling cards share (account, level up, levels board,
// achievement unlock): the card's background and glow, a member's face with
// its placeholder, Dero's pose, and the tier metal of an achievement. Each is
// composed from renderer primitives and decides no layout of its own. Feature
// local because only the leveling cards use them; a second feature that wants
// one moves it up into src/features/renderer/.
//
// Every part that can fall back to a stand in answers whether it did, so the
// card's draw function can answer `{ cacheable: false }` (see DrawOutcome) and
// the stand in is never stored under an immutable S3 key.

// A card's corners are rounded so the dark sheet sits inside Discord's embed
// like the platform's own panels do; outside the corners stays transparent.
const CARD_CORNER_RADIUS = 28;
// How strongly the accent glows out of the background: enough to tie the card
// to its embed color, faint enough that white text on it keeps its contrast.
const ACCENT_GLOW_ALPHA = 0.35;
// A placeholder face shows the name's first letter at this share of its size.
const PLACEHOLDER_LETTER_SCALE = 0.45;
const PLACEHOLDER_DISC_ALPHA = 0.3;

/** Paints the card's dark sheet and a soft accent glow centred on (glowX, glowY). */
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

/**
 * A member's face in a circle, or a placeholder disc with the first letter of
 * their name when the avatar cannot be had. Answers true when it drew the
 * placeholder, which makes the card a stand in.
 */
export async function drawMemberFace(
	context: SKRSContext2D,
	avatar: AvatarRequest | null | undefined,
	displayName: string,
	centerX: number,
	centerY: number,
	diameter: number
): Promise<boolean> {
	const image = avatar ? await fetchAvatar(avatar) : null;
	if (image) {
		drawCircularImage(context, image, centerX, centerY, diameter);
		return false;
	}
	// A translucent muted disc rather than a panel token, so the placeholder stays
	// visible on every surface a face sits on (the sheet, a panel, a nested row).
	fillCircle(context, centerX, centerY, diameter, withAlpha(COLORS.CARD_TEXT_MUTED, PLACEHOLDER_DISC_ALPHA));
	drawText(context, firstLetter(displayName), {
		x: centerX,
		y: centerY,
		size: Math.round(diameter * PLACEHOLDER_LETTER_SCALE),
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		align: "center",
		baseline: "middle",
	});
	return true;
}

/**
 * Dero's pose for a slot, fitted into `box`. Answers true when the pose was the
 * stand in (or nothing could be drawn), which makes the card a stand in.
 */
export async function drawDeroPose(context: SKRSContext2D, slot: DeroArtSlot, box: Rect): Promise<boolean> {
	const art = await loadDeroArt(slot);
	if (!art) return true;
	drawImageContained(context, art.image, box);
	return art.standIn;
}

// The four tier metals, and the embed's bronze for a tier name this file does
// not know yet, so a fifth tier added to achievements.ts still draws.
const TIER_COLORS: Record<string, ColorResolvable> = {
	bronze: COLORS.ACHIEVEMENT_BRONZE,
	silver: COLORS.ACHIEVEMENT_SILVER,
	gold: COLORS.ACHIEVEMENT_GOLD,
	diamond: COLORS.ACHIEVEMENT_DIAMOND,
};

/** An achievement tier's metal as a brand token, for a glow or anything else that takes a token. */
export function tierToken(tier: string): ColorResolvable {
	return TIER_COLORS[tier] ?? COLORS.ACHIEVEMENT;
}

/** An achievement tier's metal as a canvas color. */
export function tierColor(tier: string): string {
	return canvasColor(tierToken(tier));
}

// Array.from walks code points, so a name that opens with an emoji or an
// astral letter shows that whole character rather than half a surrogate pair.
function firstLetter(name: string): string {
	const [first] = Array.from(name.trim());
	return first ? first.toUpperCase() : "?";
}
