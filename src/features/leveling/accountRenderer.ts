import { COLORS } from "@base/copy/brand.js";
import { canvasColor, drawBarSegment, drawCardBackground, drawDeroPose, drawMemberFace, drawPanel, drawPill, drawText, fillCircle, renderCard, type AvatarRequest, type DrawOutcome, type Rect, type RenderPayload } from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { tierColor } from "./levelingCardParts.js";
import { levelingCopy } from "./levelingCopy.js";
import type { AccountView } from "./levelingEmbeds.js";

// ── accountRenderer ────────────────────────────────────────────────────────
// The /account profile as a card: face, name and level, the progress bar, the
// three standings, the overall game record, the presence counters and the most
// recent achievement tiers, with Dero's account pose beside them. It takes the
// same AccountView buildAccountEmbed takes and answers the PNG, or null when the
// text profile should post instead. /account calls it through withRenderFallback.
//
// The per game table, the month's luck and each achievement's "earned by" sentence
// are not drawn: a card at Discord's embed width cannot hold ten columns of
// numbers legibly, so it shows the overall record and the tiers, and the card's
// embed carries the table and the luck as fields (buildAccountCardEmbed).

/** The avatar size the account card requests. The face draws at 150 pixels. */
export const ACCOUNT_AVATAR_SIZE = 256;

// Bump whenever the drawing changes, or members keep seeing cached cards.
const ACCOUNT_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const CARD_HEIGHT = 540;
const MARGIN = 40;
const FACE_DIAMETER = 150;
const FACE_RING = 8;
const FACE_CENTER = { x: MARGIN + FACE_DIAMETER / 2, y: MARGIN + FACE_DIAMETER / 2 };
const IDENTITY_X = MARGIN + FACE_DIAMETER + 30;
const LEFT_COLUMN_WIDTH = 640;
const DERO_BOX: Rect = { x: 700, y: 24, width: 236, height: 260 };
const PRESENCE_PANEL: Rect = { x: 700, y: 300, width: 220, height: 210 };
const BAR: Rect = { x: MARGIN, y: 238, width: LEFT_COLUMN_WIDTH, height: 26 };
const STAT_ROW_Y = 300;
const STAT_PANEL_HEIGHT = 100;
const BOTTOM_ROW_Y = 420;
const BOTTOM_PANEL_HEIGHT = 90;
const PANEL_GAP = 20;
const PANEL_RADIUS = 16;
// The most achievement tiers the card shows as dots; the count says the rest.
const MAX_TIER_DOTS = 8;
const TIER_DOT_DIAMETER = 18;

// Only what the card draws, as plain numbers and strings. The view can carry
// Mongoose subdocuments (games, unlocked) that hashRenderInput refuses, and a
// field the card never reads would only split the cache.
interface AccountCardInput {
	displayName: string;
	avatar: AvatarRequest | null;
	level: number;
	totalXp: number;
	xpIntoLevel: number;
	xpToNext: number;
	nextLevelIsMilestone: boolean;
	guildRank: number;
	guildSize: number;
	weekRank: number | null;
	monthRank: number | null;
	messages: number;
	reactionsGiven: number;
	voiceMinutes: number;
	record: { won: number; lost: number; drawn: number } | null;
	unlockedTiers: string[];
}

/** The /account card, or null when the text profile should post. Never throws. */
export function renderAccountCard(view: AccountView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "account",
		version: ACCOUNT_CARD_VERSION,
		input: toCardInput(view),
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		draw: drawAccountCard,
	});
}

function toCardInput(view: AccountView): AccountCardInput {
	const record = view.games.length === 0 ? null : sumRecord(view.games.map((game) => game.record));
	return {
		displayName: view.displayName,
		avatar: view.avatar ?? null,
		level: view.level,
		totalXp: view.totalXp,
		xpIntoLevel: view.xpIntoLevel,
		xpToNext: view.xpToNext,
		nextLevelIsMilestone: view.nextLevelIsMilestone,
		guildRank: view.guildRank,
		guildSize: view.guildSize,
		weekRank: view.weekRank,
		monthRank: view.monthRank,
		messages: view.messages,
		reactionsGiven: view.reactionsGiven,
		voiceMinutes: view.voiceMinutes,
		record,
		unlockedTiers: view.unlocked.map((unlock) => String(unlock.tier)),
	};
}

function sumRecord(records: Array<{ won: number; lost: number; drawn: number }>): { won: number; lost: number; drawn: number } {
	let won = 0;
	let lost = 0;
	let drawn = 0;
	for (const record of records) {
		won += record.won;
		lost += record.lost;
		drawn += record.drawn;
	}
	return { won, lost, drawn };
}

async function drawAccountCard(context: SKRSContext2D, input: AccountCardInput): Promise<DrawOutcome> {
	const accent = canvasColor(COLORS.ACCOUNT);
	drawCardBackground(context, COLORS.ACCOUNT, FACE_CENTER.x, FACE_CENTER.y, CARD_WIDTH * 0.6);

	const deroStandIn = await drawDeroPose(context, "account", DERO_BOX);
	fillCircle(context, FACE_CENTER.x, FACE_CENTER.y, FACE_DIAMETER + FACE_RING * 2, accent);
	const faceStandIn = await drawMemberFace(context, input.avatar, input.displayName, FACE_CENTER.x, FACE_CENTER.y, FACE_DIAMETER);

	drawIdentity(context, input, accent);
	drawProgress(context, input, accent);
	drawStandings(context, input);
	drawRecordAndAchievements(context, input);
	drawPresence(context, input);

	return deroStandIn || faceStandIn ? { cacheable: false } : undefined;
}

