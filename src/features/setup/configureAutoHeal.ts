import { MessageFlags, type RepliableInteraction, type SlashCommandSubcommandBuilder } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";

// ── /configure auto-heal ──────────────────────────────────────────────
// What:  master switch for the bot's channel auto-repair behavior.
//        When ON (default), the boot sweep and the realtime
//        ChannelDeleteWatcher rebuild missing homebase channels. When
//        OFF, both paths early-return after logging a single summary
//        line per boot so the admin knows the repair was skipped
//        without log spam.
// Who:   admins who deliberately deleted/renamed channels and do not
//        want the bot reconstituting them. Captured from 2026-05-11
//        streamer feedback.
// When:  on demand. No-op if the new value matches the current state
//        so the admin gets a clear "already on / already off" signal
//        rather than a silent re-write.
// Where: writes GuildConfig.autoHealEnabled via guildConfigStore.update.
//        Read at runtime by ChannelDeleteWatcher and by
//        GuildSetupManager.autoSetup before the repair sweep.
// How:   ① guildId gate (rejects DM use); ② config existence gate
//        (rejects guilds that have not run /setup yet); ③ idempotent
//        write with explicit "already X" feedback so repeat invocations
//        do not gaslight the admin.

/** The options this handler reads, added to the merged command's subcommand. */
export function addAutoHealOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub
		.addBooleanOption((option) =>
			option
				.setName("enabled")
				.setDescription("True to keep auto-repair on, false to let deleted channels stay gone")
				.setRequired(true)
		);
}

export async function configureAutoHeal(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({
			embeds: [errorEmbed("Run this in a server, not a DM.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const enabled = options.getBoolean("enabled", true);

	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config) {
		// Guild has never run /setup. Toggling a flag on a non-existent
		// row would silently no-op; surface the actual blocker so the
		// admin knows where to start.
		await interaction.reply({
			embeds: [errorEmbed("This server has not been set up yet. Run /setup first.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Idempotency. The user asking for the current state should hear that,
	// not see a fake "Updated" confirmation.
	if (config.autoHealEnabled === enabled) {
		await interaction.reply({
			embeds: [
				infoEmbed(
					"Auto-heal already that way",
					`Channel auto-repair is already ${enabled ? "ON" : "OFF"}. No change made.`,
					COLORS.SCHEDULE
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		await guildConfigStore.update(guildId, { autoHealEnabled: enabled });
		adminLog.emitFor(interaction, guildId, "config.change", { subject: setupCopy.adminLog.subjects.autoHeal, detail: enabled ? setupCopy.adminLog.on : setupCopy.adminLog.off });
		const heading = enabled ? "🛠️ Auto-heal ON" : "✋ Auto-heal OFF";
		const body = enabled
			? "The bot will rebuild any homebase channel that goes missing. This is the default behavior."
			: "The bot will no longer rebuild deleted homebase channels. A single summary line per boot will note which channels would have been repaired, so check the bot's Railway logs if something feels off. Run this command again with `enabled:True` to restore.";
		await interaction.reply({
			embeds: [infoEmbed(heading, body, COLORS.SCHEDULE)],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		console.error("[configure auto-heal] update failed", err);
		await interaction.reply({
			embeds: [errorEmbed("Could not save the toggle. Try again or check the bot's logs.")],
			flags: MessageFlags.Ephemeral,
		});
	}
}
