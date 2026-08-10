import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { listEventsEmbed } from "@utils/embedBuilder.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { getUpcomingOccurrences } from "@features/events/occurrenceCalculator.js";

export const data = new SlashCommandBuilder()
	.setName("list-events")
	.setDescription("List all active events configured for this server");

export async function execute(interaction: ChatInputCommandInteraction) {
	const events = await eventStore.findByGuildId(interaction.guildId!);

	// Load the config up front: it both selects the copy pack for the
	// empty-state message below and feeds listEventsEmbed (pack voice +
	// announcements channel), so a single read serves both paths.
	const config = await guildConfigStore.findByGuildId(interaction.guildId!);

	if (!events.length) {
		await interaction.reply({
			content: getPluginCopy(config).listEvents.noEvents,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// reminders always post to the guild's announcements channel, so resolve
	// it once and hand it to the embed to render in the description. the rows
	// themselves no longer carry a channel, because per event overrides were
	// removed from the data model.
	const announcementsChannelId = config?.announcementsChannelId ?? null;

	const fields = events.map((event) => {
		let nextOccurrenceTs: number;

		if (event.type === "one-time") {
			// use firstOccurrence directly, no interval math needed
			nextOccurrenceTs = Math.floor(new Date(event.firstOccurrence).getTime() / 1000);
		} else {
			const [next] = getUpcomingOccurrences(event as any, 1);
			// fall back to firstOccurrence if season ended and no future occurrence exists
			nextOccurrenceTs = Math.floor((next ?? new Date(event.firstOccurrence)).getTime() / 1000);
		}

		// Regular announcements have no seasonEnd. Send null through to the
		// embed so it hides the "Season ends" line for that row instead of
		// rendering an Invalid Date string from a null Date.
		const seasonEndTs = event.seasonEnd ? Math.floor(new Date(event.seasonEnd).getTime() / 1000) : null;

		// Pass pause state straight through so the embed can render the
		// "⏸️ paused" tag. The schedule arithmetic above still runs even
		// for paused events, paused only suppresses reminder firing, not
		// the occurrence calculation, so "would have fired" timestamps
		// stay informative for the admin scanning the list.
		const pausedUntilTs = event.pausedUntil ? Math.floor(new Date(event.pausedUntil).getTime() / 1000) : null;

		return {
			name: event.name,
			type: event.type as "recurring" | "one-time",
			nextOccurrenceTs,
			intervalHours: event.type === "recurring" ? event.intervalHours : null,
			seasonEndTs,
			paused: Boolean(event.paused),
			pausedUntilTs,
		};
	});

	await interaction.reply({
		embeds: [listEventsEmbed(fields, announcementsChannelId, config)],
		flags: MessageFlags.Ephemeral,
	});
}
