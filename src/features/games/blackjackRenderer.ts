import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackground,
	drawImageRounded,
	drawPanel,
	drawPill,
	drawPlayingCard,
	drawText,
	playingCardRadius,
	renderCard,
	type CardSuit,
	type DrawOutcome,
	type PlayingCardFace,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { Image, SKRSContext2D } from "@features/renderer/canvasModule.js";
import { gamesCopy } from "./gamesCopy.js";
import { renderTotal } from "./gamesEmbeds.js";
import { blackjackHandXp } from "./gameXp.js";
import { loadDeckFaces, loadGameArt, type DeckFaces } from "./gamesArt.js";
import type { BlackjackTable, Card, Hand, HandOutcome, SeatResult, Suit } from "./blackjackState.js";

// ── blackjackRenderer ────────────────────────────────────────────────
// The two blackjack cards. The RESULT card (2026-10 item 243 Phases 3 and 3b):
// the dealer's hand, then one row per player hand with its cards (the Dero deck's
// faces, or a drawn face for one whose file is missing), its total, how it came
// out, and the XP that hand paid. The TABLE card (Dero 1.7.0 test fixes, Phase 3a):
// the table in play, with the dealer's up card, the hole card FACE DOWN, every
// hand, and the hand on the clock marked. blackjackHandler draws the table card
// after every deal and action and the result card once, when the table settles,
// each behind the drawing pause, so the text embed posts unchanged whenever a card
// does not draw. Both share drawHand and drawHandRow below, so a hand looks the
// same in play and settled.
//
// ⚠️ THE HOLE CARD NEVER ENTERS THE TABLE VIEW. blackjackTableView copies only
// the dealer's first card; the second is a face down slot with no rank or suit, so
// the table card can neither draw it nor carry it into the cache key. Only the
// result card, drawn once the dealer has played, shows every card.
//
// The totals come from gamesEmbeds.renderTotal and the XP from
// gameXp.blackjackHandXp, so a card can never print a different total than the
// embed or a different award than the one paid.

export interface BlackjackHandRow {
	name: string;
	/** "Hand 2 of 2" after a split, null for a seat playing one hand. */
	label: string | null;
	cards: PlayingCardFace[];
	total: string;
	outcome: HandOutcome;
	doubled: boolean;
	xp: number;
}

/** Everything the result card draws: a settled table, as plain data. */
export interface BlackjackResultView {
	dealer: { cards: PlayingCardFace[]; total: string };
	hands: BlackjackHandRow[];
}

/** Where a hand stands while the table plays: on the clock, not reached yet, or done. */
export type BlackjackHandStanding = "acting" | "waiting" | "stood" | "bust" | "blackjack";

export interface BlackjackTableHandRow {
	name: string;
	/** "Hand 2 of 2" after a split, null for a seat playing one hand. */
	label: string | null;
	cards: PlayingCardFace[];
	total: string;
	standing: BlackjackHandStanding;
	doubled: boolean;
}

/** Everything the table card draws: a table in play, as plain data, with the hole card left out. */
export interface BlackjackTableView {
	/** The dealer's face up card, and how many cards lie face down beside it. */
	dealer: { upCards: PlayingCardFace[]; faceDown: number };
	hands: BlackjackTableHandRow[];
}

const SUIT_FACES: Record<Suit, CardSuit> = { S: "spade", H: "heart", D: "diamond", C: "club" };

const toFace = (card: Card): PlayingCardFace => ({ rank: card.rank, suit: SUIT_FACES[card.suit] });

/** The result card's view of a settled table, one row per hand in seat order. */
export function blackjackResultView(table: BlackjackTable, results: SeatResult[]): BlackjackResultView {
	const c = gamesCopy.blackjack;
	const hands = results.flatMap((result) => {
		const seat = table.seats.find((candidate) => candidate.userId === result.userId);
		return result.hands.map((outcome, index): BlackjackHandRow => {
			const cards = seat?.hands[index]?.cards ?? [];
			const doubled = result.doubled[index] ?? false;
			return {
				name: result.username,
				label: result.hands.length > 1 ? c.handLabel(index, result.hands.length) : null,
				cards: cards.map(toFace),
				total: renderTotal(cards),
				outcome,
				doubled,
				xp: blackjackHandXp(outcome, doubled),
			};
		});
	});
	return { dealer: { cards: table.dealer.cards.map(toFace), total: renderTotal(table.dealer.cards) }, hands };
}

