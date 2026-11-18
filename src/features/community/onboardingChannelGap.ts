import {
	ChannelType,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	PermissionFlagsBits,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type EmbedBuilder,
	type ForumChannel,
	type Guild,
	type GuildBasedChannel,
	type ModalSubmitInteraction,
	type NewsChannel,
	type TextChannel,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { beginChannelAnswer, answerInChannel, type PendingChannelAnswer } from "@utils/answerInChannel.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { showModalOrReply, showPendingNotice } from "@utils/textModal.js";
import { slugify } from "@features/game-rooms/roomNaming.js";
import { matchesAdoptionPattern, readAdoptedChannelIds } from "@features/setup/adoption.js";
import { adminLog } from "@features/setup/adminLog.js";
import { introCommunityOverwrites } from "@features/setup/communityOverwrites.js";
import { GuildSetupManager } from "@features/setup/GuildSetupManager.js";
import { MANAGED_CATEGORY_FIELDS } from "@features/setup/selfDestruct.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { communityCopy, type IOnboardingGapProgress } from "./communityCopy.js";
import { COMMUNITY_PREFIX, buildChannelGapReviewRow } from "./communityControls.js";
import { draftOnboardingReview, replyOnboardingError, type IConfigureOnboardingConfig } from "./configureOnboarding.js";
import { describeRefusal, type IWriteRefusal } from "./enableCommunity.js";
import { MIN_EVERYONE_SENDABLE_CHANNELS, checkOnboardingPreconditions, everyoneCanView, everyoneSendableChannelIds } from "./onboardingPreconditions.js";
import { MODAL_TIMEOUT_MS, createPendingByMember } from "./pendingByMember.js";

// ── onboardingChannelGap ─────────────────────────────────────────────
// What:  the fix for Configure Onboarding's "too few channels everyone can post in"
//        refusal (2026-11 item 367): one modal lets the owner or an admin open some of the
//        server's own read only channels to everyone, create new plain channels, or both;
//        a private review; Confirm writes them, then goes straight into the Onboarding
//        draft. The channels it creates are the owner's: nothing stores them, nothing
//        heals or renames them, and /self-destruct leaves them, because they are never
//        filed under one of Dero's three managed categories.
// Who:   configureOnboarding.handleConfigureOnboardingButton opens the modal on that one
//        refusal at the press; communityButtons routes the review's Confirm and Cancel here
//        after it has gated the presser. The modal's Submit never passes the router: an
//        awaitModalSubmit collector answers it, so it is gated here.
// When:  on a press. The picks wait GAP_PICKS_TTL_MS in memory (pendingByMember), so a
//        restart drops them, and the collector with them; the owner presses again.
// How:   ① the press: Manage Channels checked, then the modal built from cached reads
//        only, since Discord takes a modal as the first answer within three seconds;
//        ② the Submit: gate, parse, review, picks held per member; ③ Confirm: picks
//        taken, acknowledged once through beginChannelAnswer, every pick checked again
//        against the live server; ④ the writes in order, stopping at a refusal with
//        nothing undone; ⑤ audit and admin log; ⑥ the preconditions again, then the
//        same draft a fresh Configure Onboarding press makes.

// ── constants ────────────────────────────────────────────────────────

/** The most new channels one Submit may create: the names box's line cap. */
export const GAP_NEW_CHANNELS_MAX = 5;
/** Discord's channel name cap. A longer name is refused rather than cut, so the owner sees the name they get. */
export const CHANNEL_NAME_MAX_LENGTH = 100;
/** How long the picks wait for Confirm, the same window Enable Community gives its picks. */
export const GAP_PICKS_TTL_MS = 2 * 60_000;
/** Discord's caps: 25 options a select, 100 characters an option label, 45 a modal title. */
export const SELECT_OPTIONS_MAX = 25;
const SELECT_LABEL_MAX = 100;
const MODAL_TITLE_MAX = 45;

const MODAL_ID_PREFIX = `${COMMUNITY_PREFIX}:gapmodal`;
const OPEN_FIELD = "gap_open";
const CATEGORY_FIELD = "gap_category";
const NAMES_FIELD = "gap_names";
// Category select values that are no channel id. A snowflake is all digits, so neither clashes.
const CATEGORY_NEW_VALUE = "new";
const CATEGORY_NONE_VALUE = "none";

// The kinds everyoneSendableChannelIds counts, and so the only kinds worth opening.
const OPENABLE_TYPES: ReadonlySet<ChannelType> = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum]);
// What Dero needs in a channel to grant @everyone View and Send there: Manage Roles is
// the overwrite edit itself, and Discord refuses an overwrite that grants a permission
// the editor lacks in that channel, unless the editor is an Administrator (has() counts it).
const DERO_CHANNEL_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.SendMessages];
const EVERYONE_SEND = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
// Names the boot repair adopts into Dero's welcome or rules slot (adoption.scanAndClaim).
// An owner channel with such a name could be adopted and locked by publicCommunityOverwrites,
// which would silently undo the fix, so it is never opened, created or suggested.
const RESERVED_NAME_PATTERNS: readonly string[] = [...BOT_CONSTANTS.WELCOME_ADOPTION_PATTERNS, ...BOT_CONSTANTS.RULES_ADOPTION_PATTERNS];

