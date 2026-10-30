import { PermissionFlagsBits, TextChannel, type Client, type Guild, type GuildMember, type HexColorString } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { buildDeroImageAttachment, COLORS, DERO_IMAGE_REF } from "@base/copy/brand.js";
import { getCopyOverride } from "@base/copy/getCopy.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { levelFromTotalXp, xpIntoLevel } from "./levelCurve.js";
import { milestoneLevelsUpTo } from "./primeLevels.js";
import { levelingCopy } from "./levelingCopy.js";
import { buildCombinedLevelUpEmbed, buildLevelUpEmbed, type AchievementUnlockEntry, type AchievementUnlockView, type LevelUpView } from "./levelingEmbeds.js";
import { getLevelingConfig, type GuildLevelingContext } from "./levelingConfig.js";
import { scheduleLevelsBoardRefresh } from "./LevelsBoard.js";
import { reconcileRewards } from "./roleRewards.js";
import { buildAchievementUnlockCardEmbed, buildAchievementUnlockEmbed, buildRoleUnlockEmbed, type RoleUnlockView } from "./levelingEmbeds.js";
import { LEVEL_UP_AVATAR_SIZE, renderLevelUpCard } from "./levelUpRenderer.js";
import { ACHIEVEMENT_UNLOCK_AVATAR_SIZE, renderAchievementUnlockCard } from "./achievementUnlockRenderer.js";
import { ROLE_UNLOCK_AVATAR_SIZE, renderRoleUnlockCard } from "./roleUnlockRenderer.js";
import { avatarRequestFor, canvasColor, isRenderPayload, withRenderFallback } from "@features/renderer/index.js";

// ── levelUpAnnouncer ───────────────────────────────────────────────────────
// Decides that a level was crossed, claims the right to say so exactly once, and
// says it without ever notifying anybody.
//
// What:  ① derive old and new level from the two totals, ② claim the
//        announcement atomically, ③ coalesce a burst of more than
//        ANNOUNCE_BURST_THRESHOLD into one message, ④ post every other announced
//        level up as its own drawn card (2026-10 item 263 Phase 5).
// Who:   xpWriter's flush for buffered message xp, and awardXp directly for
//        every write-through source (games, voice, admin).
// When:  once per member per level, guaranteed by the claim rather than by
//        anything in this process's memory.
// Where: level crossing detection lives HERE rather than in awardXp so the
//        buffered path and the write-through path cannot drift into two
//        different definitions of "leveled up". The claim being an
//        `announcedLevel` high water mark is why this module owns it.
//
// ⚠️ THE NEVER PING INVARIANT (the owner's locked decision D3). EVERY send in
// this file sets allowedMentions: { parse: [], roles: [], users: [] }, so a
// <@id> renders as a name and notifies nobody. That is already house style (the
// test reminder fires and the duel result embed both do it), but a rule kept by
// habit decays, so assertNotPingable below makes it structural: a future
// engineer who wants leveling to ping has to add this message kind to a NAMED
// allow list in BOT_CONSTANTS, which is a decision somebody can review, rather
// than delete one line, which is an accident nobody notices until a thousand
// members get a notification.

// The kind string this feature sends under. Deliberately absent from
// BOT_CONSTANTS.PINGABLE, and asserted absent before every send.
const LEVELING_MESSAGE_KIND = "leveling.levelUp";

// Silences every mention in a message, whatever the text contains.
const NO_MENTIONS = { parse: [], roles: [], users: [] } as const;

// Everything the bot needs in a channel before it can announce. AddReactions is
// in the list because the congratulations reaction is part of the payload the
// owner asked for, not a nice to have.
const REQUIRED_PERMISSIONS = [
	{ flag: PermissionFlagsBits.ViewChannel, name: "ViewChannel" },
	{ flag: PermissionFlagsBits.SendMessages, name: "SendMessages" },
	{ flag: PermissionFlagsBits.EmbedLinks, name: "EmbedLinks" },
	{ flag: PermissionFlagsBits.AttachFiles, name: "AttachFiles" },
	{ flag: PermissionFlagsBits.AddReactions, name: "AddReactions" },
];

