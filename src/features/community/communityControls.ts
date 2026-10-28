import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, type MessageActionRowComponentBuilder } from "discord.js";
import { communityCopy } from "./communityCopy.js";

// ── communityControls ────────────────────────────────────────────────
// What:  every customId and component the community feature puts on screen (2026-10
//        item 247 Phases 3 and 4, and item 254's Onboarding editor): the two admin
//        guide buttons, the Enable Community review's Confirm, the Configure
//        Onboarding offer the flow chains into, and the Onboarding review's controls.
//        Pure builders only.
// Who:   communityButtons (the admin guide row and the router that answers these
//        customIds), enableCommunity and configureOnboarding (their review and
//        result replies).
// Where: a leaf on purpose. The router imports the flow and the flow replies with
//        these controls, so keeping them in either file would make the two import
//        each other; here both import one module that imports neither.
// How:   customIds follow the registry convention `community:<action>`, and the
//        registry routes on the part before the first colon, so one registration
//        of COMMUNITY_PREFIX answers every action below. The review's editing
//        controls carry the draft's REVISION before their indexes, so a control on
//        an older review can never edit the wrong question of a newer draft.

/** The interactionRegistry prefix every community control routes on. */
export const COMMUNITY_PREFIX = "community";
// The Onboarding confirm's own prefix (2026-10 item 263 R3-20). A modal registered under
// COMMUNITY_PREFIX would also catch promptEditModal's `community:promptmodal:*` modals,
// which their awaitModalSubmit collectors answer, so the confirm's Submit routes apart.
export const COMMUNITY_CONFIRM_PREFIX = "communityconfirm";

/** The customId of each community control, `community:<action>`. */
export const COMMUNITY_CUSTOM_IDS = {
	enable: `${COMMUNITY_PREFIX}:enable`,
	configure: `${COMMUNITY_PREFIX}:configure`,
	confirm: `${COMMUNITY_PREFIX}:confirm`,
	// The Onboarding review's editor (2026-10 item 254). Each carries more segments,
	// see COMMUNITY_INDEXED_ACTIONS: `<revision>`, then the question's index, then
	// the answer's index where the control acts on one answer.
	pickPrompt: `${COMMUNITY_PREFIX}:pickprompt`,
	editPrompt: `${COMMUNITY_PREFIX}:editprompt`,
	deletePrompt: `${COMMUNITY_PREFIX}:deleteprompt`,
	addPrompt: `${COMMUNITY_PREFIX}:addprompt`,
	pickOption: `${COMMUNITY_PREFIX}:pickoption`,
	addOption: `${COMMUNITY_PREFIX}:addoption`,
	editOption: `${COMMUNITY_PREFIX}:editoption`,
	deleteOption: `${COMMUNITY_PREFIX}:deleteoption`,
	confirmOnboarding: `${COMMUNITY_PREFIX}:confirmOnboarding`,
	// The confirm modal's Submit and its fallback button (2026-10 item 263 R3-20): the
	// one press that writes Onboarding, routed as a modal or a button under its own prefix.
	writeOnboarding: `${COMMUNITY_CONFIRM_PREFIX}:onboarding`,
	cancelOnboarding: `${COMMUNITY_PREFIX}:cancelOnboarding`,
} as const;

/** The action a community customId names, the part after the prefix. */
export type CommunityAction = keyof typeof COMMUNITY_CUSTOM_IDS;

/** The actions whose customId carries more segments after the action; every other action matches its customId exactly. */
export const COMMUNITY_INDEXED_ACTIONS: ReadonlySet<CommunityAction> = new Set<CommunityAction>([
	"pickPrompt",
	"editPrompt",
	"deletePrompt",
	"addPrompt",
	"pickOption",
	"addOption",
	"editOption",
	"deleteOption",
]);

/** The review's two selects; every other community control is a button. */
export const COMMUNITY_SELECT_ACTIONS: ReadonlySet<CommunityAction> = new Set<CommunityAction>(["pickPrompt", "pickOption"]);

// Discord caps a select at 25 options and an option label at 100 characters.
const SELECT_OPTIONS_MAX = 25;
const SELECT_LABEL_MAX = 100;

/** What the Onboarding review's controls need to know about the draft. */
export interface IOnboardingReviewControlsView {
	revision: number;
	prompts: ReadonlyArray<{ title: string; isFinal: boolean; options: ReadonlyArray<{ title: string }> }>;
	/** The question picked in the question select, whose controls show; null when none is. */
	focusedPrompt: number | null;
	/** The answer of the focused question picked in the answer select; null when none is. */
	focusedOption: number | null;
}

/** Enable Community, the lead button on the admin guide's community row. */
export function buildEnableCommunityButton(): ButtonBuilder {
	return new ButtonBuilder().setCustomId(COMMUNITY_CUSTOM_IDS.enable).setLabel(communityCopy.buttons.enable).setEmoji("🏘️").setStyle(ButtonStyle.Primary);
}

/** Configure Onboarding, on the admin guide and as the offer after Community is on. */
export function buildConfigureOnboardingButton(): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(COMMUNITY_CUSTOM_IDS.configure)
		.setLabel(communityCopy.buttons.configure)
		.setEmoji("🧭")
		.setStyle(ButtonStyle.Secondary);
}

/** The review's one row: Confirm, which is the only button that changes the server. */
export function buildConfirmEnableRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(COMMUNITY_CUSTOM_IDS.confirm).setLabel(communityCopy.buttons.confirm).setEmoji("✅").setStyle(ButtonStyle.Success)
	);
}

