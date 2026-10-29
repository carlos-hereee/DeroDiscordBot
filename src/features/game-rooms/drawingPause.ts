import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { withRenderFallback, type RenderPayload } from "@features/renderer/index.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── drawingPause ─────────────────────────────────────────────────────
// What:  the one way a timed or per turn game redraws its board with a card: show
//        "Dero is drawing the table", hold the game's clocks, draw the card through
//        withRenderFallback, swap the card (or the text board) in, release the clocks.
// Who:   blackjack's click and seating paths, the battleship and Monopoly redraws,
//        and the Hold'em table redraw (Dero 1.7.0 test fixes, Phase 3a). Their clocks
//        (roomTurnSweep's battleship and Monopoly turn sweeps, the Hold'em clock,
//        blackjack's table lifetime) read isClockExpired and pausedDeadline below.
//        The Monopoly auction close is deliberately NOT held: its bid gates check the
//        nominal close (auctionClosesAt) too, so holding only the closing sweep would
//        give bidders no extra time.
// When:  after a move has been persisted, whoever made it.
// Where: process memory only. A pause lasts as long as one render, so a restart
//        loses nothing worth keeping: every clock falls back to its stored stamp.
//        It knows nothing about any game; a caller names its game with a key.
// How:   ① mark the game as drawing and show the status line; ② wait for an earlier
//        draw of the same game, so boards land in the order the moves happened;
//        ③ draw, then swap in; ④ in a finally, clear the mark and record how long
//        the clock was held, which every sweep adds to that game's deadline.
//
// It never decides who acts or what is legal: a click during a draw is still
// judged by the game's own engine, and the clocks are only held, never reset.

/** A span of time a game's clocks were held. */
interface HeldSpan {
	start: number;
	end: number;
}

interface GameDrawingState {
	// Draws queued or running for this game. The mark is up while this is above 0.
	inFlight: number;
	// When the current held span began, or null while nothing is drawing.
	heldSince: number | null;
	// Finished spans, oldest first, pruned past HELD_SPAN_RETENTION_MS.
	spans: HeldSpan[];
	// The newest queued draw, which the next one waits on.
	tail: Promise<void>;
}

// How long a finished span is kept. The longest clock that reads these spans is a
// Monopoly seat's idle budget, and a span that ended before a clock started is never
// counted toward it, so that budget is the furthest back any deadline can reach.
const HELD_SPAN_RETENTION_MS = BOT_CONSTANTS.GAME_ROOM_MONOPOLY_IDLE_MS;

const games = new Map<string, GameDrawingState>();

/** The drawing key of a game room: unique per guild and room, so two guilds never share a clock hold. */
export const roomDrawingKey = (room: { guildId: string; roomId: string }): string => `room:${room.guildId}:${room.roomId}`;

/** What a redraw hands the pause: how to show the status, how to draw, and how to put the result on the board. */
export interface DrawingPauseRequest<Fallback> {
	/** Names the game whose clocks hold while it draws, such as roomDrawingKey(room). */
	gameKey: string;
	/** Edits the board to the status line. A failure costs the status line only, never the draw. */
	showStatus: (statusLine: string) => Promise<unknown>;
	/** The card, through renderCard. A null or a throw posts the fallback instead. */
	render: () => Promise<RenderPayload | null>;
	/** The text board, built only when it is what gets posted. */
	fallback: () => Fallback;
	/** Puts the drawn card, or the fallback, on the board in place of the status. */
	swapIn: (drawn: RenderPayload | Fallback) => Promise<unknown>;
}

/**
 * Redraw a board behind the drawing pause. Resolves once the card (or its text
 * fallback) is on the board; a swapIn that throws rejects, but only after the
 * game's clocks have been released, so no failure can leave a clock held.
 */