export interface LevelCrossingInput {
	client: Client;
	guildId: string;
	userId: string;
	// Optional, mirroring AwardXpInput. The text announcement addresses the member
	// by mention, which needs only the id; the milestone card cannot draw a
	// mention, so it draws this name when the member is not in the guild cache.
	username?: string;
	oldTotalXp: number;
	newTotalXp: number;
	// Where the xp was earned, when that is knowable. Only read under
	// announceMode "current"; a voice sweep has no channel and falls back.
	sourceChannelId?: string | null;
}

interface QueuedLevelUp {
	userId: string;
	level: number;
	milestone: boolean;
	xpIntoLevel: number;
	// Populated by Phase 4's role rewards. Renders the {earned:...} block.
	earnedRoleId: string | null;
	// The stored username, the milestone card's name when no member is found.
	username: string | null;
}

// ── handleLevelCrossing ────────────────────────────────────────────────────
// Never throws. Every failure is logged and swallowed, because this runs after a
// successful primary write and must not be able to break it (convention 7).
export async function handleLevelCrossing(input: LevelCrossingInput): Promise<void> {
	try {
		const context = await getLevelingConfig(input.guildId);
		if (!context || context.homebaseDestroyed) return;
		const settings = context.settings;
		if (!settings.enabled) return;

		const oldLevel = levelFromTotalXp(input.oldTotalXp, settings.curve, settings.curveMultiplier, settings.maxLevel);
		const newLevel = levelFromTotalXp(input.newTotalXp, settings.curve, settings.curveMultiplier, settings.maxLevel);
		// Not a crossing. The overwhelming majority of awards land here and cost
		// nothing beyond the arithmetic above.
		if (newLevel <= oldLevel) return;

		const milestone = crossesLoudLevel(oldLevel, newLevel, settings.milestoneMode, settings.milestoneEveryN);

		// ⚠️ Decide whether this level is announceable BEFORE claiming it. The
		// claim is a high water mark, so claiming a level the guild does not want
		// announced would silently consume it: if the admin later turned
		// announcements on, that level could never be announced again. Checking
		// first also keeps an "off" guild from writing to the database on every
		// single level up.
		const announced = settings.announceMode !== "off" && (settings.announceMode !== "milestone" || milestone);
		if (!announced) {
			// A role reward is earned by the level, not by the announcement, so a guild that
			// silences level ups still grants it (2026-10 item 280). reconcileRewards applies
			// the full desired role set in one roles.set, so a racing call cannot grant twice.
			await reconcileRewards(input.client, input.guildId, input.userId, newLevel);
			return;
		}

		// ⚠️ THE CLAIM. updateOne on { announcedLevel: { $lt: newLevel } }: whoever
		// raises the high water mark first is the one caller that announces, and
		// every other concurrent path sees modifiedCount 0 and returns silently.
		// This is what makes a double announcement impossible across two flushes,
		// two processes, or a flush racing a write-through award.
		const claimed = await memberLevelStore.claimAnnouncement(input.guildId, input.userId, newLevel);
		if (!claimed) return;

		// ── role rewards ──
		// AWAITED, deliberately, unlike every other side effect here. The role has
		// to be known before the message is composed so the {earned:...} block
		// renders in the SAME message as the level up rather than arriving in a
		// second one a moment later. reconcileRewards never throws and returns null
		// when there is nothing to grant, which is the overwhelming majority of
		// level ups, so this costs nothing on the common path.
		const earnedRoleId = await reconcileRewards(input.client, input.guildId, input.userId, newLevel);

		const channel = await resolveAnnounceChannel(input.client, input.guildId, context, input.sourceChannelId ?? null);
		if (!channel) return;

		enqueue(input.client, channel, {
			userId: input.userId,
			level: newLevel,
			milestone,
			xpIntoLevel: xpIntoLevel(input.newTotalXp, settings.curve, settings.curveMultiplier, settings.maxLevel),
			earnedRoleId,
			username: input.username ?? null,
		});

		// The standings moved, so nudge the pinned board. Coalesced per guild, so a
		// busy evening produces one edit per window rather than one per level up.
		scheduleLevelsBoardRefresh(input.client, input.guildId);

		// Fire and forget, and deliberately after the enqueue: the member's
		// celebration must not wait on an admin notice.
		void maybePostAdminNotice(input.client, input.guildId, context);
	} catch (error) {
		console.error(LOG_MESSAGES.leveling.announceFailed(input.guildId), error);
	}
}

