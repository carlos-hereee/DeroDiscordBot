import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { redeemChipGift, type ChipGiftOutcome } from "@features/economy/chipGift.js";
import { chips } from "@features/economy/economyCopy.js";
import { secretCodeCopy } from "@features/fortune/fortuneCopy.js";
import { redeemCode, type RedeemOutcome } from "@features/fortune/secretCodes.js";
import { showNotice, type TextModalContent } from "@utils/textModal.js";

// ── /secret-code ───────────────────────────────────────────────────────────
// Redeem a secret phrase: a PERMANENT fortune luck buff, or a birthday gift the owner set
// aside for this member. Open to every member (deliberately NOT in
// BOT_CONSTANTS.ADMIN_COMMANDS): the launch code is public and the rarer ones are meant
// to be hunted or handed out. Every reply is private, so a code and its outcome are seen
// only by the person redeeming and never over their shoulder. Validate, keep-highest,
// payment and persistence live in redeemCode and redeemChipGift; this handler just maps
// the outcome to words.
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
	const gift = await redeemChipGift(interaction.user.id, raw);
	const notice = gift.status === "none" ? await luckNotice(interaction.user.id, raw) : await giftNotice(gift, interaction.guildId);
	await showNotice(interaction, notice);
}

async function luckNotice(userId: string, raw: string): Promise<TextModalContent> {
	const outcome = await redeemCode(userId, raw);
	return { title: getPluginCopy(null).notice.secretCode, sections: [luckLine(outcome)] };
}

function luckLine(outcome: RedeemOutcome): string {
	if (outcome.status === "invalid") return secretCodeCopy.invalid;
	return outcome.status === "granted" ? secretCodeCopy.granted(outcome.percent) : secretCodeCopy.unchanged(outcome.percent);
}

async function giftNotice(gift: Exclude<ChipGiftOutcome, { status: "none" }>, guildId: string | null): Promise<TextModalContent> {
	const copy = (await packFor(guildId)).birthdayGift;
	return { title: copy.title, sections: [gift.status === "paid" ? copy.paid(chips(gift.amount)) : copy.collected] };
}

// The gift is already paid when this runs, so a failed config read may cost the server's
// voice and nothing more: the member still gets their birthday message, in the default pack.
async function packFor(guildId: string | null): Promise<ReturnType<typeof getPluginCopy>> {
	if (!guildId) return getPluginCopy(null);
	const config = await guildConfigStore.findByGuildId(guildId).catch((error: unknown) => {
		console.warn(`[secret-code] reading guild ${guildId}'s copy pack failed, answering in the default pack`, error);
		return null;
	});
	return getPluginCopy(config);
}
