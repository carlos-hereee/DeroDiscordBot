import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { secretCodeCopy } from "@features/fortune/fortuneCopy.js";
import { answerSecretCode } from "@features/secret-codes/secretCodeEntry.js";

// ── /secret-code ───────────────────────────────────────────────────────────
// Redeem a code: a birthday gift, a PERMANENT fortune luck buff, or whatever comes next.
// Open to every member (deliberately NOT in BOT_CONSTANTS.ADMIN_COMMANDS): the launch
// code is public and the rarer ones are meant to be hunted or handed out. The Enter a
// code button on #command-center is the same door; secretCodeEntry answers both.
export const data = new SlashCommandBuilder()
	.setName("secret-code")
	.setDescription(secretCodeCopy.commandDescription)
	.addStringOption((option) =>
		option
			.setName("code")
			.setDescription(secretCodeCopy.codeOptionDescription)
			.setMaxLength(BOT_CONSTANTS.SECRET_CODE_MAX_LENGTH)
			.setRequired(true)
	);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await answerSecretCode(interaction, interaction.options.getString("code", true));
}
