import {
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	RoleSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type Guild,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { communityCopy } from "./communityCopy.js";
import { COMMUNITY_PREFIX } from "./communityControls.js";
import {
	buildOnboardingReview,
	readPendingDraftState,
	replyOnboardingError,
	storePendingDraft,
	type IConfigureOnboardingConfig,
	type IOnboardingReviewFocus,
	type IPendingDraftState,
} from "./configureOnboarding.js";
import { isRoleBelowBot } from "./onboardingPreconditions.js";
import {
	ONBOARDING_OPTIONS_PER_PROMPT_MAX,
	ONBOARDING_OPTION_DESCRIPTION_MAX_LENGTH,
	ONBOARDING_OPTION_ROLES_MAX,
	ONBOARDING_OPTION_TITLE_MAX_LENGTH,
	ONBOARDING_PROMPTS_MAX,
	ONBOARDING_PROMPT_TITLE_MAX_LENGTH,
	newOptionalPrompt,
	plainOption,
	type IDraftOption,
	type IDraftPrompt,
	type PendingOnboardingDraft,
} from "./onboardingDraft.js";

// ── promptEditModal ──────────────────────────────────────────────────
// What:  the Onboarding review's editor (2026-10 item 247 Phase 4, reworked by 2026-10
//        item 254): pick a question from a select, then Edit question, Delete
//        question or Add answer; pick one of its answers from a second select, then
//        Edit answer or Delete answer; or Add question. Each answer is edited on its
//        own, in a modal with its title, its description and a role select allowing
//        several roles, so every answer can give its own roles. A delete is one
//        press. Every change redraws the review in place.
// Who:   communityButtons routes the review's editing controls here AFTER it has
//        gated the clicker; every modal submit gates its submitter again, because a
//        modal submit is not a press and a role can be taken away while it is open.
// When:  while the admin's draft is live (configureOnboarding's window). Nothing here
//        talks to Discord beyond the modals and the redraw; Confirm does the write.
// How:   every control carries the draft's revision (communityControls), and a
//        control or submit whose revision is not the live one is refused, so an
//        older review can never change the wrong question. Every role an answer
//        gives passes the member role's own "sits below Dero" check
//        (onboardingPreconditions.isRoleBelowBot) at submit, and again at Confirm.
//        The final question keeps its shape: only its two titles change, so its one
//        answer always gives the member role. A role reused across questions is
//        warned about on the review, never refused (the owner's decision).

// ── constants ────────────────────────────────────────────────────────

// How long a modal waits for its submit, the same wait as Enable Community's.
const MODAL_TIMEOUT_MS = 10 * 60_000;

const MODAL_ID_PREFIX = `${COMMUNITY_PREFIX}:promptmodal`;
const TITLE_FIELD = "prompt_title";
const FINAL_OPTION_FIELD = "final_option_title";
const OPTION_TITLE_FIELD = "option_title";
const OPTION_DESCRIPTION_FIELD = "option_description";
const OPTION_ROLES_FIELD = "option_roles";
const INDEX_PATTERN = /^\d+$/;

// Zero width characters: a title made only of these looks filled in and renders as
// nothing, so they are stripped before the empty check. The same set as rulesEdit's
// ZERO_WIDTH (a hand kept pair; that file is a Phase 2 module this phase leaves
// alone). Built from code points so no invisible character sits in this source.
const ZERO_WIDTH = new RegExp(`[${[0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((codePoint) => String.fromCharCode(codePoint)).join("")}]`, "g");

// ── types ────────────────────────────────────────────────────────────

/** What a question's modal submit typed: its title, and for the final question its one answer's title. */
export interface IPromptEdit {
	title: string;
	finalOptionTitle?: string;
}

/** What an answer's modal submit typed and picked. */
export interface IAnswerEdit {
	title: string;
	description: string;
	roleIds: readonly string[];
}

/** The draft with the edit applied and where the review should open next, or the sentence that says why it was refused (the draft is then unchanged). */
export type DraftEditResult = { ok: true; draft: PendingOnboardingDraft; focus: IOnboardingReviewFocus } | { ok: false; reason: string };

/** A press on one of the review's editing controls. */
type EditorPress = ButtonInteraction | StringSelectMenuInteraction;

// ── pure: the edits ──────────────────────────────────────────────────

/** Rename the question at this index; the final question's one answer can be renamed too, and nothing else of it changes. */
export function applyPromptEdit(draft: PendingOnboardingDraft, index: number, edit: IPromptEdit): DraftEditResult {
	const copy = communityCopy.onboarding.editErrors;
	const prompt = draft.prompts[index];
	if (!prompt) return refuse(copy.promptGone);
	const title = clean(edit.title);
	const titleRefusal = refusePromptTitle(title);
	if (titleRefusal) return refuse(titleRefusal);
	if (!prompt.isFinal) return edited(replacePrompt(draft, index, { ...prompt, title }), { prompt: index });

	// The answer keeps its id, its member role and the rest of itself, so however
	// the owner renames it, picking it still gives the role.
	const optionTitle = clean(edit.finalOptionTitle ?? "");
	const optionRefusal = refuseOptionTitle(optionTitle);
	if (optionRefusal) return refuse(optionRefusal);
	const options = prompt.options.map((option, position) => (position === 0 ? { ...option, title: optionTitle } : option));
	return edited(replacePrompt(draft, index, { ...prompt, title, options }), { prompt: index });
}

/** Add an optional, pick any question with its first answer, just before the final question so that one stays last. */
export function addPrompt(draft: PendingOnboardingDraft, title: string, firstAnswer: IAnswerEdit): DraftEditResult {
	const copy = communityCopy.onboarding.editErrors;
	if (draft.prompts.length >= ONBOARDING_PROMPTS_MAX) return refuse(copy.tooManyPrompts(ONBOARDING_PROMPTS_MAX));
	const cleanTitle = clean(title);
	const titleRefusal = refusePromptTitle(cleanTitle);
	if (titleRefusal) return refuse(titleRefusal);
	const answer = readAnswer(firstAnswer, []);
	if (!answer.ok) return answer;

	const finalIndex = draft.prompts.findIndex((prompt) => prompt.isFinal);
	const at = finalIndex === -1 ? draft.prompts.length : finalIndex;
	const prompts = [...draft.prompts.slice(0, at), newOptionalPrompt(cleanTitle, [{ ...plainOption(answer.title, answer.description), roleIds: answer.roleIds }]), ...draft.prompts.slice(at)];
	return edited({ ...draft, prompts }, { prompt: at, option: 0 });
}

/** Remove the question at this index, in one press. The final question cannot go: it gives the member role. */
export function deletePrompt(draft: PendingOnboardingDraft, index: number): DraftEditResult {
	const copy = communityCopy.onboarding.editErrors;
	const prompt = draft.prompts[index];
	if (!prompt) return refuse(copy.promptGone);
	if (prompt.isFinal) return refuse(copy.finalPromptFixed);
	return edited({ ...draft, prompts: draft.prompts.filter((_, position) => position !== index) }, {});
}

/**
 * Save one answer of the question at promptIndex: a new one when optionIndex is
 * null, otherwise the answer at that index, which keeps its id, channels and emoji
 * and takes the submitted title, description and roles.
 */
export function saveAnswer(draft: PendingOnboardingDraft, promptIndex: number, optionIndex: number | null, edit: IAnswerEdit): DraftEditResult {
	const copy = communityCopy.onboarding.editErrors;
	const prompt = draft.prompts[promptIndex];
	if (!prompt) return refuse(copy.promptGone);
	if (prompt.isFinal) return refuse(copy.finalPromptFixed);
	const existing = optionIndex === null ? null : prompt.options[optionIndex];
	if (existing === undefined) return refuse(copy.optionGone);
	if (!existing && prompt.options.length >= ONBOARDING_OPTIONS_PER_PROMPT_MAX) return refuse(copy.tooManyOptions(ONBOARDING_OPTIONS_PER_PROMPT_MAX));

	const others = prompt.options.filter((_, position) => position !== optionIndex);
	const answer = readAnswer(edit, others);
	if (!answer.ok) return answer;
	const saved: IDraftOption = existing
		? { ...existing, title: answer.title, description: answer.description, roleIds: answer.roleIds }
		: { ...plainOption(answer.title, answer.description), roleIds: answer.roleIds };
	const options = existing ? prompt.options.map((option, position) => (position === optionIndex ? saved : option)) : [...prompt.options, saved];
	return edited(replacePrompt(draft, promptIndex, { ...prompt, options }), { prompt: promptIndex, option: existing ? optionIndex : options.length - 1 });
}

/** Remove one answer, in one press. A question keeps at least one answer, and the final question's answer never goes. */
export function deleteAnswer(draft: PendingOnboardingDraft, promptIndex: number, optionIndex: number): DraftEditResult {
	const copy = communityCopy.onboarding.editErrors;
	const prompt = draft.prompts[promptIndex];
	if (!prompt) return refuse(copy.promptGone);
	if (prompt.isFinal) return refuse(copy.finalPromptFixed);
	if (!prompt.options[optionIndex]) return refuse(copy.optionGone);
	if (prompt.options.length === 1) return refuse(copy.lastOption);
	const options = prompt.options.filter((_, position) => position !== optionIndex);
	return edited(replacePrompt(draft, promptIndex, { ...prompt, options }), { prompt: promptIndex });
}

/**
 * Why Discord would refuse to hand out one of these roles, or null when every one
 * can be given: @everyone, a role no longer in the server, or a role at or above
 * Dero's highest, the same check the member role passes before Onboarding is offered.
 */
export function refuseAnswerRoles(guild: Guild, roleIds: readonly string[]): string | null {
	const copy = communityCopy.onboarding.editErrors;
	for (const roleId of roleIds) {
		if (roleId === guild.roles.everyone.id) return copy.roleIsEveryone;
		const role = guild.roles.cache.get(roleId);
		if (!role) return copy.roleGone;
		if (!isRoleBelowBot(guild, role)) return copy.roleAboveBot(role.name);
	}
	return null;
}

type ReadAnswer = { ok: true; title: string; description: string | null; roleIds: string[] } | { ok: false; reason: string };

// One answer's typed fields, checked against Discord's caps, and its title against
// the question's other answers (two with one title would read the same to a member).
function readAnswer(edit: IAnswerEdit, others: readonly IDraftOption[]): ReadAnswer {
	const copy = communityCopy.onboarding.editErrors;
	const title = clean(edit.title);
	const titleRefusal = refuseOptionTitle(title);
	if (titleRefusal) return { ok: false, reason: titleRefusal };
	const description = clean(edit.description);
	if (description.length > ONBOARDING_OPTION_DESCRIPTION_MAX_LENGTH) return { ok: false, reason: copy.descriptionTooLong(title, ONBOARDING_OPTION_DESCRIPTION_MAX_LENGTH) };
	if (others.some((option) => option.title.toLowerCase() === title.toLowerCase())) return { ok: false, reason: copy.duplicateOption(title) };
	if (edit.roleIds.length > ONBOARDING_OPTION_ROLES_MAX) return { ok: false, reason: copy.tooManyRoles(ONBOARDING_OPTION_ROLES_MAX) };
	return { ok: true, title, description: description || null, roleIds: [...new Set(edit.roleIds)] };
}

function refusePromptTitle(title: string): string | null {
	const copy = communityCopy.onboarding.editErrors;
	if (!title) return copy.emptyTitle;
	if (title.length > ONBOARDING_PROMPT_TITLE_MAX_LENGTH) return copy.titleTooLong(ONBOARDING_PROMPT_TITLE_MAX_LENGTH);
	return null;
}

function refuseOptionTitle(title: string): string | null {
	const copy = communityCopy.onboarding.editErrors;
	if (!title) return copy.emptyOptionTitle;
	if (title.length > ONBOARDING_OPTION_TITLE_MAX_LENGTH) return copy.optionTitleTooLong(title, ONBOARDING_OPTION_TITLE_MAX_LENGTH);
	return null;
}

// Every other question keeps its own object, so an edit never disturbs the rest.
function replacePrompt(draft: PendingOnboardingDraft, index: number, prompt: IDraftPrompt): PendingOnboardingDraft {
	return { ...draft, prompts: draft.prompts.map((existing, position) => (position === index ? prompt : existing)) };
}

const edited = (draft: PendingOnboardingDraft, focus: IOnboardingReviewFocus): DraftEditResult => ({ ok: true, draft, focus });
const refuse = (reason: string): DraftEditResult => ({ ok: false, reason });
const clean = (text: string): string => text.replace(ZERO_WIDTH, "").trim();

// ── the modals ───────────────────────────────────────────────────────
// A preloaded value longer than its input allows makes Discord reject the whole
// modal, so a question or answer read from the live config that is longer is not
// offered (null), and the press answers tooLongToEdit.

/** The edit modal for a question: its title, and for the final question its one answer's title too. */
export function buildPromptEditModal(modalId: string, prompt: IDraftPrompt, position: number): ModalBuilder | null {
	const copy = communityCopy.onboarding.modal;
	if (prompt.title.length > ONBOARDING_PROMPT_TITLE_MAX_LENGTH) return null;
	const titleInput = textInput(TITLE_FIELD, TextInputStyle.Short, ONBOARDING_PROMPT_TITLE_MAX_LENGTH, prompt.title, true);

	if (!prompt.isFinal) {
		return new ModalBuilder()
			.setCustomId(modalId)
			.setTitle(copy.title(position))
			.addLabelComponents(new LabelBuilder().setLabel(copy.promptTitleLabel).setDescription(copy.promptTitleDescription).setTextInputComponent(titleInput));
	}
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

/** The Add question modal: the question, then its first answer's title, description and roles. Four of a modal's five components. */
export function buildAddPromptModal(modalId: string): ModalBuilder {
	const copy = communityCopy.onboarding.modal;
	return new ModalBuilder()
		.setCustomId(modalId)
		.setTitle(copy.addPromptTitle)
		.addLabelComponents(
			new LabelBuilder()
				.setLabel(copy.promptTitleLabel)
				.setDescription(copy.promptTitleDescription)
				.setTextInputComponent(textInput(TITLE_FIELD, TextInputStyle.Short, ONBOARDING_PROMPT_TITLE_MAX_LENGTH, "", true)),
			...answerLabels(null, copy.firstOptionTitleDescription)
		);
}

/** The modal for one answer of the question at this position: a new answer when option is null, otherwise that answer preloaded. */
export function buildAnswerModal(modalId: string, position: number, option: IDraftOption | null): ModalBuilder | null {
	const copy = communityCopy.onboarding.modal;
	if (option && (option.title.length > ONBOARDING_OPTION_TITLE_MAX_LENGTH || (option.description ?? "").length > ONBOARDING_OPTION_DESCRIPTION_MAX_LENGTH)) return null;
	if (option && option.roleIds.length > ONBOARDING_OPTION_ROLES_MAX) return null;
	return new ModalBuilder()
		.setCustomId(modalId)
		.setTitle(option ? copy.editOptionTitle(position) : copy.addOptionTitle(position))
		.addLabelComponents(...answerLabels(option, copy.optionTitleDescription));
}

// An answer's three fields. The role select allows Discord's own maximum and none
// at all, since an answer that gives nothing is a real answer.
function answerLabels(option: IDraftOption | null, titleDescription: string): LabelBuilder[] {
	const copy = communityCopy.onboarding.modal;
	const roles = new RoleSelectMenuBuilder().setCustomId(OPTION_ROLES_FIELD).setRequired(false).setMinValues(0).setMaxValues(ONBOARDING_OPTION_ROLES_MAX);
	if (option && option.roleIds.length > 0) roles.setDefaultRoles(...option.roleIds);
	return [
		new LabelBuilder()
			.setLabel(copy.optionTitleLabel)
			.setDescription(titleDescription)
			.setTextInputComponent(textInput(OPTION_TITLE_FIELD, TextInputStyle.Short, ONBOARDING_OPTION_TITLE_MAX_LENGTH, option?.title ?? "", true)),
		new LabelBuilder()
			.setLabel(copy.optionDescriptionLabel)
			.setDescription(copy.optionDescriptionDescription)
			.setTextInputComponent(textInput(OPTION_DESCRIPTION_FIELD, TextInputStyle.Short, ONBOARDING_OPTION_DESCRIPTION_MAX_LENGTH, option?.description ?? "", false)),
		new LabelBuilder().setLabel(copy.optionRolesLabel).setDescription(copy.optionRolesDescription).setRoleSelectMenuComponent(roles),
	];
}

function textInput(customId: string, style: TextInputStyle, maxLength: number, value: string, required: boolean): TextInputBuilder {
	const input = new TextInputBuilder().setCustomId(customId).setStyle(style).setMaxLength(maxLength).setRequired(required);
	// An empty preload is left unset: Discord treats a set value as at least 1 long.
	return value ? input.setValue(value) : input;
}

// ── the presses ──────────────────────────────────────────────────────
// Each takes the customId's segments after the action (`<revision>[:<n>[:<m>]]`),
// once the router has gated the clicker.

/** The question select: open the review's controls on the picked question. Changes nothing in the draft. */
export async function handlePickPrompt(interaction: StringSelectMenuInteraction, guild: Guild, config: IConfigureOnboardingConfig, argument: string | null): Promise<void> {
	const current = await readCurrentDraft(interaction, guild, config, argument, 0);
	if (!current) return;
	const index = Number(interaction.values[0]);
	if (!current.state.draft.prompts[index]) {
		await replyOnboardingError(interaction, communityCopy.onboarding.editErrors.promptGone, config);
		return;
	}
	await interaction.update(buildOnboardingReview(current.state.draft, config, current.state.revision, { prompt: index }));
}

/** The answer select: open the picked answer's Edit and Delete. Changes nothing in the draft. */
export async function handlePickOption(interaction: StringSelectMenuInteraction, guild: Guild, config: IConfigureOnboardingConfig, argument: string | null): Promise<void> {
	const current = await readCurrentDraft(interaction, guild, config, argument, 1);
	if (!current) return;
	const [promptIndex] = current.indexes as [number];
	const optionIndex = Number(interaction.values[0]);
	if (!current.state.draft.prompts[promptIndex]?.options[optionIndex]) {
		await replyOnboardingError(interaction, communityCopy.onboarding.editErrors.optionGone, config);
		return;
	}
	await interaction.update(buildOnboardingReview(current.state.draft, config, current.state.revision, { prompt: promptIndex, option: optionIndex }));
}

/** Edit question: its title (and the final question's answer title) in a modal. */
export async function handleEditPromptButton(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig, argument: string | null): Promise<void> {
	const current = await readCurrentDraft(interaction, guild, config, argument, 1);
	if (!current) return;
	const [index] = current.indexes as [number];
	const prompt = current.state.draft.prompts[index];
	if (!prompt) {
		await replyOnboardingError(interaction, communityCopy.onboarding.editErrors.promptGone, config);
		return;
	}
	const modalId = modalIdFor(interaction);
	await runModalEdit(interaction, config, buildPromptEditModal(modalId, prompt, index + 1), modalId, current.state.revision, (draft, submission) =>
		applyPromptEdit(draft, index, { title: textValue(submission, TITLE_FIELD), finalOptionTitle: prompt.isFinal ? textValue(submission, FINAL_OPTION_FIELD) : undefined })
	);
}

/** Delete question: one press, then the review redraws without it. */
export async function handleDeletePrompt(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig, argument: string | null): Promise<void> {
	const current = await readCurrentDraft(interaction, guild, config, argument, 1);
	if (!current) return;
	const [index] = current.indexes as [number];
	await applyPressEdit(interaction, guild, config, deletePrompt(current.state.draft, index));
}

/** Add question: the question and its first answer in one modal. */
export async function handleAddPrompt(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig, argument: string | null): Promise<void> {
	const current = await readCurrentDraft(interaction, guild, config, argument, 0);
	if (!current) return;
	const modalId = modalIdFor(interaction);
	await runModalEdit(interaction, config, buildAddPromptModal(modalId), modalId, current.state.revision, (draft, submission, submitGuild) => {
		const answer = answerValues(submission);
		const roleRefusal = refuseAnswerRoles(submitGuild, answer.roleIds);
		return roleRefusal ? refuse(roleRefusal) : addPrompt(draft, textValue(submission, TITLE_FIELD), answer);
	});
}

/** Add answer: a new answer to the picked question, with its own roles. */
export async function handleAddOption(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig, argument: string | null): Promise<void> {
	await openAnswerModal(interaction, guild, config, argument, false);
}

/** Edit answer: the picked answer's title, description and roles. */
export async function handleEditOption(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig, argument: string | null): Promise<void> {
	await openAnswerModal(interaction, guild, config, argument, true);
}

/** Delete answer: one press, then the review redraws on its question. */
export async function handleDeleteOption(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig, argument: string | null): Promise<void> {
	const current = await readCurrentDraft(interaction, guild, config, argument, 2);
	if (!current) return;
	const [promptIndex, optionIndex] = current.indexes as [number, number];
	await applyPressEdit(interaction, guild, config, deleteAnswer(current.state.draft, promptIndex, optionIndex));
}

async function openAnswerModal(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig, argument: string | null, editing: boolean): Promise<void> {
	const current = await readCurrentDraft(interaction, guild, config, argument, editing ? 2 : 1);
	if (!current) return;
	const [promptIndex, optionIndex] = current.indexes as [number, number | undefined];
	const prompt = current.state.draft.prompts[promptIndex];
	const option = editing && optionIndex !== undefined ? prompt?.options[optionIndex] : null;
	if (!prompt || option === undefined) {
		await replyOnboardingError(interaction, prompt ? communityCopy.onboarding.editErrors.optionGone : communityCopy.onboarding.editErrors.promptGone, config);
		return;
	}
	const modalId = modalIdFor(interaction);
	await runModalEdit(interaction, config, buildAnswerModal(modalId, promptIndex + 1, option), modalId, current.state.revision, (draft, submission, submitGuild) => {
		const answer = answerValues(submission);
		const roleRefusal = refuseAnswerRoles(submitGuild, answer.roleIds);
		return roleRefusal ? refuse(roleRefusal) : saveAnswer(draft, promptIndex, editing ? (optionIndex ?? null) : null, answer);
	});
}

// ── shared steps ─────────────────────────────────────────────────────

/**
 * The live draft for a press, once its customId's revision matches it, and the
 * indexes the customId carries. Answers the press itself and returns null when the
 * control is malformed, the draft expired, or the review is older than the draft.
 */
async function readCurrentDraft(
	interaction: EditorPress,
	guild: Guild,
	config: IConfigureOnboardingConfig,
	argument: string | null,
	indexCount: number
): Promise<{ state: IPendingDraftState; indexes: number[] } | null> {
	const parsed = parseControlArgument(argument, indexCount);
	// An id with the wrong segments is from no layout this version draws, including
	// the `editprompt:<index>` Edit buttons of the review before 2026-10 item 254.
	if (!parsed) {
		await replyOnboardingError(interaction, communityCopy.errors.controlRetired, config);
		return null;
	}
	const state = readPendingDraftState(guild.id, interaction.user.id);
	if (!state) {
		await replyOnboardingError(interaction, communityCopy.onboarding.expired, config);
		return null;
	}
	if (state.revision !== parsed.revision) {
		await replyOnboardingError(interaction, communityCopy.onboarding.editErrors.reviewOutdated, config);
		return null;
	}
	return { state, indexes: parsed.indexes };
}

function parseControlArgument(argument: string | null, indexCount: number): { revision: number; indexes: number[] } | null {
	const segments = argument?.split(":") ?? [];
	if (segments.length !== indexCount + 1 || !segments.every((segment) => INDEX_PATTERN.test(segment))) return null;
	const [revision, ...indexes] = segments.map(Number);
	return { revision: revision!, indexes };
}

// A delete: no modal, so the press itself is answered with the redrawn review.
async function applyPressEdit(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig, result: DraftEditResult): Promise<void> {
	if (!result.ok) {
		await replyOnboardingError(interaction, result.reason, config);
		return;
	}
	const revision = storePendingDraft(guild.id, interaction.user.id, result.draft);
	await interaction.update(buildOnboardingReview(result.draft, config, revision, result.focus));
}

// The interaction id keys the modal, so a modal opened from another press is never mistaken for this one.
const modalIdFor = (interaction: EditorPress): string => `${MODAL_ID_PREFIX}:${interaction.id}`;

// Open the modal, wait for its submit, then apply the edit the submit carries.
async function runModalEdit(
	interaction: ButtonInteraction,
	config: IConfigureOnboardingConfig,
	modal: ModalBuilder | null,
	modalId: string,
	openedRevision: number,
	apply: (draft: PendingOnboardingDraft, submission: ModalSubmitInteraction, guild: Guild) => DraftEditResult
): Promise<void> {
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
	await handleEditSubmitted(submission, openedRevision, apply);
}

/** One editor modal submit: gate again, check the draft has not moved on, apply the edit, and redraw the review. */
export async function handleEditSubmitted(
	submission: ModalSubmitInteraction,
	openedRevision: number,
	apply: (draft: PendingOnboardingDraft, submission: ModalSubmitInteraction, guild: Guild) => DraftEditResult
): Promise<void> {
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
	const state = readPendingDraftState(guild.id, submission.user.id);
	if (!state) {
		await replyOnboardingError(submission, communityCopy.onboarding.expired, config);
		return;
	}
	// The draft may have moved on while the modal was open (a fresh Configure
	// Onboarding press, an edit from another review). Writing this submit onto
	// whatever now sits at its index would change the wrong question.
	if (state.revision !== openedRevision) {
		await replyOnboardingError(submission, communityCopy.onboarding.editErrors.promptGone, config);
		return;
	}

	const result = apply(state.draft, submission, guild);
	if (!result.ok) {
		await replyOnboardingError(submission, result.reason, config);
		return;
	}
	const revision = storePendingDraft(guild.id, submission.user.id, result.draft);

	// The modal opened from the review's own control, so the submit updates that
	// review in place; a new private reply covers the case where it did not.
	const review = buildOnboardingReview(result.draft, config, revision, result.focus);
	if (submission.isFromMessage()) await submission.update(review);
	else await submission.reply({ ...review, flags: MessageFlags.Ephemeral });
}

function answerValues(submission: ModalSubmitInteraction): IAnswerEdit {
	return { title: textValue(submission, OPTION_TITLE_FIELD), description: textValue(submission, OPTION_DESCRIPTION_FIELD), roleIds: roleValues(submission, OPTION_ROLES_FIELD) };
}

// A field the modal left out reads as empty rather than throwing, which is what
// discord.js does for a missing id (the roomMonopolyTrade pattern).
function textValue(submission: ModalSubmitInteraction, customId: string): string {
	return submission.fields.fields.has(customId) ? submission.fields.getTextInputValue(customId) : "";
}

// The KEYS of the picked roles: discord.js keys each by id, and the guild cache is
// what the role check reads, so the resolved values are not needed here.
function roleValues(submission: ModalSubmitInteraction, customId: string): string[] {
	if (!submission.fields.fields.has(customId)) return [];
	return [...(submission.fields.getSelectedRoles(customId)?.keys() ?? [])];
}