function drawIdentity(context: SKRSContext2D, input: AccountCardInput, accent: string): void {
	drawText(context, input.displayName, {
		x: IDENTITY_X,
		y: 100,
		size: 44,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		maxWidth: LEFT_COLUMN_WIDTH + MARGIN - IDENTITY_X,
	});
	drawPill(context, { x: IDENTITY_X, y: 124, width: 170, height: 40, fill: accent, label: levelingCopy.cards.levelBadge(input.level) });
}

function drawProgress(context: SKRSContext2D, input: AccountCardInput, accent: string): void {
	const labels = levelingCopy.labels;
	const secondary = canvasColor(COLORS.CARD_TEXT_SECONDARY);
	const span = input.xpIntoLevel + input.xpToNext;
	drawText(context, `${labels.totalXp} ${input.totalXp.toLocaleString()}`, { x: BAR.x, y: BAR.y - 12, size: 20, color: secondary });
	drawText(context, levelingCopy.cards.xpProgress(input.xpIntoLevel, span), {
		x: BAR.x + BAR.width,
		y: BAR.y - 12,
		size: 20,
		color: secondary,
		align: "right",
	});
	// A capped member has nothing left to earn, so the span is zero and the full
	// bar is the honest picture, matching progressBar in the text profile.
	const ratio = span > 0 ? input.xpIntoLevel / span : 1;
	drawBarSegment(context, { ...BAR, fillRatio: ratio, fillColor: accent, trackColor: canvasColor(COLORS.CARD_NESTED) });
	if (input.nextLevelIsMilestone) {
		drawText(context, labels.nextMilestone, { x: BAR.x, y: BAR.y + BAR.height + 26, size: 18, color: canvasColor(COLORS.CARD_TEXT_MUTED) });
	}
}

function drawStandings(context: SKRSContext2D, input: AccountCardInput): void {
	const labels = levelingCopy.labels;
	const cards = levelingCopy.cards;
	const panelWidth = (LEFT_COLUMN_WIDTH - PANEL_GAP * 2) / 3;
	const stats: Array<[string, string]> = [
		[labels.guildRank, cards.rankOf(input.guildRank, input.guildSize)],
		[labels.weekRank, input.weekRank === null ? cards.unranked : `#${input.weekRank.toLocaleString()}`],
		[labels.monthRank, input.monthRank === null ? cards.unranked : `#${input.monthRank.toLocaleString()}`],
	];
	stats.forEach(([label, value], index) => {
		const x = MARGIN + index * (panelWidth + PANEL_GAP);
		drawStatPanel(context, { x, y: STAT_ROW_Y, width: panelWidth, height: STAT_PANEL_HEIGHT }, label, value);
	});
}

function drawRecordAndAchievements(context: SKRSContext2D, input: AccountCardInput): void {
	const panelWidth = (LEFT_COLUMN_WIDTH - PANEL_GAP) / 2;
	const record = input.record
		? levelingCopy.cards.winLoss(input.record.won, input.record.lost, input.record.drawn)
		: levelingCopy.labels.noRecordYet;
	drawStatPanel(context, { x: MARGIN, y: BOTTOM_ROW_Y, width: panelWidth, height: BOTTOM_PANEL_HEIGHT }, levelingCopy.cards.record, record);

	const achievements: Rect = { x: MARGIN + panelWidth + PANEL_GAP, y: BOTTOM_ROW_Y, width: panelWidth, height: BOTTOM_PANEL_HEIGHT };
	drawStatPanel(context, achievements, levelingCopy.labels.achievements, input.unlockedTiers.length.toLocaleString());
	// The most recent tiers as metal dots beside the count, newest last, so the
	// card says what kind of achievements without needing their sentences.
	const recent = input.unlockedTiers.slice(-MAX_TIER_DOTS);
	recent.forEach((tier, index) => {
		const x = achievements.x + achievements.width - 24 - (recent.length - 1 - index) * (TIER_DOT_DIAMETER + 6);
		fillCircle(context, x, achievements.y + 64, TIER_DOT_DIAMETER, tierColor(tier));
	});
}

function drawPresence(context: SKRSContext2D, input: AccountCardInput): void {
	const labels = levelingCopy.labels;
	drawPanel(context, { ...PRESENCE_PANEL, radius: PANEL_RADIUS, fill: canvasColor(COLORS.CARD_PANEL) });
	drawText(context, levelingCopy.cards.presence, {
		x: PRESENCE_PANEL.x + 20,
		y: PRESENCE_PANEL.y + 34,
		size: 18,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
	});
	const rows: Array<[string, number]> = [
		[labels.messages, input.messages],
		[labels.reactions, input.reactionsGiven],
		[labels.voiceMinutes, input.voiceMinutes],
	];
	rows.forEach(([label, value], index) => {
		const y = PRESENCE_PANEL.y + 74 + index * 46;
		drawText(context, label, { x: PRESENCE_PANEL.x + 20, y, size: 16, color: canvasColor(COLORS.CARD_TEXT_MUTED) });
		drawText(context, value.toLocaleString(), {
			x: PRESENCE_PANEL.x + PRESENCE_PANEL.width - 20,
			y,
			size: 22,
			weight: "bold",
			color: canvasColor(COLORS.CARD_TEXT),
			align: "right",
		});
	});
}

function drawStatPanel(context: SKRSContext2D, box: Rect, label: string, value: string): void {
	drawPanel(context, { ...box, radius: PANEL_RADIUS, fill: canvasColor(COLORS.CARD_PANEL) });
	drawText(context, label, { x: box.x + 20, y: box.y + 34, size: 18, color: canvasColor(COLORS.CARD_TEXT_SECONDARY), maxWidth: box.width - 40 });
	drawText(context, value, {
		x: box.x + 20,
		y: box.y + box.height - 22,
		size: 28,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		maxWidth: box.width - 40,
	});
}
