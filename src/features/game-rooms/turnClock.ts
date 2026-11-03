import type { Client } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isBotSeatId } from "./botSeat.js";
import { postTurnWarning } from "./turnPrompt.js";
import { announceToMatch, isDeroInMatchCall, spokenNameOf, warningSeconds } from "./roomAnnouncer.js";
import type { GameSlug } from "./roomTypes.js";
import { pickLine } from "@utils/pickLine.js";

// ── turnClock ────────────────────────────────────────────────────────
// What:  the one per turn timer every timed game arms from its own deadline (2026-10 item 267,
//        owner decision 15): a warning TURN_WARNING_LEAD_MS before the turn ends, one room line
//        pinging only the member on the clock and spoken by Dero when he is in the match's call,
//        and a check at the deadline that ends the turn through the game's own timeout function,
//        whose existing line is the "your turn is over" line (spoken too).
// Who:   each game hands in its TurnClockGame where it starts a turn (Hold'em's and Battleship's
//        redraw, Monopoly's board placement and its first seat, a Blackjack table's promptTurn),
//        and roomBootRecovery rebuilds every clock. A finished room needs no disarm: each game's
//        last redraw finds nobody on the clock, and any firing after the finish re-reads the row
//        and drops (telling a Blackjack table, which lives in this process, to stop).
// Does NOT: decide a deadline, end a turn itself or post the turn over line. A game answers both
//        through its TurnClockGame: `current` reads the deadline from the game's own clock (the
//        same stamp its sweep reads, every drawing hold added) and `expire` IS the function the
//        game's sweep calls, so there is never a second way to end a turn. The sweeps stay as the
//        backstop, and each timeout function is a compare and swap, so the clock and a sweep
//        landing together end a turn once.
// Where: memory only, like the drawing pause it reads through. A restart empties it and
//        roomBootRecovery arms every playing room again from the row (risk R7).
//
// ⚠️ EVERY FIRING RE-READS THE ROW (risk R6). A timer only knows the turn it was armed for, so
// the warning and the deadline both read the room again and act only while it is still playing
// and the SAME turn (fingerprint and member) is on the clock. A turn that passed in between,
// played, timed out by a sweep or the room finished, is dropped without a word, so a passed turn
// is never warned and never ended twice.
// ⚠️ A DEADLINE CAN MOVE LATER, NEVER EARLIER: a board draw holds a clock (drawingPause) and a
// Monopoly seat that acts inside its turn restarts its idle budget. A firing that finds the same
// turn with a later deadline re-arms for it rather than acting early.
// ⚠️ THE WARNING FIRES ONCE PER TURN. A turn re-armed with a moved deadline keeps its warned
// flag, and a warning whose moment already passed when the clock was armed (a rebuild after a
// restart inside the last seconds, which may have warned before it went down) is skipped.

/** Which of a game's clocks a timer belongs to: Monopoly runs its idle clock and an auction's at once. */
export type TurnClockKind = "holdem" | "blackjack" | "battleship" | "monopoly-idle" | "monopoly-auction";

/** The turn a game has on one of its clocks, read from the room as it stands. */
export interface ClockedTurn {
	/** The member on the clock; a Dero bot seat is never armed, its tick plays it. */
	memberId: string;
	/** The same for the whole turn and different for the next one (the turn prompt's, where the game has one). */
	fingerprint: string;
	/** When the turn runs out, epoch milliseconds, every drawing hold added. */
	deadline: number;
}

/** What a game hands the clock: how to read its turn, and its own timeout function. */
export interface TurnClockGame {
	readonly kind: TurnClockKind;
	/** The turn on this clock in `room`, or null when nobody is on it. */
	current(room: IGameRoom, now: number): ClockedTurn | null;
	/** The game's sweep's own timeout function for this clock. True when it ended the turn. */
	expire(client: Client, room: IGameRoom, now: Date): Promise<boolean>;
	/**
	 * A firing found the room no longer playing: it ended another way (the idle sweep, a deleted
	 * channel). For a game whose table lives in this process (Blackjack) and must stop playing in
	 * a closed room; a game whose state lives on the row needs nothing.
	 */
	roomEnded?(room: IGameRoom): void;
}

/** A game's clocks, by the room's game; turnClocks.ts is the table, roomBootRecovery its reader. */
export type TurnClockLookup = (game: GameSlug) => readonly TurnClockGame[];

type RoomKey = Pick<IGameRoom, "guildId" | "roomId">;

interface ArmedClock {
	client: Client;
	game: TurnClockGame;
	guildId: string;
	roomId: string;
	memberId: string;
	fingerprint: string;
	deadline: number;
	warned: boolean;
	retries: number;
	warningTimer: NodeJS.Timeout | null;
	deadlineTimer: NodeJS.Timeout | null;
}

const clocks = new Map<string, ArmedClock>();