// Prime levels are the milestone levels. "everyN" survives only as an opt out
// for a guild that wants the ordinary thing, and level 1 is never loud under
// either mode because a member starts there. A jump counts as loud when ANY level
// in (oldLevel, newLevel] is, so a member leaping from 1 to 4 past 2 and 3 is not
// skipped under "milestone" mode (2026-10 item 280).
function crossesLoudLevel(oldLevel: number, newLevel: number, mode: "prime" | "everyN", everyN: number): boolean {
	if (newLevel <= 1) return false;
	if (mode === "everyN") {
		const step = Math.max(1, everyN);
		return Math.floor(newLevel / step) > Math.floor(Math.max(1, oldLevel) / step);
	}
	return milestoneLevelsUpTo(newLevel) > milestoneLevelsUpTo(oldLevel);
}

// ── the coalescing queue ───────────────────────────────────────────────────
// Copied in shape from scheduleLeaderboardRefresh in LeaderboardBoard.ts, and
// the reason is worth repeating here because it is not the obvious one: the
// FIRST level up schedules a send one window out and every later one inside that
// window is ABSORBED with the timer LEFT RUNNING. It is deliberately not a
// reset-on-each-call debounce, which would starve a busy channel for the whole
// burst and then deliver everything at the end.
interface ChannelQueue {
	client: Client;
	channel: TextChannel;
	events: QueuedLevelUp[];
	timer: ReturnType<typeof setTimeout>;
}

const queues = new Map<string, ChannelQueue>();

function enqueue(client: Client, channel: TextChannel, event: QueuedLevelUp): void {
	const existing = queues.get(channel.id);
	if (existing) {
		existing.events.push(event);
		return;
	}

	const timer = setTimeout(() => void drain(channel.id), BOT_CONSTANTS.LEVELING.ANNOUNCE_COALESCE_MS);
	timer.unref?.();
	queues.set(channel.id, { client, channel, events: [event], timer });
}

async function drain(channelId: string): Promise<void> {
	const queue = queues.get(channelId);
	if (!queue) return;
	// Remove before sending, so level ups arriving during the send start a fresh
	// window rather than joining a batch that has already left.
	queues.delete(channelId);
	clearTimeout(queue.timer);

	try {
		const guildId = queue.channel.guildId;
		const context = await getLevelingConfig(guildId);
		const settings = context?.settings;

		const missing = missingPermissions(queue.channel);
		if (missing.length > 0) {
			// The failure that is otherwise INVISIBLE to an admin: the feature is on,
			// the bot is in the channel, and nothing ever appears. Named permissions
			// put the fix in the log line.
			console.warn(LOG_MESSAGES.leveling.announceMissingPermissions(queue.channel.id, guildId, missing.join(", ")));
			return;
		}

		// Above the burst threshold everything collapses into ONE message. This
		// is what keeps a busy channel from going unreadable and keeps the bot
		// under Discord's per channel 429 limit now that every level up is a card.
		if (queue.events.length > BOT_CONSTANTS.LEVELING.ANNOUNCE_BURST_THRESHOLD) {
			await sendCombined(
				queue,
				settings?.reactionEmoji ?? "🎉",
				queue.events.some((event) => event.milestone)
			);
			return;
		}

		// Three or fewer in one window: each level up gets its own card, in the
		// order they were earned, so none reads as one entry in a list.
		for (const event of queue.events) {
			await sendLevelUpCard(queue, event, settings?.reactionEmoji ?? "🎉", context ?? null);
		}
	} catch (error) {
		console.error(LOG_MESSAGES.leveling.announceFailed(queue.channel.guildId), error);
	}
}

