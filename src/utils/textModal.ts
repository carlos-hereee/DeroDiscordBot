import {
	MessageFlags,
	ModalBuilder,
	TextDisplayBuilder,
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
// Who:   game-rooms privateView (a player's own board or hand) and the admin
//        controls that answer a press with a notice: the community row and the admin
//        command launcher. main.ts registers the notice's close once at boot.
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

/** The text modal under one customId. Exported for the tests, which read it back with toJSON. */
export function buildTextModal(customId: string, content: TextModalContent): ModalBuilder {
	return new ModalBuilder()
		.setCustomId(customId)
		.setTitle(content.title.slice(0, MAX_TITLE_LENGTH))
		.addTextDisplayComponents(
			...content.sections
				.filter((section) => section.trim().length > 0)
				.slice(0, MAX_SECTIONS)
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
	try {
		await interaction.showModal(buildTextModal(customId, content));
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
 * Answer an admin control with a short notice: a text modal when the interaction can
 * still open one, and otherwise (a modal submit, or an interaction already deferred
 * or answered) the ephemeral reply `fallback` builds, with no button on it. The
 * interaction id keys the modal, so two notices are never confused.
 */
export async function showNotice(
	interaction: RepliableInteraction,
	content: TextModalContent,
	fallback: () => InteractionReplyOptions | Promise<InteractionReplyOptions>
): Promise<void> {
	if (canOpenModal(interaction)) {
		await showTextModal(interaction, `${NOTICE_MODAL_PREFIX}:${interaction.id}`, content, fallback);
		return;
	}
	const reply = await fallback();
	const sent = interaction.deferred || interaction.replied ? interaction.followUp(reply) : interaction.reply(reply);
	await sent.catch((error: unknown) => console.error("[text-modal] the private notice failed", { interactionId: interaction.id, error }));
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

/** Register the notice modal's close. Called once at boot from main.ts, before the InteractionCreate listener installs. */
export function registerNoticeModal(): void {
	registerModal(NOTICE_MODAL_PREFIX, acknowledgeTextModal);
}

// A modal can only be the FIRST answer, and only to an interaction that carries
// showModal: a modal submit has none, which is the case this guard exists for.
function canOpenModal(interaction: RepliableInteraction): interaction is ModalOpeningInteraction {
	if (interaction.deferred || interaction.replied) return false;
	return "showModal" in interaction;
}
