import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	PermissionFlagsBits,
	MessageFlags,
} from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

// /continue-all-schedules, bulk equivalent of /continue-schedule. Resumes
// every paused event in the guild, including ones that had a pausedUntil
// set. The intent of running this command is "everything back on right
// now", so clearing pausedUntil alongside paused is correct.

const c = rokCommanderCopy.continueAllSchedules;

export const data = new SlashCommandBuilder()
	.setName("continue-all-schedules")
	.setDescription("Resume every paused schedule on this server at once")
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({ embeds: [errorEmbed("Run this in a server, not a DM.")], flags: MessageFlags.Ephemeral });
		return;
	}

	const events = await eventStore.findByGuildId(guildId);
	if (events.length === 0) {
		await interaction.reply({ embeds: [errorEmbed(c.noEvents)], flags: MessageFlags.Ephemeral });
		return;
	}

	const toResume = events.filter((e) => e.paused);
	if (toResume.length === 0) {
		await interaction.reply({ embeds: [errorEmbed(c.noneCurrentlyPaused)], flags: MessageFlags.Ephemeral });
		return;
	}

	// Per-event try/catch so a single failed write does not abort the batch.
	let succeeded = 0;
	let failed = 0;
	for (const event of toResume) {
		try {
			// Clear both fields together, same reasoning as /continue-schedule:
			// leaving a stale pausedUntil around lets a future pause accidentally
			// re-use it.
			await eventStore.updateInGuild(event.eventId, guildId, { paused: false, pausedUntil: null });
			succeeded++;
		} catch (err) {
			failed++;
			console.error("[continue-all-schedules] update failed", { eventId: event.eventId }, err);
		}
	}

	refreshSchedule(interaction.client, guildId).catch((err) =>
		console.error(LOG_MESSAGES.schedule.refreshAfterRouteFailed("/continue-all-schedules"), err)
	);

	if (failed > 0 && succeeded === 0) {
		await interaction.reply({ embeds: [errorEmbed(c.failed)], flags: MessageFlags.Ephemeral });
		return;
	}

	if (failed > 0) {
		await interaction.reply({
			embeds: [infoEmbed("▶️ Partially resumed", c.partialFailure(succeeded, failed), rokCommanderCopy.COLORS.SCHEDULE)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.reply({
		embeds: [infoEmbed("▶️ All schedules resumed", c.resumed(succeeded), rokCommanderCopy.COLORS.SCHEDULE)],
		flags: MessageFlags.Ephemeral,
	});
}
