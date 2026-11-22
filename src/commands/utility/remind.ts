import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/index.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { openMemberTimezoneModal } from "@features/reminders/memberTimezone.js";
import { createPersonalReminder, personalRefusalLine, replyReminderList } from "@features/reminders/personalReminders.js";
import { showNotice } from "@utils/textModal.js";

// ── /remind me when text, /remind list, /remind timezone (2026-11 item 388 Phase 2) ──
// A member's own reminders, open to every member in any channel (owner decision D18): Dero
// sends each one by DM at its time and pings the member in the channel it was set in when
// their DMs are closed. /remind timezone sets the zone the member's typed times are read in.

// A typed time is short (30m, 12/24@18:00); the cap only keeps a pasted paragraph out.
const WHEN_OPTION_MAX = 40;

export const data = new SlashCommandBuilder()
	.setName("remind")
	.setDescription("Set yourself a reminder, list yours, or set your timezone")
	.addSubcommand((sub) =>
		sub
			.setName("me")
			.setDescription("A reminder by direct message")
			.addStringOption((option) => option.setName("when").setDescription("Like 30m, 2h, 7pm, 19:30 or 12/24@18:00").setMaxLength(WHEN_OPTION_MAX).setRequired(true))
			.addStringOption((option) => option.setName("text").setDescription("What to remind you of").setMaxLength(BOT_CONSTANTS.REMINDERS.TEXT_MAX).setRequired(true))
	)
	.addSubcommand((sub) => sub.setName("list").setDescription("Your waiting reminders in this server"))
	.addSubcommand((sub) => sub.setName("timezone").setDescription("The timezone your typed times are read in, in this server"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		const words = getPluginCopy(null).todoReminders.reminders;
		await showNotice(interaction, { title: words.noticeTitle, sections: [words.guildOnly] });
		return;
	}
	const subcommand = interaction.options.getSubcommand();
	if (subcommand === "list") return replyReminderList(interaction);
	if (subcommand === "timezone") return openMemberTimezoneModal(interaction);

	const config = await guildConfigStore.findByGuildId(guildId);
	const copy = getPluginCopy(config as unknown as ICopyConfig | null);
	const result = await createPersonalReminder({
		guildId,
		userId: interaction.user.id,
		channelId: interaction.channelId,
		whenText: interaction.options.getString("when", true),
		text: interaction.options.getString("text", true),
		serverTimezone: config?.timezone,
	});
	const words = copy.todoReminders.reminders;
	const line = result.ok ? words.set(Math.floor(result.fireAt.getTime() / 1000)) : personalRefusalLine(result.reason, copy);
	await showNotice(interaction, { title: words.noticeTitle, sections: [line] });
}