// A server emoji as Discord writes it in text; Discord keeps none of it in a channel name.
const CUSTOM_EMOJI = /<a?:\w+:\d+>/;
// One leading emoji: a keycap, a flag pair, or a pictographic sequence with its variation
// selectors, skin tones and ZWJ joins, so 👩‍💻 stays one emoji rather than three.
const LEADING_EMOJI = /^(?:[0-9#*]️?⃣|\p{Regional_Indicator}{2}|\p{Extended_Pictographic}[️\p{Emoji_Modifier}]*(?:‍\p{Extended_Pictographic}[️\p{Emoji_Modifier}]*)*)/u;

// ── types ────────────────────────────────────────────────────────────

/** Where new channels go: a category made from the pack's name, none, or an existing one. */
export type GapCategoryChoice = { kind: "new"; name: string } | { kind: "none" } | { kind: "existing"; id: string };

/** What one valid Submit picked, held until Confirm. */
export interface IGapPicks {
	openChannelIds: string[];
	newChannelNames: string[];
	category: GapCategoryChoice;
}

/** A channel @everyone can be opened in: the three kinds that carry permission overwrites. */
export type OpenableChannel = TextChannel | NewsChannel | ForumChannel;

/** One option of the modal's category select. */
export interface ICategoryOption {
	label: string;
	value: string;
	isDefault: boolean;
}

/** Everything the modal shows, read from the cache in one pass. */
export interface IChannelGapView {
	sendableCount: number;
	needed: number;
	candidates: Array<{ id: string; name: string }>;
	categoryOptions: ICategoryOption[];
	prefill: string[];
}

/** The names box parsed: the final channel names, or the one sentence that refuses it. */
export type ParsedChannelNames = { ok: true; names: string[] } | { ok: false; reason: string };

type LineResult = { ok: true; name: string } | { ok: false; reason: string };

/** How a Confirm ended, for the audit row. */
type GapOutcome = "filled" | "refused-recheck" | "open-unconfirmed" | IWriteRefusal["outcome"];

interface IGapWriteResult {
	progress: IOnboardingGapProgress;
	refusal: { outcome: GapOutcome; ownerMessage: string; discordCode: number | string | null } | null;
}

// ── pending picks (owner decision D2: the shared store) ─────────────────

const gapPicks = createPendingByMember<IGapPicks>(GAP_PICKS_TTL_MS);

// ── which channels and categories are Dero's ──────────────────────────
// Read through the existing lists, never a third one: every stored channel field
// (GuildSetupManager.CHANNEL_FIELDS), every adopted channel, and every child of a managed
// category (MANAGED_CATEGORY_FIELDS). The parent check is what catches game rooms, which
// live only on GameRoom rows: opening one would break its players only rule, and the
// archive sweep would later delete it and drop the server under the minimum again.

function storedIds(stored: unknown, fields: readonly string[]): Set<string> {
	const row = (stored ?? {}) as Record<string, unknown>;
	const ids = new Set<string>();
	for (const field of fields) {
		const value = row[field];
		if (typeof value === "string" && value.length > 0) ids.add(value);
	}
	return ids;
}

/** The ids of Dero's three managed categories on the stored row. */
export function managedCategoryIds(stored: unknown): Set<string> {
	return storedIds(stored, MANAGED_CATEGORY_FIELDS);
}

/** True when the channel is Dero's: a stored slot, an adopted channel, a managed category, or anything filed under one. */
export function isDeroManagedChannel(channel: Pick<GuildBasedChannel, "id" | "parentId">, stored: unknown): boolean {
	const categories = managedCategoryIds(stored);
	if (categories.has(channel.id)) return true;
	if (channel.parentId && categories.has(channel.parentId)) return true;
	if (readAdoptedChannelIds(stored).includes(channel.id)) return true;
	return storedIds(stored, GuildSetupManager.CHANNEL_FIELDS).has(channel.id);
}

// ── ① which channels may be opened (constraint 3, all six clauses) ─────

/**
 * True when Dero may open this channel to everyone: (a) a text, announcement or forum
 * channel, (b) not Dero's, (c) already visible to @everyone, (d) not already sendable by
 * @everyone, (e) one Dero can change, and (f) not named like a welcome or rules channel.
 * A hidden channel is never offered: opening a staff channel to every newcomer is the
 * risk this rule prevents. Run at the press and again at Confirm.
 */
export function isOpenableChannel(guild: Guild, channel: GuildBasedChannel, stored: unknown): channel is OpenableChannel {
	if (!OPENABLE_TYPES.has(channel.type)) return false;
	if (isDeroManagedChannel(channel, stored)) return false;
	if (!everyoneCanView(guild, channel)) return false;
	if (channel.permissionsFor(guild.roles.everyone)?.has(EVERYONE_SEND) === true) return false;
	const me = guild.members.me;
	if (!me || channel.permissionsFor(me)?.has(DERO_CHANNEL_PERMISSIONS) !== true) return false;
	return !matchesAdoptionPattern(channel.name, RESERVED_NAME_PATTERNS);
}

/** The channels the open select offers, in channel list order, the first SELECT_OPTIONS_MAX. */
export function openableChannels(guild: Guild, stored: unknown): OpenableChannel[] {
	const openable: OpenableChannel[] = [];
	for (const channel of guild.channels.cache.values()) if (isOpenableChannel(guild, channel, stored)) openable.push(channel);
	return openable.sort(byPosition).slice(0, SELECT_OPTIONS_MAX);
}

/**
 * The category select: the pack's category first and picked (the existing one of that exact
 * name when the server already has it, so no duplicate is built), then No category, then
 * the server's own categories in order. Dero's three managed categories are left out (owner
 * decision D1), because /self-destruct and /arcade off empty them.
 */
export function categoryOptions(guild: Guild, stored: unknown, packCategoryName: string): ICategoryOption[] {
	const managed = managedCategoryIds(stored);
	const categories = [...guild.channels.cache.values()].filter((channel) => channel.type === ChannelType.GuildCategory && !managed.has(channel.id)).sort(byPosition);
	const samePackName = categories.find((category) => category.name === packCategoryName);
	const first: ICategoryOption = samePackName
		? { label: clip(samePackName.name), value: samePackName.id, isDefault: true }
		: { label: clip(communityCopy.onboardingGap.modal.categoryNew(packCategoryName)), value: CATEGORY_NEW_VALUE, isDefault: true };
	const rest = categories.filter((category) => category !== samePackName).map((category) => ({ label: clip(category.name), value: category.id, isDefault: false }));
	return [first, { label: communityCopy.onboardingGap.modal.categoryNone, value: CATEGORY_NONE_VALUE, isDefault: false }, ...rest].slice(0, SELECT_OPTIONS_MAX);
}

// ── names ──────────────────────────────────────────────────────────────

/** Every channel name in the server, lowercased, for the "already exists" check. */
export function existingChannelNames(guild: Guild): Set<string> {
	return new Set([...guild.channels.cache.values()].map((channel) => channel.name.toLowerCase()));
}

// One line to its final name: the leading emoji kept as typed, the rest slugged by the
// rule game rooms use (owner decision D3), joined with no separator like 📜introductions.
function parseLine(line: string, lineNumber: number): LineResult {
	const copy = communityCopy.onboardingGap.names;
	if (CUSTOM_EMOJI.test(line)) return { ok: false, reason: copy.customEmoji(lineNumber) };
	const emoji = LEADING_EMOJI.exec(line)?.[0] ?? "";
	const slug = slugify(line.slice(emoji.length));
	if (!slug) return { ok: false, reason: copy.emptyName(lineNumber) };
	const name = `${emoji}${slug}`;
	if (name.length > CHANNEL_NAME_MAX_LENGTH) return { ok: false, reason: copy.tooLong(lineNumber, CHANNEL_NAME_MAX_LENGTH) };
	if (matchesAdoptionPattern(name, RESERVED_NAME_PATTERNS)) return { ok: false, reason: copy.reserved(lineNumber, name) };
	return { ok: true, name };
}

/**
 * The names box, one channel per line: trimmed, empty lines skipped, at most
 * GAP_NEW_CHANNELS_MAX. The first refused line answers, with its line number in the box.
 * `existingNames` is lowercased (existingChannelNames).
 */
export function parseChannelNames(text: string, existingNames: ReadonlySet<string>): ParsedChannelNames {
	const copy = communityCopy.onboardingGap.names;
	const lines = text
		.split(/\r?\n/)
		.map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
		.filter(({ line }) => line.length > 0);
	if (lines.length > GAP_NEW_CHANNELS_MAX) return { ok: false, reason: copy.tooManyLines(GAP_NEW_CHANNELS_MAX) };

	const names: string[] = [];
	const seen = new Set<string>();
	for (const { line, lineNumber } of lines) {
		const parsed = parseLine(line, lineNumber);
		if (!parsed.ok) return parsed;
		const key = parsed.name.toLowerCase();
		if (seen.has(key)) return { ok: false, reason: copy.duplicate(lineNumber, parsed.name) };
		if (existingNames.has(key)) return { ok: false, reason: copy.exists(lineNumber, parsed.name) };
		seen.add(key);
		names.push(parsed.name);
	}
	return { ok: true, names };
}

/** The names box's prefill: the first `count` pack suggestions whose final name the server does not have yet. */
export function suggestedChannelNames(suggestions: readonly string[], existingNames: ReadonlySet<string>, count: number): string[] {
	const picked: string[] = [];
	for (const suggestion of suggestions) {
		if (picked.length >= count) break;
		const parsed = parseLine(suggestion, 1);
		if (parsed.ok && !existingNames.has(parsed.name.toLowerCase())) picked.push(parsed.name);
	}
	return picked;
}

/** How many channels are still missing after the picks; zero or less means Confirm is offered. */
export function channelShortfall(needed: number, picks: Pick<IGapPicks, "openChannelIds" | "newChannelNames">): number {
	return needed - picks.openChannelIds.length - picks.newChannelNames.length;
}

// ── ① the modal ──────────────────────────────────────────────────────

/** Everything the modal shows, from cached reads only, with no await. */
export function readChannelGapView(guild: Guild, config: IConfigureOnboardingConfig): IChannelGapView {
	const sendableCount = everyoneSendableChannelIds(guild).length;
	const needed = Math.max(MIN_EVERYONE_SENDABLE_CHANNELS - sendableCount, 0);
	const pack = getPluginCopy(config).onboardingChannelGap;
	return {
		sendableCount,
		needed,
		candidates: openableChannels(guild, config).map((channel) => ({ id: channel.id, name: channel.name })),
		categoryOptions: categoryOptions(guild, config, pack.categoryName),
		prefill: suggestedChannelNames(pack.suggestions, existingChannelNames(guild), needed),
	};
}

/**
 * The modal, at most Discord's five components: the count, the open select (left out when
 * nothing can be opened), the category select, and the names box.
 */
export function buildChannelGapModal(modalId: string, view: IChannelGapView): ModalBuilder {
	const copy = communityCopy.onboardingGap.modal;
	const modal = new ModalBuilder()
		.setCustomId(modalId)
		.setTitle(copy.title.slice(0, MODAL_TITLE_MAX))
		.addTextDisplayComponents(new TextDisplayBuilder().setContent(copy.intro(view.sendableCount, MIN_EVERYONE_SENDABLE_CHANNELS, view.needed)));

	const labels: LabelBuilder[] = [];
	if (view.candidates.length > 0) {
		const open = new StringSelectMenuBuilder()
			.setCustomId(OPEN_FIELD)
			.setRequired(false)
			.setMinValues(0)
			.setMaxValues(Math.max(Math.min(view.needed, view.candidates.length), 1))
			.setPlaceholder(copy.openPlaceholder)
			.addOptions(view.candidates.slice(0, SELECT_OPTIONS_MAX).map((channel) => new StringSelectMenuOptionBuilder().setLabel(clip(`#${channel.name}`)).setValue(channel.id)));
		labels.push(new LabelBuilder().setLabel(copy.openLabel).setDescription(copy.openDescription).setStringSelectMenuComponent(open));
	}
	const category = new StringSelectMenuBuilder()
		.setCustomId(CATEGORY_FIELD)
		.setRequired(true)
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(view.categoryOptions.map((option) => new StringSelectMenuOptionBuilder().setLabel(option.label).setValue(option.value).setDefault(option.isDefault)));
	labels.push(new LabelBuilder().setLabel(copy.categoryLabel).setDescription(copy.categoryDescription).setStringSelectMenuComponent(category));

	const names = new TextInputBuilder().setCustomId(NAMES_FIELD).setStyle(TextInputStyle.Paragraph).setRequired(false);
	// An empty value is left unset: Discord refuses a text input preset to "".
	if (view.prefill.length > 0) names.setValue(view.prefill.join("\n"));
	labels.push(new LabelBuilder().setLabel(copy.namesLabel).setDescription(copy.namesDescription).setTextInputComponent(names));
	return modal.addLabelComponents(...labels);
}

/**
 * The Configure Onboarding press on a server short of channels everyone can post in,
 * once the router has gated the presser and the press has audited the refusal.
 * `refusalReason` is today's notice sentence, kept for every way this cannot open.
 */
export async function openChannelGapModal(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig, refusalReason: string): Promise<void> {
	const copy = communityCopy.onboardingGap;
	// Manage Roles is already proved by the preconditions' clause ②; Manage Channels is the
	// one this flow adds. Without it the modal would collect picks Dero cannot write.
	if (guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels) !== true) {
		await replyOnboardingError(interaction, `${refusalReason}\n\n${copy.missingManageChannels}`, config);
		return;
	}

	// The interaction id keys the modal, so a second admin's modal opened at the same
	// moment is never mistaken for this one (enableCommunity's pattern).
	const modalId = `${MODAL_ID_PREFIX}:${interaction.id}`;
	// Flagged by the fallback itself, because discord.js marks the press replied either way.
	let fellBack = false;
	await showModalOrReply(interaction, buildChannelGapModal(modalId, readChannelGapView(guild, config)), () => {
		fellBack = true;
		return { content: `${refusalReason}\n\n${copy.addByHand}`, flags: MessageFlags.Ephemeral };
	});
	// No modal is open, so nothing will be submitted.
	if (fellBack) return;

	const submission = await interaction
		.awaitModalSubmit({ time: MODAL_TIMEOUT_MS, filter: (submit) => submit.user.id === interaction.user.id && submit.customId === modalId })
		.catch(() => null);
	// Timed out, dismissed, or a restart dropped the collector: nothing changed.
	if (!submission) return;
	await handleChannelGapSubmit(submission);
}

// ── ② the Submit and the review ───────────────────────────────────────

/** One gap modal Submit: gate, parse, then post the review, holding the picks when they can be written. */
export async function handleChannelGapSubmit(submission: ModalSubmitInteraction): Promise<void> {
	const guild = submission.guild;
	const config = guild ? ((await guildConfigStore.findByGuildId(guild.id)) as IConfigureOnboardingConfig | null) : null;
	if (!guild || !config) {
		await replyOnboardingError(submission, communityCopy.onboardingGap.expired, config);
		return;
	}
	// The Submit does not pass the router, and a role can be taken away while the modal is open.
	if (!(await gateOwnerOrAdmin(submission, config))) {
		await replyOnboardingError(submission, getPluginCopy(config).responses.noWizardPowers, config);
		return;
	}
	// A second Submit replaces the first, and one that is refused leaves nothing to confirm.
	gapPicks.forget(guild.id, submission.user.id);

	const picks = readPicks(submission, guild, config);
	if (!picks.ok) {
		await postReview(submission, config, [errorEmbed(communityCopy.onboardingGap.review.refused(picks.reason), config)], false);
		return;
	}
	const sendableCount = everyoneSendableChannelIds(guild).length;
	const needed = Math.max(MIN_EVERYONE_SENDABLE_CHANNELS - sendableCount, 0);
	const missing = channelShortfall(needed, picks.picks);
	const embeds = [reviewEmbed(guild, config, picks.picks, sendableCount)];
	if (missing > 0) {
		await postReview(submission, config, [...embeds, errorEmbed(communityCopy.onboardingGap.review.shortfall(missing), config)], false);
		return;
	}
	gapPicks.remember(guild.id, submission.user.id, picks.picks);
	await postReview(submission, config, embeds, true);
}

// The Submit's three fields, each checked against the live server as it reads.
function readPicks(submission: ModalSubmitInteraction, guild: Guild, config: IConfigureOnboardingConfig): { ok: true; picks: IGapPicks } | { ok: false; reason: string } {
	const copy = communityCopy.onboardingGap;
	const fields = submission.fields;
	const openChannelIds = fields.fields.has(OPEN_FIELD) ? [...fields.getStringSelectValues(OPEN_FIELD)] : [];
	for (const id of openChannelIds) {
		const channel = guild.channels.cache.get(id);
		if (!channel || !isOpenableChannel(guild, channel, config)) return { ok: false, reason: copy.recheck.channelGone };
	}
	const [categoryValue] = fields.fields.has(CATEGORY_FIELD) ? fields.getStringSelectValues(CATEGORY_FIELD) : [];
	const category = toCategoryChoice(categoryValue ?? CATEGORY_NEW_VALUE, getPluginCopy(config).onboardingChannelGap.categoryName);
	if (category.kind === "existing" && !isUsableCategory(guild, config, category.id)) return { ok: false, reason: copy.recheck.categoryGone };
	const namesText = fields.fields.has(NAMES_FIELD) ? fields.getTextInputValue(NAMES_FIELD) : "";
	const names = parseChannelNames(namesText, existingChannelNames(guild));
	if (!names.ok) return names;
	return { ok: true, picks: { openChannelIds, newChannelNames: names.names, category } };
}

function toCategoryChoice(value: string, packCategoryName: string): GapCategoryChoice {
	if (value === CATEGORY_NEW_VALUE) return { kind: "new", name: packCategoryName };
	if (value === CATEGORY_NONE_VALUE) return { kind: "none" };
	return { kind: "existing", id: value };
}

function isUsableCategory(guild: Guild, stored: unknown, categoryId: string): boolean {
	const channel = guild.channels.cache.get(categoryId);
	return channel?.type === ChannelType.GuildCategory && !managedCategoryIds(stored).has(categoryId);
}

function categoryLabel(guild: Guild, category: GapCategoryChoice): string {
	const words = communityCopy.onboardingGap.modal;
	if (category.kind === "new") return words.categoryNew(category.name);
	if (category.kind === "none") return words.categoryNone;
	return guild.channels.cache.get(category.id)?.name ?? category.id;
}

function reviewEmbed(guild: Guild, config: IConfigureOnboardingConfig, picks: IGapPicks, sendableCount: number): EmbedBuilder {
	const copy = communityCopy.onboardingGap.review;
	const description = copy.description({
		openChannelIds: picks.openChannelIds,
		newChannelNames: picks.newChannelNames,
		categoryLabel: categoryLabel(guild, picks.category),
		countBefore: sendableCount,
		countAfter: sendableCount + picks.openChannelIds.length + picks.newChannelNames.length,
		minimum: MIN_EVERYONE_SENDABLE_CHANNELS,
	});
	return infoEmbed(copy.title, description, getPluginCopy(config).COLORS.ADMIN, config);
}

// A new message rather than an update: the modal opened from a press on the pinned steps
// card or a reply, and updating that would overwrite it. It posts in 🧭onboarding and
// answers only its submitter, because the picks are kept per guild and per member.
async function postReview(submission: ModalSubmitInteraction, config: IConfigureOnboardingConfig, embeds: EmbedBuilder[], canConfirm: boolean): Promise<void> {
	await answerInChannel(submission, "onboarding", { embeds, components: [buildChannelGapReviewRow(canConfirm)] }, { config });
}

// ── ③ ④ ⑤ ⑥ Confirm ───────────────────────────────────────────────

/** The gap review's Confirm, once the router has gated the presser: recheck, write, then draft Onboarding. */
export async function handleChannelGapConfirm(interaction: ButtonInteraction, guild: Guild, config: IConfigureOnboardingConfig): Promise<void> {
	// Taken, not read: a double press finds nothing the second time, so the picks write once.
	const entry = gapPicks.take(guild.id, interaction.user.id);
	if (!entry) {
		await replyOnboardingError(interaction, communityCopy.onboardingGap.expired, config);
		return;
	}
	// The one acknowledgement of this press, in place of a bare deferUpdate: with a
	// 🧭onboarding channel it is a quiet deferUpdate, so the review can be edited into the
	// result; without one it is the private defer the draft then answers. The draft
	// function never acknowledges, so the press is answered exactly once (R4).
	const answer = await beginChannelAnswer(interaction, "onboarding", { config });
	const picks = entry.value;

	// The review can be minutes old: a channel, a category, a name or a permission can all
	// have changed since. The picks go back so Confirm works once the cause is fixed.
	const refusal = recheckPicks(guild, config, picks);
	if (refusal) {
		gapPicks.remember(guild.id, interaction.user.id, picks, entry.expiresAt);
		auditFill(guild.id, interaction.user.id, picks, "refused-recheck", null, emptyProgress());
		await answerOnReview(interaction, answer, [errorEmbed(communityCopy.onboardingGap.review.refused(refusal), config)], false);
		return;
	}

	const written = await writePicks(guild, config, picks);
	if (written.refusal) {
		// Nothing is rolled back: deleting channels after a refusal is riskier than leaving
		// them, and the next Configure Onboarding press counts whatever exists now.
		auditFill(guild.id, interaction.user.id, picks, written.refusal.outcome, written.refusal.discordCode, written.progress);
		const message = `${written.refusal.ownerMessage}\n\n${communityCopy.onboardingGap.partial(written.progress)}`;
		await answerOnReview(interaction, answer, [errorEmbed(message, config)], true);
		return;
	}
	auditFill(guild.id, interaction.user.id, picks, "filled", null, written.progress);
	const opened = written.progress.openedChannelIds.length;
	const created = written.progress.createdChannelIds.length;
	adminLog.emitFor(interaction, guild.id, "config.change", {
		subject: setupCopy.adminLog.subjects.onboardingChannels,
		detail: communityCopy.onboardingGap.adminLogDetail(opened, created),
	});

	const sendable = everyoneSendableChannelIds(guild).length;
	const draftAnswer = await announceFilled(interaction, answer, config, { opened, created, sendable });
	// ⑥ The preconditions again: another admin can have removed a channel meanwhile, and
	// then that refusal shows instead of a draft Discord would refuse.
	const precondition = checkOnboardingPreconditions(guild, config);
	if (!precondition.ok) {
		await showPendingNotice(interaction, draftAnswer, { title: getPluginCopy(config).notice.community, sections: [precondition.reason] });
		return;
	}
	await draftOnboardingReview(interaction, guild, config, draftAnswer);
}

/** The gap review's Cancel: forget the picks and close the review. Nothing on Discord changes. */
export async function handleChannelGapCancel(interaction: ButtonInteraction, guild: Guild): Promise<void> {
	gapPicks.forget(guild.id, interaction.user.id);
	await interaction.update({ content: communityCopy.onboardingGap.cancelled, embeds: [], components: [] });
}

// Every clause of the press, checked again: the preconditions other than the count this
// flow is fixing, Manage Channels when something is created, and each pick on the live guild.
function recheckPicks(guild: Guild, config: IConfigureOnboardingConfig, picks: IGapPicks): string | null {
	const copy = communityCopy.onboardingGap;
	const precondition = checkOnboardingPreconditions(guild, config);
	if (!precondition.ok && precondition.code !== "too-few-sendable-channels") return precondition.reason;
	if (picks.newChannelNames.length > 0 && guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels) !== true) return copy.missingManageChannels;
	for (const id of picks.openChannelIds) {
		const channel = guild.channels.cache.get(id);
		if (!channel || !isOpenableChannel(guild, channel, config)) return copy.recheck.channelGone;
	}
	if (picks.category.kind === "existing" && !isUsableCategory(guild, config, picks.category.id)) return copy.recheck.categoryGone;
	const existing = existingChannelNames(guild);
	const taken = picks.newChannelNames.find((name) => existing.has(name.toLowerCase()));
	return taken ? copy.recheck.nameTaken(taken) : null;
}

