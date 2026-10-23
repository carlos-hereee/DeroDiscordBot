import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackground,
	drawPanel,
	drawPill,
	drawPlayingCard,
	drawText,
	renderCard,
	type CardSuit,
	type PlayingCardFace,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { gamesCopy } from "./gamesCopy.js";
import { renderTotal } from "./gamesEmbeds.js";
import { blackjackHandXp } from "./gameXp.js";
import type { BlackjackTable, Card, HandOutcome, SeatResult, Suit } from "./blackjackState.js";

// ── blackjackRenderer ────────────────────────────────────────────────
// The blackjack result card (2026-10 item 243 Phase 3): the dealer's hand, then
// one row per player hand with its cards, its total, how it came out, and the
// XP that hand paid. blackjackHandler draws it once, when the table settles,
// through withRenderFallback, so the result embed posts unchanged whenever the
// card does not draw. It renders only a SETTLED table: before the dealer plays
// the hole card is secret from everyone, and this card shows every card.
//
// The totals come from gamesEmbeds.renderTotal and the XP from
// gameXp.blackjackHandXp, so the card can never print a different total than
// the embed or a different award than the one paid.

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

// Bump whenever the drawing changes, or members keep seeing cached cards.
const BLACKJACK_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const PADDING = 32;
const ROW_HEIGHT = 136;
const ROW_GAP = 12;
// Five seats that each split twice would be twenty rows; past six the card says
// how many more there are and the embed under it still lists every hand.
const MAX_HAND_ROWS = 6;
const MORE_LINE_HEIGHT = 44;
const PLAYING_CARD_WIDTH = 68;
const PLAYING_CARD_HEIGHT = 96;
const PLAYING_CARD_GAP = 10;
const NAME_X = PADDING + 24;
const CARDS_X = 300;
const CARDS_RIGHT = 720;
const OUTCOME_X = 748;
const OUTCOME_WIDTH = 160;

const OUTCOME_FILL: Record<HandOutcome, ColorResolvable> = {
	blackjack: COLORS.CARD_OUTCOME_WIN,
	win: COLORS.CARD_OUTCOME_WIN,
	push: COLORS.CARD_TEXT_SECONDARY,
	lose: COLORS.CARD_OUTCOME_LOSE,
};

function outcomeLabel(outcome: HandOutcome): string {
	const c = gamesCopy.blackjack;
	const labels: Record<HandOutcome, string> = { blackjack: c.outcomeBlackjack, win: c.outcomeWin, push: c.outcomePush, lose: c.outcomeLose };
	return labels[outcome].toUpperCase();
}

function cardHeight(handCount: number): number {
	const rows = Math.min(handCount, MAX_HAND_ROWS);
	const more = handCount > MAX_HAND_ROWS ? MORE_LINE_HEIGHT : 0;
	return PADDING * 2 + (rows + 1) * ROW_HEIGHT + rows * ROW_GAP + more;
}

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

function drawBlackjackResultCard(context: SKRSContext2D, view: BlackjackResultView): void {
	drawCardBackground(context, COLORS.GAME_BLACKJACK, CARD_WIDTH / 2, 0, CARD_WIDTH * 0.6);
	drawDealerRow(context, view.dealer);
	const shown = view.hands.slice(0, MAX_HAND_ROWS);
	shown.forEach((hand, index) => drawHandRow(context, hand, PADDING + (index + 1) * (ROW_HEIGHT + ROW_GAP)));

	const hidden = view.hands.length - shown.length;
	if (hidden <= 0) return;
	drawText(context, gamesCopy.blackjack.cardMoreHands(hidden), {
		x: CARD_WIDTH - PADDING,
		y: context.canvas.height - PADDING,
		size: 20,
		color: canvasColor(COLORS.CARD_TEXT_MUTED),
		align: "right",
	});
}

function drawDealerRow(context: SKRSContext2D, dealer: BlackjackResultView["dealer"]): void {
	const top = PADDING;
	drawText(context, gamesCopy.blackjack.cardDealer, {
		x: NAME_X,
		y: top + ROW_HEIGHT / 2 - 10,
		size: 28,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
	});
	drawText(context, dealer.total, {
		x: NAME_X,
		y: top + ROW_HEIGHT / 2 + 24,
		size: 22,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		baseline: "middle",
	});
	drawHand(context, dealer.cards, top);
}

function drawHandRow(context: SKRSContext2D, hand: BlackjackHandRow, top: number): void {
	drawPanel(context, { x: PADDING, y: top, width: CARD_WIDTH - PADDING * 2, height: ROW_HEIGHT, radius: 18, fill: canvasColor(COLORS.CARD_PANEL) });
	const middle = top + ROW_HEIGHT / 2;
	drawText(context, hand.name, {
		x: NAME_X,
		y: middle - 18,
		size: 26,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: CARDS_X - NAME_X - 16,
	});
	const detail = [hand.label, hand.total, hand.doubled ? gamesCopy.blackjack.cardDoubled : null].filter((part): part is string => part !== null).join("  ");
	drawText(context, detail, {
		x: NAME_X,
		y: middle + 18,
		size: 20,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		baseline: "middle",
		maxWidth: CARDS_X - NAME_X - 16,
	});
	drawHand(context, hand.cards, top);
	drawPill(context, {
		x: OUTCOME_X,
		y: middle - 34,
		width: OUTCOME_WIDTH,
		height: 40,
		fill: canvasColor(OUTCOME_FILL[hand.outcome]),
		label: outcomeLabel(hand.outcome),
		labelColor: canvasColor(COLORS.CARD_BACKGROUND),
	});
	drawText(context, gamesCopy.blackjack.cardHandXp(hand.xp), {
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
// outcome column.
function drawHand(context: SKRSContext2D, cards: PlayingCardFace[], rowTop: number): void {
	const span = CARDS_RIGHT - CARDS_X;
	const naturalStep = PLAYING_CARD_WIDTH + PLAYING_CARD_GAP;
	const step = cards.length > 1 ? Math.min(naturalStep, (span - PLAYING_CARD_WIDTH) / (cards.length - 1)) : naturalStep;
	const y = rowTop + (ROW_HEIGHT - PLAYING_CARD_HEIGHT) / 2;
	cards.forEach((card, index) => {
		drawPlayingCard(context, { x: CARDS_X + index * step, y, width: PLAYING_CARD_WIDTH, height: PLAYING_CARD_HEIGHT, rank: card.rank, suit: card.suit });
	});
}
