import { LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, type ButtonInteraction, type Guild, type ModalSubmitInteraction } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { communityCopy } from "./communityCopy.js";
import { COMMUNITY_PREFIX } from "./communityControls.js";
import { buildOnboardingReview, readPendingDraft, replyOnboardingError, storePendingDraft, type IConfigureOnboardingConfig } from "./configureOnboarding.js";
import {
	ONBOARDING_OPTIONS_PER_PROMPT_MAX,
	ONBOARDING_OPTION_DESCRIPTION_MAX_LENGTH,
	ONBOARDING_OPTION_TITLE_MAX_LENGTH,
	ONBOARDING_PROMPT_TITLE_MAX_LENGTH,
	plainOption,
	type IDraftOption,
	type IDraftPrompt,
	type PendingOnboardingDraft,
} from "./onboardingDraft.js";

// ── promptEditModal ──────────────────────────────────────────────────
// What:  the Edit button on each question of the Onboarding review (2026-10 item 247
//        Phase 4): a modal preloaded with the question and its answers, one answer a
//        line as "title | description"; the submit changes that question in the
//        draft, or removes it when every answer is cleared, and redraws the review in
//        place. The final question's modal holds only its title and its one answer's
//        title, so its required, pick one shape and its member role never change.
// Who:   communityButtons routes `community:editprompt:<index>` here AFTER it has
//        gated the clicker; the submit gates its submitter again, because a modal
//        submit is not a button press and a role can be taken away while it is open.
// When:  while the admin's draft is live (configureOnboarding's window). Nothing here
//        talks to Discord beyond the modal and the redraw; Confirm does the write.
// How:   answers are matched to the question's current answers by TITLE, ignoring
//        case, and a matched answer keeps its id, roles, channels and emoji. By title
//        rather than by line: deleting a line would shift every answer below it onto
//        another answer's role, and a renamed answer losing its role is the safe way
//        to be wrong (the review shows it). An answer typed fresh gives nothing.

// ── constants ────────────────────────────────────────────────────────

// How long the modal waits for its submit, the same wait as Enable Community's.
const MODAL_TIMEOUT_MS = 10 * 60_000;
// Discord's cap on a text input's value; the answers box cannot preload more.
const TEXT_INPUT_MAX_LENGTH = 4000;

const MODAL_ID_PREFIX = `${COMMUNITY_PREFIX}:promptmodal`;
const TITLE_FIELD = "prompt_title";
const OPTIONS_FIELD = "prompt_options";
const FINAL_OPTION_FIELD = "final_option_title";
// Splits an answer line into title and description; the box shows it with a space
// on each side, and a typed one without spaces works the same.
const OPTION_SEPARATOR = "|";
const INDEX_PATTERN = /^\d+$/;

// Zero width characters: a title made only of these looks filled in and renders as
// nothing, so they are stripped before the empty check. The same set as rulesEdit's
// ZERO_WIDTH (a hand kept pair; that file is a Phase 2 module this phase leaves
// alone). Built from code points so no invisible character sits in this source.
const ZERO_WIDTH = new RegExp(`[${[0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((codePoint) => String.fromCharCode(codePoint)).join("")}]`, "g");

// ── types ────────────────────────────────────────────────────────────

/** What one submit typed: the question, then either the answers box or the final answer's title. */
export interface IPromptEdit {
	title: string;
	optionsText?: string;
	finalOptionTitle?: string;
}

/** The draft with the edit applied, or the sentence that says why it was refused (the draft is then unchanged). */
export type PromptEditResult = { ok: true; draft: PendingOnboardingDraft } | { ok: false; reason: string };

type ParsedOptions = { ok: true; options: IDraftOption[] } | { ok: false; reason: string };

// ── pure: the answers box ────────────────────────────────────────────

/** The answers as the edit box shows them: one per line, "title | description", or the title alone when it has none. */
export function serializeOptions(options: readonly IDraftOption[]): string {
	return options.map((option) => (option.description ? `${option.title} ${OPTION_SEPARATOR} ${option.description}` : option.title)).join("\n");
}

