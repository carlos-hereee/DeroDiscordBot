import { ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel, type ButtonInteraction } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { isHangmanRoundRunning, startHangmanRound } from "@features/games/hangmanHandler.js";
import { offerChallengeDraft } from "./challengeBoard.js";
import { gamesCopy } from "@features/games/gamesCopy.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { PARTY_MODAL_PREFIX, PARTY_RSVP_PREFIX, buildScheduleModal, handleRsvpButton, handleScheduleSubmit } from "./partyGamesSchedule.js";
import { beginChannelAnswer } from "@utils/answerInChannel.js";
import { showNotice, showPendingNotice } from "@utils/textModal.js";
import { resolveServerTimezone } from "@utils/tzParser.js";

// ── partyGames ───────────────────────────────────────────────────────
// What:  the 🎉party-games channel's admin controls (post-launch plan item 3): Host
//        hangman, which opens a public hangman round in this channel for everyone, Host
//        Texas hold em and Host Monopoly (2026-10 item 254, Arcade 4), which post the
//        game's normal challenge card, and Schedule a party game, which opens the
//        schedule modal (partyGamesSchedule).
// Who:   GuildSetupManager puts buildPartyGamesRow under the channel's intro; main.ts
//        calls registerPartyGameHandlers once at boot.
// Where: Host hangman is the admin "Post hangman" button that used to sit on the admin
//        controls card and post into #command-center; it moved here, so a group game is
//        played where the party is announced. Both run the same startHangmanRound the
//        /mini-game hangman slash path does, so the round cannot differ by door. The two
//        table games go through challengeBoard.offerChallengeDraft, the door every other
//        challenge uses, so their card posts where its game and match decide like any
//        other card's and its room opens when the host presses Start.
//
// ⚠️ THE BUTTONS ARE PUBLIC, THE GATE IS NOT. A message cannot show a button to admins
// only, so every press re-checks the owner or the admin role (gateOwnerOrAdmin), and a
// modal submit re-checks again in partyGamesSchedule.

const PREFIX = "party_games";

// The table games a party host may open from here, as their challenge cards. Hangman is
// apart because it opens a round in this channel rather than a challenge.
const PARTY_TABLE_GAMES = ["holdem", "monopoly"] as const;
type PartyTableGame = (typeof PARTY_TABLE_GAMES)[number];
const isPartyTableGame = (game: string | undefined): game is PartyTableGame => (PARTY_TABLE_GAMES as readonly (string | undefined)[]).includes(game);

/**
 * The 🎉party-games intro's one row: Host hangman, Host Texas hold em, Host Monopoly and
 * Schedule a party game, four of Discord's five buttons a row.
 */
export function buildPartyGamesRow(): ActionRowBuilder<ButtonBuilder> {
	const words = gameRoomsCopy.partyGames;
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${PREFIX}:host:hangman`).setLabel(words.hostHangmanLabel).setEmoji("🪢").setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`${PREFIX}:host:holdem`).setLabel(words.hostHoldemLabel).setEmoji("🃏").setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`${PREFIX}:host:monopoly`).setLabel(words.hostMonopolyLabel).setEmoji("🏠").setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`${PREFIX}:schedule`).setLabel(words.scheduleLabel).setEmoji("📅").setStyle(ButtonStyle.Primary)
	);
}

async function handlePartyGamesButton(interaction: ButtonInteraction): Promise<void> {
	const [, action, game] = interaction.customId.split(":");
	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) return;

	const config = await guildConfigStore.findByGuildId(guildId);
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.partyGames, sections: [gameRoomsCopy.partyGames.adminsOnly] });
		return;
	}

	if (action === "schedule") {
		// The modal names the zone its start is read in; the Submit reads the zone again.
		await interaction.showModal(buildScheduleModal(resolveServerTimezone(config?.timezone)));
		return;
	}
	// The table game's own challenge card, posted only on its creation modal's Submit (2026-10
	// item 263 Phase 2a). The modal answers the press itself, so nothing is deferred first.
	// The card's controls are the host's from here on.
	if (action === "host" && isPartyTableGame(game)) {
		await offerChallengeDraft(interaction, game);
		return;
	}
	if (action === "host") {
		await hostHangman(interaction, guildId, (config as unknown as { partyGamesChannelId?: string | null } | null)?.partyGamesChannelId ?? null);
		return;
	}
	await showNotice(interaction, { title: gameRoomsCopy.notices.partyGames, sections: [gameRoomsCopy.errors.controlRetired] });
}

// What a Host hangman press refuses with no I/O, or null when it may go on.
function hangmanPressRefusal(channelId: string | null): string | null {
	if (!channelId) return gameRoomsCopy.partyGames.noChannel;
	if (isHangmanRoundRunning(channelId)) return gamesCopy.hangman.alreadyRunning;
	return null;
}

// Open a public hangman round in 🎉party-games. Acknowledged after the press checks: it
// resolves a channel and posts a board, which can run past Discord's three second window on a
// cold cache. The admin's answer posts in 🎰arcade-control (2026-10 item 257 Phase 5).
async function hostHangman(interaction: ButtonInteraction, guildId: string, channelId: string | null): Promise<void> {
	// No 🎉party-games stored, or a round already in it, is a state the press reads with no I/O,
	// so it is a notice while a modal can still open (owner rule 1 of the Round 3 list, 2026-10
	// item 263). A channel gone since setup needs the fetch, so it is read after the acknowledgement.
	const pressRefusal = hangmanPressRefusal(channelId);
	if (pressRefusal) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.partyGames, sections: [pressRefusal] });
		return;
	}
	const answer = await beginChannelAnswer(interaction, "arcade");
	const channel = channelId ? await interaction.client.channels.fetch(channelId).catch(() => null) : null;
	if (!(channel instanceof TextChannel)) {
		await showPendingNotice(interaction, answer, { title: gameRoomsCopy.notices.partyGames, sections: [gameRoomsCopy.partyGames.noChannel] });
		return;
	}

	const result = await startHangmanRound(channel, interaction.user.id);
	// A round started since the press check: the race, answered as the same notice.
	if (result === "alreadyRunning") {
		await showPendingNotice(interaction, answer, { title: gameRoomsCopy.notices.partyGames, sections: [gamesCopy.hangman.alreadyRunning] });
		return;
	}
	if (result === "failed") {
		await answer.send({ embeds: [errorEmbed(gameRoomsCopy.partyGames.noChannel)] });
		return;
	}

	// The same audit line the admin card's Post hangman wrote, so the trail reads the
	// same before and after the move.
	adminLog.emitFor(interaction, guildId, "powerup.toggle", { subject: setupCopy.adminLog.subjects.postHangman });
	await answer.send({ content: gameRoomsCopy.partyGames.hostStarted(channel.id) });
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