// The dealer's FIRST card is the up card, the same one buildBlackjackTableEmbed
// shows beside its "??"; everything after it stays face down until the dealer plays.
const DEALER_UP_CARDS = 1;

/** The table card's view of a table in play, one row per hand in seat order, with the hand on the clock marked. */
export function blackjackTableView(table: BlackjackTable): BlackjackTableView {
	const c = gamesCopy.blackjack;
	const hands = table.seats.flatMap((seat, seatIndex) =>
		seat.hands.map(
			(hand, index): BlackjackTableHandRow => ({
				name: seat.username,
				label: seat.hands.length > 1 ? c.handLabel(index, seat.hands.length) : null,
				cards: hand.cards.map(toFace),
				total: renderTotal(hand.cards),
				standing: handStanding(table, hand, seatIndex === table.turn && index === seat.activeHand),
				doubled: hand.doubled,
			})
		)
	);
	const upCards = table.dealer.cards.slice(0, DEALER_UP_CARDS).map(toFace);
	return { dealer: { upCards, faceDown: Math.max(0, table.dealer.cards.length - upCards.length) }, hands };
}

function handStanding(table: BlackjackTable, hand: Hand, isOnTheClock: boolean): BlackjackHandStanding {
	if (hand.status !== "playing") return hand.status;
	return table.phase === "playing" && isOnTheClock ? "acting" : "waiting";
}

// Bump whenever the drawing changes, or members keep seeing cached cards.
const BLACKJACK_CARD_VERSION = 2;
const BLACKJACK_TABLE_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const PADDING = 32;
const ROW_HEIGHT = 136;
const ROW_GAP = 12;
// Five seats that each split twice would be twenty rows; past six the card says
// how many more there are and the embed under it still lists every hand.
const MAX_HAND_ROWS = 6;
const MORE_LINE_HEIGHT = 44;
// The Dero deck's faces are about twice as tall as they are wide (roughly 96 by
// 204), so a card is drawn at that shape rather than the usual five by seven,
// which would crop the art. The drawn stand in face takes the same shape.
const PLAYING_CARD_HEIGHT = 118;
const PLAYING_CARD_WIDTH = Math.round(PLAYING_CARD_HEIGHT * (96 / 204));
const PLAYING_CARD_GAP = 8;
const NAME_X = PADDING + 24;
const CARDS_X = 300;
const CARDS_RIGHT = 720;
const OUTCOME_X = 748;
const OUTCOME_WIDTH = 160;
const PILL_HEIGHT = 40;

const OUTCOME_FILL: Record<HandOutcome, ColorResolvable> = {
	blackjack: COLORS.CARD_OUTCOME_WIN,
	win: COLORS.CARD_OUTCOME_WIN,
	push: COLORS.CARD_TEXT_SECONDARY,
	lose: COLORS.CARD_OUTCOME_LOSE,
};

const STANDING_FILL: Record<BlackjackHandStanding, ColorResolvable> = {
	acting: COLORS.GAME_BLACKJACK,
	waiting: COLORS.CARD_NESTED,
	stood: COLORS.CARD_TEXT_SECONDARY,
	bust: COLORS.CARD_OUTCOME_LOSE,
	blackjack: COLORS.CARD_OUTCOME_WIN,
};

// A waiting hand's pill sits on the row in the nested shade, so its label takes the
// light ink; every other pill is a bright fill under the dark ink the result uses.
const STANDING_INK: Record<BlackjackHandStanding, ColorResolvable> = {
	acting: COLORS.CARD_TEXT,
	waiting: COLORS.CARD_TEXT_SECONDARY,
	stood: COLORS.CARD_BACKGROUND,
	bust: COLORS.CARD_BACKGROUND,
	blackjack: COLORS.CARD_BACKGROUND,
};

function outcomeLabel(outcome: HandOutcome): string {
	const c = gamesCopy.blackjack;
	const labels: Record<HandOutcome, string> = { blackjack: c.outcomeBlackjack, win: c.outcomeWin, push: c.outcomePush, lose: c.outcomeLose };
	return labels[outcome].toUpperCase();
}

function standingLabel(standing: BlackjackHandStanding): string {
	const c = gamesCopy.blackjack;
	const labels: Record<BlackjackHandStanding, string> = {
		acting: c.cardActing,
		waiting: c.cardWaiting,
		stood: c.cardStood,
		bust: c.cardBust,
		blackjack: c.outcomeBlackjack,
	};
	return labels[standing].toUpperCase();
}

