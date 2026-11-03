import type { GameSlug } from "./roomTypes.js";
import type { TurnAdapter, TurnAdapterLookup } from "./turnPrompt.js";
import { holdemTurnAdapter } from "./roomHoldemHandlers.js";
import { monopolyTurnAdapter } from "./roomMonopolyHandlers.js";
import { battleshipTurnAdapter } from "./roomBattleshipHandlers.js";
import { blackjackTurnAdapter } from "@features/games/blackjackHandler.js";
import { soloRpsTurnAdapter } from "./soloLuckRoom.js";

// ── turnAdapters ─────────────────────────────────────────────────────
// What:  which game answers to which turn adapter (2026-10 item 257 Phase 4a), in one table the
//        router reads, so turnPrompt itself imports no game.
// Who:   gameRoomHandlers, for the Take your turn press and the modal's Submit. A game that
//        syncs its own prompt after a redraw passes its adapter to syncTurnPrompt directly.
// Does NOT: hold any game logic; every adapter lives beside the game it adapts.

const ADAPTERS: Partial<Record<GameSlug, TurnAdapter>> = {
	holdem: holdemTurnAdapter,
	monopoly: monopolyTurnAdapter,
	battleship: battleshipTurnAdapter,
	// Both blackjack room tables: blackjackHandler.promptTurn syncs a turn line for any table in a
	// room, the one seat solo-blackjack table too, and the adapter reads the table by the room's
	// channel, so one seat is just a table whose turn never moves (2026-10 item 263 R3-23).
	blackjack: blackjackTurnAdapter,
	"solo-blackjack": blackjackTurnAdapter,
	// Rock paper scissors against Dero asks for its throw in its room (2026-10 item 257 Phase 4b).
	"solo-rps": soloRpsTurnAdapter,
};

/** The adapter of a game that prompts its turns, or undefined for one that does not. */
export const turnAdapterFor: TurnAdapterLookup = (game) => ADAPTERS[game];
