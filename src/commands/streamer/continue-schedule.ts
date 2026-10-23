import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	AutocompleteInteraction,
	MessageFlags,
} from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

// ── /continue-schedule ────────────────────────────────────────────────
// What:  clears event.paused (and pausedUntil) so the scheduler resumes
//        firing reminders on the next matching occurrence. Inverse of
//        /pause-schedule. Same autocomplete pattern.
// Who:   streamers and KvK admins resuming a previously paused event.
// When:  on demand, typically right when the streamer is back from
//        vacation. If they used /pause-schedule with a duration the
//        scheduler will auto-resume on its own; this command is for the
//        "resume early" or "resume an indefinite pause" case.
// Where: writes the Event document via eventStore.update, then kicks a
//        schedule board refresh so the paused tag disappears.
// How:   ① autocomplete shows only PAUSED events to keep the list short
//        and the choice obvious; ② idempotent, already-active events
//        report "already active" rather than silently no-op.

const c = rokCommanderCopy.pauseSchedule;

export const data = new SlashCommandBuilder()
	.setName("continue-schedule")
	.setDescription("Resume a paused recurring event")
	.addStringOption((option) =>
		option.setName("name").setDescription("Which schedule to resume").setRequired(true).setAutocomplete(true)
	);

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
	if (!interaction.guildId) {
		await interaction.respond([]);
		return;
	}
	// Filter to paused only. Listing every event would force the streamer
	// to scroll past schedules that are already active, and the natural
	// failure mode (selecting an active event) just shows "already
	// active", annoying but harmless. Scoping the list keeps the choice
	// space minimal for the common case.
	const events = await eventStore.findByGuildId(interaction.guildId);
	const paused = events.filter((e) => e.paused);
	await interaction.respond(paused.slice(0, 25).map((e) => ({ name: e.name, value: e.eventId })));
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({ embeds: [errorEmbed("Run this in a server, not a DM.")], flags: MessageFlags.Ephemeral });
		return;
	}

	const eventId = interaction.options.getString("name", true);
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
		await interaction.reply({
			embeds: [errorEmbed(getPluginCopy(config).pauseSchedule.notFound)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (!event.paused) {
		await interaction.reply({ embeds: [errorEmbed(c.alreadyActive(event.name))], flags: MessageFlags.Ephemeral });
		return;
	}

	try {
		// Clear both fields together. Leaving pausedUntil populated would
		// let a future "/pause-schedule" call accidentally re-use a stale
		// expiry. The scheduler's auto-resume check is also a no-op once
		// paused is false, but cleaner to drop both.
		await eventStore.updateInGuild(event.eventId, guildId, { paused: false, pausedUntil: null });

		await interaction.reply({
			embeds: [infoEmbed("▶️ Schedule resumed", c.resumed(event.name), rokCommanderCopy.COLORS.SCHEDULE)],
			flags: MessageFlags.Ephemeral,
		});

		refreshSchedule(interaction.client, guildId).catch((err) =>
			console.error(LOG_MESSAGES.schedule.refreshAfterRouteFailed("/continue-schedule"), err)
		);
	} catch (err) {
		console.error("[continue-schedule] update failed", err);
		await interaction.reply({ embeds: [errorEmbed(c.failed)], flags: MessageFlags.Ephemeral });
	}
}
