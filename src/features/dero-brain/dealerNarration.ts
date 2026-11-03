import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { NO_PINGS } from "@utils/mentions.js";
import { HAND_CATEGORIES, formatCard, type Card, type HandCategory } from "@features/games/holdemHand.js";
import { handInProgress, whoActs, type ActionOutcome, type HoldemTable, type SeatLastAction, type Street } from "@features/games/holdemTable.js";
import { defaultCallAnnouncerDeps, speakInCall, type CallAnnouncerDeps } from "@features/voice/callAnnouncer.js";
import { withRenderFallback, type RenderPayload } from "@features/renderer/index.js";
import { deroBrainCopy, type DealerWinner } from "./deroBrainCopy.js";
import { dealerShowdownView, renderDealerShowdownCard, type DealerShowdownView } from "./dealerShowdownRenderer.js";
import { pickLine } from "@utils/pickLine.js";

// ── dealerNarration ───────────────────────────────────────────────────────
// What:  Dero as the dealer of a hold em table it opened: a few lines in the
//        room's text channel (the hand start and the result) and, for a table
//        opened from a voice call, the deal, the streets, whose turn it is and
//        the result spoken in that call.
// Who:   roomHoldemHandlers calls announceDealer after a deal, an action and a
//        turn clock fold; the rules card registers a table here when it opens
//        one. A table opened any other way (the challenge board) is never in
//        the map, so it gets no narration and no extra I/O.
// When:  after the table change has been written, fire and forget.
// Where: commentary, NOT a move. roomTrail.postMove appends to the room's
//        transcript, and the dealer's lines are not moves, so they go through
//        postDealerText below and never into the transcript. The map is memory
//        only: a restart simply stops narration, and the table plays on.
// How:   ① toPublicView copies the public fields of a table, field by field;
//        ② narrate compares two views and returns ordered lines; ③ the text
//        lines and the spoken lines are picked against their per hand caps;
//        ④ delivery is chained per table, so lines leave in the order the hand
//        happened even when one render is slow. The result line carries the
//        showdown card (dealerShowdownRenderer) when it draws, and posts alone
//        when it does not.
//
// ⚠️ A PLAYER'S PRIVATE CARDS NEVER REACH THIS FILE. toPublicView is the only
// function here that reads a table, it names every field it copies, and the
// PublicView type has no field that could hold a player's cards. The only cards
// the narrator ever sees are the board's. A tripwire test fails if the private
// card field's name appears anywhere in this file, and the narrator tests check
// that every card a line names is on the board.

// ── the public view ──

export interface PublicSeat {
	userId: string;
	name: string;
	stack: number;
	folded: boolean;
	allIn: boolean;
	out: boolean;
	/** Away from the table: still dealt in, folded whenever the action reaches it. */
	sittingOut: boolean;
	/** The seat's last decision this hand, already public in the room's trail. */
	lastAction: SeatLastAction | null;
}

/** Everything the dealer may know about a table: what the board embed already shows anyone. */
export interface PublicView {
	status: HoldemTable["status"];
	handNumber: number;
	street: Street;
	board: Card[];
	smallBlind: number;
	bigBlind: number;
	buttonUserId: string | null;
	/** Who must act now; null between hands and once the tournament is over. */
	actingUserId: string | null;
	winnerId: string | null;
	seats: PublicSeat[];
}

/** What a settled hand paid, from the engine's own outcome: amounts, and a hand category only when the engine named one. */
export interface PublicResult {
	winners: { userId: string; amount: number; category: HandCategory | null }[];
	tournamentOver: boolean;
}

