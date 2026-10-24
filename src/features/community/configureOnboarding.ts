import { MessageFlags, type ActionRowBuilder, type ButtonBuilder, type ButtonInteraction, type EmbedBuilder, type Guild, type ModalSubmitInteraction } from "discord.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { communityCopy } from "./communityCopy.js";
import { buildOnboardingReviewRows } from "./communityControls.js";
import { describeRefusal, type IWriteRefusal } from "./enableCommunity.js";
import { checkOnboardingPreconditions } from "./onboardingPreconditions.js";
import {
	buildOnboardingDraft,
	snapshotOnboarding,
	toOnboardingEditOptions,
	validateOnboardingDraft,
	type IDraftPrompt,
	type IOnboardingSnapshot,
	type PendingOnboardingDraft,
} from "./onboardingDraft.js";

// ── configureOnboarding ──────────────────────────────────────────────
// What:  the Configure Onboarding flow behind the admin guide's button (2026-10 item
//        247 Phase 4): check the server can take Onboarding, read what it already
//        has, draft the questions, show a private review with an Edit button per
//        question, and on Confirm write the whole config in one guild.editOnboarding
//        call. It never writes a role to a member (Discord Onboarding does, when the
//        member answers the final question) and never stores anyone's answers.
// Who:   communityButtons routes `community:configure`, `community:confirmOnboarding`
//        and `community:cancelOnboarding` here AFTER it has gated the clicker;
//        promptEditModal edits a question of the draft this file holds and redraws
//        the review with buildOnboardingReview.
// When:  on a press. The draft waits ONBOARDING_DRAFT_TTL_MS in memory, so a restart
//        drops it and Confirm then answers "expired".
// How:   ① preconditions, refused with one plain sentence; ② fetchOnboarding, and
//        nothing is drafted over a config Dero could not read; ③ the draft, which
//        keeps every question the server already has; ④ the review; ⑤ Confirm runs
//        ① and the draft's own checks again against the live guild, then writes;
//        ⑥ audit rows and the owner DM, fire and forget.

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

/** The review message: one embed and its Edit, Confirm and Cancel rows. */
export interface IOnboardingReviewMessage {
	embeds: EmbedBuilder[];
	components: ActionRowBuilder<ButtonBuilder>[];
}

type OwnerDmOutcome = "sent" | "failed";

// ── pending drafts ───────────────────────────────────────────────────
// Keyed guildId:userId, so two admins configuring at once never confirm each
// other's draft. A second Configure Onboarding press from the same admin replaces
// the first draft. Read by the edit modal, taken by Confirm, dropped by Cancel.

interface IPendingDraftEntry {
	draft: PendingOnboardingDraft;
	expiresAt: number;
}

const pendingDrafts = new Map<string, IPendingDraftEntry>();

const draftKey = (guildId: string, userId: string): string => `${guildId}:${userId}`;

/** Hold this admin's draft for ONBOARDING_DRAFT_TTL_MS from now, replacing any earlier one. */
export function storePendingDraft(guildId: string, userId: string, draft: PendingOnboardingDraft): void {
	// Dropping expired entries on every write keeps the map from holding drafts
	// nobody will confirm, without a timer of its own (enableCommunity does the same).
	const now = Date.now();
	for (const [key, entry] of pendingDrafts) if (entry.expiresAt <= now) pendingDrafts.delete(key);
	pendingDrafts.set(draftKey(guildId, userId), { draft, expiresAt: now + ONBOARDING_DRAFT_TTL_MS });
}

/** This admin's draft while it is live, or null. Read, not taken: an edit replaces it and the review keeps going. */
export function readPendingDraft(guildId: string, userId: string): PendingOnboardingDraft | null {
	const entry = pendingDrafts.get(draftKey(guildId, userId));
	return entry && entry.expiresAt > Date.now() ? entry.draft : null;
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
	// Deferred: fetchOnboarding is a Discord round trip. A new private reply rather
	// than an update, because the press can come from the pinned admin guide, and
	// updating that message would overwrite the guide.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const current = await readLiveOnboarding(guild);
	if ("readError" in current) {
		await interaction.editReply({ embeds: [errorEmbed(communityCopy.onboarding.readFailed(current.readError), config)] });
		return;
	}

	const result = buildOnboardingDraft({ guild, stored: config, copy: communityCopy.onboarding, current });
	if (!result.ok) {
		auditRefusedPress(guild.id, interaction.user.id, "draft", result);
		await interaction.editReply({ embeds: [errorEmbed(result.reason, config)] });
		return;
	}
	storePendingDraft(guild.id, interaction.user.id, result.draft);
	await interaction.editReply(buildOnboardingReview(result.draft, config));
}