function cardHeight(handCount: number): number {
	const rows = Math.min(handCount, MAX_HAND_ROWS);
	const more = handCount > MAX_HAND_ROWS ? MORE_LINE_HEIGHT : 0;
	return PADDING * 2 + (rows + 1) * ROW_HEIGHT + rows * ROW_GAP + more;
}

const rowTop = (index: number): number => PADDING + (index + 1) * (ROW_HEIGHT + ROW_GAP);

/** The result card for a settled table, or null when the result embed should post alone. Never throws. */
export function renderBlackjackResultCard(view: BlackjackResultView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "blackjack-result",
		version: BLACKJACK_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: cardHeight(view.hands.length),
		draw: drawBlackjackResultCard,
	});
}

/** The table card for a table in play, or null when the table embed should post alone. Never throws. */
export function renderBlackjackTableCard(view: BlackjackTableView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "blackjack-table",
		version: BLACKJACK_TABLE_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: cardHeight(view.hands.length),
		draw: drawBlackjackTableCard,
	});
}

async function drawBlackjackResultCard(context: SKRSContext2D, view: BlackjackResultView): Promise<DrawOutcome> {
	const deck = await loadDeckFaces([...view.dealer.cards, ...view.hands.flatMap((hand) => hand.cards)]);
	drawCardBackground(context, COLORS.GAME_BLACKJACK, CARD_WIDTH / 2, 0, CARD_WIDTH * 0.6);
	drawDealerRow(context, view.dealer.total, view.dealer.cards, deck, null);
	const shown = view.hands.slice(0, MAX_HAND_ROWS);
	shown.forEach((hand, index) =>
		drawHandRow(context, rowTop(index), deck, {
			name: hand.name,
			detail: [hand.label, hand.total, hand.doubled ? gamesCopy.blackjack.cardDoubled : null],
			cards: hand.cards,
			pill: { label: outcomeLabel(hand.outcome), fill: OUTCOME_FILL[hand.outcome], ink: COLORS.CARD_BACKGROUND },
			footer: gamesCopy.blackjack.cardHandXp(hand.xp),
			highlighted: false,
		})
	);
	drawMoreHands(context, view.hands.length - shown.length);
	// A face drawn without its deck art is a stand in, so the card is not cached.
	return deck.allPresent ? undefined : { cacheable: false };
}

async function drawBlackjackTableCard(context: SKRSContext2D, view: BlackjackTableView): Promise<DrawOutcome> {
	const deck = await loadDeckFaces([...view.dealer.upCards, ...view.hands.flatMap((hand) => hand.cards)]);
	const back = view.dealer.faceDown > 0 ? await loadGameArt("cardBack") : null;
	drawCardBackground(context, COLORS.GAME_BLACKJACK, CARD_WIDTH / 2, 0, CARD_WIDTH * 0.6);
	const dealerCards: Array<PlayingCardFace | null> = [...view.dealer.upCards, ...Array.from({ length: view.dealer.faceDown }, () => null)];
	drawDealerRow(context, null, dealerCards, deck, back);
	const shown = view.hands.slice(0, MAX_HAND_ROWS);
	shown.forEach((hand, index) =>
		drawHandRow(context, rowTop(index), deck, {
			name: hand.name,
			detail: [hand.label, hand.total, hand.doubled ? gamesCopy.blackjack.cardDoubled : null],
			cards: hand.cards,
			pill: { label: standingLabel(hand.standing), fill: STANDING_FILL[hand.standing], ink: STANDING_INK[hand.standing] },
			footer: null,
			highlighted: hand.standing === "acting",
		})
	);
	drawMoreHands(context, view.hands.length - shown.length);
	// A face or the back drawn without its art is a stand in, so the card is not cached.
	const backMissing = view.dealer.faceDown > 0 && !back;
	return deck.allPresent && !backMissing ? undefined : { cacheable: false };
}

// The dealer's row: the label, the total when every card is face up, and the hand.
// The table card passes null, as the table embed shows no dealer total in play
// either: a total of the up card alone would read as the dealer's whole hand.
function drawDealerRow(
	context: SKRSContext2D,
	total: string | null,
	cards: Array<PlayingCardFace | null>,
	deck: DeckFaces,
	back: Image | null
): void {
	const top = PADDING;
	drawText(context, gamesCopy.blackjack.cardDealer, {
		x: NAME_X,
		y: top + ROW_HEIGHT / 2 - 10,
		size: 28,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
	});
	if (total !== null) {
		drawText(context, total, {
			x: NAME_X,
			y: top + ROW_HEIGHT / 2 + 24,
			size: 22,
			color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
			baseline: "middle",
		});
	}
	drawHand(context, cards, top, deck, back);
}

