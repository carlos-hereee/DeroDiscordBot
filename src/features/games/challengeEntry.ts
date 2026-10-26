import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { startChallengeDraft } from "@features/game-rooms/challengeBoard.js";
import { playSoloLuck, type SoloLuckGame, type SoloLuckPlay } from "./soloLuck.js";
import { RPS_CHOICES, type RpsChoice } from "./rpsWinner.js";
import { gamesCopy } from "./gamesCopy.js";

// ── challengeEntry ─────────────────────────────────────────────────────────
// What:  the slash-command doorway into the challenge board, for the three head to
//        head games and Monopoly.
// Who:   MINI_GAME_HANDLERS in src/commands/fun/mini-game.ts.
// When:  on /mini-game coin-flip, dice-roll, rps or monopoly. The three luck games
//        hand a round against Dero to soloLuck instead (see `against` below).
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

// ── against Dero (the 1.7.0 test fixes, item 14) ──
// The three luck games carry an optional `against` choice. Its default, a member,
// is the challenge path exactly as it was; "dero" plays a solo round inline through
// soloLuck instead, or in a solo room when typed in a challenge channel (2026-10 item
// 254, Arcade 1, through miniGameInChallenges). ⚠️ HAND KEPT PAIR: the option names and
// the "dero" value are declared in the builder in src/commands/fun/mini-game.ts, and its
// suite mocks this module wholesale, so the builder cannot import them from here.
const AGAINST_OPTION = "against";
const AGAINST_DERO = "dero";
const THROW_OPTION = "throw";

/**
 * The round against Dero a luck subcommand asks for: null when `against` is a member (the
 * challenge path), "throwMissing" for rps against Dero with no throw, the play otherwise.
 * Shared by the handlers below and miniGameInChallenges, so the option contract is read in
 * one place whichever channel the command was typed in.
 */
export function readDeroPlay(interaction: ChatInputCommandInteraction, game: SoloLuckGame): SoloLuckPlay | "throwMissing" | null {
	if (interaction.options.getString(AGAINST_OPTION) !== AGAINST_DERO) return null;
	if (game !== "rps") return { game };
	// Discord cannot make `throw` required only when `against` is Dero, so a member who
	// left it blank is told how to fix it rather than given a throw they did not choose.
	// Discord validates the value against the builder's choices; checked again anyway.
	const memberThrow = interaction.options.getString(THROW_OPTION) as RpsChoice | null;
	return memberThrow && RPS_CHOICES.includes(memberThrow) ? { game: "rps", memberThrow } : "throwMissing";
}

// One luck subcommand: a challenge card against a member, or a round against Dero played
// in place. (Typed in a challenge channel, miniGameInChallenges answers first instead.)
async function runLuckGame(interaction: ChatInputCommandInteraction, game: SoloLuckGame): Promise<void> {
	const play = readDeroPlay(interaction, game);
	if (play === null) {
		await startChallengeDraft(interaction, game);
		return;
	}
	if (play === "throwMissing") {
		await interaction.reply({ content: gamesCopy.soloLuck.throwNeeded, flags: MessageFlags.Ephemeral });
		return;
	}
	await playSoloLuck(interaction, play);
}

// startChallengeDraft returns the draft row for the rematch path's benefit; the slash
// doorway has no use for it, so each wrapper discards it back to void.
export const runCoinFlip = (interaction: ChatInputCommandInteraction): Promise<void> => runLuckGame(interaction, "coinflip");
export const runDiceRoll = (interaction: ChatInputCommandInteraction): Promise<void> => runLuckGame(interaction, "diceroll");
export const runRps = (interaction: ChatInputCommandInteraction): Promise<void> => runLuckGame(interaction, "rps");

// The same card the board's Monopoly button posts: visibility, the auction toggle,
// the pool and Start all happen on it, so the doorway adds nothing of its own.
export const runMonopoly = async (interaction: ChatInputCommandInteraction): Promise<void> => {
	await startChallengeDraft(interaction, "monopoly");
};
