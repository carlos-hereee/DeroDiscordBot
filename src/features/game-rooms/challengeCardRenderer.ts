import type { ColorResolvable, Guild } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	avatarRequestFor,
	canvasColor,
	drawCardBackground,
	drawImageContained,
	drawMemberFace,
	drawPill,
	drawText,
	renderCard,
	strokeCircle,
	type AvatarRequest,
	type DrawOutcome,
	type Rect,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { loadGameArt } from "@features/games/gamesArt.js";
import { gameAssetPath, type GameAssetKey } from "@features/games/gamesAssets.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { openerLogoKey } from "./gameRoomsEmbeds.js";
import { badgeOfCard, type ChallengeBadge, type OpenerCardState } from "./challengeBoardEmbeds.js";
import type { GameSlug } from "./roomTypes.js";

// ── challengeCardRenderer ────────────────────────────────────────────
// The picture on a challenge opener card (2026-10 item 243 Phase 4): the host's
// face on the left, VS, and the faces of whoever has joined burned onto the
// right, under the game's name and the draft's state. challengeBoard draws it on
// every card edit through withRenderFallback, so the text card posts unchanged
// when the picture does not draw.
//
// A game with a logo leads the picture with a band of its art above the faces
// (2026-10 item 245 Phase 3b): the logo, and the game's character beside it
// where one was drawn. A game with no logo keeps the plain card, height and all.
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
	/** RATED or CASUAL, from challengeBadge, the helper the embed's badge line reads too. */
	badge: ChallengeBadge;
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

// Bump whenever the drawing changes, or members keep seeing cached cards. 3 added the
// RATED or CASUAL badge pill (2026-10 item 254, Arcade 5); 4 the status watermark (Arcade 6);
// 5 the rock paper scissors logo (Arcade 3).
const CHALLENGE_CARD_VERSION = 5;
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

// ── the game's art band ──
// The logo is the game's room opener logo (openerLogoKey), so a challenge post
// and the room it opens show one mark. Only battleship has a character: the
// admiral, who left the private fleet card to stand here. Hangman's Dero poses
// stay on its gallows card.
const CHALLENGE_CHARACTERS: Partial<Record<GameSlug, GameAssetKey>> = {
	battleship: "battleshipAdmiral",
};
const ART_BAND_HEIGHT = 240;
// The logo centred alone, or the logo and the character as one centred pair.
const LOGO_ALONE: Rect = { x: 270, y: 16, width: 420, height: 208 };
const LOGO_PAIRED: Rect = { x: 180, y: 12, width: 360, height: 216 };
const CHARACTER_PAIRED: Rect = { x: 560, y: 4, width: 240, height: 236 };

/** The art one game's card leads with, by slot. */
interface ChallengeArtKeys {
	logo: GameAssetKey;
	character: GameAssetKey | null;
}

// The badge pill sits left of the status pill, the same height. RATED takes the card's win
// color so it reads as the stakes it is (not a gold: the brand keeps one gold, its top
// rung); CASUAL stays muted, since most cards are casual.
const BADGE_PILL_WIDTH = 150;
const PILL_GAP = 12;
const BADGE_FILL: Record<ChallengeBadge, ColorResolvable> = {
	rated: COLORS.CARD_OUTCOME_WIN,
	casual: COLORS.CARD_TEXT_MUTED,
};

// ── the status watermark (2026-10 item 254, Arcade 6) ──
// The pill's word, drawn again large and faint across the whole card on its diagonal, so
// a member scrolling a challenge channel on a phone reads OPEN TO ALL or FINISHED without
// finding the 200 pixel pill in the corner. The pill stays: it is the exact label, and
// the watermark is the glance. Drawn in the card's near white text color rather than the
// status accent: the accent on the card's dark ground of the same hue (a violet OPEN TO ALL
// on violet) was too low in contrast to read on a phone (the owner's review). Translucent
// enough that the faces under it still read.
const WATERMARK_ALPHA = 0.3;
const WATERMARK_SIZE = 120;
// Of the card's diagonal, so a long word squeezes to fit rather than running off a corner.
const WATERMARK_SPAN = 0.8;

const STATUS_ACCENT: Record<ChallengeCardStatus, ColorResolvable> = {
	choosing: COLORS.ARCADE,
	invite: COLORS.ARCADE,
	open: COLORS.ARCADE,
	started: COLORS.CARD_OUTCOME_WIN,
	cancelled: COLORS.CARD_TEXT_MUTED,
	finished: COLORS.CARD_OUTCOME_WIN,
};

