import type { ButtonInteraction } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";
import { setupCopy } from "./setupCopy.js";

// ── renameInfoStep ──────────────────────────────────────────────────────────
// What:  🛠️server-config's step 8 (2026-11 item 285 Phase 4): an info step that teaches
//        one rule, that /server channels rename persists through auto heal while a rename
//        made straight in Discord is put back to Dero's default name.
// Who:   headquartersSteps.ts routes the step's button here.
// Where: it teaches renameChannel.ts and changes nothing, so it writes no row, logs
//        nothing to 🗒️admin-log and has no state to keep in sync.
// How:   re-checks the owner or admin gate on the press, then posts the explainer in
//        🛠️server-config in the guild's pack voice. It is an answer, so it posts in the
//        channel and never as a private reply (utils/answerInChannel.ts).

/**
 * Open the rename explainer: re-check the presser, then post the embed in 🛠️server-config.
 * Never changes state.
 */
export async function handleOpen(interaction: ButtonInteraction): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const config = await guildConfigStore.findByGuildId(guild.id);
	const copyConfig = config as unknown as ICopyConfig | null;
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await showNotice(interaction, { title: getPluginCopy(copyConfig).notice.server, sections: [setupCopy.headquarters.serverConfig.rename.notAdmin] });
		return;
	}

	const responses = getPluginCopy(copyConfig).responses;
	await answerInChannel(interaction, "serverConfig", { embeds: [infoEmbed(responses.renameInfoTitle, responses.renameInfoBody, COLORS.ADMIN, copyConfig)] }, { config });
}