async function sendCombined(queue: ChannelQueue, reactionEmoji: string, anyMilestone: boolean): Promise<void> {
	assertNotPingable();
	const message = await queue.channel.send({
		embeds: [
			buildCombinedLevelUpEmbed(
				queue.events.map((event) => ({ userId: event.userId, level: event.level, milestone: event.milestone }))
			),
		],
		allowedMentions: NO_MENTIONS,
	});
	// Only worth a reaction when at least one of the batch was a real milestone.
	if (anyMilestone) await addReaction(message, reactionEmoji, queue.channel.guildId);
}

// One announced level up as its drawn card, a milestone or not. The card is the
// same either way; only a milestone gets the congratulations reaction, so the
// loud levels still stand out in a channel that now shows a card for every level.
async function sendLevelUpCard(
	queue: ChannelQueue,
	event: QueuedLevelUp,
	reactionEmoji: string,
	context: GuildLevelingContext | null
): Promise<void> {
	assertNotPingable();
	const member = await resolveCardMember(queue.channel.guild, event.userId);
	const view: LevelUpView = {
		description: renderLine(event, queue, context),
		level: event.level,
		milestone: event.milestone,
		imageRef: DERO_IMAGE_REF,
		displayName: member?.displayName ?? event.username,
		avatar: member ? avatarRequestFor(member.user, LEVEL_UP_AVATAR_SIZE) : null,
	};
	// The rendered card takes the image slot when it draws (a GIF on a prime
	// level); otherwise the embed keeps Dero's bundled still, exactly as before.
	const card = await withRenderFallback(
		() => renderLevelUpCard(view),
		() => buildLevelUpEmbed(view)
	);
	const message = await queue.channel.send({
		...(isRenderPayload(card)
			? { embeds: [buildLevelUpEmbed({ ...view, imageRef: card.ref })], files: [card.attachment] }
			: { embeds: [card], files: [buildDeroImageAttachment()] }),
		allowedMentions: NO_MENTIONS,
	});

	if (!event.milestone) return;

	// ⚠️ The reaction goes on the BOT'S OWN post, never on the member's message.
	// A level up can come from a reaction or from a voice sweep, where there is no
	// message of the member's to react to, so anchoring here is the only version
	// that always works. It is also what makes the congratulations something the
	// channel can pile onto.
	await addReaction(message, reactionEmoji, queue.channel.guildId);
}

async function addReaction(
	message: { react: (emoji: string) => Promise<unknown> },
	emoji: string,
	guildId: string
): Promise<void> {
	// A guild can configure an emoji the bot cannot use (a custom emoji from a
	// server it is not in). That must not turn a successful celebration into a
	// logged failure of the whole announcement, so it is caught on its own.
	await message.react(emoji).catch((error: unknown) => {
		console.warn(LOG_MESSAGES.leveling.reactionFailed(guildId), error);
	});
}

// The member a card draws, from the guild cache or one fetch. Null when they
// cannot be found (they left between the xp and the announcement), and the card
// then draws its placeholder face; never throws, since a card is decoration.
async function resolveCardMember(guild: Guild, userId: string): Promise<GuildMember | null> {
	try {
		return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId));
	} catch (error) {
		console.warn(LOG_MESSAGES.leveling.announceMemberMissing(userId, guild.id), error);
		return null;
	}
}

