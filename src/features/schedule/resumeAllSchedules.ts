import { MessageFlags, type RepliableInteraction } from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";

// /schedule resume with no event, the bulk equivalent of resumeOneSchedule.
// Resumes every paused event in the guild, including ones that had a
// pausedUntil set. The intent of running this is "everything back on right
// now", so clearing pausedUntil alongside paused is correct.

const c = rokCommanderCopy.continueAllSchedules;

/** Resume every paused event in the guild. Reads no option, so it takes only the interaction. */
export async function resumeAllSchedules(interaction: RepliableInteraction): Promise<void> {
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
			// Clear both fields together, same reasoning as resumeOneSchedule:
			// leaving a stale pausedUntil around lets a future pause accidentally
			// re-use it.
			await eventStore.updateInGuild(event.eventId, guildId, { paused: false, pausedUntil: null });
			succeeded++;
		} catch (err) {
			failed++;
			console.error("[schedule resume all] update failed", { eventId: event.eventId }, err);
		}
	}

	if (succeeded > 0) adminLog.emitFor(interaction, guildId, "schedule.update", { subject: setupCopy.adminLog.allSchedules, detail: setupCopy.adminLog.resumedCount(succeeded) });

	refreshSchedule(interaction.client, guildId).catch((err) =>
		console.error(LOG_MESSAGES.schedule.refreshAfterRouteFailed("/schedule resume"), err)
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
