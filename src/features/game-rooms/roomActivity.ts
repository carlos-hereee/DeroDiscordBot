import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomActivity ─────────────────────────────────────────────────────
// What:  when a match last saw activity, the stamp Battleship's turn clock and Monopoly's idle
//        clock count from.
// Who:   roomTurnSweep (the sweeps and the idle sweep) and the turn clocks beside the Battleship
//        and Monopoly handlers (2026-10 item 267), so the sweep and the clock read one stamp.
// Does NOT: import anything that runs, so both sides can read it without importing each other.

/**
 * When this match last saw activity. The move trail is the record of that: every shot appends
 * one entry, so its last timestamp is the last time somebody played. A match with NO moves falls
 * back to `startedAt`, which is what gives the first player a full turn budget rather than an
 * instant expiry on the next tick.
 */
export function lastActivityAt(room: Pick<IGameRoom, "moves" | "startedAt">): number {
	const moves = room.moves ?? [];
	const last = moves.length > 0 ? moves[moves.length - 1]?.at : null;
	const stamp = last ?? room.startedAt;
	return stamp ? new Date(stamp).getTime() : 0;
}
