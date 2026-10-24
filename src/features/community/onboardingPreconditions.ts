import { ChannelType, PermissionFlagsBits, type Guild, type Role } from "discord.js";
import { communityCopy } from "./communityCopy.js";
import { isCommunityEnabled } from "./enableCommunity.js";

// ── onboardingPreconditions ──────────────────────────────────────────
// What:  the checks Configure Onboarding runs before it drafts anything and again
//        before Confirm writes (2026-10 item 247 Phase 4): Community on, Dero able to
//        edit Onboarding, a member role Dero can hand out, and the channels Discord
//        insists on. Pure reads of the cached guild; nothing here fetches or writes.
// Who:   configureOnboarding, on the Configure Onboarding press and on Confirm;
//        onboardingDraft reuses isRoleBelowBot and everyoneSendableChannelIds so the
//        draft's own checks and its default channels agree with these.
// When:  every press. A refusal is a plain sentence for the owner; the caller audits it.
// How:   the clauses run in a fixed order and the first that fails is the answer,
//        so the owner fixes one thing at a time, in the order Discord would complain.

// ── constants ────────────────────────────────────────────────────────

/**
 * Discord's Onboarding rule (developer docs, Guild Onboarding constraints): at
 * least 5 default channels must let @everyone send messages. Discord also asks for
 * 7 default channels in all, which Advanced mode counts with the questions; this
 * plan checks only the 5, and a refusal on the 7 comes back verbatim at Confirm.
 */
export const MIN_EVERYONE_SENDABLE_CHANNELS = 5;

// The channel kinds a member can post in and Onboarding can list as a default.
// Threads and voice text chats are left out on purpose: neither can be a default
// channel, so counting them would pass a server Discord then refuses.
const SENDABLE_CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum]);

// Discord's Modify Guild Onboarding needs both (developer docs). has() counts
// Administrator as every flag, so an Administrator Dero always passes.
const REQUIRED_BOT_PERMISSIONS = [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles] as const;

// ── types ────────────────────────────────────────────────────────────

/** The stored GuildConfig fields the checks read. */
export interface IOnboardingPreconditionConfig {
	memberRoleId?: string | null;
}

/** Which clause refused, for the audit row and the tests. */
export type OnboardingPreconditionCode =
	| "community-off"
	| "permissions-unreadable"
	| "missing-permissions"
	| "no-member-role"
	| "member-role-everyone"
	| "member-role-gone"
	| "member-role-above-bot"
	| "too-few-sendable-channels";

/** Either every clause passed, or the first one that did not, with the sentence the owner reads. */
export type OnboardingPreconditionResult = { ok: true } | { ok: false; code: OnboardingPreconditionCode; reason: string };

// ── shared reads ─────────────────────────────────────────────────────

/** True when the role sits below Dero's highest role, which is what lets Discord hand it out on Dero's say so. */
export function isRoleBelowBot(guild: Guild, role: Pick<Role, "position">): boolean {
	const highest = guild.members.me?.roles.highest;
	return highest !== undefined && role.position < highest.position;
}

/**
 * The text, announcement and forum channels where @everyone can both see and send,
 * from the RESOLVED permissions (the @everyone role's own bits plus every overwrite),
 * not from Dero's channel list: the server's own channels count as much as Dero's,
 * and on a Community server Dero's gated channels count for nothing.
 */
export function everyoneSendableChannelIds(guild: Guild): string[] {
	const everyone = guild.roles.everyone;
	const sendable: string[] = [];
	for (const channel of guild.channels.cache.values()) {
		if (!SENDABLE_CHANNEL_TYPES.has(channel.type)) continue;
		if (channel.permissionsFor(everyone)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) sendable.push(channel.id);
	}
	return sendable;
}

// ── the check ────────────────────────────────────────────────────────

/** Run every clause, in order, against the cached guild and the stored config. */
export function checkOnboardingPreconditions(guild: Guild, stored: IOnboardingPreconditionConfig): OnboardingPreconditionResult {
	const copy = communityCopy.onboarding.preconditions;

	// ① Onboarding is a Community feature; without it Discord refuses every write.
	if (!isCommunityEnabled(guild)) return refuse("community-off", copy.communityOff);

	// ② Dero's own member is cached for every guild it is in; a miss is a cold cache
	// worth a retry, not a missing permission, so it gets its own sentence.
	const me = guild.members.me;
	if (!me) return refuse("permissions-unreadable", communityCopy.errors.permissionsUnreadable);
	if (!REQUIRED_BOT_PERMISSIONS.every((flag) => me.permissions.has(flag))) return refuse("missing-permissions", copy.missingPermissions);

	// ③ The final question hands out the member role, so there has to be a real one.
	// /setup's picker allows @everyone, and a stored id can outlive its role; both
	// would make Discord refuse the write, so both are named here instead.
	const memberRoleId = stored.memberRoleId;
	if (!memberRoleId) return refuse("no-member-role", copy.noMemberRole);
	if (memberRoleId === guild.roles.everyone.id) return refuse("member-role-everyone", copy.memberRoleIsEveryone);
	const memberRole = guild.roles.cache.get(memberRoleId);
	if (!memberRole) return refuse("member-role-gone", copy.memberRoleGone);

	// ④ Discord only assigns roles below the editor's highest, the same hierarchy
	// rule as Manage Roles itself.
	if (!isRoleBelowBot(guild, memberRole)) return refuse("member-role-above-bot", copy.memberRoleAboveBot(memberRole.name));

	// ⑤ Last because it is the one most often fixed by adding channels, and the
	// count it names is only meaningful once everything above is settled.
	const sendableCount = everyoneSendableChannelIds(guild).length;
	if (sendableCount < MIN_EVERYONE_SENDABLE_CHANNELS) {
		return refuse("too-few-sendable-channels", copy.tooFewSendableChannels(sendableCount, MIN_EVERYONE_SENDABLE_CHANNELS));
	}
	return { ok: true };
}

function refuse(code: OnboardingPreconditionCode, reason: string): OnboardingPreconditionResult {
	return { ok: false, code, reason };
}
