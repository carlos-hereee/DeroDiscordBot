import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawBarSegment,
	drawCardBackground,
	drawPanel,
	drawPill,
	drawPlayingCard,
	drawText,
	renderCard,
	withAlpha,
	type CardSuit,
	type PlayingCardFace,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import { RANK_LABELS, type Card, type Suit } from "@features/games/holdemHand.js";
import { deroBrainCopy } from "./deroBrainCopy.js";
import type { PublicResult, PublicView } from "./dealerNarration.js";

// ── dealerShowdownRenderer ───────────────────────────────────────────
// The hold em dealer's showdown card (2026-10 item 243 Phase 3): the board,
// who won what and with which hand, the pot, and a strip of every seat with its
// stack as a bar and how it stood when the hand ended (in the hand, folded, all
// in, out, and the button). dealerNarration attaches it to the dealer's result
// line through withRenderFallback, so the line posts on its own whenever the
// card does not draw. Only tables Dero deals get it.
//
// ⚠️ BUILT FROM THE PUBLIC VIEW AND THE PUBLIC RESULT ONLY, the same two shapes
// the narrator reads, so this file can no more see a player's private cards
// than dealerNarration can. The only cards it draws are the board's. The dealer
// tripwire test scans this file too.

export type DealerSeatStanding = "inHand" | "folded" | "allIn" | "out";

export interface DealerShowdownSeat {
	name: string;
	stack: number;
	standing: DealerSeatStanding;
	hasButton: boolean;
	isWinner: boolean;
}

/** Everything the showdown card draws. Names are display names; nothing takes a mention. */
export interface DealerShowdownView {
	handNumber: number;
	board: PlayingCardFace[];
	pot: number;
	/** One line per winner, worded by the dealer's own result copy. */
	winnerLines: string[];
	championLine: string | null;
	seats: DealerShowdownSeat[];
}

const SUIT_FACES: Record<Suit, CardSuit> = { s: "spade", h: "heart", d: "diamond", c: "club" };

const toFace = (card: Card): PlayingCardFace => ({ rank: RANK_LABELS[card.rank] ?? String(card.rank), suit: SUIT_FACES[card.suit] });

function standingOf(seat: PublicView["seats"][number]): DealerSeatStanding {
	if (seat.out) return "out";
	if (seat.folded) return "folded";
	if (seat.allIn) return "allIn";
	return "inHand";
}

/**
 * The showdown card's view of a settled hand. The pot is what the winners were
 * paid, which is the engine's own award, so chips handed back uncalled are not
 * counted as won.
 */
export function dealerShowdownView(view: PublicView, result: PublicResult): DealerShowdownView {
	const names = new Map(view.seats.map((seat) => [seat.userId, seat.name]));
	const nameOf = (userId: string): string => names.get(userId) ?? "a player";
	const winnerIds = new Set(result.winners.map((winner) => winner.userId));
	const champion = result.tournamentOver && view.winnerId ? deroBrainCopy.dealer.tournamentWon(nameOf(view.winnerId)) : null;
	return {
		handNumber: view.handNumber,
		board: view.board.map(toFace),
		pot: result.winners.reduce((total, winner) => total + winner.amount, 0),
		winnerLines: result.winners.map((winner) =>
			deroBrainCopy.dealer.result([{ name: nameOf(winner.userId), amount: winner.amount, category: winner.category }])
		),
		championLine: champion,
		seats: view.seats.map((seat) => ({
			name: seat.name,
			stack: seat.stack,
			standing: standingOf(seat),
			hasButton: seat.userId === view.buttonUserId,
			isWinner: winnerIds.has(seat.userId),
		})),
	};
}

// Bump whenever the drawing changes, or members keep seeing cached cards.
const SHOWDOWN_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const PADDING = 40;
const BOARD_TOP = 104;
const BOARD_CARD_WIDTH = 80;
const BOARD_CARD_HEIGHT = 112;
const BOARD_CARD_GAP = 12;
const BOARD_SIZE = 5;
const STRIP_TOP = 260;
const SEAT_ROW_HEIGHT = 56;
const NAME_WIDTH = 230;
const STANDING_WIDTH = 130;
const BAR_LEFT = PADDING + 24 + NAME_WIDTH + STANDING_WIDTH + 24;
const BAR_WIDTH = 330;

const STANDING_FILL: Record<DealerSeatStanding, ColorResolvable> = {
	inHand: COLORS.ARCADE,
	allIn: COLORS.ARCADE,
	folded: COLORS.CARD_NESTED,
	out: COLORS.CARD_NESTED,
};

function standingLabel(seat: DealerShowdownSeat): string {
	const copy = deroBrainCopy.dealer;
	const labels: Record<DealerSeatStanding, string> = { inHand: copy.cardInHand, folded: copy.cardFolded, allIn: copy.cardAllIn, out: copy.cardOut };
	return labels[seat.standing];
}

/** The showdown card for the dealer's result line, or null when the line should post alone. Never throws. */
export function renderDealerShowdownCard(view: DealerShowdownView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "holdem-showdown",
		version: SHOWDOWN_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: STRIP_TOP + view.seats.length * SEAT_ROW_HEIGHT + PADDING,
		draw: drawShowdownCard,
	});
}

