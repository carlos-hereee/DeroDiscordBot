import { COLORS } from "@base/copy/brand.js";
import { fetchAvatar, type AvatarRequest } from "./avatarCache.js";
import type { SKRSContext2D } from "./canvasModule.js";
import { loadDeroArt, type DeroArtSlot } from "./deroArt.js";
import { canvasColor, drawCircularImage, drawImageContained, drawText, fillCircle, withAlpha, type Rect } from "./primitives.js";

// ── card parts ───────────────────────────────────────────────────────
// The two composed pieces most cards draw: a member's face with its placeholder,
// and Dero's pose from the v2 lineup. Unlike primitives.ts these load an image,
// so they live beside it rather than in it. They decide no layout of their own.
// The leveling cards of 2026-10 item 243 Phase 2 drew them first; the platform
// cards of Phase 4 (welcome, voice presence, fortune, challenge, role unlock,
// weekly digest) are their second users, which is why they live here now.
//
// Each answers whether it drew a stand in, so the card's draw function can
// answer `{ cacheable: false }` (see DrawOutcome in index.ts) and the stand in
// is never stored under an immutable S3 key.

// A placeholder face shows the name's first letter at this share of its size.
const PLACEHOLDER_LETTER_SCALE = 0.45;
const PLACEHOLDER_DISC_ALPHA = 0.3;

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

// Array.from walks code points, so a name that opens with an emoji or an
// astral letter shows that whole character rather than half a surrogate pair.
function firstLetter(name: string): string {
	const [first] = Array.from(name.trim());
	return first ? first.toUpperCase() : "?";
}
