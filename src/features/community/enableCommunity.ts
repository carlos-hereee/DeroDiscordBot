import {
	type ActionRowBuilder,
	type ButtonBuilder,
	type EmbedBuilder,
	ChannelSelectMenuBuilder,
	ChannelType,
	CheckboxBuilder,
	DiscordAPIError,
	GuildExplicitContentFilter,
	GuildVerificationLevel,
	LabelBuilder,
	MembershipScreeningFieldType,
	MessageFlags,
	ModalBuilder,
	PermissionFlagsBits,
	RESTJSONErrorCodes,
	Routes,
	type APIGuildMembershipScreeningField,
	type ButtonInteraction,
	type Guild,
	type GuildEditOptions,
	type ModalSubmitInteraction,
	type RESTPatchAPIGuildMemberVerificationJSONBody,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { resolveRulesMarkdown, type IRulesConfig } from "@features/setup/rulesContent.js";
import { communityCopy, type ICommunityChangeSummary, type ScreeningReplyOutcome } from "./communityCopy.js";
import { COMMUNITY_PREFIX, buildConfigureOnboardingOfferRow, buildConfirmEnableRow } from "./communityControls.js";

// ── enableCommunity ──────────────────────────────────────────────────
// What:  the Enable Community flow behind the admin guide's button (2026-10 item
//        247 Phase 3): one modal picks the rules channel, the community updates
//        channel and whether Membership Screening goes on (default on); a private
//        review says what will change; Confirm makes one guild edit that switches
//        COMMUNITY on, then writes the screening form from the server's rules. It
//        never configures Onboarding (Phase 4) and never stores the rules anywhere
//        but Discord's own form.
// Who:   communityButtons routes `community:enable` and `community:confirm` here
//        AFTER it has gated the clicker; the modal submit gates its submitter again,
//        because a role can be taken away while the modal is open.
// When:  on a press. The picks wait PENDING_FLOW_TTL_MS for Confirm, in memory, so a
//        restart drops them and Confirm then answers "expired".
// How:   ① already Community, or Dero missing a permission: say so, change nothing;
//        ② the modal (the configure-rok-reminders showModal + awaitModalSubmit
//        pattern); ③ the review, with the picks held under guildId:userId;
//        ④ Confirm re-checks ① against the live guild, then edits; ⑤ the screening
//        write, which may fail on its own without undoing Community; ⑥ audit rows,
//        fire and forget, ids and outcome codes only.

// ── constants ────────────────────────────────────────────────────────

const COMMUNITY_FEATURE = "COMMUNITY";

/** The cap on the rules text the screening form carries (plan risk R5); longer rules are cut at the last whole rule that fits, and the owner is told. */
export const MEMBERSHIP_SCREENING_RULES_MAX_LENGTH = 1500;

// The plan's pending flow window (section 5, State management): how long the picks
// from one modal submit wait for that admin's Confirm. Past it, Confirm says expired
// and Enable Community starts over, which costs one modal.
const PENDING_FLOW_TTL_MS = 2 * 60_000;
// How long the modal waits for its submit, the rules editor's wait. A submit after it
// is not heard and changes nothing.
const MODAL_TIMEOUT_MS = 10 * 60_000;

const MODAL_ID_PREFIX = `${COMMUNITY_PREFIX}:modal`;
const RULES_CHANNEL_FIELD = "rules_channel";
const PUBLIC_UPDATES_CHANNEL_FIELD = "public_updates_channel";
const SCREENING_FIELD = "membership_screening";

// What a Dero that is not an Administrator needs for this flow: Manage Server is the
// guild edit itself; Manage Roles and Manage Channels are what Community's own setup
// touches. has() counts Administrator as every flag, so an Administrator Dero is
// never refused here.
const REQUIRED_BOT_PERMISSIONS = [
	{ flag: PermissionFlagsBits.ManageGuild, name: communityCopy.permissionNames.ManageGuild },
	{ flag: PermissionFlagsBits.ManageRoles, name: communityCopy.permissionNames.ManageRoles },
	{ flag: PermissionFlagsBits.ManageChannels, name: communityCopy.permissionNames.ManageChannels },
] as const;

// ── types ────────────────────────────────────────────────────────────

/** The stored GuildConfig fields this flow reads. */
export interface IEnableCommunityConfig extends IRulesConfig {
	adminRoleId?: string | null;
	rulesChannelId?: string | null;
	adminChannelId?: string | null;
}

/** What one modal submit picked. */
export interface ICommunityPicks {
	rulesChannelId: string;
	publicUpdatesChannelId: string;
	membershipScreening: boolean;
}

interface IPendingFlow extends ICommunityPicks {
	expiresAt: number;
}

/** The Membership Screening PATCH, ready to send, and what the owner is told about it. */
export interface IMembershipScreeningRequest {
	body: RESTPatchAPIGuildMemberVerificationJSONBody;
	truncated: boolean;
	rulesLength: number;
}

/** How a Discord write ended, for the audit row. */
type WriteOutcome = "enabled" | "refused-permissions" | "refused-discord" | "failed";

/** A refused Discord write: the audit outcome, the sentence the owner reads, and Discord's error code when it sent one. */
export interface IWriteRefusal {
	outcome: Exclude<WriteOutcome, "enabled">;
	ownerMessage: string;
	discordCode: number | string | null;
}

/** The three sentences a refused write can end in, in each flow's own words (communityCopy.failures, communityCopy.onboarding.failures). */
export interface IDiscordRefusalCopy {
	missingPermission: string;
	rejected(discordMessage: string): string;
	unconfirmed: string;
}

// ── pending picks ────────────────────────────────────────────────────
// Held between the modal submit and Confirm. Keyed guildId:userId so two admins
// enabling at once never confirm each other's picks; a second submit from the same
// admin replaces the first, so Confirm always applies the picks shown last.

const pendingFlows = new Map<string, IPendingFlow>();

const pendingFlowKey = (guildId: string, userId: string): string => `${guildId}:${userId}`;

function rememberPicks(guildId: string, userId: string, picks: ICommunityPicks, expiresAt = Date.now() + PENDING_FLOW_TTL_MS): void {
	// Dropping expired entries on every write keeps the map from holding picks nobody
	// will ever confirm, without a timer of its own.
	const now = Date.now();
	for (const [key, flow] of pendingFlows) if (flow.expiresAt <= now) pendingFlows.delete(key);
	pendingFlows.set(pendingFlowKey(guildId, userId), { ...picks, expiresAt });
}

// Taken, not read: a double press of Confirm finds nothing the second time, so one
// set of picks edits the guild once. A refused edit puts the picks back.
function takePicks(guildId: string, userId: string): IPendingFlow | null {
	const key = pendingFlowKey(guildId, userId);
	const flow = pendingFlows.get(key) ?? null;
	pendingFlows.delete(key);
	if (!flow || flow.expiresAt <= Date.now()) return null;
	return flow;
}

// ── pure checks and builders ─────────────────────────────────────────

/** True when Discord Community is already switched on for the guild, read live. */
export function isCommunityEnabled(guild: Pick<Guild, "features">): boolean {
	return guild.features.includes(COMMUNITY_FEATURE);
}

/** The verification level Confirm sets: Medium, or the current level when it is already higher. */
export function raisedVerificationLevel(current: GuildVerificationLevel): GuildVerificationLevel {
	return current < GuildVerificationLevel.Medium ? GuildVerificationLevel.Medium : current;
}

/**
 * The one guild edit that switches Community on, with the two settings Discord
 * requires for it. discord.js names the channels rulesChannel and
 * publicUpdatesChannel and resolves an id for each.
 */
export function buildCommunityEdit(guild: Pick<Guild, "features" | "verificationLevel">, picks: ICommunityPicks): GuildEditOptions {
	return {
		features: [...guild.features, COMMUNITY_FEATURE],
		rulesChannel: picks.rulesChannelId,
		publicUpdatesChannel: picks.publicUpdatesChannelId,
		verificationLevel: raisedVerificationLevel(guild.verificationLevel),
		// AllMembers is the strictest filter there is, so it is never a downgrade.
		explicitContentFilter: GuildExplicitContentFilter.AllMembers,
		reason: communityCopy.auditReason,
	};
}

/**
 * The rules that fit the screening form: all of them when they are within
 * MEMBERSHIP_SCREENING_RULES_MAX_LENGTH, otherwise every whole rule up to the last
 * one that fits, so a member never reads a rule cut off mid sentence.
 */
export function fitRulesToScreeningForm(rulesMarkdown: string): { rules: string; truncated: boolean } {
	if (rulesMarkdown.length <= MEMBERSHIP_SCREENING_RULES_MAX_LENGTH) return { rules: rulesMarkdown, truncated: false };
	return { rules: rulesMarkdown.slice(0, lastRuleBoundary(rulesMarkdown)).trimEnd(), truncated: true };
}

// Where to cut rules that are too long. A rule is a block ending at a blank line:
// the pack default is joined that way, and the Edit rules modal preloads it, so
// owner edits mostly keep the shape. Rules written one per line with no blank
// lines fall back to the last line break; only a single rule longer than the whole
// limit is cut mid rule. lastIndexOf from the limit finds a break starting at or
// before it, so the text in front of the break is never longer than the limit.
function lastRuleBoundary(rulesMarkdown: string): number {
	const limit = MEMBERSHIP_SCREENING_RULES_MAX_LENGTH;
	const ruleBreak = rulesMarkdown.lastIndexOf("\n\n", limit);
	if (ruleBreak > 0) return ruleBreak;
	const lineBreak = rulesMarkdown.lastIndexOf("\n", limit);
	if (lineBreak > 0) return lineBreak;
	return limit;
}

/**
 * The Membership Screening PATCH body: one required rules field carrying the
 * server's rules, as many whole rules as fit (fitRulesToScreeningForm). Discord
 * takes the field list as a JSON STRING, not an array
 * (RESTPatchAPIGuildMemberVerificationJSONBody).
 */
export function buildMembershipScreeningRequest(rulesMarkdown: string): IMembershipScreeningRequest {
	const { rules, truncated } = fitRulesToScreeningForm(rulesMarkdown);
	const field: APIGuildMembershipScreeningField = {
		field_type: MembershipScreeningFieldType.Terms,
		label: communityCopy.screeningForm.label,
		values: [rules],
		required: true,
	};
	return {
		body: { enabled: true, form_fields: JSON.stringify([field]), description: communityCopy.screeningForm.description },
		truncated,
		rulesLength: rulesMarkdown.length,
	};
}

/** The permissions Dero lacks for this flow, by Discord's names; null when Dero's own member cannot be read. */
export async function findMissingBotPermissions(guild: Guild): Promise<string[] | null> {
	const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
	if (!me) return null;
	return REQUIRED_BOT_PERMISSIONS.filter(({ flag }) => !me.permissions.has(flag)).map(({ name }) => name);
}

// ── ① and ②: the Enable Community press ─────────────────────────────

/** The Enable Community button, once the router has gated the clicker. */
export async function handleEnableClick(interaction: ButtonInteraction, guild: Guild, config: IEnableCommunityConfig): Promise<void> {
	if (isCommunityEnabled(guild)) {
		await interaction.reply({ ...alreadyOnReply(guild, config), flags: MessageFlags.Ephemeral });
		return;
	}
	const refusal = await permissionRefusal(guild);
	if (refusal) {
		await replyError(interaction, refusal, config);
		return;
	}

	// The interaction id keys the modal, so a second admin's modal opened at the same
	// moment is never mistaken for this one.
	const modalId = `${MODAL_ID_PREFIX}:${interaction.id}`;
	await interaction.showModal(buildChannelsModal(modalId, guild, config));
	const submission = await interaction
		.awaitModalSubmit({ time: MODAL_TIMEOUT_MS, filter: (submit) => submit.user.id === interaction.user.id && submit.customId === modalId })
		.catch(() => null);
	// Timed out or dismissed: Discord gives nothing to reply to, and nothing changed.
	if (!submission) return;

	await handleChannelsPicked(submission);
}

// ── ③ the review ─────────────────────────────────────────────────────

/** One modal submit: hold the picks and show the review with its Confirm button. */
export async function handleChannelsPicked(submission: ModalSubmitInteraction): Promise<void> {
	const guild = submission.guild;
	const config = guild ? ((await guildConfigStore.findByGuildId(guild.id)) as IEnableCommunityConfig | null) : null;
	if (!guild || !config) {
		await replyError(submission, communityCopy.errors.expired, config);
		return;
	}
	if (!(await gateOwnerOrAdmin(submission, config))) {
		await replyError(submission, getPluginCopy(config).responses.noWizardPowers, config);
		return;
	}

	const rulesChannelId = submission.fields.getSelectedChannels(RULES_CHANNEL_FIELD)?.first()?.id;
	const publicUpdatesChannelId = submission.fields.getSelectedChannels(PUBLIC_UPDATES_CHANNEL_FIELD)?.first()?.id;
	if (!rulesChannelId || !publicUpdatesChannelId) {
		await replyError(submission, communityCopy.errors.channelsMissing, config);
		return;
	}
	const picks: ICommunityPicks = { rulesChannelId, publicUpdatesChannelId, membershipScreening: submission.fields.getCheckbox(SCREENING_FIELD) };
	rememberPicks(guild.id, submission.user.id, picks);

	// A new private reply rather than an update: the first modal opens from the
	// pinned admin guide, and updating that message would overwrite the guide.
	const summary = summarizeChange(guild, picks, config);
	await submission.reply({
		embeds: [infoEmbed(communityCopy.review.title, communityCopy.review.description(summary, MEMBERSHIP_SCREENING_RULES_MAX_LENGTH), getPluginCopy(config).COLORS.ADMIN, config)],
		components: [buildConfirmEnableRow()],
		flags: MessageFlags.Ephemeral,
	});
}

// ── ④ ⑤ ⑥ Confirm ───────────────────────────────────────────────────

/** The review's Confirm button, once the router has gated the clicker: edit the guild, then the screening form. */
export async function handleConfirm(interaction: ButtonInteraction, guild: Guild, config: IEnableCommunityConfig): Promise<void> {
	const flow = takePicks(guild.id, interaction.user.id);
	if (!flow) {
		await replyError(interaction, communityCopy.errors.expired, config);
		return;
	}
	// Deferred: the guild edit and the screening write are two Discord round trips,
	// which can outlast the three second acknowledgement window.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	// The review may be minutes old: another admin, or the owner in Server Settings,
	// can have switched Community on or taken a permission away since.
	if (isCommunityEnabled(guild)) {
		await interaction.editReply(alreadyOnReply(guild, config));
		return;
	}
	const refusal = await permissionRefusal(guild);
	if (refusal) {
		rememberPicks(guild.id, interaction.user.id, flow, flow.expiresAt);
		await interaction.editReply({ embeds: [errorEmbed(refusal, config)] });
		return;
	}

	// Summarized BEFORE the edit: a successful edit updates the cached guild, and
	// the reply has to say what the settings were raised from.
	const summary = summarizeChange(guild, flow, config);
	const edit = buildCommunityEdit(guild, flow);
	const editRefusal = await editGuild(guild, edit);
	auditCommunityEdit(guild.id, interaction.user.id, flow, edit, editRefusal);
	if (editRefusal) {
		// The picks go back so Confirm works again once the cause is fixed.
		rememberPicks(guild.id, interaction.user.id, flow, flow.expiresAt);
		await interaction.editReply({ embeds: [errorEmbed(editRefusal.ownerMessage, config)] });
		return;
	}

	const screening: ScreeningReplyOutcome = flow.membershipScreening ? await enableMembershipScreening(guild, config, interaction.user.id) : "skipped";
	await interaction.editReply({
		embeds: [
			infoEmbed(
				communityCopy.success.title,
				communityCopy.success.description(summary, screening, MEMBERSHIP_SCREENING_RULES_MAX_LENGTH),
				getPluginCopy(config).COLORS.ADMIN,
				config
			),
		],
		components: [buildConfigureOnboardingOfferRow()],
	});
}

// ── Discord writes ───────────────────────────────────────────────────

/** The guild edit; null on success, or what to tell the owner and audit. */
async function editGuild(guild: Guild, edit: GuildEditOptions): Promise<IWriteRefusal | null> {
	try {
		await guild.edit(edit);
		return null;
	} catch (error) {
		console.warn(`[enable-community] guild ${guild.id} Community edit refused`, error);
		return describeRefusal(error);
	}
}

// ⑤ Not fatal. Community is already on when this runs, so a refusal leaves it on and
// the reply tells the owner to switch screening on by hand. The endpoint is not in
// discord.js, and discord-api-types marks it unstable (it never reached Discord's
// public docs), so it goes through the REST client directly.
async function enableMembershipScreening(guild: Guild, config: IEnableCommunityConfig, actorId: string): Promise<ScreeningReplyOutcome> {
	const request = buildMembershipScreeningRequest(resolveRulesMarkdown(config));
	let refusal: IWriteRefusal | null = null;
	try {
		await guild.client.rest.patch(Routes.guildMemberVerification(guild.id), { body: request.body, reason: communityCopy.auditReason });
	} catch (error) {
		console.warn(`[enable-community] guild ${guild.id} Membership Screening write refused`, error);
		refusal = describeRefusal(error);
	}
	// Ids, a length and outcome codes only: the form's rules text never reaches a row
	// (the MEMBERSHIP_SCREENING_ENABLED_BY_BOT privacy note).
	audit(guild.id, BOT_LOG_EVENTS.MEMBERSHIP_SCREENING_ENABLED_BY_BOT, {
		actorId,
		outcome: refusal?.outcome ?? "enabled",
		discordCode: refusal?.discordCode ?? null,
		rulesLength: request.rulesLength,
		truncated: request.truncated,
	});
	return refusal ? "refused" : "enabled";
}

/**
 * What to tell the owner about a refused Discord write, for this flow and for
 * Configure Onboarding's write (which passes its own copy). A 50013 gets a plain
 * line naming the permission. It is NOT routed to
 * GuildSetupManager.handlePermissionFailure: that is the category build failure
 * tracker, which after seven days DMs the owner and makes Dero leave the guild,
 * and a refused settings change must never start that clock. Any other Discord
 * refusal shows Discord's own message verbatim.
 */
export function describeRefusal(error: unknown, copy: IDiscordRefusalCopy = communityCopy.failures): IWriteRefusal {
	if (error instanceof DiscordAPIError) {
		if (error.code === RESTJSONErrorCodes.MissingPermissions) {
			return { outcome: "refused-permissions", ownerMessage: copy.missingPermission, discordCode: error.code };
		}
		return { outcome: "refused-discord", ownerMessage: copy.rejected(error.message), discordCode: error.code };
	}
	// No Discord answer at all (a timeout, a dropped connection): the change may or
	// may not have landed, so the owner is sent to look rather than told it did not.
	return { outcome: "failed", ownerMessage: copy.unconfirmed, discordCode: null };
}

// ── audit ────────────────────────────────────────────────────────────

// ⑥ One row per Confirm that reached Discord, refused or not, so "did Dero switch
// Community on here, and who asked" has an answer either way.
function auditCommunityEdit(guildId: string, actorId: string, picks: ICommunityPicks, edit: GuildEditOptions, refusal: IWriteRefusal | null): void {
	audit(guildId, BOT_LOG_EVENTS.COMMUNITY_ENABLED_BY_BOT, {
		actorId,
		outcome: refusal?.outcome ?? "enabled",
		discordCode: refusal?.discordCode ?? null,
		rulesChannelId: picks.rulesChannelId,
		publicUpdatesChannelId: picks.publicUpdatesChannelId,
		verificationLevel: edit.verificationLevel ?? null,
		explicitContentFilter: edit.explicitContentFilter ?? null,
		membershipScreening: picks.membershipScreening,
	});
}

// Fire and forget: a failed audit write never changes what the owner is told.
function audit(guildId: string, event: string, metadata: Record<string, unknown>): void {
	void botLogStore.log(guildId, event, metadata).catch((error) => console.warn(`[enable-community] guild ${guildId} audit write failed`, error));
}

// ── helpers ──────────────────────────────────────────────────────────

async function permissionRefusal(guild: Guild): Promise<string | null> {
	const missing = await findMissingBotPermissions(guild);
	if (missing === null) return communityCopy.errors.permissionsUnreadable;
	return missing.length > 0 ? communityCopy.errors.missingPermissions(missing) : null;
}

function summarizeChange(guild: Guild, picks: ICommunityPicks, config: IEnableCommunityConfig): ICommunityChangeSummary {
	return {
		rulesChannelId: picks.rulesChannelId,
		publicUpdatesChannelId: picks.publicUpdatesChannelId,
		verificationLevel: {
			from: communityCopy.verificationLevelName(guild.verificationLevel),
			to: communityCopy.verificationLevelName(raisedVerificationLevel(guild.verificationLevel)),
		},
		contentFilter: {
			from: communityCopy.contentFilterName(guild.explicitContentFilter),
			to: communityCopy.contentFilterName(GuildExplicitContentFilter.AllMembers),
		},
		membershipScreening: picks.membershipScreening,
		rulesTruncated: fitRulesToScreeningForm(resolveRulesMarkdown(config)).truncated,
	};
}

// The status of a guild that is already Community, with the offer of the next step.
function alreadyOnReply(guild: Guild, config: IEnableCommunityConfig): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
	const description = communityCopy.alreadyOn.description({
		rulesChannelId: guild.rulesChannelId,
		publicUpdatesChannelId: guild.publicUpdatesChannelId,
		verificationLevel: communityCopy.verificationLevelName(guild.verificationLevel),
		contentFilter: communityCopy.contentFilterName(guild.explicitContentFilter),
	});
	return {
		embeds: [infoEmbed(communityCopy.alreadyOn.title, description, getPluginCopy(config).COLORS.ADMIN, config)],
		components: [buildConfigureOnboardingOfferRow()],
	};
}

