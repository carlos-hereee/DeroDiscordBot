import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	AutocompleteInteraction,
	ComponentType,
	ButtonBuilder,
	ButtonStyle,
	ActionRowBuilder,
	MessageFlags,
} from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { infoEmbed, errorEmbed } from "@utils/embedBuilder.js";

const c = rokCommanderCopy.deleteEvent;

export const data = new SlashCommandBuilder()
	.setName("delete-event")
	.setDescription("Delete an active KvK event and stop its reminders")
	.addStringOption((option) =>
		option.setName("event").setDescription("The event to delete").setRequired(true).setAutocomplete(true)
	);

// ── autocomplete ─────────────────────────────────────────────
// What:  surface the active events in this guild as the user types,
//        ranked by case-insensitive substring match against the
//        focused input value.
// Who:   Discord's autocomplete pipeline. The user sees the event
//        NAME in the picker; the option's `value` (sent to execute)
//        is the eventId, so the existing eventStore.findByIdInGuild
//        path stays unchanged.
// When:  per keystroke in the `event` option.
// Where: Discord caps autocomplete responses at 25 entries; we slice
//        defensively even when the underlying findByGuildId returns
//        fewer than 25 today, so this still behaves when a guild
//        accumulates a long event list later.
// How:   ① fetch all active events for the guild via eventStore.
//        ② lowercase the focused value and the candidate names so
//          the match is case-insensitive.
//        ③ filter by substring. Substring (not prefix) so a streamer
//          looking for "Friday Night Stream" finds it by typing
//          "friday" or "stream".
//        ④ slice to 25, map to { name, value } pairs, respond.
//        Empty array is fine; Discord renders "No matches found."
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
	const focused = interaction.options.getFocused().toLowerCase();
	const events = await eventStore.findByGuildId(interaction.guildId!);
	const matches = events
		.filter((e) => e.name.toLowerCase().includes(focused))
		.slice(0, 25)
		.map((e) => ({ name: e.name, value: e.eventId }));
	await interaction.respond(matches);
}

// ── execute ──────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({ embeds: [errorEmbed("Run this in a server, not a DM.")], flags: MessageFlags.Ephemeral });
		return;
	}

	const eventId = interaction.options.getString("event", true);
	// findByIdInGuild applies the guild scope at the store layer so the redundant
	// guildId check below has been removed.
	const event = await eventStore.findByIdInGuild(eventId, guildId);

	if (!event) {
		await interaction.reply({
			embeds: [errorEmbed(c.notFound(eventId))],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// ── confirmation step ────────────────────────────────────
	const confirm = new ButtonBuilder().setCustomId("confirm_delete").setLabel("Delete").setStyle(ButtonStyle.Danger);

	const cancel = new ButtonBuilder().setCustomId("cancel_delete").setLabel("Cancel").setStyle(ButtonStyle.Secondary);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(cancel, confirm);

	const confirmMessage = await interaction.reply({
		embeds: [infoEmbed(c.confirmTitle, c.confirmDescription(event.name), rokCommanderCopy.COLORS.ERROR)],
		components: [row],
		flags: MessageFlags.Ephemeral,
	});

	try {
		const button = await confirmMessage.awaitMessageComponent({
			componentType: ComponentType.Button,
			time: 60_000,
		});

		if (button.customId === "cancel_delete") {
			await button.update({ embeds: [errorEmbed(c.cancelled)], components: [] });
			return;
		}

		// confirmed, soft delete
		await eventStore.deleteInGuild(event.eventId, guildId);
		await button.update({
			embeds: [infoEmbed(c.confirmTitle, c.successDescription(event.name), rokCommanderCopy.COLORS.SCHEDULE)],
			components: [],
		});
	} catch {
		// awaitMessageComponent throws on timeout
		await interaction.editReply({ embeds: [errorEmbed(c.timedOut)], components: [] });
	}
}