/**
 * The answers typed into the box: one a line, blank lines skipped, split at the
 * first "|" into title and description, each checked against Discord's caps, and
 * matched to the question's current answers by title (see the header).
 */
export function parseOptionLines(text: string, previous: readonly IDraftOption[]): ParsedOptions {
	const copy = communityCopy.onboarding.editErrors;
	const lines = text.split(/\r?\n/).map(clean).filter((line) => line !== "");
	if (lines.length > ONBOARDING_OPTIONS_PER_PROMPT_MAX) return { ok: false, reason: copy.tooManyOptions(ONBOARDING_OPTIONS_PER_PROMPT_MAX) };

	const previousByTitle = new Map(previous.map((option) => [option.title.toLowerCase(), option]));
	const seen = new Set<string>();
	const options: IDraftOption[] = [];
	for (const line of lines) {
		const separator = line.indexOf(OPTION_SEPARATOR);
		const title = clean(separator === -1 ? line : line.slice(0, separator));
		const description = separator === -1 ? "" : clean(line.slice(separator + OPTION_SEPARATOR.length));
		if (!title) return { ok: false, reason: copy.emptyOptionTitle };
		if (title.length > ONBOARDING_OPTION_TITLE_MAX_LENGTH) return { ok: false, reason: copy.optionTitleTooLong(title, ONBOARDING_OPTION_TITLE_MAX_LENGTH) };
		if (description.length > ONBOARDING_OPTION_DESCRIPTION_MAX_LENGTH) {
			return { ok: false, reason: copy.descriptionTooLong(title, ONBOARDING_OPTION_DESCRIPTION_MAX_LENGTH) };
		}
		// Two answers with one title would make the title match ambiguous next edit.
		const key = title.toLowerCase();
		if (seen.has(key)) return { ok: false, reason: copy.duplicateOption(title) };
		seen.add(key);

		const matched = previousByTitle.get(key);
		options.push(matched ? { ...matched, title, description: description || null } : plainOption(title, description || null));
	}
	return { ok: true, options };
}

/** Apply one submitted edit to the question at this index: a new draft with it changed, or with it removed when every answer was cleared. */
export function applyPromptEdit(draft: PendingOnboardingDraft, index: number, edit: IPromptEdit): PromptEditResult {
	const copy = communityCopy.onboarding.editErrors;
	const prompt = draft.prompts[index];
	if (!prompt) return { ok: false, reason: copy.promptGone };

	if (prompt.isFinal) return applyFinalPromptEdit(draft, index, prompt, edit);

	const parsed = parseOptionLines(edit.optionsText ?? "", prompt.options);
	if (!parsed.ok) return parsed;
	// Clearing every answer is how a question is removed, checked before the title so
	// clearing the whole modal removes it too.
	if (parsed.options.length === 0) return { ok: true, draft: { ...draft, prompts: draft.prompts.filter((_, position) => position !== index) } };

	const title = clean(edit.title);
	const titleRefusal = refuseTitle(title);
	if (titleRefusal) return titleRefusal;
	return { ok: true, draft: replacePrompt(draft, index, { ...prompt, title, options: parsed.options }) };
}

// Only the two titles change. The answer keeps its id, its member role and the rest
// of itself, so however the owner renames it, picking it still gives the role.
function applyFinalPromptEdit(draft: PendingOnboardingDraft, index: number, prompt: IDraftPrompt, edit: IPromptEdit): PromptEditResult {
	const copy = communityCopy.onboarding.editErrors;
	const title = clean(edit.title);
	const titleRefusal = refuseTitle(title);
	if (titleRefusal) return titleRefusal;
	const optionTitle = clean(edit.finalOptionTitle ?? "");
	if (!optionTitle) return { ok: false, reason: copy.emptyOptionTitle };
	if (optionTitle.length > ONBOARDING_OPTION_TITLE_MAX_LENGTH) return { ok: false, reason: copy.optionTitleTooLong(optionTitle, ONBOARDING_OPTION_TITLE_MAX_LENGTH) };
	const options = prompt.options.map((option, position) => (position === 0 ? { ...option, title: optionTitle } : option));
	return { ok: true, draft: replacePrompt(draft, index, { ...prompt, title, options }) };
}

