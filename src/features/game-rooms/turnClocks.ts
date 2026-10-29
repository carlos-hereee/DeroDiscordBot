import type { GameSlug } from "./roomTypes.js";
import type { TurnClockGame, TurnClockLookup } from "./turnClock.js";
import { holdemTurnClock } from "./roomHoldemHandlers.js";
import { MONOPOLY_TURN_CLOCKS } from "./roomMonopolyHandlers.js";
import { battleshipTurnClock } from "./roomBattleshipHandlers.js";

// ── turnClocks ───────────────────────────────────────────────────────
// What:  which game's turn clocks a restart rebuilds (2026-10 item 267, decision 15, risk R7), in
//        one table, so turnClock itself imports no game: Hold'em, Battleship, and Monopoly's idle
//        seat and auction round.
// Who:   roomBootRecovery. A game that arms its own clock after a redraw passes it to
//        syncTurnClocks directly.
// Does NOT: hold any clock logic; every clock lives beside the game's own timeout function.
//
// No Blackjack: a restart loses the table itself (it lives in blackjackHandler's process Map), and
// boot recovery closes its room, so there is never a Blackjack turn to rebuild.

const CLOCKS: Partial<Record<GameSlug, readonly TurnClockGame[]>> = {
	holdem: [holdemTurnClock],
	battleship: [battleshipTurnClock],
	monopoly: MONOPOLY_TURN_CLOCKS,
};

/** The clocks a restart rebuilds for a game, or none. */
export const turnClocksFor: TurnClockLookup = (game) => CLOCKS[game] ?? [];
