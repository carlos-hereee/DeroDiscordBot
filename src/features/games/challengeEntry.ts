import { type ChatInputCommandInteraction } from "discord.js";
import { offerChallengeDraft } from "@features/game-rooms/challengeBoard.js";
import type { SoloLuckGame } from "./soloLuck.js";

// ── challengeEntry ─────────────────────────────────────────────────────────
// What:  the slash-command doorway into the challenge board, for the three head to
//        head games and Monopoly.
// Who:   MINI_GAME_HANDLERS in src/commands/fun/mini-game.ts.
// When:  on /mini-game coin-flip, dice-roll, rps or monopoly against a member. A round
//        against Dero opens its solo room in miniGameInChallenges instead.
// Where: the SAME function the board's own buttons call, deliberately. Two ways to
//        start a match that did not share a code path would be two places to
//        enforce the one-room-per-host rule, two places to check entitlement, and
//        two definitions of what an opponent is.
// How:   read the slug from which subcommand ran, then hand over: the creation modal opens
//        as the command's first answer (2026-10 item 263 Phase 2a), exactly as the board's
//        buttons open it. There is nothing else here on purpose.
//
// ⚠️ THIS REPLACED versusHandler.ts AND rpsHandler.ts (game rooms Phase 4). Those
// files ran the whole match inside one slash invocation: a public challenge message,
// an inline component collector, and for rps a module-scoped Map of open rounds.
// Every part of that died on a Railway deploy, which happens several times a week,
// and the collector's 60 second window meant a match was never allowed to be slow.
// The room row survives both. The pure halves they were built around, versusResolve
// and rpsWinner, are unchanged and are now called from
// @features/game-rooms/roomGames.ts.

// ── against Dero (the 1.7.0 test fixes, item 14) ──
// The three luck games carry an optional `against` choice. Its default, a member, is the
// challenge path; "dero" opens a solo room wherever the command is typed (2026-10 item 263
// R3-8), which miniGameInChallenges answers before this module runs. ⚠️ HAND KEPT PAIR: the
// option name and the "dero" value are declared in the builder in src/commands/fun/mini-game.ts,
// and its suite mocks this module wholesale, so the builder cannot import them from here.
const AGAINST_OPTION = "against";
const AGAINST_DERO = "dero";

/** Whether a luck subcommand asks for a round against Dero rather than a member. Read by miniGameInChallenges. */
export const isAgainstDero = (interaction: ChatInputCommandInteraction): boolean => interaction.options.getString(AGAINST_OPTION) === AGAINST_DERO;

// One luck subcommand against a member: a challenge card, through its creation modal. A round
// against Dero never reaches here, since miniGameInChallenges opens its solo room first.
async function runLuckGame(interaction: ChatInputCommandInteraction, game: SoloLuckGame): Promise<void> {
	await offerChallengeDraft(interaction, game);
}

export const runCoinFlip = (interaction: ChatInputCommandInteraction): Promise<void> => runLuckGame(interaction, "coinflip");
export const runDiceRoll = (interaction: ChatInputCommandInteraction): Promise<void> => runLuckGame(interaction, "diceroll");
export const runRps = (interaction: ChatInputCommandInteraction): Promise<void> => runLuckGame(interaction, "rps");

// The same creation modal and card the board's Monopoly button opens, so the doorway adds
// nothing of its own.
export const runMonopoly = async (interaction: ChatInputCommandInteraction): Promise<void> => {
	await offerChallengeDraft(interaction, "monopoly");
};