/** ① The public fields of a table, copied one by one. The only reader of a table in this file. */
export function toPublicView(table: HoldemTable): PublicView {
	const live = table.seats.filter((seat) => !seat.out);
	return {
		status: table.status,
		handNumber: table.handNumber,
		street: table.street,
		board: table.board.map((card) => ({ rank: card.rank, suit: card.suit })),
		smallBlind: table.smallBlind,
		bigBlind: table.bigBlind,
		// The button indexes the live seats, the same ring dealHand reads.
		buttonUserId: live.length > 0 ? live[table.buttonIndex % live.length]?.userId ?? null : null,
		// After a fold out the betting round is not closed, so whoActs alone would
		// still name somebody; between hands nobody acts.
		actingUserId: handInProgress(table) ? whoActs(table) : null,
		winnerId: table.winnerId,
		seats: table.seats.map((seat) => ({
			userId: seat.userId,
			name: seat.username,
			stack: seat.stack,
			folded: seat.folded,
			allIn: seat.allIn,
			out: seat.out,
			sittingOut: seat.sittingOut ?? false,
			lastAction: seat.lastAction ? { action: seat.lastAction.action, amount: seat.lastAction.amount } : null,
		})),
	};
}

const isHandCategory = (value: string): value is HandCategory => (HAND_CATEGORIES as readonly string[]).includes(value);

/** The public half of an action's outcome: who won what, and the category the engine named, if any. */
export function toPublicResult(outcome: ActionOutcome | undefined): PublicResult | null {
	if (!outcome?.handOver) return null;
	const winners = (outcome.awards ?? [])
		.filter((award) => award.amount > 0)
		.map((award) => {
			const shown = outcome.showdown?.find((entry) => entry.userId === award.userId)?.hand;
			return { userId: award.userId, amount: award.amount, category: shown && isHandCategory(shown) ? shown : null };
		});
	return { winners, tournamentOver: Boolean(outcome.tournamentOver) };
}

// ── the narrator ──

/**
 * What a dealer line is. The first six are a Hold'em hand's narration; the last four are Dero
 * calling any card or room to order (2026-10 item 267): new challengers, the Start countdown and
 * the turn clock's warning and end. Those four never pass through narrate or the per hand caps,
 * they are spoken one at a time through announcementLine.
 */
export type DealerLineKind = "handStart" | "flop" | "turn" | "river" | "result" | "action" | "toAct" | AnnouncementKind;

/** A line Dero says to a card or a room outside any hand. */
export type AnnouncementKind = "challengers" | "countdown" | "turnWarning" | "turnOver" | "commentary";

/** One thing the dealer says, in its text form (mentions) and its spoken form (names). */
export interface DealerLine {
	kind: DealerLineKind;
	text: string;
	spoken: string;
	/** The board cards this line names; empty for every line but the streets. */
	cards: Card[];
}

// Which lines survive when the spoken cap bites: the turn prompts go first,
// because the board embed already shows whose turn it is.
// The announcements outrank everything, though no hand ever carries one into the cap.
const LINE_VALUE: Record<DealerLineKind, number> = { handStart: 3, result: 3, flop: 2, turn: 2, river: 2, action: 1, toAct: 1, challengers: 3, countdown: 3, turnWarning: 3, turnOver: 3, commentary: 2 };
const LOWEST_VALUE = 1;

/** One announcement as a dealer line: spoken words with no mention, so its text form is the same. */
export function announcementLine(kind: AnnouncementKind, spoken: string): DealerLine {
	return { kind, text: spoken, spoken, cards: [] };
}

// The lines a hand can still produce that outrank a turn prompt: every street not
// dealt yet, plus the result. A turn prompt is spoken only if these still fit.
function highValueLinesStillToCome(view: PublicView): number {
	if (view.status !== "playing" || view.street === "showdown") return 0;
	// The flop turns three cards at once, so an empty board still has three streets.
	const streetsLeft = view.board.length < 3 ? 3 : 5 - view.board.length;
	return streetsLeft + 1;
}

const dealerCopy = deroBrainCopy.dealer;

type Namer = (userId: string | null) => string;

const STREET_COPY = { flop: dealerCopy.flop, turn: dealerCopy.turn, river: dealerCopy.river };

function namers(view: PublicView): { text: Namer; spoken: Namer } {
	const names = new Map(view.seats.map((seat) => [seat.userId, seat.name]));
	return {
		text: (userId) => (userId ? `<@${userId}>` : ""),
		spoken: (userId) => (userId ? names.get(userId) ?? "a player" : ""),
	};
}

