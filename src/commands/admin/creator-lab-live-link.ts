import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { creatorLabLiveEnabled } from "@utils/config.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { showNotice } from "@utils/textModal.js";
import { creatorLabChannelCodeStore, CREATOR_LAB_CHANNEL_CODE_TTL_MS } from "@db/stores/creatorLabChannelCodeStore.js";
import { liveLinkCopy } from "@features/creator-lab/creatorLabCopy.js";

// ── /creator-lab-live-link (Creator Lab live capture, 2026-11 item 284 Phase 3) ──
// Run in the channel a stream's chat uses. Hands a member who can manage this server a one time code,
// privately, bound to THIS guild and channel; an app admin pastes it in Creator Lab's Live capture
// settings and the server redeems it at the signed /api/creator-lab/live-link/redeem. From then on
// /highlight and /count in this channel write to that app. Seeing the code proves control of the
// channel and pasting it proves the Company Uno side, so no app can claim a channel by typing its id.
//
// Manage Server is checked TWICE on purpose: setDefaultMemberPermissions only hides the command from
// other members' pickers, and a server's own integration settings can widen it, so execute re-checks
// the member's resolved permissions before it issues anything. It is not in ADMIN_COMMANDS, because
// that gate needs /setup's config and live capture belongs to the app, not to Dero's server setup.
//
// Behind CREATOR_LAB_LIVE_ENABLED (Risk R6): while it is off the command only says so, privately.

const MS_PER_MINUTE = 60_000;

export const data = new SlashCommandBuilder()
	.setName("creator-lab-live-link")
	.setDescription("Link this channel to Creator Lab so /highlight and /count work during your streams")
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!creatorLabLiveEnabled) {
		await showNotice(interaction, { title: liveLinkCopy.title, sections: [liveLinkCopy.unavailable] });
		return;
	}
	if (!interaction.inGuild() || !interaction.channelId) {
		await showNotice(interaction, { title: liveLinkCopy.title, sections: [liveLinkCopy.guildOnly] });
		return;
	}
	if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
		await showNotice(interaction, { title: liveLinkCopy.title, sections: [liveLinkCopy.needsManageServer] });
		return;
	}
	// Private from the first byte: the code is a claim token and must never post in a channel.
	// Deferred because the issue is a Mongo write that can outlast Discord's 3 second window.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	try {
		const channel = interaction.channel;
		const channelName = channel && "name" in channel ? (channel.name ?? "") : "";
		const code = await creatorLabChannelCodeStore.issue({
			guildId: interaction.guildId,
			channelId: interaction.channelId,
			guildName: interaction.guild?.name ?? "",
			channelName,
			discordUserId: interaction.user.id,
		});
		await interaction.editReply({
			embeds: [infoEmbed(liveLinkCopy.title, liveLinkCopy.code(code, CREATOR_LAB_CHANNEL_CODE_TTL_MS / MS_PER_MINUTE))],
		});
	}
	catch (err) {
		console.error("[creator-lab-live-link] code issue failed", err instanceof Error ? err.name : "unknown");
		await interaction.editReply({ embeds: [errorEmbed(liveLinkCopy.failed)] });
	}
}
