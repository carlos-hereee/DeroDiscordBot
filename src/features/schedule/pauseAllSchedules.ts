import { type RepliableInteraction } from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { showErrorNotice, showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { answerInChannel } from "@utils/answerInChannel.js";

// /events pause with no event, the bulk equivalent of pauseOneSchedule.
// Pauses every non-paused event in the guild in one shot. Already-paused
// events are skipped on purpose so any pausedUntil the streamer set
// individually earlier (e.g. /events pause event:X days:14) stays intact
// and is not overwritten by a guild-wide days argument.

const c = rokCommanderCopy.pauseAllSchedules;

/** Pause every event in the guild that is not already paused, for `days` days or until resumed. */
export async function pauseAllSchedules(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: ["Run this in a server, not a DM."] });
		return;
	}

	const days = options.getInteger("days", false);

	const events = await eventStore.findByGuildId(guildId);
	if (events.length === 0) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: [c.noEvents] });
		return;
	}

	// Partition before the writes so the success message can report skipped
	// counts honestly. Already-paused events get skipped to preserve any
	// per-event pausedUntil the streamer set earlier with /events pause.
	const toPause = events.filter((e) => !e.paused);
	const alreadyPaused = events.length - toPause.length;

	if (toPause.length === 0) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: [c.allAlreadyPaused(events.length)] });
		return;
	}

	// Compute pausedUntil once and reuse across all writes. Anchoring every
	// event to the same "now" keeps the resume cohort tidy: when the auto-
	// resume tick comes around they all flip back together.
	let pausedUntil: Date | null = null;
	if (days !== null) {
		pausedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
	}

	// Per-event try/catch so a single failed write does not abort the batch.
	// Partial-failure path surfaces the count split rather than pretending
	// success.
	let succeeded = 0;
	let failed = 0;
	for (const event of toPause) {
		try {
			await eventStore.updateInGuild(event.eventId, guildId, { paused: true, pausedUntil });
			succeeded++;
		} catch (err) {
			failed++;
			console.error("[schedule pause all] update failed", { eventId: event.eventId }, err);
		}
	}

	if (succeeded > 0) adminLog.emitFor(interaction, guildId, "schedule.update", { subject: setupCopy.adminLog.allSchedules, detail: setupCopy.adminLog.pausedCount(succeeded) });

	// Fire-and-forget board refresh so paused tags render right away.
	refreshSchedule(interaction.client, guildId).catch((err) =>
		console.error(LOG_MESSAGES.schedule.refreshAfterRouteFailed("/events pause"), err)
	);

	if (failed > 0 && succeeded === 0) {
		await showErrorNotice(interaction, c.failed);
		return;
	}

	// Some or all of the schedules changed: work done, an answer, so it posts in
	// 🎛️admin-controls and pings the admin who ran it (owner rule 1, 2026-10 item 263 R3-11).
	if (failed > 0) {
		await answerInChannel(interaction, "admin", { embeds: [infoEmbed("⏸️ Partially paused", c.partialFailure(succeeded, failed), rokCommanderCopy.COLORS.SCHEDULE)] });
		return;
	}

	const successText = pausedUntil
		? c.pausedUntil(succeeded, alreadyPaused, Math.floor(pausedUntil.getTime() / 1000))
		: c.paused(succeeded, alreadyPaused);

	await answerInChannel(interaction, "admin", { embeds: [infoEmbed("⏸️ All schedules paused", successText, rokCommanderCopy.COLORS.SCHEDULE)] });
}
