import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, TextChannel, type ButtonInteraction } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { startHangmanRound } from "@features/games/hangmanHandler.js";
import { gamesCopy } from "@features/games/gamesCopy.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { PARTY_MODAL_PREFIX, PARTY_RSVP_PREFIX, buildScheduleModal, handleRsvpButton, handleScheduleSubmit } from "./partyGamesSchedule.js";

// ── partyGames ───────────────────────────────────────────────────────
// What:  the 🎉party-games channel's two admin controls (post-launch plan item 3): Host
//        hangman, which opens a public hangman round in this channel for everyone, and
//        Schedule a party game, which opens the schedule modal (partyGamesSchedule).
// Who:   GuildSetupManager puts buildPartyGamesRow under the channel's intro; main.ts
//        calls registerPartyGameHandlers once at boot.
// Where: Host hangman is the admin "Post hangman" button that used to sit on the admin
//        controls card and post into #command-center; it moved here, so a group game is
//        played where the party is announced. Both run the same startHangmanRound the
//        /mini-game hangman slash path does, so the round cannot differ by door.
//
// ⚠️ THE BUTTONS ARE PUBLIC, THE GATE IS NOT. A message cannot show a button to admins
// only, so every press re-checks the owner or the admin role (gateOwnerOrAdmin), and a
// modal submit re-checks again in partyGamesSchedule.

const PREFIX = "party_games";

/** The 🎉party-games intro's one row: Host hangman and Schedule a party game. */
export function buildPartyGamesRow(): ActionRowBuilder<ButtonBuilder> {
	const words = gameRoomsCopy.partyGames;
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${PREFIX}:host:hangman`).setLabel(words.hostHangmanLabel).setEmoji("🪢").setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`${PREFIX}:schedule`).setLabel(words.scheduleLabel).setEmoji("📅").setStyle(ButtonStyle.Primary)
	);
}

async function handlePartyGamesButton(interaction: ButtonInteraction): Promise<void> {
	const [, action] = interaction.customId.split(":");
	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) return;

	const config = await guildConfigStore.findByGuildId(guildId);
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await interaction.reply({ content: gameRoomsCopy.partyGames.adminsOnly, flags: MessageFlags.Ephemeral });
		return;
	}

	if (action === "schedule") {
		await interaction.showModal(buildScheduleModal());
		return;
	}
	if (action === "host") {
		await hostHangman(interaction, guildId, (config as unknown as { partyGamesChannelId?: string | null } | null)?.partyGamesChannelId ?? null);
		return;
	}
	await interaction.reply({ content: gameRoomsCopy.errors.controlRetired, flags: MessageFlags.Ephemeral });
}

// Open a public hangman round in 🎉party-games. Deferred first: it resolves a channel
// and posts a board, which can run past Discord's three second window on a cold cache.
async function hostHangman(interaction: ButtonInteraction, guildId: string, channelId: string | null): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const channel = channelId ? await interaction.client.channels.fetch(channelId).catch(() => null) : null;
	if (!(channel instanceof TextChannel)) {
		await interaction.editReply({ embeds: [errorEmbed(gameRoomsCopy.partyGames.noChannel)] });
		return;
	}

	const result = await startHangmanRound(channel, interaction.user.id);
	if (result === "alreadyRunning") {
		await interaction.editReply({ embeds: [errorEmbed(gamesCopy.hangman.alreadyRunning)] });
		return;
	}
	if (result === "failed") {
		await interaction.editReply({ embeds: [errorEmbed(gameRoomsCopy.partyGames.noChannel)] });
		return;
	}

	// The same audit line the admin card's Post hangman wrote, so the trail reads the
	// same before and after the move.
	adminLog.emitFor(interaction, guildId, "powerup.toggle", { subject: setupCopy.adminLog.subjects.postHangman });
	await interaction.editReply({ content: gameRoomsCopy.partyGames.hostStarted(channel.id) });
}

/**
 * Register the 🎉party-games buttons, the schedule modal and the RSVP buttons. Called
 * once at boot from main.ts, before the InteractionCreate listener installs, like every
 * persistent control, so a card posted by an earlier deploy keeps working.
 */
export function registerPartyGameHandlers(): void {
	registerButton(PREFIX, handlePartyGamesButton);
	registerModal(PARTY_MODAL_PREFIX, handleScheduleSubmit);
	registerButton(PARTY_RSVP_PREFIX, handleRsvpButton);
}
