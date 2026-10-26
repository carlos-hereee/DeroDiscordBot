import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	type ButtonInteraction,
	type MessageEditOptions,
	type RepliableInteraction,
	type TextChannel,
	type User,
} from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { resolveVersus, type CoinFace } from "./versusResolve.js";
import { scoreRps, RPS_CHOICES, type RpsChoice } from "./rpsWinner.js";
import { buildSoloLuckEmbed } from "./gamesEmbeds.js";
import { renderDiceCard } from "./diceRenderer.js";
import { isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { awardSoloLuckResult } from "./gameXp.js";
import { gamesCopy } from "./gamesCopy.js";

// ── soloLuck ───────────────────────────────────────────────────────────────
// What:  a coin flip, dice roll or rock paper scissors against Dero himself: one press,
//        one result message, no challenge card (the 1.7.0 test fixes, item 14).
// Who:   /mini-game coin-flip, dice-roll and rps with `against: Dero` typed outside the
//        challenge channels, through challengeEntry, and the solo luck row on the
//        🕹️games intro (2026-10 item 245 Phase 4a), through handleSoloLuckButton below;
//        both end in playSoloLuck, answered in place. Play Dero instead and a round
//        against Dero typed in ⚔️challenges end in playSoloLuckInChannel instead, posted
//        into the solo room soloRooms opened for it (2026-10 item 254, Arcade 1), so
//        nothing is played in ⚔️challenges.
// Where: it reuses the two pure resolvers the member against member games use,
//        with Dero as the second side: resolveVersus for the coin and the dice (the
//        member is the challenger, Dero the opponent) and scoreRps for the throws.
//        A second resolver would be a second set of odds to keep fair.
// How:   resolveSoloLuck is pure (the rng is injectable, matching versusResolve); both
//        posting paths post the result and only then pay through gameXp, so the odds,
//        the card and the pay are one round whichever door it came through.

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
	// The Dero die card joins a dice round once it draws (2026-10 item 250 Phase 5), in an
	// edit, so the reply above already landed inside Discord's three second window.
	if (result.game === "diceroll") {
		const memberName = (): string => (interaction.inCachedGuild() ? interaction.member.displayName : (interaction.user.globalName ?? interaction.user.username));
		void addDiceCard(interaction.user.id, memberName, result, (payload) => interaction.editReply(payload));
	}

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

/** The member a round against Dero is posted for, when there is no interaction to reply to. */
export interface SoloLuckPlayer {
	user: User;
	displayName: string;
}

/**
 * Play one solo round into a channel, a solo room (2026-10 item 254, Arcade 1), then pay
 * the member exactly as playSoloLuck does. Answers the result so the room can be finished
 * with its winner, or null when the result could not be posted, so the caller closes the
 * room as abandoned rather than paying for a round nobody saw.
 */
export async function playSoloLuckInChannel(
	channel: TextChannel,
	player: SoloLuckPlayer,
	play: SoloLuckPlay,
	rng: () => number = Math.random
): Promise<SoloLuckResult | null> {
	const result = resolveSoloLuck(play, rng);
	const message = await channel.send({ embeds: [buildSoloLuckEmbed(player.user.id, result)], allowedMentions: { parse: [] } }).catch((error) => {
		console.warn("[games] posting a round against Dero into its room failed", { channelId: channel.id, error });
		return null;
	});
	if (!message) return null;
	if (result.game === "diceroll") void addDiceCard(player.user.id, () => player.displayName, result, (payload) => message.edit(payload));

	awardSoloLuckResult({
		client: channel.client,
		guildId: channel.guildId,
		channelId: channel.id,
		user: player.user,
		won: result.outcome === "won",
	});
	return result;
}

// Fire and forget after the result is on screen (house rule 7): a card that does not
// draw, or an edit that fails, leaves the text result as it was. `edit` is whichever way
// the result was posted: the interaction's reply, or the room message itself. The name is
// resolved inside the try, so a lookup that throws costs the card and never the round.
async function addDiceCard(
	userId: string,
	memberName: () => string,
	result: Extract<SoloLuckResult, { game: "diceroll" }>,
	edit: (payload: MessageEditOptions) => Promise<unknown>
): Promise<void> {
	try {
		const card = await withRenderFallback(
			() =>
				renderDiceCard({
					left: { name: memberName(), roll: result.memberRoll },
					right: { name: gamesCopy.soloLuck.deroName, roll: result.deroRoll },
					winner: DICE_CARD_WINNER[result.outcome],
				}),
			() => null
		);
		if (!isRenderPayload(card)) return;
		const embed = buildSoloLuckEmbed(userId, result).setImage(card.ref);
		await edit({ embeds: [embed], files: [card.attachment], allowedMentions: { parse: [] } });
	} catch (error) {
		console.warn("[games] adding the dice card to a dice round against Dero failed", error);
	}
}

const DICE_CARD_WINNER: Record<SoloLuckOutcome, "left" | "right" | "tie"> = { won: "left", lost: "right", tie: "tie" };

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
