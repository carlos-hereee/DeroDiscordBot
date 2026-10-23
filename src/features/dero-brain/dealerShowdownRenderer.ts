import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawBarSegment,
	drawCardBackground,
	drawImageRounded,
	drawPanel,
	drawPill,
	drawPlayingCard,
	drawText,
	playingCardRadius,
	renderCard,
	withAlpha,
	type CardSuit,
	type DrawOutcome,
	type PlayingCardFace,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { Image, SKRSContext2D } from "@features/renderer/canvasModule.js";
import { RANK_LABELS, type Card, type Suit } from "@features/games/holdemHand.js";
import type { SeatLastAction } from "@features/games/holdemTable.js";
import type { BettingAction } from "@features/games/holdemBetting.js";
import { loadDeckFaces, loadGameArt, type DeckFaces } from "@features/games/gamesArt.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { deroBrainCopy } from "./deroBrainCopy.js";
import type { PublicResult, PublicView } from "./dealerNarration.js";

// ── dealerShowdownRenderer ───────────────────────────────────────────
// The two hold em table cards. The SHOWDOWN card (2026-10 item 243 Phase 3): the
// board, who won what and with which hand, the pot, and a strip of every seat with
// its stack as a bar and how it stood when the hand ended (in the hand, folded, all
// in, out, and the button). dealerNarration attaches it to the dealer's result
// line through withRenderFallback, so the line posts on its own whenever the card
// does not draw. Only tables Dero deals get it. The LIVE card (Dero 1.7.0 test
// fixes, Phase 3a): the same board and strip while the table plays, with whose
// turn it is, the pot, and each seat's stack and last action. The room's board
// redraw shows it after every action at every table, behind the drawing pause.
//
// ⚠️ BUILT FROM THE PUBLIC VIEW AND THE PUBLIC RESULT ONLY, the same two shapes
// the narrator reads, so this file can no more see a player's private cards
// than dealerNarration can. The only cards it draws are the board's, on both
// cards. The dealer tripwire test scans this file too.

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

// ── the live table ──
/** How a seat stands while the table plays: the showdown's four, or sitting out. */
export type HoldemLiveStanding = DealerSeatStanding | "sittingOut";

export interface HoldemLiveSeat {
	name: string;
	stack: number;
	standing: HoldemLiveStanding;
	/** The seat's last decision this hand, worded for its pill, or null before it has acted. */
	lastAction: string | null;
	hasButton: boolean;
	isActing: boolean;
}

/** Everything the live card draws. Names are display names; nothing takes a mention. */
export interface HoldemLiveView {
	handNumber: number;
	board: PlayingCardFace[];
	pot: number;
	/** Whose turn it is, or what the table is waiting on. */
	headline: string;
	blindsLine: string;
	seats: HoldemLiveSeat[];
}

function liveStandingOf(seat: PublicView["seats"][number]): HoldemLiveStanding {
	if (!seat.out && seat.sittingOut) return "sittingOut";
	return standingOf(seat);
}

function lastActionLabel(last: SeatLastAction | null): string | null {
	if (!last) return null;
	const copy = gameRoomsCopy.holdem;
	const labels: Record<BettingAction, string> = {
		fold: copy.cardFold,
		check: copy.cardCheck,
		call: copy.cardCall,
		bet: copy.cardBet(last.amount),
		raise: copy.cardRaise(last.amount),
		allIn: copy.cardAllIn,
	};
	return labels[last.action];
}

function liveHeadline(view: PublicView, nameOf: (userId: string) => string): string {
	const copy = gameRoomsCopy.holdem;
	if (view.status === "joining") return copy.cardJoining;
	if (view.status === "finished") return copy.cardFinished;
	if (view.actingUserId) return copy.cardToAct(nameOf(view.actingUserId));
	return copy.cardBetweenHands;
}

/**
 * The live card's view of a table in any state: the board dealt so far, the pot
 * standing in the hand (the caller's currentPot, which the table embed shows too),
 * whose turn it is, and every seat with its stack and last decision.
 */
export function holdemLiveView(view: PublicView, pot: number): HoldemLiveView {
	const names = new Map(view.seats.map((seat) => [seat.userId, seat.name]));
	const nameOf = (userId: string): string => names.get(userId) ?? "a player";
	return {
		handNumber: view.handNumber,
		board: view.board.map(toFace),
		pot,
		headline: liveHeadline(view, nameOf),
		blindsLine: gameRoomsCopy.holdem.cardBlinds(view.smallBlind, view.bigBlind),
		seats: view.seats.map((seat) => ({
			name: seat.name,
			stack: seat.stack,
			standing: liveStandingOf(seat),
			lastAction: lastActionLabel(seat.lastAction),
			hasButton: seat.userId === view.buttonUserId,
			isActing: seat.userId === view.actingUserId,
		})),
	};
}