// ④ In order: open, then the category if one is needed, then each new channel. The first
// refusal stops the run, and the progress says exactly what exists.
async function writePicks(guild: Guild, config: IConfigureOnboardingConfig, picks: IGapPicks): Promise<IGapWriteResult> {
	const reason = communityCopy.onboardingGap.auditReason;
	const progress: { openedChannelIds: string[]; categoryId: string | null; createdChannelIds: string[] } = { openedChannelIds: [], categoryId: null, createdChannelIds: [] };
	try {
		for (const id of picks.openChannelIds) {
			const channel = guild.channels.cache.get(id);
			if (!channel || !isOpenableChannel(guild, channel, config)) {
				return { progress, refusal: { outcome: "refused-recheck", ownerMessage: communityCopy.onboardingGap.recheck.channelGone, discordCode: null } };
			}
			// Only @everyone's entry changes; every other overwrite on the channel stays as it is.
			await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: true, SendMessages: true }, { reason });
			progress.openedChannelIds.push(id);
			if (channel.permissionsFor(guild.roles.everyone)?.has(EVERYONE_SEND) !== true) {
				return { progress, refusal: { outcome: "open-unconfirmed", ownerMessage: communityCopy.onboardingGap.openUnconfirmed(id), discordCode: null } };
			}
		}
		if (picks.newChannelNames.length === 0) return { progress, refusal: null };

		const parent = await resolveParent(guild, config, picks.category, reason, progress);
		const overwrites = introCommunityOverwrites(guild, { ownerId: guild.ownerId }, { memberRoleId: config.memberRoleId ?? null, adminRoleId: config.adminRoleId ?? null });
		for (const name of picks.newChannelNames) {
			const created = await guild.channels.create({ name, type: ChannelType.GuildText, parent, permissionOverwrites: overwrites, reason });
			progress.createdChannelIds.push(created.id);
		}
		return { progress, refusal: null };
	} catch (error) {
		console.warn(`[onboarding-channel-gap] guild ${guild.id} channel write refused`, error);
		return { progress, refusal: describeRefusal(error, communityCopy.onboardingGap.failures) };
	}
}