// ── rendering ──────────────────────────────────────────────────────────────
// The congratulations is the one string in this feature with a real voice, which
// is why it is the only one that is overridable per guild. Everything else
// ("Level", "XP to next", "Rank") is structural and reads identically in the
// kingdom and streamer packs, so it stays in levelingCopy with no pack
// indirection, exactly as gamesCopy.ts and fortuneCopy.ts already argue.
function renderLine(event: QueuedLevelUp, queue: ChannelQueue, context: GuildLevelingContext | null): string {
	const overrideKey = event.milestone ? "leveling.milestone" : "leveling.levelUp";
	const fallback = event.milestone ? levelingCopy.levelUp.milestoneTemplate : levelingCopy.levelUp.defaultTemplate;
	// getCopyOverride takes an ARBITRARY string key and reads the guild's
	// copyOverrides Map, so these two keys work with no schema change. Verified
	// at @base/copy/getCopy.ts, not assumed.
	const template = getCopyOverride(overrideKey, { copyOverrides: context?.copyOverrides ?? null }) ?? fallback;

	return applyTemplate(template, event, {
		displayName: queue.channel.guild.members.cache.get(event.userId)?.displayName ?? null,
		guildName: queue.channel.guild.name,
	});
}

export interface TemplateContext {
	displayName: string | null;
	guildName: string;
}

export function applyTemplate(
	template: string,
	event: Pick<QueuedLevelUp, "userId" | "level" | "xpIntoLevel" | "earnedRoleId">,
	context: TemplateContext
): string {
	const replacements: Record<string, string> = {
		// Renders as a name and notifies nobody, because every send in this file
		// pins allowedMentions to parse [].
		"{user.mention}": `<@${event.userId}>`,
		"{user.name}": context.displayName ?? `<@${event.userId}>`,
		"{user.level}": String(event.level),
		// Progress INTO the level, not the lifetime total. A member who just
		// leveled has almost none, which is the honest number and the one that
		// makes "xp to next" mean anything.
		"{user.xp}": String(event.xpIntoLevel),
		"{guild.name}": context.guildName,
	};

	let rendered = template;
	for (const [tag, value] of Object.entries(replacements)) {
		rendered = rendered.split(tag).join(value);
	}

	// The {earned:...} conditional block. Rendered only when a role landed in the
	// same beat and dropped ENTIRELY otherwise, so a template that mentions a
	// reward still reads correctly for a member who did not get one.
	//
	// ⚠️ The body must tolerate ONE level of nesting, because the whole point of
	// the block is to wrap a {role.mention}. A naive [^}]* stops at that inner
	// closing brace, matches half the block, and leaves a stray "}" in the
	// message with the role tag unreplaced. So the body is "anything that is not
	// a brace, or one complete braced tag", repeated.
	rendered = rendered.replace(/\{earned:((?:[^{}]|\{[^{}]*\})*)\}/g, (_match, body: string) =>
		event.earnedRoleId ? body.split("{role.mention}").join(`<@&${event.earnedRoleId}>`) : ""
	);
	// A guild that never edited the template still gets told about the role, so
	// the reward is never silent just because the default copy predates it.
	if (event.earnedRoleId && !template.includes("{earned:")) {
		rendered += levelingCopy.levelUp.earnedRole(event.earnedRoleId);
	}

	// An UNKNOWN tag is deliberately left verbatim rather than stripped: a typo in
	// an owner's override should read as a typo, not silently delete itself and
	// leave them wondering which word went missing.
	return rendered;
}

// ── channel resolution ─────────────────────────────────────────────────────
// The fallback chain is the second of R16's six mitigations for shipping this on
// by default: announceChannelId is null on every guild that never configured
// leveling, so it falls back to the announcements channel that /setup already
// built. A guild therefore never has to configure anything for the feature to
// have somewhere legitimate to post.
async function resolveAnnounceChannel(
	client: Client,
	guildId: string,
	context: GuildLevelingContext,
	sourceChannelId: string | null
): Promise<TextChannel | null> {
	const settings = context.settings;

	// "current" posts where the xp was earned, when that is knowable. A voice
	// sweep has no channel of its own, so it falls back rather than going silent.
	const targetId =
		settings.announceMode === "current" && sourceChannelId
			? sourceChannelId
			: (settings.announceChannelId ?? context.announcementsChannelId);

	// No configured channel and no homebase announcements channel means setup
	// never finished. A silent bail is correct; autoSetup reaches its own
	// terminal state eventually, same posture as LeaderboardBoard.
	if (!targetId) return null;

	const channel = await client.channels.fetch(targetId).catch(() => null);
	if (!channel || !(channel instanceof TextChannel)) {
		console.warn(LOG_MESSAGES.leveling.announceChannelMissing(targetId, guildId));
		return null;
	}
	return channel;
}