// Bump whenever the drawing changes, or members keep seeing cached cards.
const SHOWDOWN_CARD_VERSION = 2;
const LIVE_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const PADDING = 40;
const BOARD_TOP = 96;
// The Dero deck's faces are about twice as tall as they are wide (roughly 96 by
// 204), so the board cards take that shape rather than crop the art.
const BOARD_CARD_HEIGHT = 140;
const BOARD_CARD_WIDTH = Math.round(BOARD_CARD_HEIGHT * (96 / 204));
const BOARD_CARD_GAP = 12;
const BOARD_SIZE = 5;
const STRIP_TOP = 260;
const SEAT_ROW_HEIGHT = 56;
const NAME_WIDTH = 230;
const STANDING_WIDTH = 130;
const BAR_LEFT = PADDING + 24 + NAME_WIDTH + STANDING_WIDTH + 24;
const BAR_WIDTH = 330;

const STANDING_FILL: Record<HoldemLiveStanding, ColorResolvable> = {
	inHand: COLORS.ARCADE,
	allIn: COLORS.ARCADE,
	folded: COLORS.CARD_NESTED,
	out: COLORS.CARD_NESTED,
	sittingOut: COLORS.CARD_NESTED,
};

function standingLabel(standing: HoldemLiveStanding): string {
	const copy = deroBrainCopy.dealer;
	const labels: Record<HoldemLiveStanding, string> = {
		inHand: copy.cardInHand,
		folded: copy.cardFolded,
		allIn: copy.cardAllIn,
		out: copy.cardOut,
		sittingOut: gameRoomsCopy.holdem.cardSittingOut,
	};
	return labels[standing];
}

// A seat's name on the strip, the button marked beside it.
const stripName = (name: string, hasButton: boolean): string => (hasButton ? `${name}  (${deroBrainCopy.dealer.cardButton})` : name);

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

/** The live card for the room's board, or null when the table embed should post alone. Never throws. */
export function renderHoldemLiveCard(view: HoldemLiveView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "holdem-table",
		version: LIVE_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: STRIP_TOP + view.seats.length * SEAT_ROW_HEIGHT + PADDING,
		draw: drawLiveCard,
	});
}

async function drawShowdownCard(context: SKRSContext2D, view: DealerShowdownView): Promise<DrawOutcome> {
	const outcome = await drawTableTop(context, view.handNumber, view.pot, view.board);
	drawSideLines(context, view.winnerLines, view.championLine);
	const scale = maxStack(view.seats);
	view.seats.forEach((seat, index) =>
		drawSeatRow(context, STRIP_TOP + index * SEAT_ROW_HEIGHT, scale, {
			name: stripName(seat.name, seat.hasButton),
			stack: seat.stack,
			pillLabel: standingLabel(seat.standing),
			pillFill: STANDING_FILL[seat.standing],
			dimmed: seat.standing === "out",
			highlighted: seat.isWinner,
			barFill: seat.isWinner ? COLORS.CARD_OUTCOME_WIN : COLORS.CARD_TEXT_SECONDARY,
		})
	);
	return outcome;
}

// The live strip's pill says the seat's last decision while it is in the hand, and
// how it stands once that is all there is to say (folded, out, sitting out). The
// seat on the clock is the highlighted row, and the headline names it too.
async function drawLiveCard(context: SKRSContext2D, view: HoldemLiveView): Promise<DrawOutcome> {
	const outcome = await drawTableTop(context, view.handNumber, view.pot, view.board);
	drawSideLines(context, [view.headline], view.blindsLine);
	const scale = maxStack(view.seats);
	view.seats.forEach((seat, index) => {
		const inTheHand = seat.standing === "inHand" || seat.standing === "allIn";
		drawSeatRow(context, STRIP_TOP + index * SEAT_ROW_HEIGHT, scale, {
			name: stripName(seat.name, seat.hasButton),
			stack: seat.stack,
			pillLabel: inTheHand && seat.lastAction ? seat.lastAction : standingLabel(seat.standing),
			pillFill: STANDING_FILL[seat.standing],
			dimmed: seat.standing === "out" || seat.standing === "sittingOut",
			highlighted: seat.isActing,
			barFill: seat.isActing ? COLORS.ARCADE : COLORS.CARD_TEXT_SECONDARY,
		});
	});
	return outcome;
}

// The top of either card: the hand pill, the pot, and the five board slots. Answers
// the draw's outcome: a face or the back drawn without its deck art is a stand in,
// so the card is not cached. Before the first deal there is no hand to name.
async function drawTableTop(context: SKRSContext2D, handNumber: number, pot: number, board: PlayingCardFace[]): Promise<DrawOutcome> {
	const deck = await loadDeckFaces(board);
	const back = board.length < BOARD_SIZE ? await loadGameArt("cardBack") : null;
	drawCardBackground(context, COLORS.ARCADE, CARD_WIDTH / 2, 0, CARD_WIDTH * 0.6);
	const copy = deroBrainCopy.dealer;
	if (handNumber > 0) drawPill(context, { x: PADDING, y: 32, width: 160, height: 44, fill: canvasColor(COLORS.ARCADE), label: copy.cardHand(handNumber) });
	drawText(context, copy.cardPot(pot), {
		x: CARD_WIDTH - PADDING,
		y: 54,
		size: 28,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		align: "right",
		baseline: "middle",
	});
	drawBoard(context, board, deck, back);
	const backMissing = board.length < BOARD_SIZE && !back;
	return deck.allPresent && !backMissing ? undefined : { cacheable: false };
}

