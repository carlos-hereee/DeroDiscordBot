import { type ActionRowBuilder, type ButtonInteraction, type EmbedBuilder, type Guild, type MessageActionRowComponentBuilder, type ModalSubmitInteraction, type StringSelectMenuInteraction } from "discord.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { beginChannelAnswer } from "@utils/answerInChannel.js";
import { showConfirm, showNotice } from "@utils/textModal.js";
import { communityCopy } from "./communityCopy.js";
import { COMMUNITY_CUSTOM_IDS, buildOnboardingReviewRows } from "./communityControls.js";
import { describeRefusal, type IWriteRefusal } from "./enableCommunity.js";
import { checkOnboardingPreconditions } from "./onboardingPreconditions.js";
import {
	buildOnboardingDraft,
	reviewedDefaults,
	rolesReusedAcrossPrompts,
	toOnboardingEditOptions,
	validateOnboardingDraft,
	type IDraftPrompt,
	type IOnboardingSnapshot,
	type PendingOnboardingDraft,
} from "./onboardingDraft.js";
import { fetchOnboardingSnapshot } from "./onboardingChannels.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";

// ── configureOnboarding ──────────────────────────────────────────────
// What:  the Configure Onboarding flow behind the admin guide's button (2026-10 item
//        247 Phase 4): check the server can take Onboarding, read what it already
//        has, draft the questions, show a private review whose controls edit each
//        question and each answer (promptEditModal, 2026-10 item 254), and on
//        Confirm open a confirm modal of the summary whose Submit writes the whole
//        config in one guild.editOnboarding call (2026-10 item 263 R3-20). It never writes a role to a member (Discord Onboarding does, when the
//        member answers the final question) and never stores anyone's answers.
// Who:   communityButtons routes `community:configure`, `community:confirmOnboarding`,
//        `community:writeOnboarding` (the confirm's Submit and its fallback button) and
//        `community:cancelOnboarding` here AFTER it has gated the clicker;
//        promptEditModal edits a question of the draft this file holds and redraws
//        the review with buildOnboardingReview.
// When:  on a press. The draft waits ONBOARDING_DRAFT_TTL_MS in memory, so a restart
//        drops it and Confirm then answers "expired".
// How:   ① preconditions, refused with one plain sentence; ② fetchOnboarding, and
//        nothing is drafted over a config Dero could not read; ③ the draft, which
//        keeps every question the server already has; ④ the review; ⑤ Confirm runs
//        ① and the draft's own checks, then opens the confirm modal, and its Submit
//        runs them again against the live guild before it writes; ⑥ audit rows and
//        the owner DM, fire and forget.

// ── constants ────────────────────────────────────────────────────────

/** How long a draft waits for its admin's Confirm (the plan's 10 minute window). Every edit restarts it. */
export const ONBOARDING_DRAFT_TTL_MS = 10 * 60_000;

// Discord's embed caps: 25 fields, 256 characters a field name, 1024 a field value,
// and 6000 for the whole embed. The questions share FIELDS_TEXT_BUDGET between
// them, which leaves room for the description and its twenty channel mentions.
const EMBED_FIELDS_MAX = 25;
const EMBED_FIELD_NAME_MAX = 256;
const EMBED_FIELD_VALUE_MAX = 1024;
const FIELDS_TEXT_BUDGET = 4500;
const TRUNCATION_MARK = "...";

// ── types ────────────────────────────────────────────────────────────

/** The stored GuildConfig fields this flow reads. */
export interface IConfigureOnboardingConfig extends ICopyConfig {
	adminRoleId?: string | null;
	memberRoleId?: string | null;
	introChannelId?: string | null;
}