/** One hand's row as either card draws it: the pill says how it came out (result) or where it stands (table). */
interface DrawnHandRow {
	name: string;
	/** Joined with two spaces; a null part is left out. */
	detail: Array<string | null>;
	cards: PlayingCardFace[];
	pill: { label: string; fill: ColorResolvable; ink: ColorResolvable };
	/** The line under the pill (the XP a settled hand paid), or null to centre the pill alone. */
	footer: string | null;
	/** The hand on the clock, drawn on the lighter panel. */
	highlighted: boolean;
}

function drawHandRow(context: SKRSContext2D, top: number, deck: DeckFaces, row: DrawnHandRow): void {
	drawPanel(context, {
		x: PADDING,
		y: top,
		width: CARD_WIDTH - PADDING * 2,
		height: ROW_HEIGHT,
		radius: 18,
		fill: canvasColor(row.highlighted ? COLORS.CARD_NESTED : COLORS.CARD_PANEL),
	});
	const middle = top + ROW_HEIGHT / 2;
	drawText(context, row.name, {
		x: NAME_X,
		y: middle - 18,
		size: 26,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: CARDS_X - NAME_X - 16,
	});
	const detail = row.detail.filter((part): part is string => part !== null).join("  ");
	drawText(context, detail, {
		x: NAME_X,
		y: middle + 18,
		size: 20,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		baseline: "middle",
		maxWidth: CARDS_X - NAME_X - 16,
	});
	drawHand(context, row.cards, top, deck, null);
	drawPill(context, {
		x: OUTCOME_X,
		y: row.footer === null ? middle - PILL_HEIGHT / 2 : middle - 34,
		width: OUTCOME_WIDTH,
		height: PILL_HEIGHT,
		fill: canvasColor(row.pill.fill),
		label: row.pill.label,
		labelColor: canvasColor(row.pill.ink),
	});
	if (row.footer === null) return;
	drawText(context, row.footer, {
		x: OUTCOME_X + OUTCOME_WIDTH / 2,
		y: middle + 26,
		size: 22,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		align: "center",
		baseline: "middle",
	});
}

// The cards sit side by side, and squeeze into the space they have when a hand
// runs long (a seven card twenty one), overlapping rather than spilling into the
// outcome column. A null is a card lying face down: the Dero deck's back, or a
// blank slot of the same shape when the back is not on disk.
function drawHand(context: SKRSContext2D, cards: Array<PlayingCardFace | null>, top: number, deck: DeckFaces, back: Image | null): void {
	const span = CARDS_RIGHT - CARDS_X;
	const naturalStep = PLAYING_CARD_WIDTH + PLAYING_CARD_GAP;
	const step = cards.length > 1 ? Math.min(naturalStep, (span - PLAYING_CARD_WIDTH) / (cards.length - 1)) : naturalStep;
	const y = top + (ROW_HEIGHT - PLAYING_CARD_HEIGHT) / 2;
	cards.forEach((card, index) => {
		const slot = { x: CARDS_X + index * step, y, width: PLAYING_CARD_WIDTH, height: PLAYING_CARD_HEIGHT };
		if (card) drawPlayingCard(context, { ...slot, rank: card.rank, suit: card.suit, art: deck.faceFor(card) });
		else drawFaceDown(context, slot, back);
	});
}

function drawFaceDown(context: SKRSContext2D, slot: { x: number; y: number; width: number; height: number }, back: Image | null): void {
	if (back) {
		drawImageRounded(context, back, slot, playingCardRadius(slot.width));
		return;
	}
	drawPanel(context, { ...slot, radius: playingCardRadius(slot.width), fill: canvasColor(COLORS.CARD_NESTED) });
}

// Past MAX_HAND_ROWS the card says how many hands it left out; the embed under it
// still lists every one.
function drawMoreHands(context: SKRSContext2D, hidden: number): void {
	if (hidden <= 0) return;
	drawText(context, gamesCopy.blackjack.cardMoreHands(hidden), {
		x: CARD_WIDTH - PADDING,
		y: context.canvas.height - PADDING,
		size: 20,
		color: canvasColor(COLORS.CARD_TEXT_MUTED),
		align: "right",
	});
}
