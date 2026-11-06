import type { ChatInputCommandInteraction, SlashCommandSubcommandBuilder } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { isPlatformOwner } from "@utils/permissions.js";
import { showNotice } from "@utils/textModal.js";
import { grantChipGift } from "./chipGift.js";
import { economyCopy } from "./economyCopy.js";

// ── /platform birthday-gift ──────────────────────────────────────────
// What:  sets a birthday gift aside for one member, picked in Discord so the row holds their
//        immutable id, at an amount chosen each time. It pays nothing by itself: the member
//        collects it once through /secret-code. Run again before they do, it corrects the amount.
// Who:   commands/admin/platform.ts adds and runs it. The platform owner ONLY, checked first,
//        exactly like every other /platform door: these chips come from nowhere, and an unset
//        CREATOR_DISCORD_ID refuses everyone.

const copy = economyCopy.birthdayGift;
const MEMBER_OPTION = "member";
const CHIPS_OPTION = "chips";

/** The /platform birthday-gift subcommand and its two required options. */
export function addBirthdayGiftSubcommand(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub
		.setName("birthday-gift")
		.setDescription(copy.command.description)
		.addUserOption((option) => option.setName(MEMBER_OPTION).setDescription(copy.command.memberOption).setRequired(true))
		.addIntegerOption((option) =>
			option.setName(CHIPS_OPTION).setDescription(copy.command.chipsOption).setMinValue(1).setMaxValue(BOT_CONSTANTS.ECONOMY.MAX_GRANT_CHIPS).setRequired(true)
		);
}

/** Runs /platform birthday-gift for the platform owner, refusing everyone else before reading anything. */
export async function runBirthdayGiftSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!isPlatformOwner(interaction.user.id)) {
		await showNotice(interaction, { title: copy.title, sections: [copy.notOwner] });
		return;
	}

	const member = interaction.options.getUser(MEMBER_OPTION, true);
	if (member.bot) {
		await showNotice(interaction, { title: copy.title, sections: [copy.notABot] });
		return;
	}

	const amount = interaction.options.getInteger(CHIPS_OPTION, true);
	await grantChipGift(member.id, amount, interaction.user.id);
	await showNotice(interaction, { title: copy.title, sections: [copy.saved(member.id, amount)] });
}