function streetLine(kind: "flop" | "turn" | "river", cards: Card[]): DealerLine {
	const say = STREET_COPY[kind];
	return {
		kind,
		text: say(cards.map(formatCard).join(" ")),
		spoken: say(dealerCopy.spokenCards(cards.map((card) => dealerCopy.spokenCard(card.rank, card.suit)))),
		cards,
	};
}

export interface NarrateOptions {
	/** The player the last turn prompt named, so a repeat is not spoken twice. */
	lastTurnUserId?: string | null;
}

/** ② The ordered lines for one table change: a new hand, the streets, the result, then whose turn it is. */
export function narrate(prev: PublicView, next: PublicView, result: PublicResult | null, options: NarrateOptions = {}): DealerLine[] {
	const lines: DealerLine[] = [];
	const name = namers(next);

	const newHand = next.handNumber > prev.handNumber;
	if (newHand) {
		const say = next.handNumber > 1 && next.bigBlind !== prev.bigBlind ? dealerCopy.handStartBlindsUp : dealerCopy.handStart;
		lines.push({
			kind: "handStart",
			text: say(next.handNumber, next.smallBlind, next.bigBlind, name.text(next.buttonUserId)),
			spoken: say(next.handNumber, next.smallBlind, next.bigBlind, name.spoken(next.buttonUserId)),
			cards: [],
		});
	}

	// The call on the action just taken (owner decision of 2026-10-29: Dero as a commentator),
	// before the streets it may have turned. Spoken only; the trail already posts the action.
	if (!newHand) {
		const action = actionLine(prev, next, name);
		if (action) lines.push(action);
	}

	// A new hand starts from an empty board whatever the last hand left showing.
	// An all in run out can turn several streets in one action, so each is checked.
	const shownBefore = newHand ? 0 : prev.board.length;
	const board = next.board;
	if (shownBefore < 3 && board.length >= 3) lines.push(streetLine("flop", board.slice(0, 3)));
	if (shownBefore < 4 && board.length >= 4) lines.push(streetLine("turn", [board[3]]));
	if (shownBefore < 5 && board.length >= 5) lines.push(streetLine("river", [board[4]]));

	if (result && result.winners.length > 0) {
		const winners = (namer: Namer): DealerWinner[] =>
			result.winners.map((winner) => ({ name: namer(winner.userId), amount: winner.amount, category: winner.category }));
		const champion = result.tournamentOver ? next.winnerId : null;
		const withChampion = (line: string, namer: Namer): string =>
			champion ? `${line} ${dealerCopy.tournamentWon(namer(champion))}` : line;
		lines.push({
			kind: "result",
			text: withChampion(dealerCopy.result(winners(name.text)), name.text),
			spoken: withChampion(dealerCopy.result(winners(name.spoken)), name.spoken),
			cards: [],
		});
	}

	if (next.actingUserId && next.actingUserId !== options.lastTurnUserId) {
		// One variant for both forms, so the text and the speech say the same words.
		const toAct = pickLine(dealerCopy.toAct);
		lines.push({
			kind: "toAct",
			text: toAct(name.text(next.actingUserId)),
			spoken: toAct(name.spoken(next.actingUserId)),
			cards: [],
		});
	}
	return lines;
}

// The seat that was on the clock, if its last action changed in this table change: what it did,
// called in Dero's words. One variant for both forms, so text and speech agree.
function actionLine(prev: PublicView, next: PublicView, name: { text: Namer; spoken: Namer }): DealerLine | null {
	const actorId = prev.actingUserId;
	if (!actorId) return null;
	const before = prev.seats.find((seat) => seat.userId === actorId)?.lastAction ?? null;
	const after = next.seats.find((seat) => seat.userId === actorId)?.lastAction ?? null;
	if (!after || (before && before.action === after.action && before.amount === after.amount)) return null;
	const call = pickLine(dealerCopy.actionCalls[after.action]);
	return { kind: "action", text: call(name.text(actorId), after.amount), spoken: call(name.spoken(actorId), after.amount), cards: [] };
}

