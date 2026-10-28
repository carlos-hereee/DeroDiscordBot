import type { ChatInputCommandInteraction } from "discord.js";
import { isChallengeChannel } from "@features/game-rooms/challengeCard.js";
import { offerChallengeDraft } from "@features/game-rooms/challengeBoard.js";
import { soloLuckSlugFor } from "@features/game-rooms/soloRooms.js";
import { openSoloRoomForMember } from "./arcadeHost.js";
import { isAgainstDero } from "./challengeEntry.js";
import { runFortune } from "./fortuneHandler.js";
import type { SoloLuckGame } from "./soloLuck.js";

// ── miniGameInChallenges ───────────────────────────────────────────────────
// What:  the /mini-game subcommands that play a game, answered so nothing is played in the
//        channel the command was typed in, wherever that is (2026-10 item 263 R3-8, owner
//        decision 9; first only in the two challenge channels, 2026-10 item 254, Arcade 1):
//        a game against Dero opens its solo room, hangman its solo room, and a blackjack table
//        others may join its challenge card through the creation modal.
// Who:   /mini-game's execute, before its dispatch table, for every subcommand.
// Does NOT: handle what already only posts a challenge card (Monopoly, and a luck game against
//        a member): those fall through to their handlers. Nor a fortune outside the two challenge
//        channels, which keeps its own handler and its private option, since a reading has no
//        room; typed in one of them it is answered privately (2026-10 item 257 Phase 5), because
//        those channels hold challenge cards and nothing else.
// How:   one branch per subcommand that would otherwise post a game into its channel; only the
//        fortune branch reads the guild's two channel ids.

// The subcommands whose round against Dero opens a solo room here, by game.
const LUCK_SUBCOMMANDS: Record<string, SoloLuckGame> = {
	"coin-flip": "coinflip",
	"dice-roll": "diceroll",
	rps: "rps",
};

/**
 * Answer a /mini-game that plays a game, by opening its room. Returns true when it answered,
 * false for the subcommands whose own handler should run (a card start, or a fortune typed
 * outside the challenge channels).
 */
export async function routeMiniGameInChallenges(interaction: ChatInputCommandInteraction, subcommand: string): Promise<boolean> {
	if (!interaction.inGuild() || !interaction.guild) return false;

	if (subcommand === "fortune") {
		if (!(await isChallengeChannel(interaction.guildId, interaction.channelId))) return false;
		await runFortune(interaction, { forcePrivate: true });
		return true;
	}
	if (subcommand === "hangman") {
		await openSoloRoomForMember(interaction, "solo-hangman");
		return true;
	}
	if (subcommand === "blackjack") {
		// A table others may join is a challenge card, started from its creation modal; a hand alone
		// against the dealer is a solo room with no card.
		if (interaction.options.getString("mode") === "table") {
			await offerChallengeDraft(interaction, "blackjack");
			return true;
		}
		await openSoloRoomForMember(interaction, "solo-blackjack");
		return true;
	}

	const luckGame = LUCK_SUBCOMMANDS[subcommand];
	if (!luckGame) return false;
	// Against a member, the luck game's handler posts its challenge card.
	if (!isAgainstDero(interaction)) return false;
	// The solo room plays the coin or the dice as it opens, and asks for an rps throw in the
	// room (2026-10 item 257 Phase 4b), so the command carries no throw option.
	await openSoloRoomForMember(interaction, soloLuckSlugFor(luckGame));
	return true;
}
