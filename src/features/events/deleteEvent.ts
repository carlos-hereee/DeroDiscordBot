import {
	ButtonBuilder,
	ButtonStyle,
	ActionRowBuilder,
	type RepliableInteraction,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { infoEmbed, errorEmbed } from "@utils/embedBuilder.js";
import type { CommandOptionReader, OptionChoice } from "@handlers/commandOptions.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { askInChannel } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

// ── deleting an event ─────────────────────────────────────────────────
// What:  soft deletes one active event after a private Delete or Cancel
//        confirm, so its reminders stop. Nothing else is touched.
// Who:   /events delete (the slash command) and the admin guide's /events
//        button, both through deleteEvent below; the event choices feed the
//        command's autocomplete and the button's event picker alike.

const c = rokCommanderCopy.deleteEvent;

/** The options this handler reads, added to the merged command's subcommand. */
export function addDeleteEventOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub
		.addStringOption((option) =>
			option.setName("event").setDescription("The event to delete").setRequired(true).setAutocomplete(true)
		);
}

// ── event choices ────────────────────────────────────────────
// What:  the active events in this guild, ranked by case-insensitive
//        substring match against what the admin typed so far.
// Who:   /events delete's autocomplete (per keystroke) and the admin
//        form's event picker (typed is "" there, so every event). The
//        user sees the event NAME; the value the handler reads is the
//        eventId, so eventStore.findByIdInGuild stays the lookup.
// Where: Discord caps an autocomplete answer and a select alike at 25
//        entries; the caller slices, so this returns every match.
// How:   ① fetch all active events for the guild via eventStore.
//        ② lowercase the typed value and the candidate names so
//          the match is case-insensitive.
//        ③ filter by substring. Substring (not prefix) so a streamer
//          looking for "Friday Night Stream" finds it by typing
//          "friday" or "stream".
//        An empty list is fine; Discord renders "No matches found."
export async function deletableEventChoices(guildId: string, typed: string): Promise<OptionChoice[]> {
	const focused = typed.toLowerCase();
	const events = await eventStore.findByGuildId(guildId);
	return events.filter((e) => e.name.toLowerCase().includes(focused)).map((e) => ({ name: e.name, value: e.eventId }));
}

/** Delete the event the `event` option names, behind the "events delete" entry in ADMIN_COMMANDS. */
export async function deleteEvent(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.events, sections: ["Run this in a server, not a DM."] });
		return;
	}

	const eventId = options.getString("event", true);
	// findByIdInGuild applies the guild scope at the store layer so the redundant
	// guildId check below has been removed.
	const event = await eventStore.findByIdInGuild(eventId, guildId);

	if (!event) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.events, sections: [c.notFound(eventId)] });
		return;
	}

	// ── confirmation step ────────────────────────────────────
	const confirm = new ButtonBuilder().setCustomId("confirm_delete").setLabel("Delete").setStyle(ButtonStyle.Danger);

	const cancel = new ButtonBuilder().setCustomId("cancel_delete").setLabel("Cancel").setStyle(ButtonStyle.Secondary);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(cancel, confirm);

	// Posted in 🛠️server-config (2026-10 item 257 Phase 5); only this admin's press counts.
	const prompt = await askInChannel(interaction, "admin", {
		embeds: [infoEmbed(c.confirmTitle, c.confirmDescription(event.name), rokCommanderCopy.COLORS.ERROR)],
		components: [row],
	});

	try {
		const button = await prompt.awaitPress(60_000);
		if (!button) throw new Error("the delete prompt timed out");

		if (button.customId === "cancel_delete") {
			await button.update({ embeds: [errorEmbed(c.cancelled)], components: [] });
			return;
		}

		// confirmed, soft delete
		await eventStore.deleteInGuild(event.eventId, guildId);
		adminLog.emitFor(interaction, guildId, "event.delete", { subject: event.name, detail: setupCopy.adminLog.deleted, eventId: event.eventId });
		await button.update({
			embeds: [infoEmbed(c.confirmTitle, c.successDescription(event.name), rokCommanderCopy.COLORS.SCHEDULE)],
			components: [],
		});
	} catch {
		// A timeout, or a write that threw: the prompt is rewritten either way, so a stale
		// Delete can never be pressed into a deletion later.
		await prompt.edit({ embeds: [errorEmbed(c.timedOut)], components: [] });
	}
}
