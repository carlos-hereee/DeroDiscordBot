import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction, type RepliableInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { pauseOneSchedule, pausableEventChoices } from "@features/schedule/pauseSchedule.js";
import { pauseAllSchedules } from "@features/schedule/pauseAllSchedules.js";
import { resumeOneSchedule, resumableEventChoices } from "@features/schedule/resumeSchedule.js";
import { resumeAllSchedules } from "@features/schedule/resumeAllSchedules.js";
import type { CommandOptionReader, FormChoicesProvider, OptionChoice } from "@handlers/commandOptions.js";

// ── /schedule ─────────────────────────────────────────────────────────
// What:  pause or resume a recurring event's reminders without deleting it.
//        `pause` and `resume` each take an optional event: naming one acts on
//        that event alone, leaving it empty acts on every event in the server.
// Who:   admins (BOT_CONSTANTS.ADMIN_COMMANDS), from the slash command or the
//        /schedule button on the admin guide, which runs this same `run`.
// Where: the four handlers live in features/schedule and are only dispatched
//        here, so the two doors cannot drift (2026-10 item 245 Phase 4b merged
//        pause-schedule, continue-schedule, pause-all-schedules and
//        continue-all-schedules into this one command).

const MAX_PAUSE_DAYS = 90;

export const data = new SlashCommandBuilder()
	.setName("schedule")
	.setDescription("Pause or resume reminders for one event, or for every event at once")
	.addSubcommand((sub) =>
		sub
			.setName("pause")
			.setDescription("Pause reminders without deleting anything. No event pauses every event.")
			.addStringOption((option) =>
				option.setName("event").setDescription("Which event to pause. Leave empty to pause every event.").setRequired(false).setAutocomplete(true)
			)
			.addIntegerOption((option) =>
				option
					.setName("days")
					.setDescription("Auto-resume after N days. Omit to pause until /schedule resume.")
					.setRequired(false)
					.setMinValue(1)
					.setMaxValue(MAX_PAUSE_DAYS)
			)
	)
	.addSubcommand((sub) =>
		sub
			.setName("resume")
			.setDescription("Resume paused reminders. No event resumes every paused event.")
			.addStringOption((option) =>
				option.setName("event").setDescription("Which event to resume. Leave empty to resume every paused event.").setRequired(false).setAutocomplete(true)
			)
	);

/** The one handler the slash command and the admin guide's /schedule button share. */
export async function run(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const namesAnEvent = options.getString("event", false) !== null;
	if (options.getSubcommand(true) === "pause") {
		await (namesAnEvent ? pauseOneSchedule(interaction, options) : pauseAllSchedules(interaction, options));
		return;
	}
	await (namesAnEvent ? resumeOneSchedule(interaction, options) : resumeAllSchedules(interaction));
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await run(interaction, interaction.options);
}

async function eventChoices(guildId: string, subcommand: string): Promise<OptionChoice[]> {
	return subcommand === "pause" ? pausableEventChoices(guildId) : resumableEventChoices(guildId);
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
	if (!interaction.guildId) {
		await interaction.respond([]);
		return;
	}
	const choices = await eventChoices(interaction.guildId, interaction.options.getSubcommand());
	await interaction.respond(choices.slice(0, BOT_CONSTANTS.DISCORD_LIMITS.MAX_SELECT_OPTIONS));
}

/** The admin form's event picker reads the same lists the autocomplete answers with. */
export const formChoices: FormChoicesProvider = async (guild, leafPath, optionName) =>
	optionName === "event" ? eventChoices(guild.id, leafPath) : null;
