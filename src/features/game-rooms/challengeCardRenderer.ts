import type { ColorResolvable, Guild } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	avatarRequestFor,
	canvasColor,
	drawCardBackground,
	drawMemberFace,
	drawPill,
	drawText,
	renderCard,
	strokeCircle,
	type AvatarRequest,
	type DrawOutcome,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { OpenerCardState } from "./challengeBoardEmbeds.js";
import type { GameSlug } from "./roomTypes.js";

// ── challengeCardRenderer ────────────────────────────────────────────
// The picture on a challenge opener card (2026-10 item 243 Phase 4): the host's
// face on the left, VS, and the faces of whoever has joined burned onto the
// right, under the game's name and the draft's state. challengeBoard draws it on
// every card edit through withRenderFallback, so the text card posts unchanged
// when the picture does not draw.
//
// The plan named a challenge.gif base to burn the faces onto, but that art was
// never drawn (gamesAssets.ts reports it missing on every checkout), so the base
// is the shared card sheet in the arcade's color instead. Members are named in
// plain text here; the embed above keeps the mentions.

/** One face on the card: a display name and the avatar to fetch. */
export interface ChallengeFace {
	name: string;
	avatar: AvatarRequest | null;
}

export type ChallengeCardStatus = keyof typeof gameRoomsCopy.board.cardImage.status;

/** Everything the challenge picture draws, as plain data. */
export interface ChallengeCardView {
	game: GameSlug;
	status: ChallengeCardStatus;
	host: ChallengeFace;
	/** At most MAX_CHALLENGER_FACES joiners, in the order they joined. */
	challengers: ChallengeFace[];
	/** How many more joined than the card has room for. */
	hiddenCount: number;
}

// The faces draw at 72 and 144 pixels, so 160 covers both at Discord's sizes.
const CHALLENGE_AVATAR_SIZE = 256;
// Two rows of three: a coin flip's one opponent and a full Monopoly table both fit,
// and a busy open challenge says how many more joined.
const MAX_CHALLENGER_FACES = 6;
const CHALLENGERS_PER_ROW = 3;

// Bump whenever the drawing changes, or members keep seeing cached cards.
const CHALLENGE_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const CARD_HEIGHT = 380;
const PADDING = 32;
const HOST_CENTER = { x: 180, y: 220 };
const HOST_DIAMETER = 144;
const VERSUS_X = 380;
const GRID_LEFT = 470;
const GRID_TOP = 130;
const FACE_DIAMETER = 72;
const CELL_WIDTH = 150;
const CELL_HEIGHT = 120;

const STATUS_ACCENT: Record<ChallengeCardStatus, ColorResolvable> = {
	choosing: COLORS.ARCADE,
	invite: COLORS.ARCADE,
	open: COLORS.ARCADE,
	started: COLORS.CARD_OUTCOME_WIN,
	cancelled: COLORS.CARD_TEXT_MUTED,
};

/** Which state the opener card is in, as the picture names it. */
export function challengeCardStatus(state: OpenerCardState): ChallengeCardStatus {
	if (state.cancelled) return "cancelled";
	if (state.startedChannelId) return "started";
	if (!state.visibility) return "choosing";
	return state.visibility === "invite" ? "invite" : "open";
}

/**
 * The picture's view of one opener card: the host and the first joiners
 * resolved to names and avatars. A member who cannot be found (they left) is
 * drawn by the placeholder with an empty name rather than dropped, so the count
 * on the card still matches the pool in the embed.
 */
export async function challengeCardView(guild: Guild, state: OpenerCardState): Promise<ChallengeCardView> {
	const shown = state.pool.slice(0, MAX_CHALLENGER_FACES);
	const [host, ...challengers] = await Promise.all([state.hostId, ...shown].map((userId) => resolveFace(guild, userId)));
	return {
		game: state.game,
		status: challengeCardStatus(state),
		host,
		challengers,
		hiddenCount: Math.max(0, state.pool.length - shown.length),
	};
}

async function resolveFace(guild: Guild, userId: string): Promise<ChallengeFace> {
	const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
	if (!member) return { name: "", avatar: null };
	return { name: member.displayName, avatar: avatarRequestFor(member.user, CHALLENGE_AVATAR_SIZE) };
}

