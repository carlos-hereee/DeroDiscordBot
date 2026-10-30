import type { Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { mapWithConcurrency } from "@utils/mapWithConcurrency.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { expireBattleshipTurnIfDue } from "./roomBattleshipHandlers.js";
import { forfeitIdleMonopolySeatIfDue, forfeitRemovedMonopolySeats } from "./roomMonopolyHandlers.js";
import { monopolyStateOf } from "./roomMonopolyBoard.js";
import { lastActivityAt } from "./roomActivity.js";
import { isBlackjackRoomGame } from "./roomTypes.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { HoldemTable } from "@features/games/holdemTable.js";

// ── roomTurnSweep ────────────────────────────────────────────────────
// What:  forfeits a battleship turn nobody took, and the MATCH after two in a row;
//        forfeits a Monopoly seat that sat on the clock past its idle budget; and finishes any
//        room, draft or match, that saw no action for GAME_ROOM_IDLE_ABANDON_MS.
// Who:   the 5 minute room cron, beside the archive sweep.
// When:  every tick, over every live battleship and Monopoly match in every guild.
// Where: ⚠️ THIS IS THE THING THAT MAKES AN ABANDONED MATCH TERMINATE AT ALL, and
//        without it the failure is not "a slow game" but a permanent one: a player
//        who closes Discord leaves their opponent unable to fire, the room never
//        reaches `finish`, `archiveAt` is therefore never stamped (it has exactly
//        one writer), the archive sweep never sees the room, and it holds its
//        host's one-room slot forever. The quick games resolve in a single press or
//        when their word is guessed; the long ones can be abandoned MID-match,
//        which is why each sweep is game-scoped. (Hold em's 3 minute clock is too
//        fast for this 5 minute tick and runs on its own interval in main.ts.)
//        Since 2026-10 item 267 the turn clock (turnClock.ts) ends a Battleship turn and a
//        Monopoly idle seat at their deadlines through the very functions these sweeps call
//        (expireBattleshipTurnIfDue, forfeitIdleMonopolySeatIfDue), so the two sweeps here
//        are its backstop: a clock a restart could not rebuild is still ended on a tick.
// How:   each game's timeout function compares the last activity against the game's
//        budget, plus any time the board spent drawing (drawingPause), and passes the
//        turn or ends the match through a compare and swap, so a sweep and a clock that
//        land together end a turn once.

export interface TurnSweepSummary {
	turnsExpired: number;
	matchesForfeited: number;
	// Matches whose setup clock ran out and sailed as laid (post-launch plan item 17).
	setupsTimedOut: number;
}

/**
 * Forfeit every battleship turn nobody took within GAME_ROOM_TURN_TIMEOUT_MS, and start every
 * battle whose setup clock ran out. The backstop of the turn clock (2026-10 item 267), which ends
 * a turn at its deadline through the same expireBattleshipTurnIfDue below.
 */
export async function sweepBattleshipTurns(client: Client, now: Date = new Date()): Promise<TurnSweepSummary> {
	const rooms = await gameRoomStore.findPlayingByGame("battleship");
	if (rooms.length === 0) return { turnsExpired: 0, matchesForfeited: 0, setupsTimedOut: 0 };

	let turnsExpired = 0;
	let matchesForfeited = 0;
	let setupsTimedOut = 0;

	await mapWithConcurrency(rooms, BOT_CONSTANTS.SCHEDULER_GUILD_CONCURRENCY, async (room) => {
		try {
			const ended = await expireBattleshipTurnIfDue(client, room, now);
			if (ended === "expired") turnsExpired++;
			if (ended === "forfeited") matchesForfeited++;
			if (ended === "setupTimedOut") setupsTimedOut++;
		} catch (error) {
			// Isolated per ROOM. This runs on a cron with nobody watching, so a throw
			// would be swallowed by the tick wrapper while every other stalled match
			// stayed stalled.
			console.error("[game-rooms] turn sweep failed for one room", {
				guildId: room.guildId,
				roomId: room.roomId,
				error,
			});
		}
	});

	if (turnsExpired > 0 || matchesForfeited > 0) {
		console.log(`[game-rooms] turn sweep: ${turnsExpired} turn(s) expired, ${matchesForfeited} match(es) forfeited`);
	}
	return { turnsExpired, matchesForfeited, setupsTimedOut };
}

// ── monopoly ──────────────────────────────────────────────────────────
export interface MonopolyIdleSummary {
	seatsForfeited: number;
	matchesFinished: number;
}

/**
 * Forfeit the seat on the clock in every Monopoly match that has seen no move for
 * GAME_ROOM_MONOPOLY_IDLE_MS, and finish the match when that leaves one seat.
 * One seat per match per tick: the next seat gets a fresh budget from the passTurn
 * inside applyForfeit, so a match is never emptied in a single sweep. The backstop of the
 * turn clock (2026-10 item 267), which forfeits at the deadline through the same
 * forfeitIdleMonopolySeatIfDue.
 *
 * First, a seat the host removed that a busy board kept (2026-10 item 276, audit P3) is taken out:
 * the removal already took the member out of the room, so nobody can play that seat, and without
 * this it held the match up until its idle budget ran out. A tick that takes one out stops there,
 * since the room it read is now a move old.
 */
export async function sweepMonopolyIdle(client: Client, now: Date = new Date()): Promise<MonopolyIdleSummary> {
	const rooms = await gameRoomStore.findPlayingByGame("monopoly");
	if (rooms.length === 0) return { seatsForfeited: 0, matchesFinished: 0 };

	let seatsForfeited = 0;
	let matchesFinished = 0;

	await mapWithConcurrency(rooms, BOT_CONSTANTS.SCHEDULER_GUILD_CONCURRENCY, async (room) => {
		try {
			const removed = await forfeitRemovedMonopolySeats(client, room);
			seatsForfeited += removed;
			if (removed > 0) return;
			const written = await forfeitIdleMonopolySeatIfDue(client, room, now);
			if (!written) return;
			seatsForfeited++;
			if (written.phase === "finished") matchesFinished++;
		} catch (error) {
			// Isolated per ROOM, for the same reason as the battleship sweep above.
			console.error("[game-rooms] monopoly idle sweep failed for one room", {
				guildId: room.guildId,
				roomId: room.roomId,
				error,
			});
		}
	});

	if (seatsForfeited > 0) {
		console.log(`[game-rooms] monopoly idle sweep: ${seatsForfeited} seat(s) forfeited, ${matchesFinished} match(es) finished`);
	}
	return { seatsForfeited, matchesFinished };
}

// ── every room: the idle sweep ────────────────────────────────────────
export interface IdleRoomSummary {
	roomsAbandoned: number;
}

// When a room last saw an action, from what each game already stamps.
//   ① Hold em: the table's lastActionAt, the version stamp every engine mutation moves
//      (a deal, an action, a clock fold, a leave). A buy in moves no stamp but posts a
//      trail line, so the later of the two counts.
//   ② A playing Blackjack table: blackjackActedAt, the last bet, action or leave a MEMBER
//      chose (2026-10 item 267). Its turn clock plays a silent seat's turn for it and every
//      such move writes the row, so updatedAt would keep a table nobody touches alive forever.
//   ③ Every other game, and every draft: the row's updatedAt. Each action writes the
//      row (a trail line, an aim or an rps pick in the secret, a change to the draft),
//      and the schema's timestamps stamp every write, so it is the latest of them all.
//      createdAt covers a row that was never written again.
function lastRoomActionAt(room: IGameRoom): number {
	const table = room.game === "holdem" ? (room.secret as HoldemTable | null) : null;
	if (table?.lastActionAt) return Math.max(table.lastActionAt, lastActivityAt(room));
	if (isBlackjackRoomGame(room.game) && room.status === "playing" && room.blackjackActedAt) return new Date(room.blackjackActedAt).getTime();
	const stamp = room.updatedAt ?? room.createdAt;
	return stamp ? new Date(stamp).getTime() : 0;
}

// A Monopoly room the idle seat forfeit looks after: a match in play with its board. A playing row
// with no board is a match whose seeding failed after the start claim (2026-10 item 276, audit
// P1-5), which sweepMonopolyIdle cannot read, so the idle sweep below finishes it like any room.
// A Monopoly DRAFT has no seat to forfeit either, so it is swept like every other draft (2026-10
// item 276 Phase 7), or an abandoned card would hold its host's one room slot until Call it off.
function isMonopolyMatchWithBoard(room: IGameRoom): boolean {
	return room.game === "monopoly" && room.status === "playing" && monopolyStateOf(room) !== null;
}

// A hosted or solo hangman room past its draft, whether or not its word is set yet.
// See the exemption note on sweepIdleRooms below.
function isHangmanRoundInPlay(room: IGameRoom): boolean {
	return room.status === "playing" && (room.game === "hangman" || room.game === "solo-hangman");
}

/**
 * Finish as abandoned every room in a non terminal status whose last action is
 * older than GAME_ROOM_IDLE_ABANDON_MS. roomLifecycle.finish is the claim, so a room
 * another path finished in the same tick is skipped, and `abandoned` pays nobody,
 * which is also why an abandoned room is never rated.
 *
 * ⚠️ A MONOPOLY MATCH IS EXEMPT. Its opener tells players a seat has GAME_ROOM_MONOPOLY_IDLE_MS on
 * the clock, and sweepMonopolyIdle above already forfeits one idle seat per budget until one is
 * left, so a Monopoly match cannot strand its host's slot either. A Monopoly draft, and a playing
 * row with no board (isMonopolyMatchWithBoard), have no seat to forfeit and are swept here.
 *
 * ⚠️ A HANGMAN ROUND IN PLAY IS EXEMPT TOO, hosted or solo, by the owner's decision of
 * 2026-10-23: hangman is a relaxed game, not a race, so it has no clock. Its host
 * still frees the slot with Give up, and a hangman DRAFT is still swept, because an
 * unanswered challenge is not a round anybody is playing.
 */
export async function sweepIdleRooms(client: Client, now: Date = new Date()): Promise<IdleRoomSummary> {
	const rooms = await gameRoomStore.findNonTerminal();
	let roomsAbandoned = 0;

	await mapWithConcurrency(rooms, BOT_CONSTANTS.SCHEDULER_GUILD_CONCURRENCY, async (room) => {
		try {
			if (isMonopolyMatchWithBoard(room)) return;
			if (isHangmanRoundInPlay(room)) return;
			if (now.getTime() - lastRoomActionAt(room) < BOT_CONSTANTS.GAME_ROOM_IDLE_ABANDON_MS) return;
			const ended = await roomLifecycle.finish(client, room, { abandoned: true, now });
			if (ended) roomsAbandoned++;
		} catch (error) {
			// Isolated per ROOM, for the same reason as the battleship sweep above.
			console.error("[game-rooms] idle sweep failed for one room", {
				guildId: room.guildId,
				roomId: room.roomId,
				error,
			});
		}
	});

	if (roomsAbandoned > 0) console.log(`[game-rooms] idle sweep: ${roomsAbandoned} room(s) finished as abandoned`);
	return { roomsAbandoned };
}
