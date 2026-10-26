import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { networkCopy } from "@features/game-rooms/networkCopy.js";
import { renderAnalyticsCopy } from "@features/renderer/renderAnalyticsCopy.js";
import { addNetworkBanSubcommands, runNetworkBanSubcommand } from "@features/game-rooms/networkBanSubcommands.js";
import { addRenderAnalyticsOptions, runRenderAnalyticsSubcommand } from "@features/renderer/renderAnalyticsSubcommand.js";

// ── /platform ─────────────────────────────────────────────────────────
// What:  the platform owner's tools: the `network` group (ban and unban a member or
//        a server from every network table) and `analytics` (render cache analytics).
// Who:   the platform owner ONLY. Each handler checks isPlatformOwner first thing in
//        its own run, before reading anything; an unset CREATOR_DISCORD_ID refuses
//        everyone. It carries no Discord default permission, so it shows in every
//        member's picker, and the owner check is the whole gate.
// Where: deliberately NOT in BOT_CONSTANTS.ADMIN_COMMANDS: that runtime gate requires
//        a /setup config in the guild, and the owner must reach these from any server.
//        Not on the admin guide either, for the same reason.

export const data = new SlashCommandBuilder()
	.setName("platform")
	.setDescription(networkCopy.command.platformDescription)
	.addSubcommandGroup((group) => addNetworkBanSubcommands(group.setName("network").setDescription(networkCopy.command.description)))
	.addSubcommand((sub) => addRenderAnalyticsOptions(sub.setName("analytics").setDescription(renderAnalyticsCopy.command.analyticsDescription)));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	if (interaction.options.getSubcommandGroup(false) === "network") {
		await runNetworkBanSubcommand(interaction);
		return;
	}
	await runRenderAnalyticsSubcommand(interaction);
}
