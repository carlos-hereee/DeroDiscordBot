import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy } from "@base/copy/index.js";
import { pressEndRecording, pressStartRecording } from "@features/meetings/meetingLifecycle.js";
import { openScheduleMeetingModal } from "@features/meetings/scheduledMeetings.js";
import { showNotice } from "@utils/textModal.js";

// ── /meeting schedule, start and end (2026-11 item 388 Phases 2 and 3) ──
// schedule opens the schedule modal (title, when), the same modal as Schedule a meeting on the
// 📝meeting-notes intro. start records 🏛️ Meeting Hall now, exactly as Start recording on that
// intro does, and end stops the recording running here, as End recording on its live card does.
// The host rule is checked by each of those (features/meetings/meetingHosts.ts). A member
// command rather than an admin one, because hosts include the roles allowed to give Dero tasks,
// which an admin gate would shut out.

export const data = new SlashCommandBuilder()
	.setName("meeting")
	.setDescription("Schedule or record a meeting in 🏛️ Meeting Hall")
	.addSubcommand((sub) => sub.setName("schedule").setDescription("Schedule a meeting with reminders (hosts only)"))
	.addSubcommand((sub) =>
		sub
			.setName("start")
			.setDescription("Record 🏛️ Meeting Hall now, only members who agree (hosts only)")
			.addStringOption((option) => option.setName("title").setDescription("What the meeting is about").setMaxLength(BOT_CONSTANTS.MEETINGS.TITLE_MAX).setRequired(false))
	)
	.addSubcommand((sub) => sub.setName("end").setDescription("End the recording running in this server (hosts only)"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!interaction.inGuild()) {
		const words = getPluginCopy(null).todoReminders.meetings;
		await showNotice(interaction, { title: words.noticeTitle, sections: [words.guildOnly] });
		return;
	}
	const subcommand = interaction.options.getSubcommand();
	if (subcommand === "start") return pressStartRecording(interaction, { title: interaction.options.getString("title") ?? undefined });
	if (subcommand === "end") return pressEndRecording(interaction, null);
	await openScheduleMeetingModal(interaction);
}
