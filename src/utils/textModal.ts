import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	InteractionType,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder,
	type ButtonInteraction,
	type EmbedBuilder,
	type InteractionReplyOptions,
	type ModalSubmitInteraction,
	type RepliableInteraction,
} from "discord.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { registerModal } from "@handlers/interactionRegistry.js";
import { errorEmbed } from "./embedBuilder.js";

// ── textModal ────────────────────────────────────────────────────────
// What:  a modal that only shows text, popped over the channel in answer to a press,
//        instead of an ephemeral message that sits in the channel until the member
//        presses Discord's "Dismiss message" (post-launch plan items 9 and 16). Also
//        the shared notice: a text modal for a short answer to an admin control
//        (a refusal, a stale button, "already on").
// Who:   game-rooms privateView (a player's own board or hand), the select modals that
//        replaced a private single choice picker, and every first private text answer
//        in the bot (2026-10 item 254 Phase 5b; the site list and what stays a private
//        reply, with Discord's reason, is companyuno-discord/docs/handoffs/
//        dero-private-reply-audit-2026-10.md). main.ts registers the notice's close once
//        at boot.
// When:  only as the FIRST answer to a press or a slash command. Discord shows a
//        modal in no other place: never after a defer or a reply, and never in answer
//        to a modal submit. Those callers get the ephemeral fallback, which carries
//        no button of its own.
// How:   the modal holds TextDisplay sections and no input. Discord documents
//        TextDisplay as a modal component but says nothing on a modal with no input
//        at all, so a refusal is caught and answered with the fallback instead. A
//        failed showModal leaves the interaction unanswered, which is what lets the
//        fallback still reply inside the three second window.
//
// ⚠️ PRIVATE BY CONSTRUCTION: a modal is only ever shown to the member whose press
// opened it, exactly like an ephemeral reply.

// Discord caps one TextDisplay at 4000 characters, a modal at five components and a
// modal title at 45 characters.
const MAX_SECTIONS = 5;
const MAX_SECTION_LENGTH = 4000;
const MAX_TITLE_LENGTH = 45;

/** The interactionRegistry prefix of every notice modal; its close routes through registerNoticeModal. */
export const NOTICE_MODAL_PREFIX = "notice";

/** What a text modal shows: a title (cut to 45 characters) and up to five blocks of text. */
export interface TextModalContent {
	title: string;
	sections: string[];
}

/** The interactions Discord lets open a modal: a button, a select, a slash or context command. */
export type ModalOpeningInteraction = Extract<RepliableInteraction, { showModal: unknown }>;

/**
 * The text modal under one customId. Exported for the tests, which read it back with toJSON.
 * `reservedComponents` leaves room under the five component cap for components the caller
 * adds after the text (a confirm's select).
 */
export function buildTextModal(customId: string, content: TextModalContent, reservedComponents = 0): ModalBuilder {
	return new ModalBuilder()
		.setCustomId(customId)
		.setTitle(content.title.slice(0, MAX_TITLE_LENGTH))
		.addTextDisplayComponents(
			...content.sections
				.filter((section) => section.trim().length > 0)
				.slice(0, MAX_SECTIONS - reservedComponents)
				.map((section) => new TextDisplayBuilder().setContent(section.slice(0, MAX_SECTION_LENGTH)))
		);
}

/**
 * Open a text modal, or, when Discord refuses it, answer with the ephemeral reply
 * `fallback` builds. Never throws past a failed fallback.
 */
export async function showTextModal(
	interaction: ModalOpeningInteraction,
	customId: string,
	content: TextModalContent,
	fallback: () => InteractionReplyOptions | Promise<InteractionReplyOptions>
): Promise<void> {
	await showModalOrReply(interaction, buildTextModal(customId, content), fallback);
}

/**
 * Open any modal (a text modal, or a select modal standing in for a private picker),
 * or, when Discord refuses it, answer with the ephemeral reply `fallback` builds,
 * which for a picker is the select message it replaced. Never throws past a failed
 * fallback.
 */
export async function showModalOrReply(
	interaction: ModalOpeningInteraction,
	modal: ModalBuilder,
	fallback: () => InteractionReplyOptions | Promise<InteractionReplyOptions>
): Promise<void> {
	const customId = modal.data.custom_id;
	try {
		await interaction.showModal(modal);
		return;
	} catch (error) {
		console.warn("[text-modal] the modal was refused; answering privately instead", { customId, error });
	}
	await interaction.reply(await fallback()).catch((error) => console.error("[text-modal] the private fallback failed", { customId, error }));
}

/**
 * A text modal's Submit. There is nothing to submit, so it is acknowledged without
 * leaving a message behind: deferUpdate for a modal opened from a message button,
 * and for one opened any other way (a slash command) a private defer that is
 * deleted at once, since deferUpdate is refused there.
 */
