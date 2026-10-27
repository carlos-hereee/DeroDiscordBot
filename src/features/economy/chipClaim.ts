import { type ColorResolvable, type RepliableInteraction } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { claimChips, isChipEconomyOn, type ClaimResult } from "./chipWallet.js";
import { economyCopy } from "./economyCopy.js";
import { showEmbedNotice, showErrorNotice } from "@utils/textModal.js";

// ── chipClaim ────────────────────────────────────────────────────────
// What:  the /claim reply (2026-10 item 250 Phase 5): pay the member's claim, or say
//        when the next one opens, privately.
// Who:   src/commands/fun/claim.ts, the member's command.
// Does NOT: pay anything itself. claimChips in chipWallet.ts owns the amounts and the
//        cooldown; this only asks the server's switch first and words the answer.
//
// Private on purpose: a balance is the member's own business, and a public reply every
// day from every member would turn the channel into a ledger.

const copy = economyCopy.claim;

function claimText(result: ClaimResult): string {
	if (result.kind === "cooldown") return copy.cooldown(result.balance, result.nextClaimAt);
	if (result.kind === "first") return copy.firstClaim(result.amount, result.balance);
	return copy.dailyClaim(result.amount, result.balance);
}

const claimEmbed = (result: ClaimResult) => infoEmbed(copy.title, claimText(result), COLORS.ARCADE as ColorResolvable);

/** Answer one /claim. Every refusal and every failure is a private reply; nothing throws to the caller. */
export async function runChipClaim(interaction: RepliableInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showErrorNotice(interaction, copy.notInGuild);
		return;
	}

	try {
		const config = await guildConfigStore.findByGuildId(guildId);
		if (!isChipEconomyOn(config)) {
			await showErrorNotice(interaction, copy.economyOff);
			return;
		}
		const result = await claimChips({ guildId, userId: interaction.user.id });
		await showEmbedNotice(interaction, claimEmbed(result));
	} catch (error) {
		console.error(`[economy] /claim for ${interaction.user.id} in guild ${guildId} failed`, error);
		await showErrorNotice(interaction, copy.failed);
	}
}