/** The opener card's picture, or null when the text card should post alone. Never throws. */
export function renderChallengeCard(view: ChallengeCardView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "challenge",
		version: CHALLENGE_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		draw: drawChallengeCard,
	});
}

async function drawChallengeCard(context: SKRSContext2D, view: ChallengeCardView): Promise<DrawOutcome> {
	const accent = STATUS_ACCENT[view.status];
	drawCardBackground(context, accent, HOST_CENTER.x, HOST_CENTER.y, CARD_WIDTH * 0.6);
	drawHeader(context, view, accent);
	let standIn = await drawMemberFace(context, view.host.avatar, view.host.name, HOST_CENTER.x, HOST_CENTER.y, HOST_DIAMETER);
	strokeCircle(context, HOST_CENTER.x, HOST_CENTER.y, HOST_DIAMETER + 16, canvasColor(accent), 6);
	drawName(context, view.host.name, HOST_CENTER.x, HOST_CENTER.y + HOST_DIAMETER / 2 + 34, 24, 280);
	drawText(context, gameRoomsCopy.board.cardImage.versus, {
		x: VERSUS_X,
		y: HOST_CENTER.y,
		size: 48,
		weight: "bold",
		color: canvasColor(accent),
		align: "center",
		baseline: "middle",
	});
	if (await drawChallengers(context, view)) standIn = true;
	return standIn ? { cacheable: false } : undefined;
}

function drawHeader(context: SKRSContext2D, view: ChallengeCardView, accent: ColorResolvable): void {
	const copy = gameRoomsCopy.board.cardImage;
	drawText(context, copy.kicker(view.game), {
		x: PADDING,
		y: PADDING + 24,
		size: 24,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: CARD_WIDTH - PADDING * 2 - 220,
	});
	drawPill(context, {
		x: CARD_WIDTH - PADDING - 200,
		y: PADDING + 4,
		width: 200,
		height: 40,
		fill: canvasColor(accent),
		label: copy.status[view.status],
		labelColor: canvasColor(COLORS.CARD_BACKGROUND),
	});
}

// Answers true when any challenger was drawn as a placeholder.
async function drawChallengers(context: SKRSContext2D, view: ChallengeCardView): Promise<boolean> {
	const copy = gameRoomsCopy.board.cardImage;
	if (view.challengers.length === 0) {
		drawText(context, copy.waiting, {
			x: GRID_LEFT + (CELL_WIDTH * CHALLENGERS_PER_ROW) / 2,
			y: HOST_CENTER.y,
			size: 26,
			color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
			align: "center",
			baseline: "middle",
		});
		return false;
	}
	let standIn = false;
	for (const [index, face] of view.challengers.entries()) {
		const centerX = GRID_LEFT + (index % CHALLENGERS_PER_ROW) * CELL_WIDTH + CELL_WIDTH / 2;
		const centerY = GRID_TOP + Math.floor(index / CHALLENGERS_PER_ROW) * CELL_HEIGHT + FACE_DIAMETER / 2;
		if (await drawMemberFace(context, face.avatar, face.name, centerX, centerY, FACE_DIAMETER)) standIn = true;
		drawName(context, face.name, centerX, centerY + FACE_DIAMETER / 2 + 20, 18, CELL_WIDTH - 12);
	}
	if (view.hiddenCount > 0) {
		// Under the status pill, clear of the face grid, whose last cell reaches the
		// right edge.
		drawText(context, copy.more(view.hiddenCount), {
			x: CARD_WIDTH - PADDING,
			y: PADDING + 70,
			size: 20,
			color: canvasColor(COLORS.CARD_TEXT_MUTED),
			align: "right",
			baseline: "middle",
		});
	}
	return standIn;
}

function drawName(context: SKRSContext2D, name: string, centerX: number, y: number, size: number, maxWidth: number): void {
	if (!name) return;
	drawText(context, name, {
		x: centerX,
		y,
		size,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		align: "center",
		baseline: "middle",
		maxWidth,
	});
}