// The parent for new channels. A "new" category reuses one of the same name that appeared
// since the review, so a race never builds a duplicate; it carries no overwrites of its own.
async function resolveParent(
	guild: Guild,
	stored: unknown,
	category: GapCategoryChoice,
	reason: string,
	progress: { categoryId: string | null }
): Promise<string | null> {
	if (category.kind === "none") return null;
	if (category.kind === "existing") return category.id;
	const managed = managedCategoryIds(stored);
	const existing = [...guild.channels.cache.values()].find((channel) => channel.type === ChannelType.GuildCategory && channel.name === category.name && !managed.has(channel.id));
	if (existing) return existing.id;
	const made = await guild.channels.create({ name: category.name, type: ChannelType.GuildCategory, reason });
	progress.categoryId = made.id;
	return made.id;
}

// ⑤ The short result, then the answer the draft goes to. With 🧭onboarding the review
// itself becomes the result and the draft posts below it; without one the private defer is
// the only place left, so the result line leads the draft's own private answer.
async function announceFilled(
	interaction: ButtonInteraction,
	answer: PendingChannelAnswer,
	config: IConfigureOnboardingConfig,
	counts: { opened: number; created: number; sendable: number }
): Promise<PendingChannelAnswer> {
	const copy = communityCopy.onboardingGap.result;
	if (answer.channelId !== null) {
		const embed = infoEmbed(copy.title, copy.description(counts.opened, counts.created, counts.sendable), getPluginCopy(config).COLORS.ADMIN, config);
		await answerOnReview(interaction, answer, [embed], true);
		return answer;
	}
	const line = copy.line(counts.opened, counts.created, counts.sendable);
	return {
		channelId: null,
		send: (reply) => answer.send({ ...reply, content: reply.content ? `${line}\n\n${reply.content}` : line }),
	};
}

