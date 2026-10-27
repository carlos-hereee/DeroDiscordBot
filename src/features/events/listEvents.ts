import type { RepliableInteraction } from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { listEventsEmbed } from "@utils/embedBuilder.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { getUpcomingOccurrences } from "@features/events/occurrenceCalculator.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";

// ── /events list ──────────────────────────────────────────────────────
// What:  every active event in this server, each with its next occurrence,
//        its cadence and a paused tag, in a private reply.
// Who:   any member (/events list is a member view; only /events delete is
//        gated), from the slash command or the admin guide's /events button.
// Where: reads the event store and the guild config; writes nothing. The pack
//        voice and the announcements channel both come from the one config read.

/** List this server's active events. Reads no option, so it takes only the interaction. */
export async function listEvents(interaction: RepliableInteraction): Promise<void> {
	const events = await eventStore.findByGuildId(interaction.guildId!);

	// Load the config up front: it both selects the copy pack for the
	// empty-state message below and feeds listEventsEmbed (pack voice +
	// announcements channel), so a single read serves both paths.
	const config = await guildConfigStore.findByGuildId(interaction.guildId!);

	if (!events.length) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.events, sections: [getPluginCopy(config).listEvents.noEvents] });
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

	// One field per event, which a notice modal cannot show, so the list posts in
	// 🎛️admin-controls (2026-10 item 257 Phase 5).
	await answerInChannel(interaction, "admin", { embeds: [listEventsEmbed(fields, announcementsChannelId, config)] }, { config });
}
