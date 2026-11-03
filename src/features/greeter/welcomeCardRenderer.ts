import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackground,
	drawDeroPose,
	drawMemberFace,
	drawText,
	renderCard,
	strokeCircle,
	type AvatarRequest,
	type DrawOutcome,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";

// ── welcomeCardRenderer ──────────────────────────────────────────────
// The greeter's welcome card (2026-10 item 243 Phase 4): the newcomer's face in
// a gold ring, a pack voiced welcome, the server's name and its member count,
// and Dero's welcome pose. welcomeNewMember draws it through withRenderFallback
// and posts it under the greeting's text, so the greeting (the ping and the
// icebreaker) posts unchanged when the card does not draw. The copy arrives
// already resolved from the guild's copy pack, so this file holds no voice.

/** Everything the welcome card draws, as plain data, with its copy already in the guild's voice. */
export interface WelcomeCardView {
	kicker: string;
	title: string;
	subtitle: string;
	/** Null when the guild's member count is unknown, and the line is left out. */
	memberCount: string | null;
	displayName: string;
	avatar: AvatarRequest | null;
}

// The face is drawn at 160 pixels, so 256 is the smallest Discord size that keeps
// it sharp.
export const WELCOME_AVATAR_SIZE = 256;

// Bump whenever the drawing changes, or members keep seeing cached cards.
const WELCOME_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const CARD_HEIGHT = 340;
const PADDING = 36;
const FACE_CENTER = { x: 140, y: CARD_HEIGHT / 2 };
const FACE_DIAMETER = 160;
const RING_GAP = 10;
const TEXT_X = 260;
const DERO_BOX = { x: CARD_WIDTH - 240, y: 40, width: 220, height: 260 };
const TEXT_RIGHT = DERO_BOX.x - 16;

/** The welcome card for one newcomer, or null when the greeting should post alone. Never throws. */
export function renderWelcomeCard(view: WelcomeCardView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "welcome",
		version: WELCOME_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		draw: drawWelcomeCard,
	});
}

async function drawWelcomeCard(context: SKRSContext2D, view: WelcomeCardView): Promise<DrawOutcome> {
	drawCardBackground(context, COLORS.INTRODUCTION, FACE_CENTER.x, FACE_CENTER.y, CARD_WIDTH * 0.6);
	const deroStandIn = await drawDeroPose(context, "welcome", DERO_BOX);
	const faceStandIn = await drawMemberFace(context, view.avatar, view.displayName, FACE_CENTER.x, FACE_CENTER.y, FACE_DIAMETER);
	strokeCircle(context, FACE_CENTER.x, FACE_CENTER.y, FACE_DIAMETER + RING_GAP * 2, canvasColor(COLORS.INTRODUCTION), 6);
	drawWelcomeText(context, view);
	return deroStandIn || faceStandIn ? { cacheable: false } : undefined;
}

function drawWelcomeText(context: SKRSContext2D, view: WelcomeCardView): void {
	const maxWidth = TEXT_RIGHT - TEXT_X;
	drawText(context, view.kicker, {
		x: TEXT_X,
		y: PADDING + 40,
		size: 20,
		weight: "bold",
		color: canvasColor(COLORS.INTRODUCTION),
		baseline: "middle",
		maxWidth,
	});
	drawText(context, view.title, {
		x: TEXT_X,
		y: 140,
		size: 44,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth,
	});
	drawText(context, view.subtitle, {
		x: TEXT_X,
		y: 196,
		size: 26,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		baseline: "middle",
		maxWidth,
	});
	if (!view.memberCount) return;
	drawText(context, view.memberCount, {
		x: TEXT_X,
		y: CARD_HEIGHT - PADDING - 20,
		size: 22,
		color: canvasColor(COLORS.CARD_TEXT_MUTED),
		baseline: "middle",
		maxWidth,
	});
}