// ② A config that cannot be read is never drafted over: an empty draft written on
// top of questions Dero never saw would replace them, which is the silent
// overwrite this flow exists to avoid.
async function readLiveOnboarding(guild: Guild): Promise<IOnboardingSnapshot | { readError: string }> {
	try {
		return snapshotOnboarding(await guild.fetchOnboarding());
	}
	catch (error) {
		console.warn(`[configure-onboarding] guild ${guild.id} fetchOnboarding failed`, error);
		return { readError: error instanceof Error ? error.message : String(error) };
	}
}

// ── ⑤ ⑥ Confirm ─────────────────────────────────────────────────────

/** The review's Confirm button, once the router has gated the clicker: check again, write, audit, DM the owner. */
export async function handleConfirmOnboarding(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig): Promise<void> {
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

	// An update, so the review itself becomes the result and its buttons go away.
	await interaction.deferUpdate();
	const writeRefusal = await writeOnboarding(guild, draft);
	if (writeRefusal) {
		storePendingDraft(guild.id, interaction.user.id, draft);
		auditWrite(guild.id, interaction.user.id, draft, writeRefusal.outcome, writeRefusal.discordCode, null);
		// The review stays with its buttons and the refusal under it, so the owner can
		// fix the cause, edit, and press Confirm again without starting over.
		const review = buildOnboardingReview(draft, config);
		await interaction.editReply({ embeds: [...review.embeds, errorEmbed(writeRefusal.ownerMessage, config)], components: review.components });
		return;
	}

	void notifyOwnerThenAudit(guild, interaction.user.id, draft);
	const summary = { promptCount: draft.prompts.length, defaultChannelCount: draft.defaultChannelIds.length, memberRoleId: draft.memberRoleId };
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

/** The review of a draft: the summary, one field per question in order, and its Edit, Confirm and Cancel buttons. */
export function buildOnboardingReview(draft: PendingOnboardingDraft, config: ICopyConfig | null): IOnboardingReviewMessage {
	const copy = communityCopy.onboarding.review;
	const shown = draft.prompts.slice(0, EMBED_FIELDS_MAX);
	const fieldBudget = Math.floor(FIELDS_TEXT_BUDGET / Math.max(shown.length, 1));
	const fields = shown.map((prompt, index) => {
		const name = truncate(copy.promptFieldName(index + 1, prompt.title), Math.min(EMBED_FIELD_NAME_MAX, Math.floor(fieldBudget / 3)));
		return { name, value: promptFieldValue(prompt, Math.min(EMBED_FIELD_VALUE_MAX, fieldBudget - name.length)) };
	});
	const embed = infoEmbed(copy.title, copy.description(draft), getPluginCopy(config).COLORS.ADMIN, config).addFields(fields);
	return { embeds: [embed], components: buildOnboardingReviewRows(draft.prompts.length) };
}

// The question's rules, then its answers, as many as fit, then a count of the rest.
function promptFieldValue(prompt: IDraftPrompt, maxLength: number): string {
	const copy = communityCopy.onboarding.review;
	let value = copy.promptRules(prompt);
	for (const [index, option] of prompt.options.entries()) {
		const line = copy.optionLine(option);
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

/** A private error reply, the way every refusal in this flow and in promptEditModal is answered. */
export async function replyOnboardingError(interaction: ButtonInteraction | ModalSubmitInteraction, message: string, config: ICopyConfig | null): Promise<void> {
	await interaction.reply({ embeds: [errorEmbed(message, config)], flags: MessageFlags.Ephemeral }).catch(() => undefined);
}
