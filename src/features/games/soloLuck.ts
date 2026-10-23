import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type RepliableInteraction } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { registerButton } from "@handlers/interactionRegistry.js";
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
//        challengeEntry, and the solo luck row on the 🕹️games intro (2026-10 item 245
//        Phase 4a), through handleSoloLuckButton below. Both end in playSoloLuck.
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

// ── the 🕹️games row ────────────────────────────────────────────────────────
// Five buttons, Discord's ceiling for one row: the coin, the dice, and one button per
// rps throw. A throw is a button of its own because rps is the one game here where the
// member decides something, and a button per choice makes the press the whole game
// rather than a press that opens a second step.

const SOLO_LUCK_PREFIX = "solo_luck";

/** The row's labels, read from the guild's copy pack (channelContent.arcadeGames). */
export interface SoloLuckButtonLabels {
	coinflip: string;
	diceroll: string;
	rock: string;
	paper: string;
	scissors: string;
}

const THROW_EMOJI: Record<RpsChoice, string> = { rock: "🪨", paper: "📄", scissors: "✂️" };

/** The solo luck row the 🕹️games intro carries. Each press is one round against Dero. */
export function buildSoloLuckRow(labels: SoloLuckButtonLabels): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${SOLO_LUCK_PREFIX}:coinflip`).setLabel(labels.coinflip).setEmoji("🪙").setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`${SOLO_LUCK_PREFIX}:diceroll`).setLabel(labels.diceroll).setEmoji("🎲").setStyle(ButtonStyle.Primary),
		...RPS_CHOICES.map((choice) =>
			new ButtonBuilder().setCustomId(`${SOLO_LUCK_PREFIX}:rps:${choice}`).setLabel(labels[choice]).setEmoji(THROW_EMOJI[choice]).setStyle(ButtonStyle.Secondary)
		)
	);
}

/**
 * Translate a solo luck button's customId into the round it asks for, or null for a
 * customId this row never builds. Pure, so the parse is testable without Discord; the
 * throw is re-checked against RPS_CHOICES because a customId is replayable input.
 */
export function parseSoloLuckButton(customId: string): SoloLuckPlay | null {
	const [prefix, game, memberThrow] = customId.split(":");
	if (prefix !== SOLO_LUCK_PREFIX) return null;
	if (game === "coinflip" || game === "diceroll") return { game };
	if (game === "rps" && RPS_CHOICES.includes(memberThrow as RpsChoice)) return { game: "rps", memberThrow: memberThrow as RpsChoice };
	return null;
}

async function handleSoloLuckButton(interaction: ButtonInteraction): Promise<void> {
	const play = parseSoloLuckButton(interaction.customId);
	if (!play) return;
	await playSoloLuck(interaction, play);
}

/** Register the solo luck row. Called once at boot from main.ts, like every persistent button. */
export function registerSoloLuckHandlers(): void {
	registerButton(SOLO_LUCK_PREFIX, handleSoloLuckButton);
}
