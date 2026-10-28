import { type RepliableInteraction } from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import type { CommandOptionReader, OptionChoice } from "@handlers/commandOptions.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { showErrorNotice, showNotice } from "@utils/textModal.js";
import { answerInChannel } from "@utils/answerInChannel.js";

// ── /events resume, one event ───────────────────────────────────────
// What:  clears event.paused (and pausedUntil) so the scheduler resumes
//        firing reminders on the next matching occurrence. Inverse of
//        pauseOneSchedule. Same event choice pattern.
// Who:   /events resume when it names an event, and the admin guide's
//        /events button. Streamers and KvK admins resuming a previously
//        paused event.
// When:  on demand, typically right when the streamer is back from
//        vacation. If they paused with a duration the scheduler will
//        auto-resume on its own; this is for the "resume early" or
//        "resume an indefinite pause" case.
// Where: writes the Event document via eventStore.update, then kicks a
//        schedule board refresh so the paused tag disappears.
// How:   ① the event choices list only PAUSED events to keep the list short
//        and the choice obvious; ② idempotent, already-active events
//        report "already active" rather than silently no-op.

const c = rokCommanderCopy.pauseSchedule;

/**
 * The events /events resume can name: every paused event. Read by the command's
 * autocomplete and by the admin form's event picker.
 */
export async function resumableEventChoices(guildId: string): Promise<OptionChoice[]> {
	// Filter to paused only. Listing every event would force the streamer
	// to scroll past schedules that are already active, and the natural
	// failure mode (selecting an active event) just shows "already
	// active", annoying but harmless. Scoping the list keeps the choice
	// space minimal for the common case.
	const events = await eventStore.findByGuildId(guildId);
	return events.filter((e) => e.paused).map((e) => ({ name: e.name, value: e.eventId }));
}

/** Resume the one paused event the `event` option names. */
export async function resumeOneSchedule(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: ["Run this in a server, not a DM."] });
		return;
	}

	const eventId = options.getString("event", true);
	// findByIdInGuild scopes by guildId at the store layer so cross-guild access is
	// blocked whether we're hitting the local DB or the remote API. The redundant
	// event.guildId check below is gone, the store guarantees a guild match.
	const event = await eventStore.findByIdInGuild(eventId, guildId);

	if (!event) {
		// notFound is the one field in this namespace whose copy diverges by
		// pack (it names the list command), so resolve it against the guild's
		// config. The remaining pauseSchedule strings are identical across packs
		// and still read from the shim above. Config is loaded lazily here so the
		// happy path takes no extra read.
		const config = await guildConfigStore.findByGuildId(guildId);
		await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: [getPluginCopy(config).pauseSchedule.notFound] });
		return;
	}

	if (!event.paused) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: [c.alreadyActive(event.name)] });
		return;
	}

	try {
		// Clear both fields together. Leaving pausedUntil populated would
		// let a future pause accidentally re-use a stale expiry. The
		// scheduler's auto-resume check is also a no-op once paused is
		// false, but cleaner to drop both.
		await eventStore.updateInGuild(event.eventId, guildId, { paused: false, pausedUntil: null });
		adminLog.emitFor(interaction, guildId, "schedule.update", { subject: event.name, detail: setupCopy.adminLog.resumed, eventId: event.eventId });

		// A confirmation of work done is an answer, so it posts in 🛠️server-config and pings the admin who ran it (owner rule 1, 2026-10 item 263 R3-11).
		await answerInChannel(interaction, "admin", { embeds: [infoEmbed("▶️ Schedule resumed", c.resumed(event.name), rokCommanderCopy.COLORS.SCHEDULE)] });

		refreshSchedule(interaction.client, guildId).catch((err) =>
			console.error(LOG_MESSAGES.schedule.refreshAfterRouteFailed("/events resume"), err)
		);
	} catch (err) {
		console.error("[schedule resume] update failed", err);
		await showErrorNotice(interaction, c.failed);
	}
}
