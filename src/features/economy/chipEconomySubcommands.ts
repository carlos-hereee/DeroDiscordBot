import { type ColorResolvable, type RepliableInteraction, type SlashCommandSubcommandGroupBuilder } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { economyCopy } from "@features/economy/economyCopy.js";
import { isChipEconomyOn } from "@features/economy/chipWallet.js";
import { readVault } from "@features/economy/serverVault.js";
import { runVaultGrant } from "@features/economy/vaultGrant.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";
import { showEmbedNotice, showErrorNotice } from "@utils/textModal.js";

// ── /arcade chips ─────────────────────────────────────────────────────
// What:  the chip economy's admin subcommands (2026-10 item 250 Phase 5): `status` (the
//        vault, its recent grants and the switch), `toggle` (chips on or off for the
//        server) and `grant` (chips from the vault to a member).
// Who:   commands/admin/arcade.ts adds this group to /arcade and runs it. Admins,
//        gated at runtime by /arcade in ADMIN_COMMANDS (the guild owner or the bot's
//        admin role), from the slash command or the /arcade button on the admin guide,
//        whose settings panel holds the switch and runs `toggle` through this run.
// Where: GuildConfig.chipEconomyEnabled is read by /claim, the /account chips line and
//        every Hold'em table at open (features/economy/chipWallet.isChipEconomyOn). The
//        vault lives in features/economy/serverVault.ts.
// How:   ① guild gate; ② setup gate; ③ dispatch; ④ one private reply. A toggle and a
//        grant each write one 🗒️admin-log line; an unchanged toggle writes nothing.
//
// ⚠️ OFF NEVER DELETES. Balances and the vault stay as they were, so turning chips back
// on restores every member's chips; a table already open keeps the chips it was opened
// with, since its players paid in.

const copy = economyCopy.admin;
const ECONOMY = BOT_CONSTANTS.ECONOMY;

/** The /arcade chips group's three subcommands. */
export function addChipSubcommands(group: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder {
	return group
		.addSubcommand((sub) => sub.setName("status").setDescription(copy.statusDescription))
		.addSubcommand((sub) =>
			sub
				.setName("toggle")
				.setDescription(copy.toggleDescription)
				.addBooleanOption((option) => option.setName("enabled").setDescription(copy.toggleOption).setRequired(true))
		)
		.addSubcommand((sub) =>
			sub
				.setName("grant")
				.setDescription(copy.grantDescription)
				.addUserOption((option) => option.setName("user").setDescription(copy.grantUserOption).setRequired(true))
				.addIntegerOption((option) =>
					option.setName("amount").setDescription(copy.grantAmountOption).setRequired(true).setMinValue(1).setMaxValue(ECONOMY.MAX_GRANT_CHIPS)
				)
		);
}

const reply = (interaction: RepliableInteraction, body: string) =>
	showEmbedNotice(interaction, infoEmbed(copy.title, body, COLORS.ADMIN as ColorResolvable));

async function status(interaction: RepliableInteraction, guildId: string, on: boolean): Promise<void> {
	const vault = await readVault(guildId);
	const grants = [...vault.grantHistory].reverse().slice(0, ECONOMY.VAULT_STATUS_GRANTS_SHOWN);
	await reply(interaction, copy.statusBody({ on, vaultBalance: vault.balance, lastAwardMonth: vault.lastAwardMonth, grants }));
}

// Idempotent like every switch in the bot: an unchanged value says so and writes nothing.
async function toggle(interaction: RepliableInteraction, guildId: string, current: boolean, wanted: boolean): Promise<void> {
	if (current === wanted) {
		await reply(interaction, copy.unchanged(wanted));
		return;
	}
	await guildConfigStore.update(guildId, { chipEconomyEnabled: wanted });
	adminLog.emitFor(interaction, guildId, "config.change", {
		subject: economyCopy.adminLog.economySubject,
		detail: wanted ? setupCopy.adminLog.on : setupCopy.adminLog.off,
	});
	await reply(interaction, copy.toggled(wanted));
}

/** Runs one /arcade chips subcommand, for the slash command and the admin guide alike. */
export async function runChipSubcommand(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	// ①
	const guildId = interaction.guildId;
	if (!guildId) {
		await showErrorNotice(interaction, copy.notInGuild);
		return;
	}

	try {
		// ②
		const config = await guildConfigStore.findByGuildId(guildId);
		if (!config) {
			await showErrorNotice(interaction, copy.setupRequired);
			return;
		}
		const on = isChipEconomyOn(config);

		// ③
		const sub = options.getSubcommand(true);
		if (sub === "toggle") {
			await toggle(interaction, guildId, on, options.getBoolean("enabled", true));
			return;
		}
		if (sub === "grant") {
			if (!on) {
				await showErrorNotice(interaction, copy.economyOff);
				return;
			}
			await runVaultGrant(interaction, guildId, options.getUser("user", true), options.getInteger("amount", true));
			return;
		}
		await status(interaction, guildId, on);
	} catch (error) {
		console.error(`[arcade chips] /arcade chips failed guild=${guildId}`, error);
		await showErrorNotice(interaction, copy.failed);
	}
}
