import {
	ActionRowBuilder,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { showModalOrReply } from "@utils/textModal.js";
import { GAME_ROOM_MODAL_PREFIX, GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";

// ── pickerModal ──────────────────────────────────────────────────────
// What:  a game room's private single choice picker (the opponent, the bot count, the
//        player to remove, a rock paper scissors throw) shown as a modal with one
//        required select, instead of a private select message that sits in the channel
//        until it is dismissed (2026-10 item 254 Phase 5b, owner decision 3). Since 2026-10
//        item 257 Phase 4a it also builds the modal of several fields a turn opens
//        (buildFieldsModal): a hand as text, a select of moves and an optional typed amount;
//        and since 2026-10 item 263 Phase 2a every game's creation modal (challengeSettings),
//        with a multi choice select and prefilled values for Edit settings.
// Who:   challengeBoard (opponent, bots), hostControls (kick) and roomGames (rps), and
//        the daily claim's rock paper scissors round (economy/chipClaim.ts, 2026-10 item
//        257 Phase 3a), which routes to its own handler rather than a room's.
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

/**
 * Where a picker's answer routes: a room action (the game room handlers' prefixes, by
 * action name and room id), or a route of a picker's own, its modal's customId and its
 * fallback select's, for a picker outside the rooms.
 */
export type PickerRouting = { action: string; roomId: string } | { route: { modalId: string; selectId: string } };

/** What a picker asks: its routing, the modal's title, the prompt above the select, and the select itself. */
export type PickerContent = PickerRouting & {
	title: string;
	prompt: string;
	label: string;
	select: StringSelectMenuBuilder;
};

const modalIdOf = (content: PickerRouting): string => ("route" in content ? content.route.modalId : `${GAME_ROOM_MODAL_PREFIX}:${content.action}:${content.roomId}`);
const selectIdOf = (content: PickerRouting): string => ("route" in content ? content.route.selectId : `${GAME_ROOM_SELECT_PREFIX}:${content.action}:${content.roomId}`);

/** The picker modal. Exported for the tests, which read it back with toJSON. */
export function buildPickerModal(content: PickerContent): ModalBuilder {
	const field = StringSelectMenuBuilder.from(content.select.toJSON()).setCustomId(PICKER_FIELD).setRequired(true);
	return new ModalBuilder()
		.setCustomId(modalIdOf(content))
		.setTitle(content.title)
		.addTextDisplayComponents(new TextDisplayBuilder().setContent(content.prompt))
		.addLabelComponents(new LabelBuilder().setLabel(content.label).setStringSelectMenuComponent(field));
}

/**
 * Answer a press with the picker modal, or, when Discord refuses it, with the private
 * select message it replaced. Never throws past a failed fallback.
 */
export async function showPicker(interaction: ButtonInteraction | ChatInputCommandInteraction, content: PickerContent): Promise<void> {
	const select = StringSelectMenuBuilder.from(content.select.toJSON()).setCustomId(selectIdOf(content));
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

// ── several fields (the turn modal, 2026-10 item 257 Phase 4a) ────────
// A turn's modal is a hand over its moves: text displays, then selects and an optional text
// input. Discord caps a modal at five components in all (text displays and labels count
// alike), so the builder keeps the fields whole and gives the text what room is left.

/** Discord's ceiling on the components of one modal. */
const MODAL_COMPONENT_LIMIT = 5;

/** One option of a select field. */
export interface FieldOption {
	label: string;
	value: string;
	description?: string;
	isDefault?: boolean;
}

/**
 * One field of a fields modal: a required select, a multi choice select (any number of its
 * options, none included), or an optional text input. `value` prefills the field (the
 * challenge settings editor reopens a modal with the draft's current choices): a select's
 * chosen options, a text input's text. Absent, a select falls back to its options' own
 * `isDefault` and a text input opens empty.
 */
export type ModalField =
	| { kind: "select"; id: string; label: string; options: readonly FieldOption[]; value?: string }
	| { kind: "multi"; id: string; label: string; options: readonly FieldOption[]; value?: readonly string[] }
	| { kind: "text"; id: string; label: string; placeholder: string; maxLength: number; value?: string };

/** What a fields modal shows: its routing id, its title, the text over the fields, and the fields. */
export interface FieldsModalContent {
	customId: string;
	title: string;
	text: readonly string[];
	fields: readonly ModalField[];
}

const MAX_MODAL_TITLE_LENGTH = 45;
const MAX_TEXT_DISPLAY_LENGTH = 4000;

/**
 * The modal for several fields. The text lands in as many displays as the fields leave room
 * for (the last one carries what does not fit, joined), so a hand is never dropped for a move
 * and a move is never dropped for a hand. Exported for the tests, which read it with toJSON.
 */
export function buildFieldsModal(content: FieldsModalContent): ModalBuilder {
	const displayRoom = Math.max(MODAL_COMPONENT_LIMIT - content.fields.length, 0);
	const sections = content.text.filter((section) => section.trim().length > 0);
	const displays = sections.length <= displayRoom ? sections : [...sections.slice(0, displayRoom - 1), sections.slice(displayRoom - 1).join("\n\n")];
	const modal = new ModalBuilder().setCustomId(content.customId).setTitle(content.title.slice(0, MAX_MODAL_TITLE_LENGTH));
	for (const section of displays.slice(0, displayRoom)) modal.addTextDisplayComponents(new TextDisplayBuilder().setContent(section.slice(0, MAX_TEXT_DISPLAY_LENGTH)));
	for (const field of content.fields) modal.addLabelComponents(labelOf(field));
	return modal;
}

function labelOf(field: ModalField): LabelBuilder {
	const label = new LabelBuilder().setLabel(field.label);
	if (field.kind === "text") {
		const input = new TextInputBuilder().setCustomId(field.id).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(field.maxLength).setPlaceholder(field.placeholder);
		if (field.value) input.setValue(field.value.slice(0, field.maxLength));
		return label.setTextInputComponent(input);
	}
	// A multi choice select may be left empty (min 0), so it is not required; Discord refuses a
	// required select whose minimum is zero.
	const isMulti = field.kind === "multi";
	const chosen = prefilledValues(field);
	const select = new StringSelectMenuBuilder()
		.setCustomId(field.id)
		.setMinValues(isMulti ? 0 : 1)
		.setMaxValues(isMulti ? field.options.length : 1)
		.setRequired(!isMulti)
		.addOptions(
			field.options.map((option) => ({
				label: option.label,
				value: option.value,
				description: option.description,
				default: chosen ? chosen.includes(option.value) : option.isDefault === true,
			}))
		);
	return label.setStringSelectMenuComponent(select);
}

// The options a select opens with chosen, or undefined to leave each option's own default.
function prefilledValues(field: Exclude<ModalField, { kind: "text" }>): readonly string[] | undefined {
	if (field.kind === "multi") return field.value;
	return field.value === undefined ? undefined : [field.value];
}

/**
 * What a fields modal was answered with, by field id: a select's chosen value, a multi choice
 * select's chosen values joined with commas (an option value never holds one), a text input's
 * trimmed text. A field the submit lacks reads as empty, which only a hand made submit can
 * produce, since Discord enforces a required select; the caller refuses an empty move.
 */
export function readFieldAnswers(interaction: ModalSubmitInteraction, fields: readonly ModalField[]): Record<string, string> {
	const answers: Record<string, string> = {};
	for (const field of fields) {
		try {
			if (field.kind === "text") answers[field.id] = interaction.fields.getTextInputValue(field.id).trim();
			else if (field.kind === "multi") answers[field.id] = interaction.fields.getStringSelectValues(field.id).join(",");
			else answers[field.id] = interaction.fields.getStringSelectValues(field.id)[0] ?? "";
		} catch {
			answers[field.id] = "";
		}
	}
	return answers;
}
