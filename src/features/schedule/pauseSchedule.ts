import { MessageFlags, type RepliableInteraction } from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import type { CommandOptionReader, OptionChoice } from "@handlers/commandOptions.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";

// ── /schedule pause, one event ────────────────────────────────────────
// What:  flips event.paused to true, optionally with a pausedUntil date.
//        The schedule keeps existing in the DB (and on the schedule
//        board, with a paused tag) but ReminderScheduler skips its fire
//        decision until paused is cleared.
// Who:   /schedule pause when it names an event, and the admin guide's
//        /schedule button, which opens the same handler through a form.
//        Streamers and KvK admins both, anyone who needs to silence a
//        recurring event without losing the configuration.
// When:  on demand. The optional days arg lets the streamer say "pause
//        for two weeks" and the scheduler will auto-resume; omitting it
//        means "paused indefinitely, I'll come back and run /schedule resume".
// Where: writes the Event document via eventStore.update, then kicks a
//        schedule board refresh so the paused tag appears immediately.
// How:   ① the event choices list active events; ② days arg gates
//        on a sane range (1-90); ③ idempotent, if already paused we
//        report "already paused" rather than re-pausing silently.

const c = rokCommanderCopy.pauseSchedule;

/**
 * The events /schedule pause can name: every event not already paused. Read by the
 * command's autocomplete and by the admin form's event picker, so the two list the
 * same events.
 */
export async function pausableEventChoices(guildId: string): Promise<OptionChoice[]> {
	// Filter to NOT-paused events. Listing every event including already-paused
	// ones made the dropdown misleading: the streamer would see already-paused
	// schedules and either re-pause (idempotent no-op) or get confused about state.
	// Filtering here mirrors resumableEventChoices, which lists only paused events.
	const events = await eventStore.findByGuildId(guildId);
	return events.filter((e) => !e.paused).map((e) => ({ name: e.name, value: e.eventId }));
}

/** Pause the one event the `event` option names, for `days` days or until resumed. */
export async function pauseOneSchedule(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({ embeds: [errorEmbed("Run this in a server, not a DM.")], flags: MessageFlags.Ephemeral });
		return;
	}

	const eventId = options.getString("event", true);
	const days = options.getInteger("days", false);

	// findByIdInGuild scopes by guildId at the store layer so cross-guild access is
	// blocked whether we're hitting the local DB or the remote API. The legacy
	// event.guildId check is now redundant.
	const event = await eventStore.findByIdInGuild(eventId, guildId);
	if (!event) {
		// notFound is the one field in this namespace whose copy diverges by
		// pack (it names the list command), so resolve it against the guild's
		// config. The remaining pauseSchedule strings are identical across packs
		// and still read from the shim above. Config is loaded lazily here so the
		// happy path takes no extra read.
		const config = await guildConfigStore.findByGuildId(guildId);
		await interaction.reply({
			embeds: [errorEmbed(getPluginCopy(config).pauseSchedule.notFound)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Idempotency. If they re-pause an already paused event we surface
	// the "already paused" message rather than silently re-writing, the
	// streamer probably forgot they paused it last week.
	if (event.paused) {
		await interaction.reply({ embeds: [errorEmbed(c.alreadyPaused(event.name))], flags: MessageFlags.Ephemeral });
		return;
	}

	// Compute pausedUntil from the optional days arg. Anchored to "now"
	// (UTC, server clock) so the streamer running the command at noon
	// Friday with `days:7` gets a noon-Friday-next-week resume. The
	// scheduler does the auto-flip on the next cron tick at or after
	// pausedUntil, no per-event setTimeout needed.
	let pausedUntil: Date | null = null;
	if (days !== null) {
		pausedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
	}

	try {
		await eventStore.updateInGuild(event.eventId, guildId, { paused: true, pausedUntil });
		adminLog.emitFor(interaction, guildId, "schedule.update", {
			subject: event.name,
			detail: pausedUntil ? setupCopy.adminLog.pausedUntil(Math.floor(pausedUntil.getTime() / 1000)) : setupCopy.adminLog.paused,
			eventId: event.eventId,
		});

		const successText = pausedUntil
			? c.pausedUntil(event.name, Math.floor(pausedUntil.getTime() / 1000))
			: c.paused(event.name);

		await interaction.reply({
			embeds: [infoEmbed("⏸️ Schedule paused", successText, rokCommanderCopy.COLORS.SCHEDULE)],
			flags: MessageFlags.Ephemeral,
		});

		// Fire-and-forget board refresh so the paused tag renders right
		// away. Failure here is logged, not surfaced, the DB write is
		// the source of truth and the next refresh tick will catch up.
		refreshSchedule(interaction.client, guildId).catch((err) =>
			console.error(LOG_MESSAGES.schedule.refreshAfterRouteFailed("/schedule pause"), err)
		);
	} catch (err) {
		console.error("[schedule pause] update failed", err);
		await interaction.reply({ embeds: [errorEmbed(c.failed)], flags: MessageFlags.Ephemeral });
	}
}
