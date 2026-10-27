import { type ColorResolvable, type RepliableInteraction } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
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
//
// With chips off (2026-10 item 257, owner item 10) the press is routed to the switch: an
// admin gets the arcade settings panel at once, a member the command to send an admin.
// Every notice reads the guild's own pack. Phase 3a of that plan turns Claim into a rock
// paper scissors round; the chips off routing below stays its first gate.

const copy = economyCopy.claim;

type GuildConfigRow = Awaited<ReturnType<typeof guildConfigStore.findByGuildId>>;

// The settings panel holding the Chips switch (settingsPanels.ts, SETTINGS_PANELS).
const ARCADE_PANEL_ID = "arcade";

function claimText(result: ClaimResult): string {
	if (result.kind === "cooldown") return copy.cooldown(result.balance, result.nextClaimAt);
	if (result.kind === "first") return copy.firstClaim(result.amount, result.balance);
	return copy.dailyClaim(result.amount, result.balance);
}

const claimEmbed = (result: ClaimResult) => infoEmbed(copy.title, claimText(result), COLORS.ARCADE as ColorResolvable);

// Chips off: the arcade panel, whose Chips switch turns them on, for whoever may flip it;
// the command to send an admin for everyone else. Loaded on use rather than imported at
// the top: the launcher imports /arcade, which reaches this file back through arcadeSwitch,
// GuildSetupManager and PowerUps, and it builds its command table as it loads, so a static
// import here would close that cycle with the table half built.
async function routeToChipSwitch(interaction: RepliableInteraction, config: GuildConfigRow): Promise<void> {
	const { offerSwitchFix } = await import("@features/command-buttons/adminCommandLauncher.js");
	await offerSwitchFix(interaction, { launchId: ARCADE_PANEL_ID, title: getPluginCopy(config).error.title, memberSections: [...copy.economyOffForMember] }, config);
}

/** Answer one /claim. Every refusal and every failure is a private reply; nothing throws to the caller. */
export async function runChipClaim(interaction: RepliableInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showErrorNotice(interaction, copy.notInGuild);
		return;
	}

	// Read inside the try, kept outside it so the failure notice can still use the pack.
	let config: GuildConfigRow = null;
	try {
		config = await guildConfigStore.findByGuildId(guildId);
		if (!isChipEconomyOn(config)) {
			await routeToChipSwitch(interaction, config);
			return;
		}
		const result = await claimChips({ guildId, userId: interaction.user.id });
		await showEmbedNotice(interaction, claimEmbed(result));
	} catch (error) {
		console.error(`[economy] /claim for ${interaction.user.id} in guild ${guildId} failed`, error);
		await showErrorNotice(interaction, copy.failed, config);
	}
}
