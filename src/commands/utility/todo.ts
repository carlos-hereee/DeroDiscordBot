import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy } from "@base/copy/index.js";
import { addTodoFromMember, replyMyTodos } from "@features/todos/todoHandlers.js";
import { showNotice } from "@utils/textModal.js";

// ── /todo add text [due], /todo mine (2026-11 item 388 Phase 2) ──
// A member command: any member adds a todo (owner decision D13) and lists the ones they hold.
// Both answer privately and share their path with the ✅todos intro's Add todo and My todos
// buttons (features/todos/todoHandlers.ts), so the command and the button cannot disagree.

// A typed time is short (30m, 12/24@18:00); the cap only keeps a pasted paragraph out.
const DUE_OPTION_MAX = 40;

export const data = new SlashCommandBuilder()
	.setName("todo")
	.setDescription("Add a todo or list the ones you hold in this server")
	.addSubcommand((sub) =>
		sub
			.setName("add")
			.setDescription("Add a todo to ✅todos")
			.addStringOption((option) => option.setName("text").setDescription("What needs doing").setMaxLength(BOT_CONSTANTS.TODOS.TEXT_MAX).setRequired(true))
			.addStringOption((option) => option.setName("due").setDescription("When it is due, like 2h, 7pm or 12/24@18:00").setMaxLength(DUE_OPTION_MAX).setRequired(false))
	)
	.addSubcommand((sub) => sub.setName("mine").setDescription("The open todos you hold in this server"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!interaction.inGuild()) {
		const words = getPluginCopy(null).todoReminders.todos;
		await showNotice(interaction, { title: words.noticeTitle, sections: [words.guildOnly] });
		return;
	}
	if (interaction.options.getSubcommand() === "mine") {
		await replyMyTodos(interaction);
		return;
	}
	await addTodoFromMember(interaction, interaction.options.getString("text", true), interaction.options.getString("due"));
}
