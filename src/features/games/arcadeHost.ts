import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, TextChannel, type ButtonInteraction } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { startHangmanRound } from "./hangmanHandler.js";
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
// How:   one button per hostable game, each delegating to the SAME shared core
//        the slash path uses (startHangmanRound, startBlackjackTable), so a game
//        started from a button and one started from `/mini-game` cannot diverge.
//
// ⚠️ ONLY GAMES THAT NEED NO NAMED OPPONENT ARE HOSTABLE HERE, and the omission
// is honest rather than an oversight. Duel and rock paper scissors both go
// through challengeFlow, which requires a specific opponent chosen up front;
// turning them into "anyone may accept" is the challenge board's job (game rooms
// phase 4) and does not exist yet. The rules copy says so in its Join section,
// so the card and the buttons tell the same story.

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

	const challengesId = (stored as unknown as { gamesChallengesChannelId?: string | null } | null)?.gamesChallengesChannelId;
	const channel = challengesId ? await guild.channels.fetch(challengesId).catch(() => null) : null;
	if (!(channel instanceof TextChannel)) {
		// The arcade was never built, or an admin removed the board. Say which,
		// rather than failing silently on a button the member can plainly see.
		await interaction.editReply({ embeds: [errorEmbed(copy.hostNoChannel)] });
		return;
	}

	const host = { userId: interaction.user.id, username: interaction.user.globalName ?? interaction.user.username };
	const result =
		choice === "hangman"
			? await startHangmanRound(channel, host.userId)
			: await startBlackjackTable(channel, guild.id, host, choice === "blackjack");

	if (result === "started") {
		await interaction.editReply({ content: copy.hostStarted(labelFor(choice)) });
		return;
	}
	// "alreadyRunning" and "failed" both mean nothing was posted. The shared cores
	// already log the failure cause, so the member gets the short version.
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
