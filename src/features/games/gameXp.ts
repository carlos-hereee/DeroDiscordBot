import type { Client, User } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { awardXp } from "@features/leveling/awardXp.js";
import type { LevelingGameSlug } from "@features/leveling/levelingTypes.js";

// ── gameXp ─────────────────────────────────────────────────────────────────
// The games feature's one seam into the leveling system.
//
// What:  turns a finished round into xp and a win/loss record for everyone who
//        took part.
// Who:   duelHandler and rpsHandler (both two player, both the same three way
//        shape), hangmanHandler (many players, its own shape), and the three
//        games arriving in phases 6 to 8.
// When:  AFTER the player facing result has already been posted. Never before,
//        and never between a result being computed and the message that shows it.
// Where: this file may import awardXp and NOTHING else from leveling. A game
//        handler must never reach a store, the curve, or the announcer directly;
//        that single rule is what makes adding a game later nearly free.
// How:   every call is FIRE AND FORGET. awardXp never throws by contract, and
//        these helpers return void rather than a promise so a caller physically
//        cannot await one into a collector callback where nothing is left to
//        catch it. Convention 7 in CLAUDE.md.
//
// ⚠️ NO AMOUNT IS INLINED HERE OR IN ANY HANDLER. They all live in
// BOT_CONSTANTS.LEVELING so an operator can retune the economy in one place and
// a game cannot quietly pay differently from its siblings.

export type TwoPlayerWinner = "challenger" | "opponent" | "tie";

interface TwoPlayerResult {
	client: Client;
	guildId: string | null;
	channelId?: string | null;
	game: LevelingGameSlug;
	challenger: User;
	opponent: User;
	winner: TwoPlayerWinner;
}

// The shared duel and rps payout. The winner takes play xp PLUS the win bonus,
// the loser keeps the play xp for showing up, and a tie pays both the tie amount,
// which sits deliberately between the two so a draw is worth more than losing and
// less than winning.
export function awardTwoPlayerResult(result: TwoPlayerResult): void {
	// A game played in a DM has no guild to be ranked in. Nothing to award.
	if (!result.guildId) return;

	const { GAME_PLAY_XP, GAME_WIN_XP, GAME_TIE_XP } = BOT_CONSTANTS.LEVELING;

	const players: Array<{ user: User; won: boolean }> = [
		{ user: result.challenger, won: result.winner === "challenger" },
		{ user: result.opponent, won: result.winner === "opponent" },
	];

	for (const player of players) {
		const drawn = result.winner === "tie";
		void awardXp({
			client: result.client,
			guildId: result.guildId,
			userId: player.user.id,
			username: player.user.globalName ?? player.user.username,
			amount: drawn ? GAME_TIE_XP : GAME_PLAY_XP + (player.won ? GAME_WIN_XP : 0),
			source: "game",
			game: result.game,
			outcome: drawn ? "drawn" : player.won ? "won" : "lost",
			channelId: result.channelId ?? null,
		});
	}
}

interface MultiPlayerResult {
	client: Client;
	guildId: string | null;
	channelId?: string | null;
	game: LevelingGameSlug;
	// Everyone who took part, resolved to an id and a display name by the caller,
	// which is the only place that knows how to look them up.
	participants: Array<{ userId: string; username: string }>;
	// The member who finished it, when somebody did. Null on a loss or an expiry.
	winnerId: string | null;
}

// The hangman shape, and the reason the ASSIST outcome exists at all: a public
// round is solved by one member on top of letters several others revealed. The
// solver takes the win, everyone else who guessed takes an assist rather than a
// loss, because they materially advanced a round somebody else won.
//
// On a loss or an expiry nobody assisted anybody, so every participant takes the
// play xp and a "lost". Showing up is the behavior being rewarded either way.
export function awardMultiPlayerResult(result: MultiPlayerResult): void {
	if (!result.guildId) return;

	const { GAME_PLAY_XP, GAME_WIN_XP } = BOT_CONSTANTS.LEVELING;

	for (const participant of result.participants) {
		const isWinner = result.winnerId !== null && participant.userId === result.winnerId;
		const assisted = result.winnerId !== null && !isWinner;

		void awardXp({
			client: result.client,
			guildId: result.guildId,
			userId: participant.userId,
			username: participant.username,
			amount: GAME_PLAY_XP + (isWinner ? GAME_WIN_XP : 0),
			source: "game",
			game: result.game,
			outcome: isWinner ? "won" : assisted ? "assist" : "lost",
			channelId: result.channelId ?? null,
		});
	}
}
