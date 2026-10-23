import { type ChatInputCommandInteraction } from "discord.js";
import { startChallengeDraft } from "@features/game-rooms/challengeBoard.js";

// ── challengeEntry ─────────────────────────────────────────────────────────
// What:  the slash-command doorway into the challenge board, for the three head to
//        head games and Monopoly.
// Who:   MINI_GAME_HANDLERS in src/commands/fun/mini-game.ts.
// When:  on /mini-game coin-flip, dice-roll, rps or monopoly.
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

// startChallengeDraft returns the draft row for the rematch path's benefit; the slash
// doorway has no use for it, so each wrapper discards it back to void.
export const runCoinFlip = async (interaction: ChatInputCommandInteraction): Promise<void> => {
	await startChallengeDraft(interaction, "coinflip");
};

export const runDiceRoll = async (interaction: ChatInputCommandInteraction): Promise<void> => {
	await startChallengeDraft(interaction, "diceroll");
};

export const runRps = async (interaction: ChatInputCommandInteraction): Promise<void> => {
	await startChallengeDraft(interaction, "rps");
};

// The same card the board's Monopoly button posts: visibility, the auction toggle,
// the pool and Start all happen on it, so the doorway adds nothing of its own.
export const runMonopoly = async (interaction: ChatInputCommandInteraction): Promise<void> => {
	await startChallengeDraft(interaction, "monopoly");
};