export async function acknowledgeTextModal(interaction: ModalSubmitInteraction): Promise<void> {
	// Swallowed on purpose: the modal is already gone from the member's screen, and a
	// failed acknowledgement costs at most Discord's own "interaction failed" note.
	if (interaction.isFromMessage()) {
		await interaction.deferUpdate().catch(() => undefined);
		return;
	}
	await interaction
		.deferReply({ flags: MessageFlags.Ephemeral })
		.then(() => interaction.deleteReply())
		.catch(() => undefined);
}

// ── the notice ───────────────────────────────────────────────────────

/**
 * Answer a press or a command with a short notice: a text modal when the interaction
 * can still open one, and otherwise (a modal submit, or an interaction already
 * deferred or answered) the ephemeral reply `fallback` builds, with no button on it.
 * With no `fallback`, the private reply is the notice's text as plain content, which
 * is exactly the reply a text answer gave before it became a notice. The interaction
 * id keys the modal, so two notices are never confused.
 */
export async function showNotice(
	interaction: RepliableInteraction,
	content: TextModalContent,
	fallback: () => InteractionReplyOptions | Promise<InteractionReplyOptions> = () => ({
		content: content.sections.join("\n\n"),
		flags: MessageFlags.Ephemeral,
	})
): Promise<void> {
	if (canOpenModal(interaction)) {
		await showTextModal(interaction, `${NOTICE_MODAL_PREFIX}:${interaction.id}`, content, fallback);
		return;
	}
	await replyPrivately(interaction, await fallback());
}

/**
 * The notice a text only embed reads as: its title over its description, with its
 * footer as the last section so no word of it is lost. Null when the embed carries
 * fields, an image or a thumbnail, which a modal cannot show, or has no title, which
 * a modal cannot open without.
 */
export function noticeFromEmbed(embed: EmbedBuilder): TextModalContent | null {
	const { title, description, fields, image, thumbnail, footer } = embed.data;
	if (!title || (fields?.length ?? 0) > 0 || image || thumbnail) return null;
	return { title, sections: [description ?? "", footer?.text ?? ""] };
}

/**
 * Answer with an embed as a notice when it is text only, and otherwise as the private
 * embed reply it always was (decision 4 of the private reply sweep keeps an embed with
 * fields or an image a private message). An embed never pings, so the fallback needs
 * no allowedMentions.
 */
export async function showEmbedNotice(interaction: RepliableInteraction, embed: EmbedBuilder): Promise<void> {
	const fallback = (): InteractionReplyOptions => ({ embeds: [embed], flags: MessageFlags.Ephemeral });
	const notice = noticeFromEmbed(embed);
	if (notice) {
		await showNotice(interaction, notice, fallback);
		return;
	}
	await replyPrivately(interaction, fallback());
}

/**
 * A refusal or other short error from an admin control as a notice: the pack's error
 * title over the message, falling back to the private error embed every control
 * answered with before. Never throws.
 */
export async function showErrorNotice(interaction: RepliableInteraction, message: string, guildConfig?: ICopyConfig | null): Promise<void> {
	await showNotice(interaction, { title: getPluginCopy(guildConfig).error.title, sections: [message] }, () => ({
		embeds: [errorEmbed(message, guildConfig)],
		flags: MessageFlags.Ephemeral,
	}));
}

// ── the confirm ──────────────────────────────────────────────────────
// What:  a text modal whose Submit performs an action (2026-10 item 257, owner item 12):
//        archive, forfeit, start, leave, surrender, and an error whose fix Dero can run
//        (item 15). Closing the modal does nothing at all, which is the whole point:
//        nothing happens before Submit.
// Who:   the game rooms today; any feature whose press needs a yes first.
// How:   the modal and its fallback button carry the SAME customId, `confirmId`. The
//        caller registers that id's prefix as a modal (registerModal) and as a button
//        (registerButton), and both land in one handler, which re-gates the presser and
//        then acts: a modal Submit is reachable without the press that opened it.
// When a modal cannot open (a modal submit, an interaction already deferred or
// answered, or Discord refusing it) the confirm is a private reply carrying that one
// button, never the action done at once.

/** One option of a confirm's select. `isDefault` is what the select shows before the member picks. */
export interface ConfirmSelectOption {
	label: string;
	value: string;
	isDefault?: boolean;
}

/**
 * The one optional choice a confirm may carry (a modal holds no button, so a yes or no the
 * member makes alongside the confirm is a select inside it). `fieldId` is what the Submit
 * reads the answer back by.
 */
export interface ConfirmSelect {
	fieldId: string;
	label: string;
	options: ConfirmSelectOption[];
}