// ── ③ the per hand caps ──

const TEXT_KINDS: readonly DealerLineKind[] = ["handStart", "result"];

/** The text lines to post: the hand start and the result, never more than the per hand cap. */
export function pickTextLines(lines: DealerLine[], postedThisHand: number): DealerLine[] {
	const room = Math.max(0, BOT_CONSTANTS.DERO_DEALER_TEXT_LINES_PER_HAND - postedThisHand);
	return lines.filter((line) => TEXT_KINDS.includes(line.kind)).slice(0, room);
}

/**
 * The lines to speak under the per hand cap, lowest value dropped first. Lines
 * arrive a few at a time over a hand, so a turn prompt is spoken only while the
 * streets and the result still to come would fit after it.
 */
export function pickSpokenLines(lines: DealerLine[], spokenThisHand: number, next: PublicView): DealerLine[] {
	const cap = BOT_CONSTANTS.DERO_DEALER_SPOKEN_LINES_PER_HAND;
	const reserved = highValueLinesStillToCome(next);
	const picked: DealerLine[] = [];
	let spoken = spokenThisHand;
	for (const line of lines) {
		const fits = LINE_VALUE[line.kind] > LOWEST_VALUE ? spoken < cap : spoken + reserved < cap;
		if (!fits) continue;
		picked.push(line);
		spoken++;
	}
	return picked;
}

// ── the dealer's tables ──

interface DealerSession {
	roomId: string;
	guildId: string;
	channelId: string;
	/** True only when the card came from a call and a call was open at Open. */
	voice: boolean;
	// When the table last showed it was alive: its registration, then every announcement. The
	// prune below reads this, so a table still dealing is never dropped (2026-10 item 263 R3-28).
	lastActiveAt: number;
	lastTurnUserId: string | null;
	handNumber: number;
	textThisHand: number;
	spokenThisHand: number;
	chain: Promise<void>;
}

/** The tables Dero deals, by room id. Memory only: roomBootRecovery registers the playing referee tables again after a restart. */
const dealerSessions = new Map<string, DealerSession>();

export interface RegisterDealerInput {
	roomId: string;
	guildId: string;
	channelId: string;
	voice: boolean;
	now?: number;
}

/** Make Dero the dealer of a room it just opened, or of a playing room again after a restart. */
export function registerDealerTable({ roomId, guildId, channelId, voice, now = Date.now() }: RegisterDealerInput): void {
	// Drops only a table that has been silent for the whole window: one that ended some other way
	// (a forfeit, a deleted channel). A table still playing announces every action, which keeps it.
	for (const [id, session] of dealerSessions) {
		if (now - session.lastActiveAt > BOT_CONSTANTS.DERO_DEALER_SESSION_MAX_AGE_MS) dealerSessions.delete(id);
	}
	dealerSessions.set(roomId, {
		roomId,
		guildId,
		channelId,
		voice,
		lastActiveAt: now,
		lastTurnUserId: null,
		handNumber: 0,
		textThisHand: 0,
		spokenThisHand: 0,
		chain: Promise.resolve(),
	});
}

/** Whether Dero deals this room, and whether it speaks there. */
export function dealerTableOf(roomId: string): { voice: boolean } | null {
	const session = dealerSessions.get(roomId);
	return session ? { voice: session.voice } : null;
}

/** Test seam: forget every dealer table. */
export function _clearDealerTables(): void {
	dealerSessions.clear();
}

// ── ④ delivery ──

/** The calls delivery makes, injected so tests use fakes. The speech half is the call announcer's. */
export interface DealerDeps extends CallAnnouncerDeps {
	/** `card` rides only the result line, and only when the showdown card drew. */
	postText(client: Client, channelId: string, text: string, card?: RenderPayload): Promise<void>;
}

