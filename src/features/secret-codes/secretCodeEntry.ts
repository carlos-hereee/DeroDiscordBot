import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { redeemChipGift, type ChipGiftOutcome } from "@features/economy/chipGift.js";
import { chips } from "@features/economy/economyCopy.js";
import { secretCodeCopy } from "@features/fortune/fortuneCopy.js";
import { redeemCode, type RedeemOutcome } from "@features/fortune/secretCodes.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { showNotice, type TextModalContent } from "@utils/textModal.js";

// ── secretCodeEntry ──────────────────────────────────────────────────
// What:  the one place a typed code is answered, whichever door it came through: every kind
//        of code (a birthday gift, a luck buff, and the ones to come) is tried here, so a
//        new kind joins both doors at once.
// Who:   /secret-code and the Enter a code button on the #command-center guide, which opens
//        a one field modal.
// Does NOT: validate or pay. redeemChipGift and redeemCode do; this maps the outcome to words.
//
// Every answer is private, so a code and its outcome are seen only by the person redeeming
// and never over their shoulder.

const BUTTON_PREFIX = "secretcode";
const OPEN_BUTTON_ID = `${BUTTON_PREFIX}:open`;
const MODAL_PREFIX = "secretcodemodal";
const MODAL_ID = `${MODAL_PREFIX}:submit`;
const CODE_FIELD_ID = "code";

/** Try a typed code against every kind of code and answer the member privately. */
export async function answerSecretCode(interaction: ChatInputCommandInteraction | ModalSubmitInteraction, raw: string): Promise<void> {
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

// ── the #command-center button ──

/** The Enter a code button. A bare button so resolveIntroComponents can pack it into the guide's row. */
export function buildEnterCodeButton(): ButtonBuilder {
	return new ButtonBuilder().setCustomId(OPEN_BUTTON_ID).setLabel(secretCodeCopy.buttonLabel).setEmoji("🔐").setStyle(ButtonStyle.Secondary);
}

function buildCodeModal(): ModalBuilder {
	const field = new TextInputBuilder()
		.setCustomId(CODE_FIELD_ID)
		.setLabel(secretCodeCopy.modalFieldLabel)
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMaxLength(BOT_CONSTANTS.SECRET_CODE_MAX_LENGTH);
	return new ModalBuilder().setCustomId(MODAL_ID).setTitle(secretCodeCopy.modalTitle).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field));
}

async function handleOpenButton(interaction: ButtonInteraction): Promise<void> {
	await interaction.showModal(buildCodeModal());
}

async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
	await answerSecretCode(interaction, interaction.fields.getTextInputValue(CODE_FIELD_ID));
}

/** Register the button and its modal. Called once at boot from main.ts. */
export function registerSecretCodeHandlers(): void {
	registerButton(BUTTON_PREFIX, handleOpenButton);
	registerModal(MODAL_PREFIX, handleModalSubmit);
}
