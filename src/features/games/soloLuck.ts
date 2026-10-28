import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type ButtonInteraction,
	type MessageEditOptions,
	type RepliableInteraction,
	type TextChannel,
	type User,
} from "discord.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { resolveVersus, type CoinFace } from "./versusResolve.js";
import { scoreRps, RPS_CHOICES, type RpsChoice } from "./rpsWinner.js";
import { buildSoloLuckEmbed } from "./gamesEmbeds.js";
import { renderDiceCard } from "./diceRenderer.js";
import { renderRpsCard } from "./rpsRenderer.js";
import { isRenderPayload, withRenderFallback, type RenderPayload } from "@features/renderer/index.js";
import { awardSoloLuckResult } from "./gameXp.js";
import type { SoloLuckSlug } from "@features/game-rooms/roomTypes.js";
import { gamesCopy } from "./gamesCopy.js";
import { showNotice } from "@utils/textModal.js";
import { openSoloRoomForMember } from "./arcadeHost.js";

// ── soloLuck ───────────────────────────────────────────────────────────────
// What:  a coin flip, dice roll or rock paper scissors against Dero himself: one press,
//        one result message, no challenge card (the 1.7.0 test fixes, item 14).
// Who:   every round against Dero is played in its own solo room (2026-10 item 263 R3-7 and
//        R3-8): the 🕹️games row below, /mini-game wherever it is typed (miniGameInChallenges)
//        and Play Dero instead all open one through arcadeHost.openSoloRoomForMember, and the
//        room posts its round through playSoloLuckInChannel. playSoloLuck, the round answered
//        in place, is reached by no command or button any more; it stays for its suite, which
//        pins the pay a round against Dero earns.
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
		await showNotice(interaction, { title: gamesCopy.notices.miniGame, sections: [gamesCopy.outsideGuild] });
		return;
	}

	const result = resolveSoloLuck(play, rng);
	// Mentions render as names without notifying: the member pressed the button and
	// is looking at the result already.
	await interaction.reply({ embeds: [buildSoloLuckEmbed(interaction.user.id, result)], allowedMentions: { parse: [] } });
	// The Dero die card (2026-10 item 250 Phase 5) or the rps reveal card (2026-10 item 254
	// Phase 5a) joins its round once it draws, in an edit, so the reply above already landed
	// inside Discord's three second window. A coin flip has no card.
	if (result.game !== "coinflip") {
		const memberName = (): string => (interaction.inCachedGuild() ? interaction.member.displayName : (interaction.user.globalName ?? interaction.user.username));
		void addRoundCard(interaction.user.id, memberName, result, (payload) => interaction.editReply(payload));
	}

	// Fire and forget after the result is on screen (house rule 7); awardXp never
	// throws, and the daily cap decides how much of this actually lands.
	awardSoloLuckResult({
		client: interaction.client,
		guildId: interaction.guildId,
		channelId: interaction.channelId,
		user: interaction.user,
		won: result.outcome === "won",
		game: SOLO_SLUG[result.game],
		// A round in place owns no room or message of its own until the reply lands, so the
		// press that played it keys the coins: one interaction, one round.
		resultKey: interaction.id,
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
	if (result.game !== "coinflip") void addRoundCard(player.user.id, () => player.displayName, result, (payload) => message.edit(payload));

	awardSoloLuckResult({
		client: channel.client,
		guildId: channel.guildId,
		channelId: channel.id,
		user: player.user,
		won: result.outcome === "won",
		game: SOLO_SLUG[result.game],
		resultKey: message.id,
	});
	return result;
}

// Fire and forget after the result is on screen (house rule 7): a card that does not
// draw, or an edit that fails, leaves the text result as it was. `edit` is whichever way
// the result was posted: the interaction's reply, or the room message itself. The name is
// resolved inside the try, so a lookup that throws costs the card and never the round.
async function addRoundCard(
	userId: string,
	memberName: () => string,
	result: Exclude<SoloLuckResult, { game: "coinflip" }>,
	edit: (payload: MessageEditOptions) => Promise<unknown>
): Promise<void> {
	try {
		const card = await withRenderFallback(() => renderRoundCard(memberName(), result), () => null);
		if (!isRenderPayload(card)) return;
		const embed = buildSoloLuckEmbed(userId, result).setImage(card.ref);
		await edit({ embeds: [embed], files: [card.attachment], allowedMentions: { parse: [] } });
	} catch (error) {
		console.warn(`[games] adding the ${result.game} card to a round against Dero failed`, error);
	}
}

// The member is always the left side and Dero the right, on both cards.
function renderRoundCard(memberName: string, result: Exclude<SoloLuckResult, { game: "coinflip" }>): Promise<RenderPayload | null> {
	const winner = ROUND_CARD_WINNER[result.outcome];
	if (result.game === "diceroll") {
		return renderDiceCard({ left: { name: memberName, roll: result.memberRoll }, right: { name: gamesCopy.soloLuck.deroName, roll: result.deroRoll }, winner });
	}
	return renderRpsCard({
		left: { name: memberName, choice: result.memberThrow, isDero: false },
		right: { name: gamesCopy.soloLuck.deroName, choice: result.deroThrow, isDero: true },
		winner,
	});
}

// The slug a round's coins are recorded under, in place or in a solo room alike, so the
// solo coin cap counts both doors as one.
const SOLO_SLUG: Record<SoloLuckGame, SoloLuckSlug> = { coinflip: "solo-coinflip", diceroll: "solo-diceroll", rps: "solo-rps" };

const ROUND_CARD_WINNER: Record<SoloLuckOutcome, "left" | "right" | "tie"> = { won: "left", lost: "right", tie: "tie" };

// ── the 🕹️games row ────────────────────────────────────────────────────────
// Three buttons, one per game against Dero (2026-10 item 263 R3-7, owner decision 9), and each
// opens that game's solo room: nothing is played in 🕹️games. Rock paper scissors asks for the
// throw in its room's turn prompt, so the row needs no button per throw any more.

const SOLO_LUCK_PREFIX = "solo_luck";

/** The row's labels, read from the guild's copy pack (channelContent.arcadeGames). */
export interface SoloLuckButtonLabels {
	coinflip: string;
	diceroll: string;
	rps: string;
}

/** The solo luck row the 🕹️games intro carries. Each press opens a solo room against Dero. */
export function buildSoloLuckRow(labels: SoloLuckButtonLabels): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${SOLO_LUCK_PREFIX}:coinflip`).setLabel(labels.coinflip).setEmoji("🪙").setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`${SOLO_LUCK_PREFIX}:diceroll`).setLabel(labels.diceroll).setEmoji("🎲").setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`${SOLO_LUCK_PREFIX}:rps`).setLabel(labels.rps).setEmoji("✂️").setStyle(ButtonStyle.Primary)
	);
}

/**
 * Translate a solo luck button's customId into the game whose solo room it opens, or null for a
 * customId this row never builds. Pure, so the parse is testable without Discord.
 *
 * ⚠️ AN OLD THROW BUTTON STILL OPENS THE ROOM. An intro posted before the row changed carries
 * `solo_luck:rps:<throw>` until the boot refresh redraws it; its press opens the solo-rps room,
 * which asks for the throw, so the throw it names is not read. A throw that is not one of
 * RPS_CHOICES is replayed or forged input and parses to nothing.
 */
export function parseSoloLuckButton(customId: string): SoloLuckGame | null {
	const [prefix, game, memberThrow, extra] = customId.split(":");
	if (prefix !== SOLO_LUCK_PREFIX || extra !== undefined) return null;
	if (game === "coinflip" || game === "diceroll") return memberThrow === undefined ? game : null;
	if (game === "rps" && (memberThrow === undefined || RPS_CHOICES.includes(memberThrow as RpsChoice))) return "rps";
	return null;
}

async function handleSoloLuckButton(interaction: ButtonInteraction): Promise<void> {
	const game = parseSoloLuckButton(interaction.customId);
	if (!game) return;
	await openSoloRoomForMember(interaction, SOLO_SLUG[game]);
}

/** Register the solo luck row. Called once at boot from main.ts, like every persistent button. */
export function registerSoloLuckHandlers(): void {
	registerButton(SOLO_LUCK_PREFIX, handleSoloLuckButton);
}