function refuseTitle(title: string): PromptEditResult | null {
	const copy = communityCopy.onboarding.editErrors;
	if (!title) return { ok: false, reason: copy.emptyTitle };
	if (title.length > ONBOARDING_PROMPT_TITLE_MAX_LENGTH) return { ok: false, reason: copy.titleTooLong(ONBOARDING_PROMPT_TITLE_MAX_LENGTH) };
	return null;
}

// Every other question keeps its own object, which is what lets a submit tell that
// the question it opened is still the one at its index (handlePromptEditSubmitted).
function replacePrompt(draft: PendingOnboardingDraft, index: number, prompt: IDraftPrompt): PendingOnboardingDraft {
	return { ...draft, prompts: draft.prompts.map((existing, position) => (position === index ? prompt : existing)) };
}

const clean = (text: string): string => text.replace(ZERO_WIDTH, "").trim();

// ── the modal ────────────────────────────────────────────────────────

/** The edit modal for a question, preloaded with what it says now; null when its answers do not fit one edit box. */
export function buildPromptEditModal(modalId: string, prompt: IDraftPrompt, position: number): ModalBuilder | null {
	const copy = communityCopy.onboarding.modal;
	// A preloaded value longer than its input allows makes Discord reject the whole
	// modal, so a question read from the live config that is longer is not offered.
	if (prompt.title.length > ONBOARDING_PROMPT_TITLE_MAX_LENGTH) return null;
	const titleInput = textInput(TITLE_FIELD, TextInputStyle.Short, ONBOARDING_PROMPT_TITLE_MAX_LENGTH, prompt.title, true);

	if (prompt.isFinal) {
		const answerTitle = prompt.options[0]?.title ?? "";
		if (answerTitle.length > ONBOARDING_OPTION_TITLE_MAX_LENGTH) return null;
		return new ModalBuilder()
			.setCustomId(modalId)
			.setTitle(copy.finalTitle)
			.addLabelComponents(
				new LabelBuilder().setLabel(copy.promptTitleLabel).setDescription(copy.finalTitleDescription).setTextInputComponent(titleInput),
				new LabelBuilder()
					.setLabel(copy.finalOptionLabel)
					.setDescription(copy.finalOptionDescription)
					.setTextInputComponent(textInput(FINAL_OPTION_FIELD, TextInputStyle.Short, ONBOARDING_OPTION_TITLE_MAX_LENGTH, answerTitle, true))
			);
	}

	const answers = serializeOptions(prompt.options);
	if (answers.length > TEXT_INPUT_MAX_LENGTH) return null;
	const answersInput = textInput(OPTIONS_FIELD, TextInputStyle.Paragraph, TEXT_INPUT_MAX_LENGTH, answers, false).setPlaceholder(copy.optionsPlaceholder);
	return new ModalBuilder()
		.setCustomId(modalId)
		.setTitle(copy.title(position))
		.addLabelComponents(
			new LabelBuilder().setLabel(copy.promptTitleLabel).setDescription(copy.promptTitleDescription).setTextInputComponent(titleInput),
			new LabelBuilder().setLabel(copy.optionsLabel).setDescription(copy.optionsDescription).setTextInputComponent(answersInput)
		);
}

function textInput(customId: string, style: TextInputStyle, maxLength: number, value: string, required: boolean): TextInputBuilder {
	const input = new TextInputBuilder().setCustomId(customId).setStyle(style).setMaxLength(maxLength).setRequired(required);
	// An empty preload is left unset: Discord treats a set value as at least 1 long.
	return value ? input.setValue(value) : input;
}

// ── the Edit press ───────────────────────────────────────────────────

