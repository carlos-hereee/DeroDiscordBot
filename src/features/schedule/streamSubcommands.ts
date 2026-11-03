import type { AutocompleteInteraction, RepliableInteraction, SlashCommandSubcommandGroupBuilder } from "discord.js";
import { addAnnounceStreamOptions, announceStream } from "@features/schedule/announceStream.js";
import { addGoLiveSoonOptions, goLiveSoon } from "@features/schedule/goLiveSoon.js";
import { addStreamScheduleOptions, configureStreamSchedule, timezoneChoices } from "@features/schedule/configureStreamSchedule.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";

// ── /events stream ───────────────────────────────────────────────────────────
// What:  the streamer's three announcement tools as one subcommand group:
//        `announce` schedules a one-off stream at a set date and time, `soon`
//        posts a quick going-live heads-up with no reminder, and `weekly` creates
//        a weekly recurring reminder.
// Who:   commands/admin/events.ts adds this group to /events and dispatches it
//        here, from the slash command or the /events button on the admin guide.
//        Admins only, through /events in BOT_CONSTANTS.ADMIN_COMMANDS.
// Where: each subcommand's options and handler live together in features/schedule,
//        so the option a handler reads is declared beside it. `weekly` is named
//        for what it sets, a reminder that repeats every week.

/** The /events stream group's three subcommands. */
export function addStreamSubcommands(group: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder {
	return group
		.addSubcommand((sub) =>
			addAnnounceStreamOptions(sub.setName("announce").setDescription("Schedule a one-off stream announcement at a specific future date/time"))
		)
		.addSubcommand((sub) =>
			addGoLiveSoonOptions(sub.setName("soon").setDescription("Post a quick going-live announcement (one-shot, no recurring reminder)"))
		)
		.addSubcommand((sub) =>
			addStreamScheduleOptions(sub.setName("weekly").setDescription("Set up a weekly stream / event reminder on a fixed day and time"))
		);
}

/** Runs one /events stream subcommand. */
export async function runStreamSubcommand(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	switch (options.getSubcommand(true)) {
		case "announce":
			await announceStream(interaction, options);
			return;
		case "soon":
			await goLiveSoon(interaction, options);
			return;
		default:
			await configureStreamSchedule(interaction, options);
	}
}

// Only `weekly`'s timezone autocompletes; anything else answers nothing rather
// than suggestions that do not belong to the option.
export async function streamAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
	const focused = interaction.options.getFocused(true);
	if (focused.name !== "timezone") {
		await interaction.respond([]);
		return;
	}
	await interaction.respond(timezoneChoices(focused.value));
}
