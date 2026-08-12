import { type ChatInputCommandInteraction } from "discord.js";
import { startChallengeDraft } from "@features/game-rooms/challengeBoard.js";

// ── challengeEntry ─────────────────────────────────────────────────────────
// What:  the slash-command doorway into the challenge board, for the three head to
//        head games.
// Who:   MINI_GAME_HANDLERS in src/commands/fun/mini-game.ts.
// When:  on /mini-game coin-flip, dice-roll or rps.
// Where: the SAME function the board's own buttons call, deliberately. Two ways to
//        start a match that did not share a code path would be two places to
//        enforce the one-room-per-host rule, two places to check entitlement, and
//        two definitions of what an opponent is.
// How:   read the slug from which subcommand ran, then hand over. There is nothing
//        else here on purpose.
//
// ⚠️ THIS REPLACED versusHandler.ts AND rpsHandler.ts (game rooms Phase 4). Those
// files ran the whole match inside one slash invocation: a public challenge message,
// an inline component collector, and for rps a module-scoped Map of open rounds.
// Every part of that died on a Railway deploy, which happens several times a week,
// and the collector's 60 second window meant a match was never allowed to be slow.
// The room row survives both. The pure halves they were built around, versusResolve
// and rpsWinner, are unchanged and are now called from
// @features/game-rooms/roomGames.ts.

export const runCoinFlip = (interaction: ChatInputCommandInteraction): Promise<void> =>
	startChallengeDraft(interaction, "coinflip");

export const runDiceRoll = (interaction: ChatInputCommandInteraction): Promise<void> =>
	startChallengeDraft(interaction, "diceroll");

export const runRps = (interaction: ChatInputCommandInteraction): Promise<void> =>
	startChallengeDraft(interaction, "rps");
