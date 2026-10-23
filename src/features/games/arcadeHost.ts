import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	StringSelectMenuBuilder,
	TextChannel,
	type ButtonInteraction,
	type MessageComponentInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton, registerSelectMenu } from "@handlers/interactionRegistry.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { openSoloRoom, describeSoloOpenFailure, readPrivateQuotaStatus, type SoloGameSlug } from "@features/game-rooms/soloRooms.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { startBlackjackTable } from "./blackjackHandler.js";
import { HANGMAN_CATEGORIES, isHangmanCategory, type HangmanCategory } from "./hangmanWords.js";

// ── arcadeHost ─────────────────────────────────────────────────────────────
// What:  the "Host a game" controls and the hangman category start, both riding the
//        🕹️games intro (2026-10 item 245 Phase 4a moved them off 📋arcade-rules), so a
//        member can start a game by pressing a button rather than by learning
//        `/mini-game` first.
// Who:   GuildSetupManager.resolveIntroComponents attaches both rows to the games
//        intro; main.ts registers the handlers once at boot.
// When:  on a button press or a category pick, any time.
// Where: the solo forms open a room of their own; "Open a Blackjack table" posts its
//        table into ⚔️challenges, where an open table is joined, never into 🕹️games,
//        whose messages are the controls themselves.
// How:   the SOLO forms (Host Hangman, Play Blackjack, the hangman category start) open
//        a solo GameRoom via soloRooms.openSoloRoom, so a one-player game holds the
//        host's one-room slot, counts against the guild cap and counts as a PRIVATE
//        room for the tier quota, exactly like every other room. "Open a Blackjack
//        table" deliberately stays on the inline multi-seat path in ⚔️challenges: it
//        is the DISCOVERABLE public form of blackjack, a hand takes a minute, and a
//        table has never earned a room (see roomTypes' duration rule).
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

	// Ephemeral throughout: the PUBLIC artifact of pressing this is the room or the
	// table that opens, so a second public "X pressed a button" message would just be
	// noise beside it.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const guild = interaction.guild;
	if (!guild) return;

	// ── the solo forms: a private one-player room ──
	if (choice === "hangman" || choice === "blackjack") {
		await openSoloRoomForMember(interaction, choice === "hangman" ? "solo-hangman" : "solo-blackjack");
		return;
	}

	// ── the inline multi-seat table, posted into ⚔️challenges ──
	const stored = await guildConfigStore.findByGuildId(guild.id);
	const copy = getPluginCopy(stored as unknown as ICopyConfig | null).channelContent.arcadeGames;
	const challengesId = (stored as unknown as { arcadeChallengesChannelId?: string | null } | null)?.arcadeChallengesChannelId;
	const channel = challengesId ? await guild.channels.fetch(challengesId).catch(() => null) : null;
	if (!(channel instanceof TextChannel)) {
		// The arcade was never built, or an admin removed the board. Say which,
		// rather than failing silently on a button the member can plainly see.
		await interaction.editReply({ embeds: [errorEmbed(copy.hostNoChannel)] });
		return;
	}

	const host = { userId: interaction.user.id, username: interaction.user.globalName ?? interaction.user.username };
	const result = await startBlackjackTable(channel, guild.id, host, false);

	if (result === "started") {
		await interaction.editReply({ content: copy.hostStarted(labelFor(choice)) });
		return;
	}
	// "alreadyRunning" and "failed" both mean nothing was posted. The shared core
	// already logs the failure cause, so the member gets the short version.
	await interaction.editReply({ embeds: [errorEmbed(copy.hostFailed)] });
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
	await openSoloRoomForMember(interaction, "solo-hangman", category);
}

// The shared tail of every solo form: open the room, then tell the member where it is
// or, on a refusal, what to do about it. The interaction is already deferred.
async function openSoloRoomForMember(
	interaction: MessageComponentInteraction,
	game: SoloGameSlug,
	hangmanCategory?: HangmanCategory
): Promise<void> {
	const guild = interaction.guild!;
	const member = guild.members.cache.get(interaction.user.id);
	const result = await openSoloRoom(
		guild,
		game,
		{
			userId: interaction.user.id,
			displayName: member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
		},
		{ hangmanCategory }
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

function labelFor(id: HostableId): string {
	return HOSTABLE.find((game) => game.id === id)?.label ?? id;
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