/** An Edit button on the review, once the router has gated the clicker. indexArgument is the customId's last segment. */
export async function handleEditPromptButton(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig, indexArgument: string | null): Promise<void> {
	// An Edit id with no index is from no layout this version draws.
	if (!indexArgument || !INDEX_PATTERN.test(indexArgument)) {
		await replyOnboardingError(interaction, communityCopy.errors.controlRetired, config);
		return;
	}
	const draft = readPendingDraft(guild.id, interaction.user.id);
	if (!draft) {
		await replyOnboardingError(interaction, communityCopy.onboarding.expired, config);
		return;
	}
	const index = Number(indexArgument);
	const prompt = draft.prompts[index];
	if (!prompt) {
		await replyOnboardingError(interaction, communityCopy.onboarding.editErrors.promptGone, config);
		return;
	}

	// The interaction id keys the modal, so a modal opened from another press is never mistaken for this one.
	const modalId = `${MODAL_ID_PREFIX}:${interaction.id}`;
	const modal = buildPromptEditModal(modalId, prompt, index + 1);
	if (!modal) {
		await replyOnboardingError(interaction, communityCopy.onboarding.editErrors.tooLongToEdit, config);
		return;
	}
	await interaction.showModal(modal);
	const submission = await interaction
		.awaitModalSubmit({ time: MODAL_TIMEOUT_MS, filter: (submit) => submit.user.id === interaction.user.id && submit.customId === modalId })
		.catch(() => null);
	// Timed out or dismissed: Discord gives nothing to reply to, and nothing changed.
	if (!submission) return;

	await handlePromptEditSubmitted(submission, index, prompt);
}

/** One edit modal submit: gate again, apply the edit to the live draft, and redraw the review. */
export async function handlePromptEditSubmitted(submission: ModalSubmitInteraction, index: number, openedPrompt: IDraftPrompt): Promise<void> {
	const guild = submission.guild;
	const config = guild ? ((await guildConfigStore.findByGuildId(guild.id)) as IConfigureOnboardingConfig | null) : null;
	if (!guild || !config) {
		await replyOnboardingError(submission, communityCopy.onboarding.expired, config);
		return;
	}
	if (!(await gateOwnerOrAdmin(submission, config))) {
		await replyOnboardingError(submission, getPluginCopy(config).responses.noWizardPowers, config);
		return;
	}
	const draft = readPendingDraft(guild.id, submission.user.id);
	if (!draft) {
		await replyOnboardingError(submission, communityCopy.onboarding.expired, config);
		return;
	}
	// The draft may have moved on while the modal was open (a fresh Configure
	// Onboarding press, an edit from an older review). Writing this submit onto
	// whatever now sits at its index would change the wrong question.
	if (draft.prompts[index] !== openedPrompt) {
		await replyOnboardingError(submission, communityCopy.onboarding.editErrors.promptGone, config);
		return;
	}

	const result = applyPromptEdit(draft, index, {
		title: textValue(submission, TITLE_FIELD),
		optionsText: openedPrompt.isFinal ? undefined : textValue(submission, OPTIONS_FIELD),
		finalOptionTitle: openedPrompt.isFinal ? textValue(submission, FINAL_OPTION_FIELD) : undefined,
	});
	if (!result.ok) {
		await replyOnboardingError(submission, result.reason, config);
		return;
	}
	storePendingDraft(guild.id, submission.user.id, result.draft);

	// The modal opened from the review's own button, so the submit updates that
	// review in place; a new private reply covers the case where it did not.
	const review = buildOnboardingReview(result.draft, config);
	if (submission.isFromMessage()) await submission.update(review);
	else await submission.reply({ ...review, flags: MessageFlags.Ephemeral });
}

// A field the modal left out reads as empty rather than throwing, which is what
// discord.js does for a missing id (the roomMonopolyTrade pattern).
function textValue(submission: ModalSubmitInteraction, customId: string): string {
	return submission.fields.fields.has(customId) ? submission.fields.getTextInputValue(customId) : "";
}