function missingPermissions(channel: TextChannel): string[] {
	const me = channel.guild.members.me;
	if (!me) return [];
	const permissions = channel.permissionsFor(me);
	if (!permissions) return [];
	return REQUIRED_PERMISSIONS.filter((entry) => !permissions.has(entry.flag)).map((entry) => entry.name);
}

// ── the structural half of the never ping rule ─────────────────────────────
function assertNotPingable(): void {
	if (!BOT_CONSTANTS.PINGABLE.has(LEVELING_MESSAGE_KIND)) return;
	// Reaching this means somebody added leveling to the allow list. Loud in
	// development, and still non fatal in production, because a wrongly loud
	// celebration is better than a crashed flush.
	const message = `[leveling] "${LEVELING_MESSAGE_KIND}" was added to BOT_CONSTANTS.PINGABLE. Leveling must never ping (owner decision D3).`;
	if (process.env.NODE_ENV !== "production") throw new Error(message);
	console.error(message);
}

// ── announceAchievements ───────────────────────────────────────────────────
// Achievement unlocks post through THIS module rather than their own, so every
// leveling send in the codebase passes the same never-ping assertion and the
// same permission precheck. A second sender would be a second place to forget
// allowedMentions.
//
// Never throws, and deliberately not coalesced: unlocks are far rarer than level
// ups (a member crosses at most 48 tier thresholds ever), so a burst is not a
// realistic shape and batching them would delay a rare moment for no benefit.
export async function announceAchievements(
	client: Client,
	guildId: string,
	userId: string,
	unlocks: readonly AchievementUnlockEntry[],
	// The stored username, which the unlock card draws when no member is found.
	username?: string
): Promise<void> {
	try {
		if (unlocks.length === 0) return;
		const context = await getLevelingConfig(guildId);
		if (!context || context.homebaseDestroyed) return;
		if (!context.settings.enabled) return;
		// An achievement is not a level, so "milestone" mode (prime levels only)
		// does not suppress it; only "off" does.
		if (context.settings.announceMode === "off") return;

		const channel = await resolveAnnounceChannel(client, guildId, context, null);
		if (!channel) return;

		const missing = missingPermissions(channel);
		if (missing.length > 0) {
			console.warn(LOG_MESSAGES.leveling.announceMissingPermissions(channel.id, guildId, missing.join(", ")));
			return;
		}

		assertNotPingable();
		const member = await resolveCardMember(channel.guild, userId);
		const view: AchievementUnlockView = {
			userId,
			displayName: member?.displayName ?? username ?? "",
			avatar: member ? avatarRequestFor(member.user, ACHIEVEMENT_UNLOCK_AVATAR_SIZE) : null,
			unlocks,
		};
		const card = await withRenderFallback(
			() => renderAchievementUnlockCard(view),
			() => buildAchievementUnlockEmbed(userId, unlocks)
		);
		await channel.send({
			...(isRenderPayload(card)
				? { embeds: [buildAchievementUnlockCardEmbed(userId, unlocks.length, card.ref)], files: [card.attachment] }
				: { embeds: [card] }),
			allowedMentions: NO_MENTIONS,
		});
	} catch (error) {
		console.error(LOG_MESSAGES.leveling.announceFailed(guildId), error);
	}
}

