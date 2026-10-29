import { COLORS, signedNumberColor } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { canvasColor, drawBarSegment, drawCardBackground, drawDeroPose, drawMemberFace, drawPanel, drawPill, drawText, fillCircle, renderCard, type AvatarRequest, type DrawOutcome, type Rect, type RenderPayload } from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { tierColor } from "./levelingCardParts.js";
import { levelingCopy } from "./levelingCopy.js";
import { ratio, type AccountChips, type AccountLuck, type AccountView } from "./levelingEmbeds.js";

// ── accountRenderer ────────────────────────────────────────────────────────
// The /account profile as a card: face, name and level, the progress bar, the
// three standings, the overall game record, the presence counters and the most
// recent achievement tiers, with Dero's account pose beside them, and below them
// the per game record table, the month's luck and the chips (2026-10 item 254),
// so the card's embed carries no data in text. It takes the same AccountView
// buildAccountEmbed takes and answers the PNG, or null when the text profile
// should post instead. /account calls it through withRenderFallback.
//
// Each achievement's "earned by" sentence is not drawn: the tiers say what kind,
// and the sentences live on the text profile and in /account view:achievements.

/** The avatar size the account card requests. The face draws at 150 pixels. */
export const ACCOUNT_AVATAR_SIZE = 256;

// Bump whenever the drawing changes, or members keep seeing cached cards.
const ACCOUNT_CARD_VERSION = 3;
const CARD_WIDTH = 960;
// 540 for the profile, then a band below it for the record table, the luck and the currencies.
const CARD_HEIGHT = 850;
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
// The lower band: the record table on the left, the luck and the currencies on the right.
// The table fits every game LEVELING_GAME_SLUGS names (eight) plus the overall row.
const RECORD_TABLE: Rect = { x: MARGIN, y: 530, width: LEFT_COLUMN_WIDTH, height: 300 };
const RECORD_ROW_HEIGHT = 22;
// Each column's right edge, from the table's left, so the numbers line up.
const RECORD_COLUMNS = { played: 270, won: 330, lost: 390, drawn: 450, assists: 520, ratio: 610 } as const;
// The luck holds up to four lines (wins, readings, score, boost), the currencies three
// (chips, coins, the claim hint); each line is 24 pixels below the one before.
const LUCK_PANEL: Rect = { x: 700, y: 530, width: 220, height: 150 };
const CURRENCIES_PANEL: Rect = { x: 700, y: 700, width: 220, height: 130 };
const PANEL_LINE_HEIGHT = 24;
const MS_PER_MINUTE = 60_000;

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
	games: Array<{ slug: string; played: number; won: number; lost: number; drawn: number; assists: number }>;
	luckLines: CardLine[];
	currencyLines: CardLine[];
}

/** One line of a panel, with the sign of the number it shows when that number is signed. */
interface CardLine {
	text: string;
	sign?: number;
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
		games: view.games.map(({ slug, record: game }) => ({ slug, played: game.played, won: game.won, lost: game.lost, drawn: game.drawn, assists: game.assists })),
		luckLines: luckLines(view.luck, view.luckBoost),
		currencyLines: currencyLines(view.chips, view.coins),
	};
}

// The luck board's own numbers, as the text profile's luck line says them, in
// plain words: what was won, the 8 ball readings when there are any, the score.
// The secret code boost follows as its own line (2026-10 item 257 Phase 3a). The
// score and the boost are signed, so they carry their sign for the color.
function luckLines(luck: AccountLuck | null, luckBoost: number | null): CardLine[] {
	const cards = levelingCopy.cards;
	const lines: CardLine[] = [];
	if (!luck) lines.push({ text: cards.noLuck });
	else {
		lines.push({ text: cards.luckWins(luck.wins, luck.decided) });
		if (luck.readings) lines.push({ text: cards.luckReadings(luck.readings) });
		lines.push(luck.score === null ? { text: cards.luckScoreLater(BOT_CONSTANTS.RATINGS.LUCK_MIN_DECIDED) } : { text: cards.luckScore(luck.score), sign: luck.score });
	}
	if (luckBoost !== null) lines.push({ text: cards.luckBoost(luckBoost), sign: luckBoost });
	return lines;
}

// The currencies (2026-10 item 257 Phase 3a): the member's global chips, then the global
// coins, then the member's own claim hint. A read
// that failed leaves its own line out. Rounded to the minute, so the card cache is not
// split by the second.
function currencyLines(chips: AccountView["chips"], coins: number | null): CardLine[] {
	const cards = levelingCopy.cards;
	const lines: CardLine[] = [];
	if (chips) lines.push({ text: cards.chipsCard(chips.balance) });
	if (coins !== null) lines.push({ text: cards.coinsCard(coins) });
	const claim = chips ? claimLine(chips) : null;
	if (claim) lines.push({ text: claim });
	return lines;
}