/** The review message: one embed and its editor, Confirm and Cancel rows. */
export interface IOnboardingReviewMessage {
	embeds: EmbedBuilder[];
	components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/** Which question and answer the review's controls are open on; both null shows the question select alone. */
export interface IOnboardingReviewFocus {
	prompt?: number | null;
	option?: number | null;
}

type OwnerDmOutcome = "sent" | "failed";

// ── pending drafts ───────────────────────────────────────────────────
// Keyed guildId:userId, so two admins configuring at once never confirm each
// other's draft. A second Configure Onboarding press from the same admin replaces
// the first draft. Read by the edit modal, taken by Confirm, dropped by Cancel.
// Every store gives the draft a new REVISION, which the review's controls carry,
// so a control on an older review is refused instead of editing a newer draft.

interface IPendingDraftEntry {
	draft: PendingOnboardingDraft;
	revision: number;
	expiresAt: number;
}

/** A live draft and the revision its latest review carries. */
export interface IPendingDraftState {
	draft: PendingOnboardingDraft;
	revision: number;
}

const pendingDrafts = new Map<string, IPendingDraftEntry>();

const draftKey = (guildId: string, userId: string): string => `${guildId}:${userId}`;

// Counts every store in this process, so no two stores share a revision, even
// across a Cancel and a fresh press. A restart drops every draft anyway.
let lastRevision = 0;

/** Hold this admin's draft for ONBOARDING_DRAFT_TTL_MS from now, replacing any earlier one. Returns its new revision. */
export function storePendingDraft(guildId: string, userId: string, draft: PendingOnboardingDraft): number {
	// Dropping expired entries on every write keeps the map from holding drafts
	// nobody will confirm, without a timer of its own (enableCommunity does the same).
	const now = Date.now();
	for (const [key, entry] of pendingDrafts) if (entry.expiresAt <= now) pendingDrafts.delete(key);
	lastRevision += 1;
	pendingDrafts.set(draftKey(guildId, userId), { draft, revision: lastRevision, expiresAt: now + ONBOARDING_DRAFT_TTL_MS });
	return lastRevision;
}

/** This admin's draft and its revision while it is live, or null. Read, not taken: an edit replaces it and the review keeps going. */
export function readPendingDraftState(guildId: string, userId: string): IPendingDraftState | null {
	const entry = pendingDrafts.get(draftKey(guildId, userId));
	return entry && entry.expiresAt > Date.now() ? { draft: entry.draft, revision: entry.revision } : null;
}

/** This admin's draft while it is live, or null. */
export function readPendingDraft(guildId: string, userId: string): PendingOnboardingDraft | null {
	return readPendingDraftState(guildId, userId)?.draft ?? null;
}

// Taken, not read: a double press of Confirm finds nothing the second time, so one
// draft writes once. A refused write stores the draft again so Confirm can retry.
function takePendingDraft(guildId: string, userId: string): PendingOnboardingDraft | null {
	const draft = readPendingDraft(guildId, userId);
	pendingDrafts.delete(draftKey(guildId, userId));
	return draft;
}

// ── ① to ④ the Configure Onboarding press ───────────────────────────

/** The Configure Onboarding button, from the admin guide or an Enable Community reply, once the router has gated the clicker. */
export async function handleConfigureOnboardingButton(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig): Promise<void> {
	const precondition = checkOnboardingPreconditions(guild, config);
	if (!precondition.ok) {
		auditRefusedPress(guild.id, interaction.user.id, "open", precondition);
		await replyOnboardingError(interaction, precondition.reason, config);
		return;
	}
	// Acknowledged first: fetchOnboarding is a Discord round trip. A new message rather
	// than an update, because the press can come from the pinned admin guide, and
	// updating that message would overwrite the guide. The review posts in 🧭onboarding
	// (2026-10 item 257 Phase 5); its controls answer only the admin who drafted it,
	// because the draft is kept per guild and per presser.
	const answer = await beginChannelAnswer(interaction, "onboarding");

	const current = await readLiveOnboarding(guild);
	if ("readError" in current) {
		await answer.send({ embeds: [errorEmbed(communityCopy.onboarding.readFailed(current.readError), config)] });
		return;
	}

	const result = buildOnboardingDraft({ guild, stored: config, copy: communityCopy.onboarding, current });
	if (!result.ok) {
		auditRefusedPress(guild.id, interaction.user.id, "draft", result);
		await answer.send({ embeds: [errorEmbed(result.reason, config)] });
		return;
	}
	const revision = storePendingDraft(guild.id, interaction.user.id, result.draft);
	await answer.send(buildOnboardingReview(result.draft, config, revision));
}

// ② A config that cannot be read is never drafted over: an empty draft written on
// top of questions Dero never saw would replace them, which is the silent
// overwrite this flow exists to avoid.
async function readLiveOnboarding(guild: Guild): Promise<IOnboardingSnapshot | { readError: string }> {
	try {
		return await fetchOnboardingSnapshot(guild);
	}
	catch (error) {
		console.warn(`[configure-onboarding] guild ${guild.id} fetchOnboarding failed`, error);
		return { readError: error instanceof Error ? error.message : String(error) };
	}
}

// ── ⑤ ⑥ Confirm ─────────────────────────────────────────────────────

/**
 * The review's Confirm button, once the router has gated the clicker: check the draft,
 * then open a confirm modal whose text is the summary. Nothing is written here, so the
 * draft is read, not taken, and closing the modal leaves the review as it was.
 */
export async function handleConfirmOnboarding(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig): Promise<void> {
	const draft = readPendingDraft(guild.id, interaction.user.id);
	if (!draft) {
		await replyOnboardingError(interaction, communityCopy.onboarding.expired, config);
		return;
	}
	const refusal = recheckBeforeWrite(guild, config, draft);
	if (refusal) {
		auditRefusedPress(guild.id, interaction.user.id, "confirm", refusal);
		await replyOnboardingError(interaction, refusal.reason, config);
		return;
	}
	await showConfirm(
		interaction,
		{ title: communityCopy.onboarding.review.confirmTitle, sections: [confirmSummary(guild, draft)], confirmId: COMMUNITY_CUSTOM_IDS.writeOnboarding },
		config
	);
}

// The confirm's text: names, not mentions, because a modal shows a mention as raw text.
function confirmSummary(guild: Guild, draft: PendingOnboardingDraft): string {
	const defaults = reviewedDefaults(draft);
	const nameOf = (id: string): string => guild.channels.cache.get(id)?.name ?? id;
	return communityCopy.onboarding.review.confirmSummary({
		promptCount: draft.prompts.length,
		memberRoleName: guild.roles.cache.get(draft.memberRoleId)?.name ?? draft.memberRoleId,
		channelNames: defaults.channelIds.map(nameOf),
		categoryNames: defaults.categoryNames,
	});
}

/**
 * The confirm's Submit, or its fallback button when no modal could open, once the router
 * has gated the clicker: check again, write, audit, DM the owner. A modal Submit is
 * reachable without the Confirm press that opened it, so every check runs again here.
 */
export async function handleWriteOnboarding(interaction: ButtonInteraction | ModalSubmitInteraction, guild: Guild, config: IConfigureOnboardingConfig): Promise<void> {
	const draft = takePendingDraft(guild.id, interaction.user.id);
	if (!draft) {
		await replyOnboardingError(interaction, communityCopy.onboarding.expired, config);
		return;
	}

	// The review may be minutes old: Community, Dero's permissions, its role or the
	// member role's place can all have changed since, in Server Settings or by
	// another admin. The draft goes back so Confirm works once the cause is fixed.
	const refusal = recheckBeforeWrite(guild, config, draft);
	if (refusal) {
		storePendingDraft(guild.id, interaction.user.id, draft);
		auditRefusedPress(guild.id, interaction.user.id, "confirm", refusal);
		await replyOnboardingError(interaction, refusal.reason, config);
		return;
	}

	// An update, so the review itself becomes the result and its buttons go away: the
	// confirm modal opened from the review's Confirm, so its Submit updates that message.
	await interaction.deferUpdate();
	const writeRefusal = await writeOnboarding(guild, draft);
	if (writeRefusal) {
		const revision = storePendingDraft(guild.id, interaction.user.id, draft);
		auditWrite(guild.id, interaction.user.id, draft, writeRefusal.outcome, writeRefusal.discordCode, null);
		// The review stays with its buttons and the refusal under it, so the owner can
		// fix the cause, edit, and press Confirm again without starting over.
		const review = buildOnboardingReview(draft, config, revision);
		await interaction.editReply({ embeds: [...review.embeds, errorEmbed(writeRefusal.ownerMessage, config)], components: review.components });
		return;
	}
	adminLog.emitFor(interaction, guild.id, "config.change", { subject: setupCopy.adminLog.subjects.onboarding, detail: setupCopy.adminLog.updated });

	void notifyOwnerThenAudit(guild, interaction.user.id, draft);
	// Channels only: a category among the defaults is no channel (2026-10 item 263 R3-20).
	const summary = { promptCount: draft.prompts.length, defaultChannelCount: reviewedDefaults(draft).channelIds.length, memberRoleId: draft.memberRoleId };
	await interaction.editReply({
		embeds: [infoEmbed(communityCopy.onboarding.success.title, communityCopy.onboarding.success.description(summary), getPluginCopy(config).COLORS.ADMIN, config)],
		components: [],
	});
}

function recheckBeforeWrite(guild: Guild, config: IConfigureOnboardingConfig, draft: PendingOnboardingDraft): { code: string; reason: string } | null {
	const precondition = checkOnboardingPreconditions(guild, config);
	if (!precondition.ok) return precondition;
	return validateOnboardingDraft(guild, draft, communityCopy.onboarding);
}

/** The one write; null on success, or what to tell the owner and audit. */
async function writeOnboarding(guild: Guild, draft: PendingOnboardingDraft): Promise<IWriteRefusal | null> {
	try {
		await guild.editOnboarding(toOnboardingEditOptions(draft, communityCopy.onboarding.auditReason));
		return null;
	}
	catch (error) {
		console.warn(`[configure-onboarding] guild ${guild.id} Onboarding write refused`, error);
		return describeRefusal(error, communityCopy.onboarding.failures);
	}
}

// ⑥ After a successful write only. The DM goes first so the one audit row can say
// whether it went out; neither ever reaches the owner's reply, which has already
// been decided by the write.
async function notifyOwnerThenAudit(guild: Guild, actorId: string, draft: PendingOnboardingDraft): Promise<void> {
	let ownerDm: OwnerDmOutcome = "sent";
	try {
		const owner = await guild.fetchOwner();
		await owner.send({ content: communityCopy.onboarding.ownerDm, allowedMentions: { parse: [] } });
	}
	catch (error) {
		// An owner who blocks DMs from server members is normal; the reply in
		// #admin-commands already said what the DM says.
		ownerDm = "failed";
		console.warn(`[configure-onboarding] guild ${guild.id} owner DM failed`, error);
	}
	auditWrite(guild.id, actorId, draft, "configured", null, ownerDm);
}

// ── Cancel ───────────────────────────────────────────────────────────

/** The review's Cancel button: forget the draft and close the review. Nothing on Discord changes. */
export async function handleCancelOnboarding(interaction: ButtonInteraction, guild: Guild): Promise<void> {
	pendingDrafts.delete(draftKey(guild.id, interaction.user.id));
	await interaction.update({ content: communityCopy.onboarding.cancelled, embeds: [], components: [] });
}

// ── the review ───────────────────────────────────────────────────────

/**
 * The review of a draft: the summary (with the ⚠️ line when a role is reused across
 * questions), one field per question in order, and the editor's controls for the
 * draft at this revision, open on the focused question and answer.
 */
export function buildOnboardingReview(draft: PendingOnboardingDraft, config: ICopyConfig | null, revision: number, focus: IOnboardingReviewFocus = {}): IOnboardingReviewMessage {
	const copy = communityCopy.onboarding.review;
	const reusedRoleIds = rolesReusedAcrossPrompts(draft.prompts);
	const reused = new Set(reusedRoleIds);
	const shown = draft.prompts.slice(0, EMBED_FIELDS_MAX);
	const fieldBudget = Math.floor(FIELDS_TEXT_BUDGET / Math.max(shown.length, 1));
	const fields = shown.map((prompt, index) => {
		const name = truncate(copy.promptFieldName(index + 1, prompt.title), Math.min(EMBED_FIELD_NAME_MAX, Math.floor(fieldBudget / 3)));
		return { name, value: promptFieldValue(prompt, reused, Math.min(EMBED_FIELD_VALUE_MAX, fieldBudget - name.length)) };
	});
	const defaults = reviewedDefaults(draft);
	const description = copy.description({ ...draft, defaultChannelIds: defaults.channelIds, defaultCategoryNames: defaults.categoryNames, reusedRoleIds });
	const embed = infoEmbed(copy.title, description, getPluginCopy(config).COLORS.ADMIN, config).addFields(fields);
	const components = buildOnboardingReviewRows({ revision, prompts: draft.prompts, focusedPrompt: focus.prompt ?? null, focusedOption: focus.option ?? null });
	return { embeds: [embed], components };
}

// The question's rules, then its answers, as many as fit, then a count of the rest.
function promptFieldValue(prompt: IDraftPrompt, reusedRoleIds: ReadonlySet<string>, maxLength: number): string {
	const copy = communityCopy.onboarding.review;
	let value = copy.promptRules(prompt);
	for (const [index, option] of prompt.options.entries()) {
		const line = copy.optionLine(option, reusedRoleIds);
		const remaining = prompt.options.length - index - 1;
		// Room is kept for the "and N more" line whenever answers are still to come.
		const reserve = remaining > 0 ? copy.moreOptions(remaining).length + 1 : 0;
		if (value.length + 1 + line.length + reserve > maxLength) return `${value}\n${copy.moreOptions(prompt.options.length - index)}`;
		value = `${value}\n${line}`;
	}
	return value;
}

function truncate(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
}

// ── audit ────────────────────────────────────────────────────────────

// One row per press refused before any write, with the clause and its sentence.
function auditRefusedPress(guildId: string, actorId: string, step: "open" | "draft" | "confirm", refusal: { code: string; reason: string }): void {
	audit(guildId, BOT_LOG_EVENTS.ONBOARDING_PRECONDITION_FAILED, { actorId, step, code: refusal.code, reason: refusal.reason });
}

// One row per Confirm that reached Discord. Counts and ids only: no question or
// answer text (the ONBOARDING_CONFIGURED_BY_BOT privacy note).
function auditWrite(
	guildId: string,
	actorId: string,
	draft: PendingOnboardingDraft,
	outcome: "configured" | IWriteRefusal["outcome"],
	discordCode: number | string | null,
	ownerDm: OwnerDmOutcome | null
): void {
	audit(guildId, BOT_LOG_EVENTS.ONBOARDING_CONFIGURED_BY_BOT, {
		actorId,
		outcome,
		discordCode,
		ownerDm,
		memberRoleId: draft.memberRoleId,
		promptCount: draft.prompts.length,
		optionCount: draft.prompts.reduce((count, prompt) => count + prompt.options.length, 0),
		defaultChannelCount: draft.defaultChannelIds.length,
		startedFromExisting: draft.startedFromExisting,
		finalPromptAdded: draft.finalPromptAdded,
	});
}

// Fire and forget: a failed audit write never changes what the owner is told.
function audit(guildId: string, event: string, metadata: Record<string, unknown>): void {
	void botLogStore.log(guildId, event, metadata).catch((error) => console.warn(`[configure-onboarding] guild ${guildId} audit write failed`, error));
}

// ── helpers ──────────────────────────────────────────────────────────

/**
 * How every refusal in this flow and in promptEditModal is answered: a notice titled
 * Community, a modal for a press and the private fallback for a modal submit, which
 * cannot open one (post-launch plan item 9). Every caller states something (expired,
 * not allowed, a question gone), so none wears the error title (owner rule 1,
 * 2026-10 item 263 R3-12); a real failure here answers through errorEmbed instead.
 */
export async function replyOnboardingError(
	interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
	message: string,
	config: ICopyConfig | null
): Promise<void> {
	await showNotice(interaction, { title: getPluginCopy(config).notice.community, sections: [message] });
}
