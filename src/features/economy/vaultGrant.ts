import { type ColorResolvable, type RepliableInteraction, type User } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { adminLog } from "@features/setup/adminLog.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { grantFromVault, type GrantResult } from "./serverVault.js";
import { economyCopy } from "./economyCopy.js";
import { showNotice } from "@utils/textModal.js";
import { answerInChannel } from "@utils/answerInChannel.js";

// ── vaultGrant ───────────────────────────────────────────────────────
// What:  /arcade chips grant (2026-10 item 250 Phase 5): an admin moves chips from the server
//        vault to a member's global wallet, and the grant becomes one 🗒️admin-log line.
// Who:   features/economy/chipEconomySubcommands.ts, behind /arcade's ADMIN_COMMANDS gate, from the slash
//        command or the /arcade chips panel's grant form.
// When:  on demand. The chip switch is checked by the command before this runs.
//
// Every grant is logged with the grantor and the amount (the plan's risk R6, chip grant
// abuse): the line is the audit, and the vault's own history keeps the last fifty.

const copy = economyCopy.admin;

// A refused grant is a state, answered privately to the admin as a notice. The daily cap
// names what the member may still receive today (2026-10 item 267, risk R3).
function refusalText(result: Extract<GrantResult, { ok: false }>, recipientId: string): string {
	if (result.reason === "dailyCap") return copy.dailyCapReached(recipientId, result.leftToday);
	if (result.reason === "vaultShort") return copy.vaultShort(result.vaultBalance);
	if (result.reason === "invalidAmount") return copy.invalidAmount(BOT_CONSTANTS.ECONOMY.MAX_GRANT_CHIPS);
	return copy.grantFailed;
}

/** Grant `amount` chips to `recipient` and answer privately. A Discord bot account is refused: bots hold no chips. */
export async function runVaultGrant(interaction: RepliableInteraction, guildId: string, recipient: User, amount: number): Promise<void> {
	if (recipient.bot) {
		await showNotice(interaction, { title: copy.title, sections: [copy.botTarget] });
		return;
	}

	const result = await grantFromVault({ guildId, toUserId: recipient.id, amount, byAdminId: interaction.user.id });
	if (!result.ok) {
		await showNotice(interaction, { title: copy.title, sections: [refusalText(result, recipient.id)] });
		return;
	}

	adminLog.emitFor(interaction, guildId, "chip.grant", {
		subject: economyCopy.adminLog.grantSubject,
		detail: economyCopy.adminLog.grantDetail(recipient.id, amount, result.vaultBalance),
		toUserId: recipient.id,
		amount,
		byAdminId: interaction.user.id,
		newVaultBalance: result.vaultBalance,
		newWalletBalance: result.walletBalance,
	});
	const body = copy.granted({ userId: recipient.id, amount, walletBalance: result.walletBalance, vaultBalance: result.vaultBalance });
	// A grant made is an answer, so it posts in 🎰arcade-control (owner rule 1).
	await answerInChannel(interaction, "arcade", { embeds: [infoEmbed(copy.title, body, COLORS.ADMIN as ColorResolvable)] });
}
