import {
	ActionRowBuilder,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextDisplayBuilder,
	type ButtonInteraction,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { showModalOrReply } from "@utils/textModal.js";
import { GAME_ROOM_MODAL_PREFIX, GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";

// ── pickerModal ──────────────────────────────────────────────────────
// What:  a game room's private single choice picker (the opponent, the bot count, the
//        player to remove, a rock paper scissors throw) shown as a modal with one
//        required select, instead of a private select message that sits in the channel
//        until it is dismissed (2026-10 item 254 Phase 5b, owner decision 3).
// Who:   challengeBoard (opponent, bots), hostControls (kick) and roomGames (rps).
//        gameRoomHandlers routes the modal's submit, by the same action name, to the
//        handler the select message has always used, so both paths share one handler
//        and every re-gate in it.
// When:  only as the FIRST answer to a button press, the one place Discord opens a
//        modal. When Discord refuses it, the press is answered with the select message
//        it replaced, whose select still routes on the select prefix.
// How:   a text display with the prompt over a label holding the select. The modal's
//        customId carries the routing; the select inside it is read back by its field
//        id. Not a picker with several choices or a picker that rebuilds itself after a
//        pick: those stay select messages (the audit in companyuno-discord/docs/
//        handoffs/dero-private-reply-audit-2026-10.md says which and why).

/** The select's id inside a picker modal, which the submit reads its values back by. */
const PICKER_FIELD = "pick";

/** What a picker asks: its routing, the modal's title, the prompt above the select, and the select itself. */
export interface PickerContent {
	action: string;
	roomId: string;
	title: string;
	prompt: string;
	label: string;
	select: StringSelectMenuBuilder;
}

/** The picker modal. Exported for the tests, which read it back with toJSON. */
export function buildPickerModal(content: PickerContent): ModalBuilder {
	const field = StringSelectMenuBuilder.from(content.select.toJSON()).setCustomId(PICKER_FIELD).setRequired(true);
	return new ModalBuilder()
		.setCustomId(`${GAME_ROOM_MODAL_PREFIX}:${content.action}:${content.roomId}`)
		.setTitle(content.title)
		.addTextDisplayComponents(new TextDisplayBuilder().setContent(content.prompt))
		.addLabelComponents(new LabelBuilder().setLabel(content.label).setStringSelectMenuComponent(field));
}

/**
 * Answer a press with the picker modal, or, when Discord refuses it, with the private
 * select message it replaced. Never throws past a failed fallback.
 */
export async function showPicker(interaction: ButtonInteraction, content: PickerContent): Promise<void> {
	const select = StringSelectMenuBuilder.from(content.select.toJSON()).setCustomId(`${GAME_ROOM_SELECT_PREFIX}:${content.action}:${content.roomId}`);
	await showModalOrReply(interaction, buildPickerModal(content), () => ({
		content: content.prompt,
		components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
		flags: MessageFlags.Ephemeral,
	}));
}

/** Whether a customId's prefix is a picker's: the select message's or the modal's. */
export function isPickerPrefix(prefix: string | undefined): boolean {
	return prefix === GAME_ROOM_SELECT_PREFIX || prefix === GAME_ROOM_MODAL_PREFIX;
}

/**
 * The values a picker was answered with, from its select message or from its modal.
 * Empty for a modal submit without the field, which only a hand made submit can be,
 * since Discord enforces a required select; each handler already refuses an empty pick.
 */
export function pickedValues(interaction: StringSelectMenuInteraction | ModalSubmitInteraction): readonly string[] {
	if (!interaction.isModalSubmit()) return interaction.values;
	try {
		return interaction.fields.getStringSelectValues(PICKER_FIELD);
	} catch {
		return [];
	}
}

/**
 * Acknowledge a slow pick. A select message is deferred for an edit in place; a modal's
 * pick gets a private defer instead, because deferUpdate on a modal opened from a card's
 * button would make the next editReply rewrite that card.
 */
export async function deferPick(interaction: StringSelectMenuInteraction | ModalSubmitInteraction): Promise<void> {
	if (interaction.isModalSubmit()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	else await interaction.deferUpdate();
}

/** A slow pick's outcome: it replaces the picker message, or answers the modal privately. */
export async function answerPick(interaction: StringSelectMenuInteraction | ModalSubmitInteraction, content: string): Promise<void> {
	await interaction.editReply(interaction.isModalSubmit() ? { content } : { content, components: [] });
}