/** What a confirm shows, and the customId its Submit and its fallback button carry. */
export interface ConfirmContent extends TextModalContent {
	confirmId: string;
	select?: ConfirmSelect;
}

/** The two ways a confirm comes back: its modal's Submit, or the fallback reply's button. */
export type ConfirmInteraction = ModalSubmitInteraction | ButtonInteraction;

/**
 * Ask before acting: a text modal whose Submit is routed by `confirmId`, or, when a modal
 * cannot be shown, a private reply with one confirm button carrying the same id. Never
 * performs anything itself and never throws past a failed fallback.
 */
export async function showConfirm(interaction: RepliableInteraction, content: ConfirmContent, guildConfig?: ICopyConfig | null): Promise<void> {
	const fallback = (): InteractionReplyOptions => confirmFallback(content, guildConfig);
	if (canOpenModal(interaction)) {
		await showModalOrReply(interaction, buildConfirmModal(content), fallback);
		return;
	}
	await replyPrivately(interaction, fallback());
}

/**
 * A confirm's modal: its text, then its one select when it has one. The fallback reply stays
 * the single confirm button either way, because a button press carries no select value, so a
 * member who lands there confirms without the choice (the choice's default).
 */
export function buildConfirmModal(content: ConfirmContent): ModalBuilder {
	const modal = buildTextModal(content.confirmId, content, content.select ? 1 : 0);
	if (!content.select) return modal;
	const select = new StringSelectMenuBuilder()
		.setCustomId(content.select.fieldId)
		.setRequired(true)
		.addOptions(content.select.options.map((option) => new StringSelectMenuOptionBuilder().setLabel(option.label).setValue(option.value).setDefault(option.isDefault ?? false)));
	return modal.addLabelComponents(new LabelBuilder().setLabel(content.select.label).setStringSelectMenuComponent(select));
}

/**
 * What a confirm's select was answered with. Empty for the fallback button, which carries no
 * select, and for a modal submit without the field, which only a hand made submit can be since
 * Discord enforces a required select; every caller reads empty as the choice's default.
 */
export function confirmSelectValues(interaction: ConfirmInteraction, fieldId: string): readonly string[] {
	if (interaction.type !== InteractionType.ModalSubmit) return [];
	try {
		return interaction.fields.getStringSelectValues(fieldId);
	} catch {
		return [];
	}
}

/** The private reply a confirm falls back to: its words, and the one button that confirms. Exported for the tests. */
export function confirmFallback(content: ConfirmContent, guildConfig?: ICopyConfig | null): InteractionReplyOptions {
	const button = new ButtonBuilder().setCustomId(content.confirmId).setLabel(getPluginCopy(guildConfig).confirm.button).setStyle(ButtonStyle.Primary);
	const words = [`**${content.title}**`, ...content.sections.filter((section) => section.trim().length > 0)].join("\n\n");
	return {
		content: words.slice(0, MAX_SECTION_LENGTH),
		components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
		flags: MessageFlags.Ephemeral,
	};
}

/**
 * Acknowledge a confirm that answers with no message of its own (an archive whose channel
 * is about to go, a forfeit whose answer is the result card): the modal closes as a text
 * modal does, and the fallback reply's button press is deferred. A second press of that
 * button reaches the same handler, which re-reads the row and refuses what already ran.
 */
export async function acknowledgeConfirm(interaction: ConfirmInteraction): Promise<void> {
	if (interaction.type === InteractionType.ModalSubmit) {
		await acknowledgeTextModal(interaction);
		return;
	}
	// Swallowed on purpose, as in acknowledgeTextModal: the confirm was taken, and a failed
	// acknowledgement costs at most Discord's own "interaction failed" note.
	await interaction.deferUpdate().catch(() => undefined);
}

/** Register the notice modal's close. Called once at boot from main.ts, before the InteractionCreate listener installs. */
export function registerNoticeModal(): void {
	registerModal(NOTICE_MODAL_PREFIX, acknowledgeTextModal);
}

// The ephemeral answer for an interaction that cannot show a modal: a followUp once
// it was deferred or answered, since a second reply is refused, and a reply otherwise.
async function replyPrivately(interaction: RepliableInteraction, reply: InteractionReplyOptions): Promise<void> {
	const sent = interaction.deferred || interaction.replied ? interaction.followUp(reply) : interaction.reply(reply);
	await sent.catch((error: unknown) => console.error("[text-modal] the private notice failed", { interactionId: interaction.id, error }));
}

// A modal can only be the FIRST answer, and only to an interaction that carries
// showModal: a modal submit has none, which is the case this guard exists for.
function canOpenModal(interaction: RepliableInteraction): interaction is ModalOpeningInteraction {
	if (interaction.deferred || interaction.replied) return false;
	return "showModal" in interaction;
}
