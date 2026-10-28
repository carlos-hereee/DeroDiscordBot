import { MessageFlags, type ChatInputCommandInteraction, type SlashCommandSubcommandBuilder } from "discord.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { isPlatformOwner } from "@utils/permissions.js";
import { showNotice } from "@utils/textModal.js";
import { verseCopy } from "./verseCopy.js";
import { buildVerseProgress } from "./verseProgress.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

// ── /platform verse ──────────────────────────────────────────────────
// What:  the platform owner's read of the Verse's counts (2026-10 item 257 Phase 3b).
// Who:   commands/admin/platform.ts adds it to /platform as `verse` and runs it. The
//        platform owner ONLY (CREATOR_DISCORD_ID, through isPlatformOwner), checked
//        before anything is read, exactly like /platform analytics: the counts span
//        every server, and an unset owner id refuses everyone.
// Where: the reply is ephemeral and the module posts to no channel. The Verse has no
//        public metric (owner decision 2), and the 2.0.0 announcement teases it without a
//        number for the same reason.

/** The /platform verse subcommand: no options, the owner's counts. */
export function addVerseSubcommand(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub.setName("verse").setDescription(verseCopy.command.description);
}

/** Runs /platform verse for the platform owner, refusing everyone else first. */
export async function runVerseSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!isPlatformOwner(interaction.user.id)) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.ownerTools, sections: [verseCopy.errors.notOwner] });
		return;
	}

	// Seven aggregates can outlast Discord's three second reply window on a cold Atlas connection.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	try {
		const progress = await buildVerseProgress();
		await interaction.editReply({ embeds: [infoEmbed(verseCopy.title, verseCopy.describe(progress))] });
	} catch (error) {
		console.warn("[platform verse] reading the Verse's counts failed", error);
		await interaction.editReply({ embeds: [errorEmbed(verseCopy.errors.readFailed)] });
	}
}
