import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { creatorLabDmEnabled } from "@utils/config.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { showNotice } from "@utils/textModal.js";
import { creatorLabLinkStore, CREATOR_LAB_LINK_CODE_TTL_MS } from "@db/stores/creatorLabLinkStore.js";
import { creatorLabConnectCopy } from "@features/creator-lab/creatorLabCopy.js";

// ── /creator-lab-connect (Dero: Creator Lab, 2026-11 item 283 Phase 4) ──
// Open to anyone, in any server Dero is in or in a DM with Dero. Hands the member a one time code,
// privately, that links this Discord account to their Company Uno account in the Creator Lab tab;
// the server redeems it at the signed /api/creator-lab/link/redeem. Pasting the code is what proves
// the Company Uno side and seeing it is what proves the Discord side, so neither account can be
// claimed from the other alone. Nothing here reads or writes a guild's config.
//
// Behind CREATOR_LAB_DM_ENABLED (Risk R6): while it is off the command only says so, privately.

const MS_PER_MINUTE = 60_000;

export const data = new SlashCommandBuilder()
	.setName("creator-lab-connect")
	.setDescription("Link your Discord to Company Uno Creator Lab so Dero can DM your video reads");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!creatorLabDmEnabled) {
		await showNotice(interaction, { title: creatorLabConnectCopy.title, sections: [creatorLabConnectCopy.unavailable] });
		return;
	}
	// Private from the first byte: the code is a claim token and must never post in a channel.
	// Deferred because the issue is a Mongo write that can outlast Discord's 3 second window.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	try {
		const code = await creatorLabLinkStore.issue(interaction.user.id, interaction.user.username);
		await interaction.editReply({
			embeds: [infoEmbed(creatorLabConnectCopy.title, creatorLabConnectCopy.code(code, CREATOR_LAB_LINK_CODE_TTL_MS / MS_PER_MINUTE))],
		});
	}
	catch (err) {
		console.error("[creator-lab-connect] code issue failed", err instanceof Error ? err.name : "unknown");
		await interaction.editReply({ embeds: [errorEmbed(creatorLabConnectCopy.failed)] });
	}
}
