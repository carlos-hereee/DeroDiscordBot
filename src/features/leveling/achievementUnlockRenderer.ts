import { COLORS } from "@base/copy/brand.js";
import { canvasColor, drawCardBackground, drawDeroPose, drawMemberFace, drawText, fillCircle, renderCard, type AvatarRequest, type DrawOutcome, type Rect, type RenderPayload } from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { tierColor, tierToken } from "./levelingCardParts.js";
import { levelingCopy } from "./levelingCopy.js";
import type { AchievementUnlockView } from "./levelingEmbeds.js";

// ── achievementUnlockRenderer ──────────────────────────────────────────────
// An achievement unlock as a card: the member's face and name, Dero's prime
// pose, and one medallion per tier crossed in this pass, ringed in the tier's
// metal and captioned with the achievement and what earned it. Up to three
// medallions fit; past that the card says how many more, and the text line in
// the embed still names the member. levelUpAnnouncer.announceAchievements calls
// it through withRenderFallback.
//
// The medallion is drawn, not art: the account badge design (16 platform roles
// by 4 variants) badges ACCOUNT ROLES, and an achievement is a track and a tier
// with no role behind it (roleId is null on every track), so there is no badge
// in that design for an unlock to show. The tier metal is what tells them apart.

/** The avatar size the unlock card requests. The face draws at 64 pixels. */
export const ACHIEVEMENT_UNLOCK_AVATAR_SIZE = 128;

// Bump whenever the drawing changes, or members keep seeing cached cards.
const ACHIEVEMENT_UNLOCK_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const CARD_HEIGHT = 420;
const MARGIN = 40;
const FACE_DIAMETER = 64;
const FACE_CENTER = { x: MARGIN + FACE_DIAMETER / 2, y: MARGIN + FACE_DIAMETER / 2 };
const DERO_BOX: Rect = { x: 790, y: 12, width: 150, height: 130 };
const MAX_MEDALLIONS = 3;
const MEDALLION_COLUMN_WIDTH = 300;
const MEDALLION_DIAMETER = 150;
// The inner disc leaves a ring of metal this wide around the tier name.
const MEDALLION_RING = 14;
const MEDALLION_TIER_TEXT_SIZE = 22;
const MEDALLION_CENTER_Y = 228;
const CAPTION_WIDTH = 270;

interface AchievementUnlockCardInput {
	displayName: string;
	avatar: AvatarRequest | null;
	unlocks: Array<{ id: string; tier: string; earnedBy: string }>;
}

/** The unlock card, or null when the text announcement should post. Never throws. */
export function renderAchievementUnlockCard(view: AchievementUnlockView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "achievement-unlock",
		version: ACHIEVEMENT_UNLOCK_CARD_VERSION,
		input: {
			displayName: view.displayName,
			avatar: view.avatar,
			unlocks: view.unlocks.map((unlock) => ({ id: unlock.id, tier: unlock.tier, earnedBy: unlock.earnedBy })),
		},
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		draw: drawAchievementUnlockCard,
	});
}

async function drawAchievementUnlockCard(context: SKRSContext2D, input: AchievementUnlockCardInput): Promise<DrawOutcome> {
	const shown = input.unlocks.slice(0, MAX_MEDALLIONS);
	// The glow takes the last medallion's metal, so it matches one of them.
	const topTier = shown[shown.length - 1]?.tier ?? "";
	drawCardBackground(context, tierToken(topTier), CARD_WIDTH / 2, MEDALLION_CENTER_Y, CARD_WIDTH * 0.55);

	const deroStandIn = await drawDeroPose(context, "prime", DERO_BOX);
	const faceStandIn = await drawMemberFace(context, input.avatar, input.displayName, FACE_CENTER.x, FACE_CENTER.y, FACE_DIAMETER);
	drawText(context, input.displayName, {
		x: FACE_CENTER.x + FACE_DIAMETER / 2 + 18,
		y: FACE_CENTER.y,
		size: 30,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: DERO_BOX.x - FACE_CENTER.x - FACE_DIAMETER,
	});

	// The medallions sit centred as a group, so one unlock is not stranded on the left.
	const firstCenterX = CARD_WIDTH / 2 - ((shown.length - 1) * MEDALLION_COLUMN_WIDTH) / 2;
	shown.forEach((unlock, index) => drawMedallion(context, unlock, firstCenterX + index * MEDALLION_COLUMN_WIDTH));

	const hidden = input.unlocks.length - shown.length;
	if (hidden > 0) {
		drawText(context, levelingCopy.cards.moreUnlocks(hidden), {
			x: CARD_WIDTH - MARGIN,
			y: CARD_HEIGHT - 20,
			size: 18,
			color: canvasColor(COLORS.CARD_TEXT_MUTED),
			align: "right",
		});
	}
	return deroStandIn || faceStandIn ? { cacheable: false } : undefined;
}

/**
 * One tier medallion: a disc of the tier's metal around an inner disc carrying the
 * tier's name. Its ring and lettering scale with the diameter from this card's 150
 * pixel medallion, so the achievements card (2026-10 item 254) draws the same mark
 * smaller instead of a second one.
 */
export function drawTierMedallion(context: SKRSContext2D, tier: string, centerX: number, centerY: number, diameter: number): void {
	const metal = tierColor(tier);
	const ring = Math.round((diameter * MEDALLION_RING) / MEDALLION_DIAMETER);
	fillCircle(context, centerX, centerY, diameter, metal);
	fillCircle(context, centerX, centerY, diameter - ring * 2, canvasColor(COLORS.CARD_BACKGROUND));
	drawText(context, tier.toUpperCase(), {
		x: centerX,
		y: centerY,
		size: Math.round((diameter * MEDALLION_TIER_TEXT_SIZE) / MEDALLION_DIAMETER),
		weight: "bold",
		color: metal,
		align: "center",
		baseline: "middle",
		maxWidth: diameter - ring * 4,
	});
}

function drawMedallion(context: SKRSContext2D, unlock: AchievementUnlockCardInput["unlocks"][number], centerX: number): void {
	drawTierMedallion(context, unlock.tier, centerX, MEDALLION_CENTER_Y, MEDALLION_DIAMETER);
	const captionTop = MEDALLION_CENTER_Y + MEDALLION_DIAMETER / 2;
	drawText(context, unlock.id, {
		x: centerX,
		y: captionTop + 36,
		size: 24,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		align: "center",
		maxWidth: CAPTION_WIDTH,
	});
	drawText(context, unlock.earnedBy, {
		x: centerX,
		y: captionTop + 68,
		size: 18,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		align: "center",
		maxWidth: CAPTION_WIDTH,
	});
}