/**
 * Post one dealer line in a room's text channel with every ping off, with the
 * showdown card attached when one is given. Commentary, so it never goes
 * through roomTrail and never enters the transcript.
 */
export async function postDealerText(client: Client, channelId: string, text: string, card?: RenderPayload): Promise<void> {
	try {
		const channel = await client.channels.fetch(channelId).catch(() => null);
		if (!channel || !channel.isSendable()) return;
		await channel.send({ content: text, allowedMentions: NO_PINGS, ...(card ? { files: [card.attachment] } : {}) });
	}
	catch (error) {
		const code = (error as { code?: unknown } | null)?.code ?? "unknown";
		console.error(`[dero-dealer] text line failed channel=${channelId} code=${String(code)}`);
	}
}

export const defaultDealerDeps: DealerDeps = {
	...defaultCallAnnouncerDeps,
	postText: postDealerText,
};

// One clip per announcement. The call announcer re-checks the call, the kill
// switch and the voice, because a hand outlives any one of them.
async function deliver(
	client: Client,
	session: DealerSession,
	text: DealerLine[],
	spoken: DealerLine[],
	showdown: DealerShowdownView | null,
	deps: DealerDeps
): Promise<void> {
	for (const line of text) {
		const card = line.kind === "result" && showdown ? await showdownCard(showdown) : null;
		// The card is passed only when there is one, so a line without one makes
		// exactly the call it always made.
		if (card) await deps.postText(client, session.channelId, line.text, card);
		else await deps.postText(client, session.channelId, line.text);
	}
	if (session.voice && spoken.length > 0) await speakInCall(session.guildId, spoken.map((line) => line.spoken).join(" "), deps);
}

// The card, or null so the result line posts alone: the line IS this surface's
// fallback, the text the dealer posted before there was a card.
function showdownCard(view: DealerShowdownView): Promise<RenderPayload | null> {
	return withRenderFallback(
		() => renderDealerShowdownCard(view),
		() => null
	);
}

export interface AnnounceInput {
	client: Client;
	roomId: string;
	before: PublicView;
	after: PublicView;
	outcome?: ActionOutcome;
}

/**
 * Narrate one table change, if Dero deals this table. Fire and forget: it never
 * throws and never delays the caller, and a table Dero does not deal costs a map
 * lookup and nothing else.
 */
export function announceDealer({ client, roomId, before, after, outcome }: AnnounceInput, deps: DealerDeps = defaultDealerDeps, now: number = Date.now()): void {
	const session = dealerSessions.get(roomId);
	if (!session) return;
	session.lastActiveAt = now;
	try {
		// A new hand starts every count from zero, the last turn prompt included, so
		// the first player to act is told even if they also closed the last hand.
		if (after.handNumber !== session.handNumber) {
			session.handNumber = after.handNumber;
			session.textThisHand = 0;
			session.spokenThisHand = 0;
			session.lastTurnUserId = null;
		}
		const result = toPublicResult(outcome);
		const lines = narrate(before, after, result, { lastTurnUserId: session.lastTurnUserId });
		const showdown = result && result.winners.length > 0 ? dealerShowdownView(after, result) : null;

		// The counters move NOW, synchronously, so two announcements in quick
		// succession are capped against each other rather than both against zero.
		const text = pickTextLines(lines, session.textThisHand);
		const spoken = session.voice ? pickSpokenLines(lines, session.spokenThisHand, after) : [];
		session.textThisHand += text.length;
		session.spokenThisHand += spoken.length;
		const turnLine = lines.find((line) => line.kind === "toAct");
		if (turnLine) session.lastTurnUserId = after.actingUserId;

		session.chain = session.chain
			.then(() => deliver(client, session, text, spoken, showdown, deps))
			.catch((error) => console.error(`[dero-dealer] narration failed room=${roomId}`, error));

		if (after.status === "finished") dealerSessions.delete(roomId);
	}
	catch (error) {
		console.error(`[dero-dealer] narration skipped room=${roomId}`, error);
	}
}
