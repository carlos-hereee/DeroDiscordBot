import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, MessageFlags } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { showSelfDestructChoices } from "@features/setup/selfDestruct.js";

// ── /self-destruct ─────────────────────────────────────────────────────
// Server-owner-only. Opens the self destruct choice modal: just delete channels,
// arcade only, or delete my data (behind CONFIRM). A demolished homebase stays gone until
// /setup runs again. setDefaultMemberPermissions(Administrator) hides it from
// non-admins in the picker; showSelfDestructChoices enforces the stricter
// server-owner-only gate (Discord has no "owner only" permission flag).
export const data = new SlashCommandBuilder()
	.setName("self-destruct")
	.setDescription("Server owner only: demolish this server's bot homebase (all channels)")
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!interaction.guild) {
		await interaction.reply({ embeds: [errorEmbed("Run this in a server, not a DM.")], flags: MessageFlags.Ephemeral });
		return;
	}
	// showSelfDestructChoices performs the owner check and opens either the
	// choice modal or a denial.
	await showSelfDestructChoices(interaction);
}
