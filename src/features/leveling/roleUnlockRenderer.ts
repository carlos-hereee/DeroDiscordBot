import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackground,
	drawDeroPose,
	drawMemberFace,
	drawPanel,
	drawText,
	fillCircle,
	renderCard,
	strokeCircle,
	type DrawOutcome,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { levelingCopy } from "./levelingCopy.js";
import type { RoleUnlockView } from "./levelingEmbeds.js";

// ── roleUnlockRenderer ───────────────────────────────────────────────
// The role unlock card (2026-10 item 243 Phase 4): the member's face ringed in
// the role's own color, the role's name, the level that earned it, and Dero's
// prime pose. levelUpAnnouncer.announceRoleUnlock draws it through
// withRenderFallback the first time a reward role lands on a member (roleRewards
// decides that), so the role unlock embed posts alone when the card does not draw.
//
// The role's color is the guild's own data rather than a brand token, which is
// why it rides the view model; the card never prints text IN that color, since
// a guild can pick one that vanishes on the dark sheet.

/** The avatar size the role unlock card requests. The face draws at 140 pixels. */
export const ROLE_UNLOCK_AVATAR_SIZE = 256;

// Bump whenever the drawing changes, or members keep seeing cached cards.
const ROLE_UNLOCK_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const CARD_HEIGHT = 320;
const PADDING = 36;
const FACE_CENTER = { x: 140, y: CARD_HEIGHT / 2 };
const FACE_DIAMETER = 140;
const RING_DIAMETER = FACE_DIAMETER + 24;
const TEXT_X = 260;
const DERO_BOX = { x: CARD_WIDTH - 230, y: 30, width: 200, height: 260 };
const TEXT_RIGHT = DERO_BOX.x - 16;
const SWATCH_DIAMETER = 26;

/** The unlock card for one member and one role, or null when the embed should post alone. Never throws. */
export function renderRoleUnlockCard(view: RoleUnlockView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "role-unlock",
		version: ROLE_UNLOCK_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		draw: drawRoleUnlockCard,
	});
}

async function drawRoleUnlockCard(context: SKRSContext2D, view: RoleUnlockView): Promise<DrawOutcome> {
	drawCardBackground(context, view.roleColor, FACE_CENTER.x, FACE_CENTER.y, CARD_WIDTH * 0.6);
	const deroStandIn = await drawDeroPose(context, "prime", DERO_BOX);
	const faceStandIn = await drawMemberFace(context, view.avatar, view.displayName, FACE_CENTER.x, FACE_CENTER.y, FACE_DIAMETER);
	strokeCircle(context, FACE_CENTER.x, FACE_CENTER.y, RING_DIAMETER, view.roleColor, 8);
	drawRoleText(context, view);
	return deroStandIn || faceStandIn ? { cacheable: false } : undefined;
}

function drawRoleText(context: SKRSContext2D, view: RoleUnlockView): void {
	const copy = levelingCopy.cards;
	const maxWidth = TEXT_RIGHT - TEXT_X;
	drawText(context, copy.roleUnlocked, {
		x: TEXT_X,
		y: PADDING + 36,
		size: 20,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		baseline: "middle",
		maxWidth,
	});
	// The role's color as a swatch beside its name, on a nested panel so a dark
	// role color still shows against the sheet.
	drawPanel(context, { x: TEXT_X, y: 112, width: maxWidth, height: 72, radius: 18, fill: canvasColor(COLORS.CARD_NESTED) });
	fillCircle(context, TEXT_X + 36, 148, SWATCH_DIAMETER, view.roleColor);
	drawText(context, view.roleName, {
		x: TEXT_X + 64,
		y: 148,
		size: 34,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: maxWidth - 84,
	});
	drawText(context, view.displayName, {
		x: TEXT_X,
		y: 222,
		size: 26,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth,
	});
	drawText(context, copy.unlockedAtLevel(view.level), {
		x: TEXT_X,
		y: 258,
		size: 22,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		baseline: "middle",
		maxWidth,
	});
}