const keyOf = (guildId: string, roomId: string, kind: TurnClockKind): string => `${guildId}:${roomId}:${kind}`;
const keyOfClock = (clock: ArmedClock): string => keyOf(clock.guildId, clock.roomId, clock.game.kind);
// A timer acts only while its clock is still the one armed for its room and kind: a re-arm for
// the next turn replaces the entry, and the old timer's firing then finds a stranger and stops.
const isArmed = (clock: ArmedClock): boolean => clocks.get(keyOfClock(clock)) === clock;
const isSameTurn = (clock: Pick<ArmedClock, "memberId" | "fingerprint">, turn: ClockedTurn): boolean =>
	turn.fingerprint === clock.fingerprint && turn.memberId === clock.memberId;

// ── arming ────────────────────────────────────────────────────────────
/**
 * Arm the clock for one turn. Idempotent: the same turn with the same deadline changes nothing,
 * the same turn with a moved deadline is rescheduled and keeps its warned flag, and a new turn
 * replaces whatever this room's clock of that kind held.
 */
export function armTurnClock(client: Client, room: RoomKey, game: TurnClockGame, turn: ClockedTurn, now: number = Date.now()): void {
	const key = keyOf(room.guildId, room.roomId, game.kind);
	const armed = clocks.get(key);
	if (armed && isSameTurn(armed, turn)) {
		if (armed.deadline === turn.deadline) return;
		armed.deadline = turn.deadline;
		armed.retries = 0;
		schedule(armed, now);
		return;
	}
	if (armed) clearTimers(armed);
	const clock: ArmedClock = {
		client,
		game,
		guildId: room.guildId,
		roomId: room.roomId,
		memberId: turn.memberId,
		fingerprint: turn.fingerprint,
		deadline: turn.deadline,
		warned: false,
		retries: 0,
		warningTimer: null,
		deadlineTimer: null,
	};
	clocks.set(key, clock);
	schedule(clock, now);
}

/** Stop one clock of a room. */
export function disarmTurnClock(room: RoomKey, kind: TurnClockKind): void {
	const key = keyOf(room.guildId, room.roomId, kind);
	const armed = clocks.get(key);
	if (!armed) return;
	clearTimers(armed);
	clocks.delete(key);
}

/**
 * Put a room's clocks where its turns are, after the game started or changed a turn: re-read the
 * row, arm each clock whose turn has a member on it and disarm the rest. Called beside
 * syncTurnPrompt (a network table too, which gets no prompt but still runs out of time). Fire and
 * forget after the move that called it: never throws.
 */
export async function syncTurnClocks(client: Client, room: RoomKey, games: readonly TurnClockGame[]): Promise<void> {
	try {
		const fresh = await gameRoomStore.findByRoomId(room.guildId, room.roomId);
		const now = Date.now();
		for (const game of games) {
			const turn = fresh && fresh.status === "playing" ? game.current(fresh, now) : null;
			if (turn && !isBotSeatId(turn.memberId)) armTurnClock(client, room, game, turn, now);
			else disarmTurnClock(room, game.kind);
		}
	} catch (error) {
		console.warn("[game-rooms] the turn clocks could not be synced", { roomId: room.roomId, error });
	}
}

/**
 * A restart's half (risk R7): arm a playing room's clocks again from the row as stored, which
 * roomBootRecovery just read. A deadline already past is left to the game's sweep, which ends it
 * on its next tick, and a warning whose moment passed is skipped (see the header). Answers how
 * many clocks were armed.
 */
export function rebuildTurnClocks(client: Client, room: IGameRoom, games: readonly TurnClockGame[], now: number = Date.now()): number {
	if (room.status !== "playing") return 0;
	let rebuilt = 0;
	for (const game of games) {
		const turn = game.current(room, now);
		if (!turn || isBotSeatId(turn.memberId) || turn.deadline <= now) continue;
		armTurnClock(client, room, game, turn, now);
		rebuilt++;
	}
	return rebuilt;
}

// ── the timers ────────────────────────────────────────────────────────
// A 72 hour Monopoly idle turn is the longest; setTimeout holds up to about 24.8 days.
function schedule(clock: ArmedClock, now: number): void {
	clearTimers(clock);
	const warnAt = clock.deadline - BOT_CONSTANTS.TURN_WARNING_LEAD_MS;
	if (!clock.warned && warnAt > now) clock.warningTimer = setTimeout(() => void fireWarning(clock), warnAt - now);
	clock.deadlineTimer = setTimeout(() => void fireDeadline(clock), Math.max(0, clock.deadline - now));
}

function clearTimers(clock: ArmedClock): void {
	if (clock.warningTimer) clearTimeout(clock.warningTimer);
	if (clock.deadlineTimer) clearTimeout(clock.deadlineTimer);
	clock.warningTimer = null;
	clock.deadlineTimer = null;
}

function drop(clock: ArmedClock): void {
	if (!isArmed(clock)) return;
	clearTimers(clock);
	clocks.delete(keyOfClock(clock));
}

