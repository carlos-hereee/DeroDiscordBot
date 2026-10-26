import {
	MessageFlags,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type RepliableInteraction,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { buildLeaderboardChannelDeleteCustomId } from "@features/leaderboard/leaderboardChannelHandlers.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";

// ── /server leaderboard tracking ───────────────────────────────────
// What:  master switch for participation tracking. When ON (default),
//        ActivityTracker writes PlayerActivity rows on ✅ reactions and
//        voice-channel joins. When OFF, both listeners early-return so
//        no new rows are written. Existing rows stay; /leaderboard
//        continues to render historical data because the toggle is
//        about new tracking, not destruction.
// Who:   streamers who do not want participation tracked, or who want
//        to pause tracking during a hiatus without losing prior data.
//        Captured from 2026-05-11 streamer feedback.
// When:  on demand. Same idempotency contract as /server auto-heal,
//        no silent re-writes, explicit "already on / already off"
//        feedback on repeat invocations.
// Where: writes GuildConfig.leaderboardTrackingEnabled via
//        guildConfigStore.update. Read at runtime by ActivityTracker's
//        MessageReactionAdd and voiceStateUpdate handlers.
// How:   ① guildId gate; ② config existence gate; ③ idempotent write
//        with a clear note that historical data remains visible so the
//        admin does not panic about leaderboard accuracy after a flip.

/** The options this handler reads, added to the merged command's subcommand. */
export function addLeaderboardTrackingOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub
		.addBooleanOption((option) =>
			option
				.setName("enabled")
				.setDescription("True to keep tracking new participation, false to pause new writes")
				.setRequired(true)
		);
}

export async function configureLeaderboardTracking(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
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
		await interaction.reply({
			embeds: [errorEmbed("This server has not been set up yet. Run /setup first.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (config.leaderboardTrackingEnabled === enabled) {
		// Idempotent on the toggle itself, but the admin may have run this
		// to GET the channel-removal button rather than to flip the flag.
		// When the request is "already off" AND the channel still exists,
		// surface the Remove button anyway. The toggle does not move; the
		// affordance does. Without this, an admin who clicked away from the
		// original ephemeral reply has no path to the button short of
		// flipping the toggle on and back off.
		const offerRemoveButton = !enabled && Boolean(config.leaderboardChannelId);
		const body = offerRemoveButton
			? `Participation tracking is already OFF. No change made.\n\nIf you also want to remove the leaderboard channel itself, click the button below. The channel can be restored later by re-enabling tracking with auto-heal on.`
			: `Participation tracking is already ${enabled ? "ON" : "OFF"}. No change made.`;

		const components = offerRemoveButton
			? [
					new ActionRowBuilder<ButtonBuilder>().addComponents(
						new ButtonBuilder()
							.setCustomId(buildLeaderboardChannelDeleteCustomId(guildId))
							.setLabel("Remove leaderboard channel")
							.setStyle(ButtonStyle.Danger)
					),
			  ]
			: undefined;

		await interaction.reply({
			embeds: [
				infoEmbed(
					"Leaderboard tracking already that way",
					body,
					COLORS.SCHEDULE
				),
			],
			components,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		// On enable, also clear the leaderboard slot from userRemovedChannels
		// if it was previously flagged. The flag was set by the channel-delete
		// button to suppress auto-heal rebuilds; clearing it on toggle-on
		// means the next boot sweep (or the next /setup) rebuilds the channel.
		// Without this clearing step, the admin would re-enable tracking but
		// the channel would stay gone permanently, which contradicts the
		// "toggle is reversible" promise.
		const removedSlots = new Set<string>(
			(config as unknown as { userRemovedChannels?: string[] }).userRemovedChannels ?? []
		);
		const slotWasFlagged = removedSlots.has("leaderboardChannelId");
		const updatePayload: Record<string, unknown> = { leaderboardTrackingEnabled: enabled };
		if (enabled && slotWasFlagged) {
			removedSlots.delete("leaderboardChannelId");
			updatePayload.userRemovedChannels = Array.from(removedSlots);
		}
		await guildConfigStore.update(guildId, updatePayload);
		adminLog.emitFor(interaction, guildId, "config.change", { subject: setupCopy.adminLog.subjects.leaderboardTracking, detail: enabled ? setupCopy.adminLog.on : setupCopy.adminLog.off });
		const heading = enabled ? "📊 Leaderboard tracking ON" : "⏸️ Leaderboard tracking OFF";

		// Body copy diverges per branch. The toggle-OFF path additionally
		// offers a follow-up button to remove the leaderboard channel
		// itself, useful for streamers who want the feature fully gone,
		// not just paused. The toggle-ON path mentions channel rebuild so
		// the admin knows what to expect if they deleted the channel
		// previously.
		const channelMissing = !config.leaderboardChannelId;
		let body: string;
		if (enabled) {
			body = channelMissing
				? "The bot will record ✅ reactions and voice-channel joins as participation. The leaderboard channel itself is currently removed; auto-heal will rebuild it on the next boot sweep (or when /setup runs) as long as autoHealEnabled is on."
				: "The bot will record ✅ reactions and voice-channel joins as participation. This is the default behavior.";
		} else {
			body =
				"The bot will no longer record new participation. Existing /leaderboard data stays visible, this toggle stops new writes, it does not delete history. Run this command again with `enabled:True` to resume tracking.\n\nIf you also want to remove the leaderboard channel itself, click the button below. The channel can be restored later by re-enabling tracking with auto-heal on.";
		}

		// Build the components row only when we have a button to attach.
		// Discord rejects empty ActionRows, so guarding here keeps the
		// payload valid in both branches.
		const components =
			!enabled && !channelMissing
				? [
						new ActionRowBuilder<ButtonBuilder>().addComponents(
							new ButtonBuilder()
								.setCustomId(buildLeaderboardChannelDeleteCustomId(guildId))
								.setLabel("Remove leaderboard channel")
								.setStyle(ButtonStyle.Danger)
						),
				  ]
				: undefined;

		await interaction.reply({
			embeds: [infoEmbed(heading, body, COLORS.SCHEDULE)],
			components,
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		console.error("[configure leaderboard-tracking] update failed", err);
		await interaction.reply({
			embeds: [errorEmbed("Could not save the toggle. Try again or check the bot's logs.")],
			flags: MessageFlags.Ephemeral,
		});
	}
}