// ① The five board slots, face up where a card was dealt and face down (the Dero
// deck's back, or an empty slot without it) where the hand ended before that
// street (everyone else folded), so the board always reads as five.
function drawBoard(context: SKRSContext2D, board: PlayingCardFace[], deck: DeckFaces, back: Image | null): void {
	for (let index = 0; index < BOARD_SIZE; index += 1) {
		const slot = { x: PADDING + index * (BOARD_CARD_WIDTH + BOARD_CARD_GAP), y: BOARD_TOP, width: BOARD_CARD_WIDTH, height: BOARD_CARD_HEIGHT };
		const card = board[index];
		if (card) {
			drawPlayingCard(context, { ...slot, rank: card.rank, suit: card.suit, art: deck.faceFor(card) });
			continue;
		}
		if (back) drawImageRounded(context, back, slot, playingCardRadius(slot.width));
		else drawPanel(context, { ...slot, radius: 8, fill: withAlpha(COLORS.CARD_TEXT_MUTED, 0.15) });
	}
}

// Beside the board: the lead lines in bold (the winners, or whose turn it is) and one
// quieter line under them (the champion, or the blinds), when there is one.
function drawSideLines(context: SKRSContext2D, leadLines: string[], quietLine: string | null): void {
	const left = PADDING + BOARD_SIZE * (BOARD_CARD_WIDTH + BOARD_CARD_GAP) + 16;
	const width = CARD_WIDTH - PADDING - left;
	const lines = quietLine ? [...leadLines, quietLine] : leadLines;
	lines.forEach((line, index) => {
		const isLead = index < leadLines.length;
		drawText(context, line, {
			x: left,
			y: BOARD_TOP + 24 + index * 34,
			size: isLead ? 24 : 20,
			weight: isLead ? "bold" : "regular",
			color: canvasColor(isLead ? COLORS.CARD_OUTCOME_WIN : COLORS.CARD_TEXT_SECONDARY),
			baseline: "middle",
			maxWidth: width,
		});
	});
}

// The bars share one scale, the biggest stack at the table, so they compare
// against each other; a scale of the total chips would make every bar a sliver
// at a six seat table.
function maxStack(seats: readonly { stack: number }[]): number {
	return Math.max(1, ...seats.map((seat) => seat.stack));
}

/** One strip row as either card draws it. */
interface StripRow {
	name: string;
	stack: number;
	pillLabel: string;
	pillFill: ColorResolvable;
	/** A seat no longer playing (out, or sitting out), drawn in the muted ink. */
	dimmed: boolean;
	/** The winner on the showdown card, the seat on the clock on the live one. */
	highlighted: boolean;
	barFill: ColorResolvable;
}

// ② One row of the action strip: the name (with the button marked), the seat's
// pill, and its stack as a bar.
function drawSeatRow(context: SKRSContext2D, top: number, scale: number, row: StripRow): void {
	const height = SEAT_ROW_HEIGHT - 8;
	const middle = top + height / 2;
	drawPanel(context, {
		x: PADDING,
		y: top,
		width: CARD_WIDTH - PADDING * 2,
		height,
		radius: 12,
		fill: canvasColor(row.highlighted ? COLORS.CARD_NESTED : COLORS.CARD_PANEL),
	});
	const ink = canvasColor(row.dimmed ? COLORS.CARD_TEXT_MUTED : COLORS.CARD_TEXT);
	drawText(context, row.name, { x: PADDING + 24, y: middle, size: 20, weight: "bold", color: ink, baseline: "middle", maxWidth: NAME_WIDTH - 12 });
	drawPill(context, {
		x: PADDING + 24 + NAME_WIDTH,
		y: middle - 15,
		width: STANDING_WIDTH - 12,
		height: 30,
		fill: canvasColor(row.pillFill),
		label: row.pillLabel,
		labelColor: canvasColor(COLORS.CARD_TEXT),
	});
	drawBarSegment(context, {
		x: BAR_LEFT,
		y: middle - 8,
		width: BAR_WIDTH,
		height: 16,
		fillRatio: row.stack / scale,
		fillColor: canvasColor(row.barFill),
		trackColor: canvasColor(COLORS.CARD_NESTED),
	});
	drawText(context, deroBrainCopy.dealer.cardStack(row.stack), {
		x: CARD_WIDTH - PADDING - 24,
		y: middle,
		size: 18,
		color: ink,
		align: "right",
		baseline: "middle",
	});
}
