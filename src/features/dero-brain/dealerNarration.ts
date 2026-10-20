import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { HAND_CATEGORIES, formatCard, type Card, type HandCategory } from "@features/games/holdemHand.js";
import { handInProgress, whoActs, type ActionOutcome, type HoldemTable, type Street } from "@features/games/holdemTable.js";
import { renderCallSpeech, type CallSpeechInput, type CallSpeechResult } from "@features/voice/callSpeech.js";
import { voiceSessions, type VoiceSessionView } from "@features/voice/voiceSessions.js";
import { deroBrainCopy, type DealerWinner } from "./deroBrainCopy.js";
import { SAFE_MENTIONS } from "./executor.js";

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
//        happened even when one render is slow.
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

export type DealerLineKind = "handStart" | "flop" | "turn" | "river" | "result" | "toAct";

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
const LINE_VALUE: Record<DealerLineKind, number> = { handStart: 3, result: 3, flop: 2, turn: 2, river: 2, toAct: 1 };
const LOWEST_VALUE = 1;

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
		lines.push({
			kind: "toAct",
			text: dealerCopy.toAct(name.text(next.actingUserId)),
			spoken: dealerCopy.toAct(name.spoken(next.actingUserId)),
			cards: [],
		});
	}
	return lines;
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
	registeredAt: number;
	lastTurnUserId: string | null;
	handNumber: number;
	textThisHand: number;
	spokenThisHand: number;
	chain: Promise<void>;
}

/** The tables Dero deals, by room id. Memory only: a restart stops narration. */
const dealerSessions = new Map<string, DealerSession>();

export interface RegisterDealerInput {
	roomId: string;
	guildId: string;
	channelId: string;
	voice: boolean;
	now?: number;
}

/** Make Dero the dealer of a room it just opened. */
export function registerDealerTable({ roomId, guildId, channelId, voice, now = Date.now() }: RegisterDealerInput): void {
	for (const [id, session] of dealerSessions) {
		if (now - session.registeredAt > BOT_CONSTANTS.DERO_DEALER_SESSION_MAX_AGE_MS) dealerSessions.delete(id);
	}
	dealerSessions.set(roomId, {
		roomId,
		guildId,
		channelId,
		voice,
		registeredAt: now,
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

/** The calls delivery makes, injected so tests use fakes. */
export interface DealerDeps {
	sessionIn(guildId: string): VoiceSessionView | null;
	loadConfig(guildId: string): Promise<IDeroVoiceConfig | null>;
	render(input: CallSpeechInput): Promise<CallSpeechResult>;
	postText(client: Client, channelId: string, text: string): Promise<void>;
}

/**
 * Post one dealer line in a room's text channel with every ping off. Commentary,
 * so it never goes through roomTrail and never enters the transcript.
 */
export async function postDealerText(client: Client, channelId: string, text: string): Promise<void> {
	try {
		const channel = await client.channels.fetch(channelId).catch(() => null);
		if (!channel || !channel.isSendable()) return;
		await channel.send({ content: text, allowedMentions: SAFE_MENTIONS });
	}
	catch (error) {
		const code = (error as { code?: unknown } | null)?.code ?? "unknown";
		console.error(`[dero-dealer] text line failed channel=${channelId} code=${String(code)}`);
	}
}

export const defaultDealerDeps: DealerDeps = {
	sessionIn: (guildId) => voiceSessions.get(guildId),
	loadConfig: (guildId) => deroVoiceConfigStore.findByGuildId(guildId),
	render: renderCallSpeech,
	postText: postDealerText,
};

// One clip per announcement, at dealer priority (below Dero's own answers and
// Listen). The call, the kill switch and the voice are all re-checked here,
// because a hand outlives any one of them.
async function speakLines(session: DealerSession, spoken: string[], deps: DealerDeps): Promise<void> {
	const call = deps.sessionIn(session.guildId);
	if (!call) return;
	const config = await deps.loadConfig(session.guildId);
	if (!config?.enabled || !config.voiceId || config.guildId !== session.guildId) return;
	const speech = await deps.render({ guildId: session.guildId, voiceId: config.voiceId, text: spoken.join(" ") });
	if (speech.status !== "ok") return;
	// The call can end during the render; a line for a call that is gone is dropped.
	if (deps.sessionIn(session.guildId) !== call) return;
	call.speaker.speak(speech.pcm48kStereo, "dealer");
}

async function deliver(client: Client, session: DealerSession, text: DealerLine[], spoken: DealerLine[], deps: DealerDeps): Promise<void> {
	for (const line of text) await deps.postText(client, session.channelId, line.text);
	if (session.voice && spoken.length > 0) await speakLines(session, spoken.map((line) => line.spoken), deps);
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
export function announceDealer({ client, roomId, before, after, outcome }: AnnounceInput, deps: DealerDeps = defaultDealerDeps): void {
	const session = dealerSessions.get(roomId);
	if (!session) return;
	try {
		// A new hand starts every count from zero, the last turn prompt included, so
		// the first player to act is told even if they also closed the last hand.
		if (after.handNumber !== session.handNumber) {
			session.handNumber = after.handNumber;
			session.textThisHand = 0;
			session.spokenThisHand = 0;
			session.lastTurnUserId = null;
		}
		const lines = narrate(before, after, toPublicResult(outcome), { lastTurnUserId: session.lastTurnUserId });

		// The counters move NOW, synchronously, so two announcements in quick
		// succession are capped against each other rather than both against zero.
		const text = pickTextLines(lines, session.textThisHand);
		const spoken = session.voice ? pickSpokenLines(lines, session.spokenThisHand, after) : [];
		session.textThisHand += text.length;
		session.spokenThisHand += spoken.length;
		const turnLine = lines.find((line) => line.kind === "toAct");
		if (turnLine) session.lastTurnUserId = after.actingUserId;

		session.chain = session.chain
			.then(() => deliver(client, session, text, spoken, deps))
			.catch((error) => console.error(`[dero-dealer] narration failed room=${roomId}`, error));

		if (after.status === "finished") dealerSessions.delete(roomId);
	}
	catch (error) {
		console.error(`[dero-dealer] narration skipped room=${roomId}`, error);
	}
}
