import { type RepliableInteraction } from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { showErrorNotice, showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { answerInChannel } from "@utils/answerInChannel.js";

// /events resume with no event, the bulk equivalent of resumeOneSchedule.
// Resumes every paused event in the guild, including ones that had a
// pausedUntil set. The intent of running this is "everything back on right
// now", so clearing pausedUntil alongside paused is correct.

const c = rokCommanderCopy.continueAllSchedules;

/** Resume every paused event in the guild. Reads no option, so it takes only the interaction. */
export async function resumeAllSchedules(interaction: RepliableInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: ["Run this in a server, not a DM."] });
		return;
	}

	const events = await eventStore.findByGuildId(guildId);
	if (events.length === 0) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: [c.noEvents] });
		return;
	}

	const toResume = events.filter((e) => e.paused);
	if (toResume.length === 0) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: [c.noneCurrentlyPaused] });
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
		console.error(LOG_MESSAGES.schedule.refreshAfterRouteFailed("/events resume"), err)
	);

	if (failed > 0 && succeeded === 0) {
		await showErrorNotice(interaction, c.failed);
		return;
	}

	// Some or all of the schedules changed: work done, an answer, so it posts in
	// 🛠️server-config and pings the admin who ran it (owner rule 1, 2026-10 item 263 R3-11).
	if (failed > 0) {
		await answerInChannel(interaction, "admin", { embeds: [infoEmbed("▶️ Partially resumed", c.partialFailure(succeeded, failed), rokCommanderCopy.COLORS.SCHEDULE)] });
		return;
	}

	await answerInChannel(interaction, "admin", { embeds: [infoEmbed("▶️ All schedules resumed", c.resumed(succeeded), rokCommanderCopy.COLORS.SCHEDULE)] });
}
