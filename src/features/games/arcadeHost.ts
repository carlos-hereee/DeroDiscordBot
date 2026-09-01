import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, TextChannel, type ButtonInteraction } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { openSoloRoom, describeSoloOpenFailure } from "@features/game-rooms/soloRooms.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { startBlackjackTable } from "./blackjackHandler.js";

// ── arcadeHost ─────────────────────────────────────────────────────────────
// What:  the "Host a game" controls that ride the 📋arcade-rules card, so a
//        member can start a game by pressing a button rather than by learning
//        `/mini-game` first.
// Who:   resolveIntroComponents attaches the row to the arcade rules intro;
//        main.ts registers the handler once at boot.
// When:  on a button press, any time.
// Where: a hosted game is posted into ⚔️challenges, NOT into 📋arcade-rules.
//        The rules card is a pinned reference that members read; dropping a live
//        board on top of it would bury the thing they came to read, and the
//        challenge board channel exists precisely to be where a match begins.
// How:   the SOLO forms (Host Hangman, Play Blackjack) open a solo GameRoom via
//        soloRooms.openSoloRoom, so a one-player game holds the host's one-room
//        slot, counts against the guild cap and counts as a PRIVATE room for the
//        tier quota, exactly like every other room. "Open a Blackjack table"
//        deliberately stays on the inline multi-seat path in ⚔️challenges: it is
//        the DISCOVERABLE public form of blackjack, a hand takes a minute, and a
//        table has never earned a room (see roomTypes' duration rule).
//
// ⚠️ ONLY GAMES THAT NEED NO NAMED OPPONENT ARE HOSTABLE HERE, and the omission
// is honest rather than an oversight. Head-to-head games start from the
// challenge board, which owns opponent selection.

const PREFIX = "arcade_host";

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

async function handleArcadeHost(interaction: ButtonInteraction): Promise<void> {
	const choice = interaction.customId.split(":")[1] as HostableId;
	if (!HOSTABLE.some((game) => game.id === choice)) return;

	// Ephemeral throughout: the PUBLIC artifact of pressing this is the game board
	// that appears in ⚔️challenges, so a second public "X pressed a button"
	// message would just be noise beside it.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const guild = interaction.guild;
	if (!guild) return;

	const stored = await guildConfigStore.findByGuildId(guild.id);
	const copy = getPluginCopy(stored as unknown as ICopyConfig | null).channelContent.arcadeRules;

	// ── the solo forms: a private one-player room ──
	if (choice === "hangman" || choice === "blackjack") {
		const member = guild.members.cache.get(interaction.user.id);
		const result = await openSoloRoom(guild, choice === "hangman" ? "solo-hangman" : "solo-blackjack", {
			userId: interaction.user.id,
			displayName: member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
		});
		if (result.ok) {
			await interaction.editReply({ content: gameRoomsCopy.board.cardStarted(result.channel.id) });
			return;
		}
		// Every refusal names itself (room slot held, guild full, quota hit, no
		// arcade), so the member learns what to do rather than that something failed.
		await interaction.editReply({ embeds: [errorEmbed(describeSoloOpenFailure(result))] });
		return;
	}

	// ── the inline multi-seat table, posted into ⚔️challenges ──
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

function labelFor(id: HostableId): string {
	return HOSTABLE.find((game) => game.id === id)?.label ?? id;
}

/**
 * Register the arcade host buttons. Called once at boot from main.ts, before the
 * InteractionCreate listener installs, exactly like the suggestion box and
 * self-destruct handlers.
 */
export function registerArcadeHostHandlers(): void {
	registerButton(PREFIX, handleArcadeHost);
}