// What Confirm says on the review. With 🧭onboarding the press was a quiet deferUpdate, so
// editReply rewrites the review; `closed` drops its buttons, while a recheck refusal keeps
// them for a retry. Without one, the private defer is waiting and takes the answer.
async function answerOnReview(interaction: ButtonInteraction, answer: PendingChannelAnswer, embeds: EmbedBuilder[], closed: boolean): Promise<void> {
	if (answer.channelId === null) {
		await answer.send({ embeds });
		return;
	}
	try {
		await interaction.editReply(closed ? { embeds, components: [] } : { embeds });
	} catch (error) {
		// The review was deleted meanwhile; the work already happened and the audit has it.
		console.warn(`[onboarding-channel-gap] editing the review failed`, { interactionId: interaction.id, error });
	}
}

// ── audit ────────────────────────────────────────────────────────────

const emptyProgress = (): IOnboardingGapProgress => ({ openedChannelIds: [], categoryId: null, createdChannelIds: [] });

// One row per Confirm. Ids, counts and outcome codes only: a name the owner typed never
// reaches the store (the ONBOARDING_CHANNELS_FILLED privacy note).
function auditFill(guildId: string, actorId: string, picks: IGapPicks, outcome: GapOutcome, discordCode: number | string | null, progress: IOnboardingGapProgress): void {
	const metadata = {
		actorId,
		outcome,
		discordCode,
		requestedOpenCount: picks.openChannelIds.length,
		requestedCreateCount: picks.newChannelNames.length,
		categoryChoice: picks.category.kind,
		openedChannelIds: progress.openedChannelIds,
		createdCategoryId: progress.categoryId,
		createdChannelIds: progress.createdChannelIds,
	};
	// Fire and forget: a failed audit write never changes what the owner is told.
	void botLogStore
		.log(guildId, BOT_LOG_EVENTS.ONBOARDING_CHANNELS_FILLED, metadata)
		.catch((error: unknown) => console.warn(`[onboarding-channel-gap] guild ${guildId} audit write failed`, error));
}

// ── helpers ──────────────────────────────────────────────────────────

// Channel list order: Discord's own position, then the id so a tie never reorders.
function byPosition(left: GuildBasedChannel, right: GuildBasedChannel): number {
	const difference = positionOf(left) - positionOf(right);
	return difference !== 0 ? difference : left.id.localeCompare(right.id);
}

// A thread has no position of its own; none reaches here past the type filters, but the
// union carries it, so it reads as first rather than crashing a sort.
function positionOf(channel: GuildBasedChannel): number {
	return "position" in channel ? channel.position : 0;
}

const clip = (text: string): string => (text.length > SELECT_LABEL_MAX ? text.slice(0, SELECT_LABEL_MAX) : text);
