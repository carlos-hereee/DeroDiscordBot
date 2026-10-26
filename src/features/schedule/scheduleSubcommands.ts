import type { RepliableInteraction, SlashCommandSubcommandBuilder } from "discord.js";
import { pauseOneSchedule, pausableEventChoices } from "@features/schedule/pauseSchedule.js";
import { pauseAllSchedules } from "@features/schedule/pauseAllSchedules.js";
import { resumeOneSchedule, resumableEventChoices } from "@features/schedule/resumeSchedule.js";
import { resumeAllSchedules } from "@features/schedule/resumeAllSchedules.js";
import type { CommandOptionReader, OptionChoice } from "@handlers/commandOptions.js";

// ── /events pause and /events resume ─────────────────────────────────────────
// What:  pause or resume a recurring event's reminders without deleting it.
//        `pause` and `resume` each take an optional event: naming one acts on
//        that event alone, leaving it empty acts on every event in the server.
// Who:   commands/admin/events.ts adds these two subcommands to /events and
//        dispatches them here, from the slash command or the /events button on
//        the admin guide, through the same `run`. Admins only, through /events
//        in BOT_CONSTANTS.ADMIN_COMMANDS.
// Where: the four handlers live beside this file in features/schedule; this
//        module only declares the options and picks one, so the two doors cannot
//        drift. It exports no `data` or `execute`, so neither loader registers it.

const MAX_PAUSE_DAYS = 90;

/** The /events pause options: an optional event and an optional number of days. */
export function addPauseScheduleOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub
		.addStringOption((option) =>
			option.setName("event").setDescription("Which event to pause. Leave empty to pause every event.").setRequired(false).setAutocomplete(true)
		)
		.addIntegerOption((option) =>
			option
				.setName("days")
				.setDescription("Auto-resume after N days. Omit to pause until /events resume.")
				.setRequired(false)
				.setMinValue(1)
				.setMaxValue(MAX_PAUSE_DAYS)
		);
}

/** The /events resume option: an optional event. */
export function addResumeScheduleOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub.addStringOption((option) =>
		option.setName("event").setDescription("Which event to resume. Leave empty to resume every paused event.").setRequired(false).setAutocomplete(true)
	);
}

/** Runs /events pause or /events resume; `subcommand` is the leaf the caller dispatched on. */
export async function runScheduleSubcommand(interaction: RepliableInteraction, options: CommandOptionReader, subcommand: "pause" | "resume"): Promise<void> {
	const namesAnEvent = options.getString("event", false) !== null;
	if (subcommand === "pause") {
		await (namesAnEvent ? pauseOneSchedule(interaction, options) : pauseAllSchedules(interaction, options));
		return;
	}
	await (namesAnEvent ? resumeOneSchedule(interaction, options) : resumeAllSchedules(interaction));
}

/** The events pause offers (active ones) or resume offers (paused ones), for the autocomplete and the admin form alike. */
export async function scheduleEventChoices(guildId: string, subcommand: "pause" | "resume"): Promise<OptionChoice[]> {
	return subcommand === "pause" ? pausableEventChoices(guildId) : resumableEventChoices(guildId);
}
