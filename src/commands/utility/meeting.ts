import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getPluginCopy } from "@base/copy/index.js";
import { openScheduleMeetingModal } from "@features/meetings/scheduledMeetings.js";
import { showNotice } from "@utils/textModal.js";

// ── /meeting schedule (2026-11 item 388 Phase 2) ──
// Opens the schedule modal (title, when) for a host, the same modal as Schedule a meeting on
// the 📝meeting-notes intro; the host rule is checked there (features/meetings/meetingHosts.ts).
// A member command rather than an admin one, because hosts include the roles allowed to give
// Dero tasks, which an admin gate would shut out. Start and end join it in Phase 3.

export const data = new SlashCommandBuilder()
	.setName("meeting")
	.setDescription("Schedule a meeting in 🏛️ Meeting Hall")
	.addSubcommand((sub) => sub.setName("schedule").setDescription("Schedule a meeting with reminders (hosts only)"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!interaction.inGuild()) {
		const words = getPluginCopy(null).todoReminders.meetings;
		await showNotice(interaction, { title: words.noticeTitle, sections: [words.guildOnly] });
		return;
	}
	await openScheduleMeetingModal(interaction);
}