export async function withDrawingPause<Fallback>(request: DrawingPauseRequest<Fallback>): Promise<void> {
	const state = holdClock(request.gameKey);
	const earlier = state.tail;
	let finish = (): void => undefined;
	const mine = new Promise<void>((resolve) => {
		finish = resolve;
	});
	state.tail = earlier.then(() => mine);

	try {
		await showStatus(request);
		// The status goes up first, so the table hears at once that Dero is drawing,
		// and the draw itself waits its turn: an earlier draw still running would
		// otherwise land on top of this one and leave the older board showing.
		await earlier;
		const drawn = await withRenderFallback(request.render, request.fallback);
		await request.swapIn(drawn);
	} finally {
		finish();
		releaseClock(request.gameKey);
	}
}

/** True while a draw for this game is queued or running. */
export function isDrawing(gameKey: string): boolean {
	return (games.get(gameKey)?.inFlight ?? 0) > 0;
}

/** Resolves once every draw queued for this game so far has finished. */
export function drawingSettled(gameKey: string): Promise<void> {
	return games.get(gameKey)?.tail ?? Promise.resolve();
}

/**
 * How long this game's clocks were held between `since` and `now`, the running
 * span included. A span that straddles `since` counts only its part after it.
 */
export function heldMsSince(gameKey: string, since: number, now: number = Date.now()): number {
	const state = games.get(gameKey);
	if (!state) return 0;
	const overlap = (start: number, end: number): number => Math.max(0, Math.min(end, now) - Math.max(start, since));
	const finished = state.spans.reduce((total, span) => total + overlap(span.start, span.end), 0);
	const running = state.heldSince === null ? 0 : overlap(state.heldSince, now);
	return finished + running;
}

/** When a clock that started at `startedAt` with `budgetMs` runs out, every held millisecond added on. */
export function pausedDeadline(gameKey: string, startedAt: number, budgetMs: number, now: number = Date.now()): number {
	return startedAt + budgetMs + heldMsSince(gameKey, startedAt, now);
}

/** True once that clock has run out, and never while the game is drawing. */
export function isClockExpired(gameKey: string, startedAt: number, budgetMs: number, now: number = Date.now()): boolean {
	if (isDrawing(gameKey)) return false;
	return now >= pausedDeadline(gameKey, startedAt, budgetMs, now);
}

/** Forget every hold, so a test starts from a clean slate. */
export function _resetDrawingPauses(): void {
	games.clear();
}

// ── the hold ──────────────────────────────────────────────────────────

// The status line is a courtesy, so its failure (a deleted board, a 429) is logged
// and the draw goes on: the swap that follows is what the players actually need.
async function showStatus<Fallback>(request: DrawingPauseRequest<Fallback>): Promise<void> {
	try {
		await request.showStatus(gameRoomsCopy.drawing.status);
	} catch (error) {
		console.warn(`[game-rooms] the drawing status for ${request.gameKey} did not post`, error);
	}
}

function holdClock(gameKey: string): GameDrawingState {
	const state = games.get(gameKey) ?? { inFlight: 0, heldSince: null, spans: [], tail: Promise.resolve() };
	games.set(gameKey, state);
	state.inFlight += 1;
	state.heldSince ??= Date.now();
	return state;
}

// Back to back draws of one game are one held span, closed when the last of them
// finishes, so a span is never counted twice by heldMsSince.
function releaseClock(gameKey: string): void {
	const state = games.get(gameKey);
	if (!state) return;
	state.inFlight = Math.max(0, state.inFlight - 1);
	if (state.inFlight > 0) return;
	const now = Date.now();
	if (state.heldSince !== null) state.spans.push({ start: state.heldSince, end: now });
	state.heldSince = null;
	pruneHeldSpans(now);
}

// Every game is pruned on every release rather than only the one released, so a
// game that ended and never draws again does not keep its spans for good.
function pruneHeldSpans(now: number): void {
	for (const [key, state] of games) {
		state.spans = state.spans.filter((span) => now - span.end <= HELD_SPAN_RETENTION_MS);
		if (state.inFlight === 0 && state.spans.length === 0) games.delete(key);
	}
}