function drawShowdownCard(context: SKRSContext2D, view: DealerShowdownView): void {
	drawCardBackground(context, COLORS.ARCADE, CARD_WIDTH / 2, 0, CARD_WIDTH * 0.6);
	const copy = deroBrainCopy.dealer;
	drawPill(context, { x: PADDING, y: 32, width: 160, height: 44, fill: canvasColor(COLORS.ARCADE), label: copy.cardHand(view.handNumber) });
	drawText(context, copy.cardPot(view.pot), {
		x: CARD_WIDTH - PADDING,
		y: 54,
		size: 28,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		align: "right",
		baseline: "middle",
	});
	drawBoard(context, view.board);
	drawWinnerLines(context, view);
	view.seats.forEach((seat, index) => drawSeatRow(context, seat, STRIP_TOP + index * SEAT_ROW_HEIGHT, maxStack(view)));
}

// ① The five board slots, face up where a card was dealt and an empty slot where
// the hand ended before it (everyone else folded), so the board always reads as five.
function drawBoard(context: SKRSContext2D, board: PlayingCardFace[]): void {
	for (let index = 0; index < BOARD_SIZE; index += 1) {
		const x = PADDING + index * (BOARD_CARD_WIDTH + BOARD_CARD_GAP);
		const card = board[index];
		if (card) {
			drawPlayingCard(context, { x, y: BOARD_TOP, width: BOARD_CARD_WIDTH, height: BOARD_CARD_HEIGHT, rank: card.rank, suit: card.suit });
			continue;
		}
		drawPanel(context, { x, y: BOARD_TOP, width: BOARD_CARD_WIDTH, height: BOARD_CARD_HEIGHT, radius: 8, fill: withAlpha(COLORS.CARD_TEXT_MUTED, 0.15) });
	}
}

function drawWinnerLines(context: SKRSContext2D, view: DealerShowdownView): void {
	const left = PADDING + BOARD_SIZE * (BOARD_CARD_WIDTH + BOARD_CARD_GAP) + 16;
	const width = CARD_WIDTH - PADDING - left;
	const lines = view.championLine ? [...view.winnerLines, view.championLine] : view.winnerLines;
	lines.forEach((line, index) => {
		drawText(context, line, {
			x: left,
			y: BOARD_TOP + 24 + index * 34,
			size: index < view.winnerLines.length ? 24 : 20,
			weight: index < view.winnerLines.length ? "bold" : "regular",
			color: canvasColor(index < view.winnerLines.length ? COLORS.CARD_OUTCOME_WIN : COLORS.CARD_TEXT_SECONDARY),
			baseline: "middle",
			maxWidth: width,
		});
	});
}

// The bars share one scale, the biggest stack at the table, so they compare
// against each other; a scale of the total chips would make every bar a sliver
// at a six seat table.
function maxStack(view: DealerShowdownView): number {
	return Math.max(1, ...view.seats.map((seat) => seat.stack));
}

// ② One row of the action strip: the name (with the button marked), how the seat
// stood when the hand ended, and its stack as a bar.
function drawSeatRow(context: SKRSContext2D, seat: DealerShowdownSeat, top: number, scale: number): void {
	const height = SEAT_ROW_HEIGHT - 8;
	const middle = top + height / 2;
	drawPanel(context, {
		x: PADDING,
		y: top,
		width: CARD_WIDTH - PADDING * 2,
		height,
		radius: 12,
		fill: canvasColor(seat.isWinner ? COLORS.CARD_NESTED : COLORS.CARD_PANEL),
	});
	const name = seat.hasButton ? `${seat.name}  (${deroBrainCopy.dealer.cardButton})` : seat.name;
	const ink = canvasColor(seat.standing === "out" ? COLORS.CARD_TEXT_MUTED : COLORS.CARD_TEXT);
	drawText(context, name, { x: PADDING + 24, y: middle, size: 20, weight: "bold", color: ink, baseline: "middle", maxWidth: NAME_WIDTH - 12 });
	drawPill(context, {
		x: PADDING + 24 + NAME_WIDTH,
		y: middle - 15,
		width: STANDING_WIDTH - 12,
		height: 30,
		fill: canvasColor(STANDING_FILL[seat.standing]),
		label: standingLabel(seat),
		labelColor: canvasColor(COLORS.CARD_TEXT),
	});
	drawBarSegment(context, {
		x: BAR_LEFT,
		y: middle - 8,
		width: BAR_WIDTH,
		height: 16,
		fillRatio: seat.stack / scale,
		fillColor: canvasColor(seat.isWinner ? COLORS.CARD_OUTCOME_WIN : COLORS.CARD_TEXT_SECONDARY),
		trackColor: canvasColor(COLORS.CARD_NESTED),
	});
	drawText(context, deroBrainCopy.dealer.cardStack(seat.stack), {
		x: CARD_WIDTH - PADDING - 24,
		y: middle,
		size: 18,
		color: ink,
		align: "right",
		baseline: "middle",
	});
}