// The claim hint, on the member's own profile only.
function claimLine(chips: AccountChips): string | null {
	if (!chips.claim) return null;
	const cards = levelingCopy.cards;
	const { nextClaimAt, now } = chips.claim;
	if (nextClaimAt === null || nextClaimAt.getTime() <= now.getTime()) return cards.claimReady;
	const minutes = Math.ceil((nextClaimAt.getTime() - now.getTime()) / MS_PER_MINUTE);
	return cards.nextClaimIn(Math.floor(minutes / 60), minutes % 60);
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
	drawRecordTable(context, input);
	drawLinesPanel(context, LUCK_PANEL, levelingCopy.labels.luck, input.luckLines);
	if (input.currencyLines.length > 0) drawLinesPanel(context, CURRENCIES_PANEL, levelingCopy.labels.currencies, input.currencyLines);

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

// The per game table the text profile shows as a code block: one row a game the
// member has played, then the overall row, numbers right aligned in columns.
function drawRecordTable(context: SKRSContext2D, input: AccountCardInput): void {
	const columns = levelingCopy.cards.recordColumns;
	const secondary = canvasColor(COLORS.CARD_TEXT_SECONDARY);
	drawPanel(context, { ...RECORD_TABLE, radius: PANEL_RADIUS, fill: canvasColor(COLORS.CARD_PANEL) });
	drawText(context, levelingCopy.cards.record, { x: RECORD_TABLE.x + 20, y: RECORD_TABLE.y + 34, size: 18, color: secondary });
	if (input.games.length === 0) {
		drawText(context, levelingCopy.labels.noRecordYet, { x: RECORD_TABLE.x + 20, y: RECORD_TABLE.y + 80, size: 20, color: canvasColor(COLORS.CARD_TEXT_MUTED) });
		return;
	}

	const headerY = RECORD_TABLE.y + 64;
	for (const [column, label] of Object.entries(columns) as Array<[keyof typeof RECORD_COLUMNS, string]>) {
		drawText(context, label, { x: RECORD_TABLE.x + RECORD_COLUMNS[column], y: headerY, size: 15, weight: "bold", color: secondary, align: "right" });
	}
	const totals = input.games.reduce(
		(sum, game) => ({ played: sum.played + game.played, won: sum.won + game.won, lost: sum.lost + game.lost, drawn: sum.drawn + game.drawn, assists: sum.assists + game.assists }),
		{ played: 0, won: 0, lost: 0, drawn: 0, assists: 0 }
	);
	const rows = [...input.games, { slug: levelingCopy.labels.overall, ...totals }];
	rows.forEach((row, index) => {
		const y = headerY + (index + 1) * RECORD_ROW_HEIGHT;
		const isOverall = index === rows.length - 1;
		const color = canvasColor(isOverall ? COLORS.CARD_TEXT : COLORS.CARD_TEXT_SECONDARY);
		const weight = isOverall ? "bold" : undefined;
		drawText(context, row.slug, { x: RECORD_TABLE.x + 20, y, size: 16, weight, color });
		const values: Record<keyof typeof RECORD_COLUMNS, string> = {
			played: String(row.played),
			won: String(row.won),
			lost: String(row.lost),
			drawn: String(row.drawn),
			assists: String(row.assists),
			ratio: ratio(row.won, row.lost),
		};
		for (const [column, value] of Object.entries(values) as Array<[keyof typeof RECORD_COLUMNS, string]>) {
			drawText(context, value, { x: RECORD_TABLE.x + RECORD_COLUMNS[column], y, size: 16, weight, color, align: "right" });
		}
	});
}

// A panel with a label and up to four short lines, the first one bold. A line carrying a
// sign draws green or red through signedNumberColor (owner decision 10); the rest keep
// the plain text colors.
function drawLinesPanel(context: SKRSContext2D, box: Rect, label: string, lines: readonly CardLine[]): void {
	drawPanel(context, { ...box, radius: PANEL_RADIUS, fill: canvasColor(COLORS.CARD_PANEL) });
	drawText(context, label, { x: box.x + 20, y: box.y + 34, size: 18, color: canvasColor(COLORS.CARD_TEXT_SECONDARY), maxWidth: box.width - 40 });
	lines.forEach((line, index) => {
		const plain = index === 0 ? COLORS.CARD_TEXT : COLORS.CARD_TEXT_MUTED;
		drawText(context, line.text, {
			x: box.x + 20,
			y: box.y + 64 + index * PANEL_LINE_HEIGHT,
			size: index === 0 ? 18 : 15,
			weight: index === 0 ? "bold" : undefined,
			color: canvasColor(line.sign === undefined ? plain : signedNumberColor(line.sign)),
			maxWidth: box.width - 40,
		});
	});
}

/** The colors the card's lines draw in, by text. Exported for the tests, which check the signed ones. */
export function accountCardLineColors(view: AccountView): Array<{ text: string; color: string }> {
	const input = toCardInput(view);
	return [...input.luckLines, ...input.currencyLines]
		.filter((line) => line.sign !== undefined)
		.map((line) => ({ text: line.text, color: canvasColor(signedNumberColor(line.sign ?? 0)) }));
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