/** The offer that follows Community being on: the Configure Onboarding button alone. */
export function buildConfigureOnboardingOfferRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(buildConfigureOnboardingButton());
}

/** The customId of one review control: its action, the draft revision, then the indexes it acts on. */
export function reviewControlCustomId(action: CommunityAction, revision: number, ...indexes: number[]): string {
	return [COMMUNITY_CUSTOM_IDS[action], revision, ...indexes].join(":");
}

/**
 * The Onboarding review's controls, at most Discord's five rows:
 *   ① a select of the questions;
 *   ② for the picked question: Edit question, and Delete question and Add answer
 *      unless it is the final one, whose shape is fixed;
 *   ③ a select of the picked question's answers (never the final question's);
 *   ④ for the picked answer: Edit answer and Delete answer;
 *   ⑤ Add question, Confirm and Cancel.
 * An answer list is always picked from a select rather than shown as buttons, so a
 * question with many answers never runs out of rows. Each select shows its first 25.
 */
export function buildOnboardingReviewRows(view: IOnboardingReviewControlsView): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
	const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
	if (view.prompts.length > 0) rows.push(selectRow(promptSelect(view)));

	const prompt = view.focusedPrompt === null ? undefined : view.prompts[view.focusedPrompt];
	if (prompt && view.focusedPrompt !== null) {
		rows.push(buttonRow(promptButtons(view.revision, view.focusedPrompt, prompt.isFinal)));
		if (!prompt.isFinal && prompt.options.length > 0) rows.push(selectRow(optionSelect(view, view.focusedPrompt, prompt.options)));
		const option = view.focusedOption === null ? undefined : prompt.options[view.focusedOption];
		if (!prompt.isFinal && option && view.focusedOption !== null) rows.push(buttonRow(optionButtons(view.revision, view.focusedPrompt, view.focusedOption)));
	}

	rows.push(
		buttonRow([
			button(reviewControlCustomId("addPrompt", view.revision), communityCopy.buttons.addPrompt, "➕", ButtonStyle.Secondary),
			button(COMMUNITY_CUSTOM_IDS.confirmOnboarding, communityCopy.buttons.confirmOnboarding, "✅", ButtonStyle.Success),
			new ButtonBuilder().setCustomId(COMMUNITY_CUSTOM_IDS.cancelOnboarding).setLabel(communityCopy.buttons.cancelOnboarding).setStyle(ButtonStyle.Secondary),
		])
	);
	return rows;
}

function promptSelect(view: IOnboardingReviewControlsView): StringSelectMenuBuilder {
	const options = view.prompts.slice(0, SELECT_OPTIONS_MAX).map((prompt, index) =>
		new StringSelectMenuOptionBuilder()
			.setValue(String(index))
			.setLabel(clip(`${index + 1}. ${prompt.title}`))
			.setDefault(index === view.focusedPrompt)
	);
	return new StringSelectMenuBuilder()
		.setCustomId(reviewControlCustomId("pickPrompt", view.revision))
		.setPlaceholder(communityCopy.buttons.pickPromptPlaceholder)
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(options);
}

function optionSelect(view: IOnboardingReviewControlsView, promptIndex: number, answers: ReadonlyArray<{ title: string }>): StringSelectMenuBuilder {
	const options = answers.slice(0, SELECT_OPTIONS_MAX).map((answer, index) =>
		new StringSelectMenuOptionBuilder()
			.setValue(String(index))
			.setLabel(clip(answer.title))
			.setDefault(index === view.focusedOption)
	);
	return new StringSelectMenuBuilder()
		.setCustomId(reviewControlCustomId("pickOption", view.revision, promptIndex))
		.setPlaceholder(communityCopy.buttons.pickOptionPlaceholder)
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(options);
}

function promptButtons(revision: number, promptIndex: number, isFinal: boolean): ButtonBuilder[] {
	const edit = button(reviewControlCustomId("editPrompt", revision, promptIndex), communityCopy.buttons.editPrompt, "✏️", ButtonStyle.Primary);
	if (isFinal) return [edit];
	return [
		edit,
		button(reviewControlCustomId("deletePrompt", revision, promptIndex), communityCopy.buttons.deletePrompt, "🗑️", ButtonStyle.Danger),
		button(reviewControlCustomId("addOption", revision, promptIndex), communityCopy.buttons.addOption, "➕", ButtonStyle.Secondary),
	];
}

function optionButtons(revision: number, promptIndex: number, optionIndex: number): ButtonBuilder[] {
	return [
		button(reviewControlCustomId("editOption", revision, promptIndex, optionIndex), communityCopy.buttons.editOption, "✏️", ButtonStyle.Primary),
		button(reviewControlCustomId("deleteOption", revision, promptIndex, optionIndex), communityCopy.buttons.deleteOption, "🗑️", ButtonStyle.Danger),
	];
}

function button(customId: string, label: string, emoji: string, style: ButtonStyle): ButtonBuilder {
	return new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(style);
}

function buttonRow(buttons: ButtonBuilder[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
	return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(buttons);
}

function selectRow(select: StringSelectMenuBuilder): ActionRowBuilder<MessageActionRowComponentBuilder> {
	return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);
}

const clip = (text: string): string => (text.length > SELECT_LABEL_MAX ? text.slice(0, SELECT_LABEL_MAX) : text);
