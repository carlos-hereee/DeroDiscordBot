import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	StringSelectMenuBuilder,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type MessageComponentInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { registerButton, registerSelectMenu } from "@handlers/interactionRegistry.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { openSoloRoom, describeSoloOpenFailure, readPrivateQuotaStatus, type SoloGameSlug } from "@features/game-rooms/soloRooms.js";
import { offerChallengeDraft } from "@features/game-rooms/challengeBoard.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { HANGMAN_CATEGORIES, isHangmanCategory, type HangmanCategory } from "./hangmanWords.js";

// ── arcadeHost ─────────────────────────────────────────────────────────────
// What:  the "Host a game" controls and the hangman category start, both riding the
//        🕹️games intro (2026-10 item 245 Phase 4a moved them off 📋arcade-rules), so a
//        member can start a game by pressing a button rather than by learning
//        `/mini-game` first.
// Who:   GuildSetupManager.resolveIntroComponents attaches both rows to the games
//        intro; main.ts registers the handlers once at boot.
// When:  on a button press or a category pick, any time.
// Where: the solo forms open a room of their own; "Open a Blackjack table" posts a
//        challenge card in ⚔️challenges with Join, like every room game, and its hands
//        play in the room the card opens (2026-10 item 254, Arcade 1): nothing is played
//        in ⚔️challenges, and nothing is posted into 🕹️games, whose messages are the
//        controls themselves.
// How:   the SOLO forms (Host Hangman, Play Blackjack, the hangman category start) open
//        a solo GameRoom via soloRooms.openSoloRoom, so a one-player game holds the
//        host's one-room slot, counts against the guild cap and counts as a PRIVATE
//        room for the tier quota, exactly like every other room. "Open a Blackjack
//        table" goes through challengeBoard.offerChallengeDraft, the same door every
//        board button uses, so the table gets a card, a pool and a room the same way.
//
// ⚠️ ONLY GAMES THAT NEED NO NAMED OPPONENT ARE HOSTABLE HERE, and the omission
// is honest rather than an oversight. Head-to-head games start from the
// challenge board, which owns opponent selection.

const PREFIX = "arcade_host";
// The category start's action, on the select registry under the same prefix (the
// button and select registries are separate maps, so the two cannot collide).
const HANGMAN_CATEGORY_ACTION = "hcategory";

// value → how to start it. Adding a game is one entry here plus one line of copy;
// there is deliberately no switch statement anywhere else in this file.
const HOSTABLE = [
	{ id: "hangman", label: "Host Hangman", emoji: "🪢", style: ButtonStyle.Success },
	{ id: "blackjack", label: "Play Blackjack", emoji: "🃏", style: ButtonStyle.Primary },
	{ id: "blackjack-table", label: "Open a Blackjack table", emoji: "🪑", style: ButtonStyle.Primary },
] as const;

type HostableId = (typeof HOSTABLE)[number]["id"];

export function buildArcadeHostButtons(): ButtonBuilder[] {
	return HOSTABLE.map((game) =>
		new ButtonBuilder().setCustomId(`${PREFIX}:${game.id}`).setLabel(game.label).setEmoji(game.emoji).setStyle(game.style)
	);
}

export function buildArcadeHostRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(...buildArcadeHostButtons());
}

/**
 * The hangman category start: a select of the word bank's ten shelves that opens a
 * solo hangman room with a word Dero draws from the shelf picked. Its own row, because
 * Discord gives a select menu a whole action row. The placeholder comes from the
 * guild's copy pack, the labels from the same table the in room category select reads.
 */
export function buildHangmanCategoryStartRow(placeholder: string): ActionRowBuilder<StringSelectMenuBuilder> {
	const labels = gameRoomsCopy.hangman.categoryLabels;
	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(`${PREFIX}:${HANGMAN_CATEGORY_ACTION}`)
			.setPlaceholder(placeholder)
			.setMinValues(1)
			.setMaxValues(1)
			.addOptions(HANGMAN_CATEGORIES.map((category) => ({ label: labels[category], value: category, emoji: "🪢" })))
	);
}

async function handleArcadeHost(interaction: ButtonInteraction): Promise<void> {
	const choice = interaction.customId.split(":")[1] as HostableId;
	if (!HOSTABLE.some((game) => game.id === choice)) return;

	// ── the multi seat table: a challenge card, like every room game ──
	// Before the defer below, because the confirm answers the press itself; the card is
	// posted only on its Submit (2026-10 item 257, owner item 12).
	if (choice === "blackjack-table") {
		await offerChallengeDraft(interaction, "blackjack");
		return;
	}

	// Ephemeral throughout: the PUBLIC artifact of pressing this is the room or the
	// table that opens, so a second public "X pressed a button" message would just be
	// noise beside it.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const guild = interaction.guild;
	if (!guild) return;

	// ── the solo forms: a private one-player room ──
	await openSoloRoomForMember(interaction, choice === "hangman" ? "solo-hangman" : "solo-blackjack");
}

// The category start's submit. The value is re-checked against the bank, because a
// select's values are user input whoever built the menu.
async function handleHangmanCategoryStart(interaction: StringSelectMenuInteraction): Promise<void> {
	const [, action] = interaction.customId.split(":");
	if (action !== HANGMAN_CATEGORY_ACTION) return;
	const category = interaction.values[0] ?? "";
	if (!isHangmanCategory(category)) return;

	// A reply rather than an update: the select lives on the shared games intro, and
	// updating it would edit that public message for everyone.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	if (!interaction.guild) return;
	await openSoloRoomForMember(interaction, "solo-hangman", { hangmanCategory: category });
}

// The shared tail of every solo form: open the room, then tell the member where it is
// or, on a refusal, what to do about it. The interaction is already deferred, privately.
// Exported for miniGameInChallenges (2026-10 item 254, Arcade 1), whose slash commands
// typed in ⚔️challenges open the same solo rooms and answer the same way.
export async function openSoloRoomForMember(
	interaction: MessageComponentInteraction | ChatInputCommandInteraction,
	game: SoloGameSlug,
	options: { hangmanCategory?: HangmanCategory } = {}
): Promise<void> {
	const guild = interaction.guild!;
	const member = guild.members.cache.get(interaction.user.id);
	const result = await openSoloRoom(
		guild,
		game,
		{
			userId: interaction.user.id,
			displayName: member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
			user: interaction.user,
		},
		options
	);
	if (result.ok) {
		// The quota status line rides the confirmation when the tier surface is
		// enforcing, so a solo host sees the ceiling the same way an invite host
		// does on the visibility chooser. Null (and skipped) in production today.
		const status = await readPrivateQuotaStatus(guild.id, interaction.user.id).catch(() => null);
		const started = gameRoomsCopy.board.cardStarted(result.channel.id);
		await interaction.editReply({ content: status ? `${started} ${status}` : started });
		return;
	}
	// Every refusal names itself (room slot held, guild full, quota hit, no
	// arcade), so the member learns what to do rather than that something failed.
	await interaction.editReply({ embeds: [errorEmbed(describeSoloOpenFailure(result))] });
}

/**
 * Register the arcade host buttons and the hangman category start. Called once at
 * boot from main.ts, before the InteractionCreate listener installs, exactly like the
 * suggestion box and self-destruct handlers.
 */
export function registerArcadeHostHandlers(): void {
	registerButton(PREFIX, handleArcadeHost);
	registerSelectMenu(PREFIX, handleHangmanCategoryStart);
}