// ── announceRoleUnlock (2026-10 item 243 Phase 4) ──────────────────────────
// The role unlock card, posted once per member and role: roleRewards calls this
// only when a role landed that the member did not already hold, which is what
// "first application" means. It posts through this module for the same reason
// achievements do, one never ping assertion and one permission precheck for
// every leveling send. Same gates as an achievement: only announceMode "off"
// silences it, since a role is not a level.
//
// Never throws. It runs after the role write succeeded, so a failure here must
// not reach roleRewards (convention 7).
export async function announceRoleUnlock(client: Client, guildId: string, userId: string, roleId: string, level: number): Promise<void> {
	try {
		const context = await getLevelingConfig(guildId);
		if (!context || context.homebaseDestroyed) return;
		if (!context.settings.enabled || context.settings.announceMode === "off") return;

		const channel = await resolveAnnounceChannel(client, guildId, context, null);
		if (!channel) return;
		const missing = missingPermissions(channel);
		if (missing.length > 0) {
			console.warn(LOG_MESSAGES.leveling.announceMissingPermissions(channel.id, guildId, missing.join(", ")));
			return;
		}
		const role = channel.guild.roles.cache.get(roleId);
		if (!role) return;

		assertNotPingable();
		const member = await resolveCardMember(channel.guild, userId);
		const view: RoleUnlockView = {
			userId,
			roleId,
			roleName: role.name,
			// A role with no color reports 0 and "#000000", which would ring the face
			// in black on a near black sheet.
			roleColor: role.color === 0 ? (canvasColor(COLORS.LEVEL_MILESTONE) as HexColorString) : role.hexColor,
			level,
			displayName: member?.displayName ?? "",
			avatar: member ? avatarRequestFor(member.user, ROLE_UNLOCK_AVATAR_SIZE) : null,
		};
		const card = await withRenderFallback(
			() => renderRoleUnlockCard(view),
			() => buildRoleUnlockEmbed(view)
		);
		await channel.send({
			...(isRenderPayload(card) ? { embeds: [buildRoleUnlockEmbed(view, card.ref)], files: [card.attachment] } : { embeds: [card] }),
			allowedMentions: NO_MENTIONS,
		});
	} catch (error) {
		console.error(LOG_MESSAGES.leveling.announceFailed(guildId), error);
	}
}

// ── the one time admin notice ──────────────────────────────────────────────
// Leveling ships ON in every guild with no opt in, so without this some admin
// meets the feature for the first time when a member asks what the new messages
// are. Posted to the admin channel on the FIRST level up ever recorded in a
// guild, naming /leveling settings and how to turn it off.
//
// Idempotent through botLogStore, the same mechanism postFeatureAnnouncement
// uses for its per version broadcast, plus an in-memory guard so this costs one
// database read per guild per process rather than one per level up.
const adminNoticeChecked = new Set<string>();

export const _clearAdminNoticeGuard = (): void => adminNoticeChecked.clear();

async function maybePostAdminNotice(client: Client, guildId: string, context: GuildLevelingContext): Promise<void> {
	if (adminNoticeChecked.has(guildId)) return;
	adminNoticeChecked.add(guildId);

	try {
		if (await botLogStore.has(guildId, BOT_LOG_EVENTS.LEVELING_INTRO_SENT)) return;
		if (!context.adminChannelId) return;

		const channel = await client.channels.fetch(context.adminChannelId).catch(() => null);
		if (!channel || !(channel instanceof TextChannel)) return;

		await channel.send({
			content: `**${levelingCopy.adminNotice.title}**\n\n${levelingCopy.adminNotice.body}`,
			allowedMentions: NO_MENTIONS,
		});
		await botLogStore.log(guildId, BOT_LOG_EVENTS.LEVELING_INTRO_SENT, {});
	} catch (error) {
		// Clear the guard so a transient failure retries on the next level up
		// rather than costing this guild its only notice for the life of the
		// process.
		adminNoticeChecked.delete(guildId);
		console.warn(LOG_MESSAGES.leveling.adminNoticeFailed(guildId), error);
	}
}

// ── test seams ──
export const _drainAnnouncerNow = async (channelId: string): Promise<void> => drain(channelId);
export const _queuedChannels = (): string[] => [...queues.keys()];
export const _clearAnnouncerQueues = (): void => {
	for (const queue of queues.values()) clearTimeout(queue.timer);
	queues.clear();
};