/** Which state the opener card is in, as the picture names it. */
export function challengeCardStatus(state: OpenerCardState): ChallengeCardStatus {
	if (state.resultLine) return "finished";
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
		badge: badgeOfCard(state),
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
	// The band's presence sets the card's height, and the height is hashed into the
	// cache key, so a card drawn before a game's logo landed is never served after.
	const art = challengeArtKeys(view.game);
	return renderCard({
		kind: "challenge",
		version: CHALLENGE_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: art ? CARD_HEIGHT + ART_BAND_HEIGHT : CARD_HEIGHT,
		draw: (context, input) => drawChallengeCard(context, input, art),
	});
}

// The art a game's card leads with, or null for a game with no logo on disk,
// which keeps the plain card.
function challengeArtKeys(game: GameSlug): ChallengeArtKeys | null {
	const logo = openerLogoKey(game);
	if (!logo || !gameAssetPath(logo)) return null;
	return { logo, character: CHALLENGE_CHARACTERS[game] ?? null };
}

async function drawChallengeCard(context: SKRSContext2D, view: ChallengeCardView, art: ChallengeArtKeys | null): Promise<DrawOutcome> {
	const accent = STATUS_ACCENT[view.status];
	if (!art) {
		drawCardBackground(context, accent, HOST_CENTER.x, HOST_CENTER.y, CARD_WIDTH * 0.6);
		const outcome = await drawFaces(context, view, accent);
		drawStatusWatermark(context, view.status, CARD_WIDTH, CARD_HEIGHT);
		return outcome;
	}
	drawCardBackground(context, accent, CARD_WIDTH / 2, ART_BAND_HEIGHT / 2, CARD_WIDTH * 0.6);
	const artMissing = await drawArtBand(context, art);
	// Below the band, the plain card's drawing moved down by the band's height.
	context.save();
	context.translate(0, ART_BAND_HEIGHT);
	let outcome: DrawOutcome;
	try {
		outcome = await drawFaces(context, view, accent);
	} finally {
		context.restore();
	}
	// Last, over the band and the faces alike, so it crosses the whole card.
	drawStatusWatermark(context, view.status, CARD_WIDTH, CARD_HEIGHT + ART_BAND_HEIGHT);
	return artMissing ? { cacheable: false } : outcome;
}

/**
 * The status word, large and faint, centred on the card and turned to its diagonal
 * (bottom left to top right). Every status the pill shows has one, from the same copy, so
 * the two never disagree. Exported for the render test, which records what it draws.
 */
export function drawStatusWatermark(context: SKRSContext2D, status: ChallengeCardStatus, width: number, height: number): void {
	context.save();
	try {
		context.globalAlpha = WATERMARK_ALPHA;
		context.translate(width / 2, height / 2);
		context.rotate(-Math.atan2(height, width));
		drawText(context, gameRoomsCopy.board.cardImage.status[status], {
			x: 0,
			y: 0,
			size: WATERMARK_SIZE,
			weight: "bold",
			color: canvasColor(COLORS.CARD_TEXT),
			align: "center",
			baseline: "middle",
			maxWidth: Math.hypot(width, height) * WATERMARK_SPAN,
		});
	} finally {
		context.restore();
	}
}

// The logo, and the character beside it when its file drew; the logo centres
// alone when it did not. Answers true when a piece of the game's art is missing,
// so the card is not cached and the full band replaces it once the art lands.
async function drawArtBand(context: SKRSContext2D, art: ChallengeArtKeys): Promise<boolean> {
	const [logo, character] = await Promise.all([loadGameArt(art.logo), art.character ? loadGameArt(art.character) : Promise.resolve(null)]);
	if (logo) drawImageContained(context, logo, character ? LOGO_PAIRED : LOGO_ALONE);
	if (character) drawImageContained(context, character, CHARACTER_PAIRED);
	return !logo || (art.character !== null && !character);
}

async function drawFaces(context: SKRSContext2D, view: ChallengeCardView, accent: ColorResolvable): Promise<DrawOutcome> {
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
		maxWidth: CARD_WIDTH - PADDING * 2 - 220 - BADGE_PILL_WIDTH - PILL_GAP,
	});
	drawPill(context, {
		x: CARD_WIDTH - PADDING - 200 - PILL_GAP - BADGE_PILL_WIDTH,
		y: PADDING + 4,
		width: BADGE_PILL_WIDTH,
		height: 40,
		fill: canvasColor(BADGE_FILL[view.badge]),
		label: copy.badge[view.badge],
		labelColor: canvasColor(COLORS.CARD_BACKGROUND),
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
