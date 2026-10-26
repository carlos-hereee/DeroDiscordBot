import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction, type RepliableInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { listEvents } from "@features/events/listEvents.js";
import { addDeleteEventOptions, deletableEventChoices, deleteEvent } from "@features/events/deleteEvent.js";
import { addKvkSeasonOptions, runKvkSeason } from "@features/events/kvkSeasonSubcommand.js";
import { addPauseScheduleOptions, addResumeScheduleOptions, runScheduleSubcommand, scheduleEventChoices } from "@features/schedule/scheduleSubcommands.js";
import { addStreamSubcommands, runStreamSubcommand, streamAutocomplete } from "@features/schedule/streamSubcommands.js";
import type { CommandOptionReader, FormChoicesProvider, OptionChoice } from "@handlers/commandOptions.js";

// ── /events ───────────────────────────────────────────────────────────
// What:  everything about a server's events in one command: `list` and `delete`,
//        `pause` and `resume` for reminders, the `stream` group (announce, soon,
//        weekly) and `kvk-season`, the Rise of Kingdoms season builder.
// Who:   `list` is a MEMBER view: BOT_CONSTANTS.ADMIN_COMMANDS gates all of /events
//        and MEMBER_SUBCOMMANDS opens that one leaf back up. Every other leaf runs
//        for admins only, from the slash command or the /events button on the admin
//        guide, through this same `run`.
// Where: every handler lives in its feature (features/events, features/schedule);
//        this file only declares the tree and dispatches, so the two doors cannot drift.

export const data = new SlashCommandBuilder()
	.setName("events")
	.setDescription("This server's events: list, delete, pause or resume reminders, streams and the KvK season")
	.addSubcommand((sub) => sub.setName("list").setDescription("List all active events configured for this server"))
	.addSubcommand((sub) => addDeleteEventOptions(sub.setName("delete").setDescription("Delete an active event and stop its reminders")))
	.addSubcommand((sub) => addPauseScheduleOptions(sub.setName("pause").setDescription("Pause reminders without deleting anything. No event pauses every event.")))
	.addSubcommand((sub) => addResumeScheduleOptions(sub.setName("resume").setDescription("Resume paused reminders. No event resumes every paused event.")))
	.addSubcommandGroup((group) => addStreamSubcommands(group.setName("stream").setDescription("Announce a stream: a one-off, a quick going-live post, or a weekly reminder")))
	.addSubcommand((sub) => addKvkSeasonOptions(sub.setName("kvk-season").setDescription("ROK specific: prebuilt event reminders for a KvK season")));

/** The one handler the slash command and the admin guide's /events button share. */
export async function run(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	if (options.getSubcommandGroup(false) === "stream") {
		await runStreamSubcommand(interaction, options);
		return;
	}
	const subcommand = options.getSubcommand(true);
	switch (subcommand) {
		case "list":
			await listEvents(interaction);
			return;
		case "pause":
		case "resume":
			await runScheduleSubcommand(interaction, options, subcommand);
			return;
		case "kvk-season":
			await runKvkSeason(interaction, options);
			return;
		default:
			await deleteEvent(interaction, options);
	}
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await run(interaction, interaction.options);
}

// The event picks each leaf offers: delete lists every active event, pause the ones
// still running and resume the paused ones. Anything else picks nothing.
async function eventChoices(guildId: string, subcommand: string): Promise<OptionChoice[]> {
	if (subcommand === "delete") return deletableEventChoices(guildId, "");
	if (subcommand === "pause" || subcommand === "resume") return scheduleEventChoices(guildId, subcommand);
	return [];
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
	if (interaction.options.getSubcommandGroup(false) === "stream") {
		await streamAutocomplete(interaction);
		return;
	}
	if (!interaction.guildId) {
		await interaction.respond([]);
		return;
	}
	const subcommand = interaction.options.getSubcommand();
	// delete narrows by what the admin typed; pause and resume list their whole set.
	const choices =
		subcommand === "delete"
			? await deletableEventChoices(interaction.guildId, interaction.options.getFocused())
			: await eventChoices(interaction.guildId, subcommand);
	await interaction.respond(choices.slice(0, BOT_CONSTANTS.DISCORD_LIMITS.MAX_SELECT_OPTIONS));
}

// The stream group's timezone stays a typed field in the admin form: a select cannot
// narrow through hundreds of zones as the admin types, and the handler validates it.
export const formChoices: FormChoicesProvider = async (guild, leafPath, optionName) =>
	optionName === "event" ? eventChoices(guild.id, leafPath) : null;