// The row again, and the turn on it, when this clock's turn is still the one on the clock; null
// (and the clock dropped) when it passed. The armed check runs again after the read, because a
// redraw can arm the next turn while the read is in flight.
async function stillOnTheClock(clock: ArmedClock): Promise<{ room: IGameRoom; turn: ClockedTurn } | null> {
	if (!isArmed(clock)) return null;
	const room = await gameRoomStore.findByRoomId(clock.guildId, clock.roomId);
	if (!isArmed(clock)) return null;
	if (room && room.status !== "playing") clock.game.roomEnded?.(room);
	const turn = room && room.status === "playing" ? clock.game.current(room, Date.now()) : null;
	if (!room || !turn || !isSameTurn(clock, turn)) {
		drop(clock);
		return null;
	}
	return { room, turn };
}

// The deadline moved later (a draw held the clock, or a seat acted inside its turn): arm for it.
function followMovedDeadline(clock: ArmedClock, turn: ClockedTurn, now: number): void {
	clock.deadline = turn.deadline;
	clock.retries = 0;
	schedule(clock, now);
}

async function fireWarning(clock: ArmedClock): Promise<void> {
	clock.warningTimer = null;
	try {
		const found = await stillOnTheClock(clock);
		if (!found) return;
		const now = Date.now();
		if (found.turn.deadline - BOT_CONSTANTS.TURN_WARNING_LEAD_MS > now) {
			followMovedDeadline(clock, found.turn, now);
			return;
		}
		// Claimed synchronously after the read, so a second firing for this turn (a re-arm that
		// raced this one) finds it warned.
		if (clock.warned) return;
		clock.warned = true;
		await warnMember(clock.client, found.room, clock.memberId);
	} catch (error) {
		console.warn("[game-rooms] the turn warning failed", { roomId: clock.roomId, kind: clock.game.kind, error });
	}
}

async function fireDeadline(clock: ArmedClock): Promise<void> {
	clock.deadlineTimer = null;
	try {
		const found = await stillOnTheClock(clock);
		if (!found) return;
		const now = Date.now();
		if (found.turn.deadline > now) {
			followMovedDeadline(clock, found.turn, now);
			return;
		}
		const ended = await clock.game.expire(clock.client, found.room, new Date(now));
		if (ended) {
			// The game's redraw has usually armed the next turn under this key already; only this
			// turn's own entry is dropped.
			drop(clock);
			await sayTurnOver(clock.client, found.room, clock.memberId);
			return;
		}
		retryOrLeaveToSweep(clock);
	} catch (error) {
		console.warn("[game-rooms] the turn clock could not end a turn", { roomId: clock.roomId, kind: clock.game.kind, error });
		retryOrLeaveToSweep(clock);
	}
}

// The timeout function ended nothing although the same turn is due: its compare and swap lost to
// a move landing this instant (the next firing then finds a new turn) or the board still draws.
// A few short looks, then the game's sweep is the backstop it always was.
function retryOrLeaveToSweep(clock: ArmedClock): void {
	if (!isArmed(clock)) return;
	clock.retries += 1;
	if (clock.retries > BOT_CONSTANTS.TURN_CLOCK_RETRIES) {
		drop(clock);
		return;
	}
	clock.deadlineTimer = setTimeout(() => void fireDeadline(clock), BOT_CONSTANTS.TURN_CLOCK_RETRY_MS);
}

// ── what the members hear ─────────────────────────────────────────────
// A network table's members sit in other servers, where a ping from this room's channel and a
// voice in this server's call reach nobody, so it is neither warned nor spoken to; its turns
// still end on time.
const isNetworkRoom = (room: IGameRoom): boolean => Boolean(room.network || room.satellites?.length);

// One line through the turn prompt's own sender: it pings the member on the clock alone (the
// mention allowlist names that one id) and writes nothing to the transcript, so the warning is no
// move and moves no game's last activity stamp, which would push its own deadline back.
async function warnMember(client: Client, room: IGameRoom, memberId: string): Promise<void> {
	if (isNetworkRoom(room)) return;
	const seconds = warningSeconds();
	await postTurnWarning(client, room, memberId, pickLine(gameRoomsCopy.turnClock.warningLine)(memberId, seconds));
	if (!isDeroInMatchCall(client, room)) return;
	await announceToMatch(client, room, "turnWarning", pickLine(deroBrainCopy.dealer.turnWarning)(await spokenNameOf(client, room.guildId, memberId), seconds));
}

async function sayTurnOver(client: Client, room: IGameRoom, memberId: string): Promise<void> {
	if (isNetworkRoom(room) || !isDeroInMatchCall(client, room)) return;
	await announceToMatch(client, room, "turnOver", pickLine(deroBrainCopy.dealer.turnOver)(await spokenNameOf(client, room.guildId, memberId)));
}

// ── test seams ────────────────────────────────────────────────────────
/** Forget every clock and its timers. */
export function _resetTurnClocks(): void {
	for (const clock of clocks.values()) clearTimers(clock);
	clocks.clear();
}

/** The armed clocks, for a test to inspect. */
export function _armedTurnClocks(): Array<{ roomId: string; kind: TurnClockKind; memberId: string; fingerprint: string; deadline: number; warned: boolean }> {
	return [...clocks.values()].map((clock) => ({ roomId: clock.roomId, kind: clock.game.kind, memberId: clock.memberId, fingerprint: clock.fingerprint, deadline: clock.deadline, warned: clock.warned }));
}
