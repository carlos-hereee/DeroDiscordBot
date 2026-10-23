import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction, type RepliableInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { listEvents } from "@features/events/listEvents.js";
import { addDeleteEventOptions, deletableEventChoices, deleteEvent } from "@features/events/deleteEvent.js";
import type { CommandOptionReader, FormChoicesProvider } from "@handlers/commandOptions.js";

// ── /events ───────────────────────────────────────────────────────────
// What:  `list` shows every active event in this server; `delete` removes
//        one and stops its reminders.
// Who:   `list` is a MEMBER view, so the command as a whole is not in
//        BOT_CONSTANTS.ADMIN_COMMANDS; only "events delete" is, which gates
//        that one subcommand. Both run from the slash command or from the
//        /events button on the admin guide, through this same `run`.
// Where: 2026-10 item 245 Phase 4b merged list-events and delete-event; their
//        handlers live in features/events.

export const data = new SlashCommandBuilder()
	.setName("events")
	.setDescription("List this server's events, or delete one")
	.addSubcommand((sub) => sub.setName("list").setDescription("List all active events configured for this server"))
	.addSubcommand((sub) => addDeleteEventOptions(sub.setName("delete").setDescription("Delete an active event and stop its reminders")));

/** The one handler the slash command and the admin guide's /events button share. */
export async function run(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	if (options.getSubcommand(true) === "list") {
		await listEvents(interaction);
		return;
	}
	await deleteEvent(interaction, options);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await run(interaction, interaction.options);
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
	if (!interaction.guildId) {
		await interaction.respond([]);
		return;
	}
	const choices = await deletableEventChoices(interaction.guildId, interaction.options.getFocused());
	await interaction.respond(choices.slice(0, BOT_CONSTANTS.DISCORD_LIMITS.MAX_SELECT_OPTIONS));
}

export const formChoices: FormChoicesProvider = async (guild, _leafPath, optionName) =>
	optionName === "event" ? deletableEventChoices(guild.id, "") : null;
