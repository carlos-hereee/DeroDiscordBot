import type { ChatInputCommandInteraction } from "discord.js";
import { isChallengeChannel } from "@features/game-rooms/challengeCard.js";
import { startChallengeDraft } from "@features/game-rooms/challengeBoard.js";
import { soloLuckSlugFor } from "@features/game-rooms/soloRooms.js";
import { openSoloRoomForMember } from "./arcadeHost.js";
import { isAgainstDero } from "./challengeEntry.js";
import { runFortune } from "./fortuneHandler.js";
import type { SoloLuckGame } from "./soloLuck.js";

// ── miniGameInChallenges ───────────────────────────────────────────────────
// What:  a /mini-game typed in one of the two challenge channels (⚔️challenges or
//        🏆rated-challenges), answered so nothing is played there (2026-10 item 254,
//        Arcade 1): the game opens its room, or its solo room, and the member is told in
//        💬dero-commands where it is; a fortune is read there too, since a reading has no
//        room (2026-10 item 257 Phase 5).
// Who:   /mini-game's execute, before its dispatch table, for every subcommand.
// Does NOT: change a /mini-game typed anywhere else, which reaches its handler exactly as
//        before. Nor does it handle what already only posts a challenge card (Monopoly, and
//        a luck game against a member): those fall through to their handlers, because a
//        challenge card is the one thing these channels hold.
// How:   one read of the guild's two channel ids, then one branch per subcommand that
//        would otherwise post a game into the channel it was typed in.

// The subcommands whose round against Dero opens a solo room here, by game.
const LUCK_SUBCOMMANDS: Record<string, SoloLuckGame> = {
	"coin-flip": "coinflip",
	"dice-roll": "diceroll",
	rps: "rps",
};

/**
 * Answer a /mini-game typed in a challenge channel. Returns true when it answered, false
 * when the command was typed elsewhere (or is one that only posts a challenge card) and
 * the subcommand's own handler should run as it always has.
 */
export async function routeMiniGameInChallenges(interaction: ChatInputCommandInteraction, subcommand: string): Promise<boolean> {
	if (!interaction.inGuild() || !interaction.guild) return false;
	if (!(await isChallengeChannel(interaction.guildId, interaction.channelId))) return false;

	if (subcommand === "fortune") {
		await runFortune(interaction, { forcePrivate: true });
		return true;
	}
	if (subcommand === "hangman") {
		await openSoloRoomForMember(interaction, "solo-hangman");
		return true;
	}
	if (subcommand === "blackjack") {
		// A table others may join is a challenge card, which is what these channels hold;
		// a hand alone against the dealer is a solo room with no card.
		if (interaction.options.getString("mode") === "table") {
			await startChallengeDraft(interaction, "blackjack");
			return true;
		}
		await openSoloRoomForMember(interaction, "solo-blackjack");
		return true;
	}

	const luckGame = LUCK_SUBCOMMANDS[subcommand];
	if (!luckGame) return false;
	// Against a member, the luck game's handler posts its challenge card, which belongs here.
	if (!isAgainstDero(interaction)) return false;
	// The solo room plays the coin or the dice as it opens, and asks for an rps throw in the
	// room (2026-10 item 257 Phase 4b), so a throw option typed here is not read.
	await openSoloRoomForMember(interaction, soloLuckSlugFor(luckGame));
	return true;
}
