import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { respondWithFortune } from "@features/fortune/respondWithFortune.js";
import { fortuneCopy } from "@features/fortune/fortuneCopy.js";

// ── /fortune ───────────────────────────────────────────────────────────────
// The Company Uno fortune teller. Open to every member: deliberately NOT in
// BOT_CONSTANTS.ADMIN_COMMANDS, so main.ts's admin gate skips it. All the reading
// logic (kill-switch, cooldown, tier roll, embed, mention safety) lives in
// respondWithFortune, shared with the #command-center invite-card button so the
// two entry points can never drift.

export const data = new SlashCommandBuilder()
	.setName("fortune")
	.setDescription(fortuneCopy.commandDescription)
	.addStringOption((option) =>
		option
			.setName("question")
			.setDescription(fortuneCopy.questionOptionDescription)
			.setMaxLength(200)
			.setRequired(false)
	)
	.addBooleanOption((option) =>
		option.setName("private").setDescription(fortuneCopy.privateOptionDescription).setRequired(false)
	);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const question = interaction.options.getString("question", false);
	const isPrivate = interaction.options.getBoolean("private", false) ?? false;
	await respondWithFortune(interaction, { question, isPrivate });
}