/** The one modal: both channel picks and the screening checkbox, which starts ticked. */
function buildChannelsModal(modalId: string, guild: Guild, config: IEnableCommunityConfig): ModalBuilder {
	const copy = communityCopy.modal;
	// Pre-picked where the server already has the obvious channel: Dero's 📘rules for
	// the rules, and #inner-sanctum, which only admins can read, for Discord's
	// moderator notices. Either is one click to change.
	return new ModalBuilder()
		.setCustomId(modalId)
		.setTitle(copy.title)
		.addLabelComponents(
			new LabelBuilder()
				.setLabel(copy.rulesLabel)
				.setDescription(copy.rulesDescription)
				.setChannelSelectMenuComponent(textChannelSelect(RULES_CHANNEL_FIELD, existingTextChannelId(guild, config.rulesChannelId))),
			new LabelBuilder()
				.setLabel(copy.publicUpdatesLabel)
				.setDescription(copy.publicUpdatesDescription)
				.setChannelSelectMenuComponent(textChannelSelect(PUBLIC_UPDATES_CHANNEL_FIELD, existingTextChannelId(guild, config.adminChannelId))),
			new LabelBuilder()
				.setLabel(copy.screeningLabel)
				.setDescription(copy.screeningDescription)
				.setCheckboxComponent(new CheckboxBuilder().setCustomId(SCREENING_FIELD).setDefault(true))
		);
}

function textChannelSelect(customId: string, defaultChannelId: string | null): ChannelSelectMenuBuilder {
	// Text channels only: Discord refuses a rules or updates channel of any other type.
	const select = new ChannelSelectMenuBuilder().setCustomId(customId).setChannelTypes(ChannelType.GuildText).setRequired(true).setMinValues(1).setMaxValues(1);
	if (defaultChannelId) select.setDefaultChannels(defaultChannelId);
	return select;
}

// A default naming a channel that no longer exists would make Discord reject the
// whole modal, so a stored id is offered only while it resolves to a text channel.
function existingTextChannelId(guild: Guild, channelId: string | null | undefined): string | null {
	if (!channelId) return null;
	return guild.channels.cache.get(channelId)?.type === ChannelType.GuildText ? channelId : null;
}

async function replyError(interaction: ButtonInteraction | ModalSubmitInteraction, message: string, config: IEnableCommunityConfig | null): Promise<void> {
	await interaction.reply({ embeds: [errorEmbed(message, config)], flags: MessageFlags.Ephemeral }).catch(() => undefined);
}
