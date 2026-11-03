import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { redeemCode } from "@features/fortune/secretCodes.js";
import { secretCodeCopy } from "@features/fortune/fortuneCopy.js";
import { showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

// ── /secret-code ───────────────────────────────────────────────────────────
// Redeem a secret phrase for a PERMANENT fortune luck buff. Open to every
// member (deliberately NOT in BOT_CONSTANTS.ADMIN_COMMANDS): the launch code is
// public and the rarer ones are meant to be hunted or handed out. Every reply is
// ephemeral, so a code and its outcome are seen only by the person redeeming and
// never over their shoulder. Validate, keep-highest, and persist all live in
// redeemCode; this handler just maps the outcome to one line of copy.
export const data = new SlashCommandBuilder()
	.setName("secret-code")
	.setDescription(secretCodeCopy.commandDescription)
	.addStringOption((option) =>
		option
			.setName("code")
			.setDescription(secretCodeCopy.codeOptionDescription)
			.setMaxLength(100)
			.setRequired(true)
	);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const raw = interaction.options.getString("code", true);
	const outcome = await redeemCode(interaction.user.id, raw);

	const content =
		outcome.status === "invalid"
			? secretCodeCopy.invalid
			: outcome.status === "granted"
				? secretCodeCopy.granted(outcome.percent)
				: secretCodeCopy.unchanged(outcome.percent);

	await showNotice(interaction, { title: getPluginCopy(null).notice.secretCode, sections: [content] });
}
