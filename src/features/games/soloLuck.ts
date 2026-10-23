import { MessageFlags, type RepliableInteraction } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { resolveVersus, type CoinFace } from "./versusResolve.js";
import { scoreRps, RPS_CHOICES, type RpsChoice } from "./rpsWinner.js";
import { buildSoloLuckEmbed } from "./gamesEmbeds.js";
import { awardSoloLuckResult } from "./gameXp.js";
import { gamesCopy } from "./gamesCopy.js";

// ── soloLuck ───────────────────────────────────────────────────────────────
// What:  a coin flip, dice roll or rock paper scissors against Dero himself, played
//        inline: one press, one public result message, no room and no challenge
//        card (the 1.7.0 test fixes, item 14).
// Who:   /mini-game coin-flip, dice-roll and rps with `against: Dero`, through
//        challengeEntry; the games channel buttons call playSoloLuck too once
//        Phase 4 places them.
// Where: it reuses the two pure resolvers the member against member games use,
//        with Dero as the second side: resolveVersus for the coin and the dice (the
//        member is the challenger, Dero the opponent) and scoreRps for the throws.
//        A second resolver would be a second set of odds to keep fair.
// How:   resolveSoloLuck is pure (the rng is injectable, matching versusResolve);
//        playSoloLuck posts the result and only then pays through gameXp.
//
// Deliberately NOT a room: a coin flip lasts a second, and a room is earned by
// duration (see the game rooms section of the bot's CLAUDE.md).

export type SoloLuckGame = "coinflip" | "diceroll" | "rps";

/** What the member asked to play. Only rps needs a choice from them. */
export type SoloLuckPlay = { game: "coinflip" } | { game: "diceroll" } | { game: "rps"; memberThrow: RpsChoice };

/** How the round ended for the MEMBER, who is always the first side. */
export type SoloLuckOutcome = "won" | "lost" | "tie";

export type SoloLuckResult =
	| { game: "coinflip"; face: CoinFace; outcome: SoloLuckOutcome }
	| { game: "diceroll"; memberRoll: number; deroRoll: number; outcome: SoloLuckOutcome }
	| { game: "rps"; memberThrow: RpsChoice; deroThrow: RpsChoice; outcome: SoloLuckOutcome };

// The resolvers answer from the challenger's side; the member is always the
// challenger here, so this is the whole translation.
const OUTCOME_FOR_MEMBER: Record<"challenger" | "opponent" | "tie", SoloLuckOutcome> = {
	challenger: "won",
	opponent: "lost",
	tie: "tie",
};

/**
 * Dero's throw. rps has no rng of its own because both of its usual players pick by
 * hand, so this is the one random pick in the game: a uniform draw over
 * RPS_CHOICES, with the rng injectable the way resolveVersus takes it.
 */
export function pickDeroThrow(rng: () => number = Math.random): RpsChoice {
	return RPS_CHOICES[Math.floor(rng() * RPS_CHOICES.length)];
}

/** Resolve one solo round. Pure: no Discord, no I/O. */
export function resolveSoloLuck(play: SoloLuckPlay, rng: () => number = Math.random): SoloLuckResult {
	if (play.game === "rps") {
		const deroThrow = pickDeroThrow(rng);
		return { game: "rps", memberThrow: play.memberThrow, deroThrow, outcome: OUTCOME_FOR_MEMBER[scoreRps(play.memberThrow, deroThrow)] };
	}

	const versus = resolveVersus(play.game === "coinflip" ? "coin" : "dice", rng);
	if (versus.flip === "coin") {
		return { game: "coinflip", face: versus.face, outcome: OUTCOME_FOR_MEMBER[versus.winner] };
	}
	return {
		game: "diceroll",
		memberRoll: versus.challengerRoll,
		deroRoll: versus.opponentRoll,
		outcome: OUTCOME_FOR_MEMBER[versus.winner],
	};
}

/**
 * Play one solo round and post the result as ONE public message in the channel the
 * command or button was used in, then pay the member. Works for a slash command and
 * a button alike, since both are repliable.
 */
export async function playSoloLuck(
	interaction: RepliableInteraction,
	play: SoloLuckPlay,
	rng: () => number = Math.random
): Promise<void> {
	// XP is per server, and a DM has no server to rank in.
	if (!interaction.inGuild()) {
		await interaction.reply({ embeds: [errorEmbed(gamesCopy.outsideGuild)], flags: MessageFlags.Ephemeral });
		return;
	}

	const result = resolveSoloLuck(play, rng);
	// Mentions render as names without notifying: the member pressed the button and
	// is looking at the result already.
	await interaction.reply({ embeds: [buildSoloLuckEmbed(interaction.user.id, result)], allowedMentions: { parse: [] } });

	// Fire and forget after the result is on screen (house rule 7); awardXp never
	// throws, and the daily cap decides how much of this actually lands.
	awardSoloLuckResult({
		client: interaction.client,
		guildId: interaction.guildId,
		channelId: interaction.channelId,
		user: interaction.user,
		won: result.outcome === "won",
	});
}
