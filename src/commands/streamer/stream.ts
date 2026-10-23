import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction, type RepliableInteraction } from "discord.js";
import { addAnnounceStreamOptions, announceStream } from "@features/schedule/announceStream.js";
import { addGoLiveSoonOptions, goLiveSoon } from "@features/schedule/goLiveSoon.js";
import { addStreamScheduleOptions, configureStreamSchedule, timezoneChoices } from "@features/schedule/configureStreamSchedule.js";
import type { CommandOptionReader, FormChoicesProvider } from "@handlers/commandOptions.js";

// ── /stream ───────────────────────────────────────────────────────────
// What:  the streamer's three announcement tools under one command:
//        `announce` schedules a one-off stream at a set date and time,
//        `soon` posts a quick going-live heads-up with no reminder, and
//        `setup` creates a weekly recurring reminder.
// Who:   admins (BOT_CONSTANTS.ADMIN_COMMANDS), from the slash command or the
//        /stream button on the admin guide, which runs this same `run`.
// Where: each subcommand's options and handler live together in
//        features/schedule, so the option a handler reads is declared beside
//        it (2026-10 item 245 Phase 4b merged announce-stream, go-live-soon
//        and configure-stream-schedule into this one command).

export const data = new SlashCommandBuilder()
	.setName("stream")
	.setDescription("Announce a stream: a one-off, a quick going-live post, or a weekly schedule")
	.addSubcommand((sub) =>
		addAnnounceStreamOptions(sub.setName("announce").setDescription("Schedule a one-off stream announcement at a specific future date/time"))
	)
	.addSubcommand((sub) =>
		addGoLiveSoonOptions(sub.setName("soon").setDescription("Post a quick going-live announcement (one-shot, no recurring reminder)"))
	)
	.addSubcommand((sub) =>
		addStreamScheduleOptions(sub.setName("setup").setDescription("Set up a weekly stream / event reminder on a fixed day and time"))
	);

/** The one handler the slash command and the admin guide's /stream button share. */
export async function run(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
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

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await run(interaction, interaction.options);
}

// Only `setup`'s timezone autocompletes; anything else answers nothing rather
// than suggestions that do not belong to the option.
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
	const focused = interaction.options.getFocused(true);
	if (focused.name !== "timezone") {
		await interaction.respond([]);
		return;
	}
	await interaction.respond(timezoneChoices(focused.value));
}

// The timezone stays a typed field in the admin form: a select cannot narrow
// through hundreds of zones as the admin types, and the handler validates it.
export const formChoices: FormChoicesProvider = async () => null;
