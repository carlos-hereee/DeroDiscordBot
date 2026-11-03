import { PermissionFlagsBits, PermissionsBitField, type Guild, type PermissionOverwriteOptions, type TextChannel, type VoiceChannel } from "discord.js";
import { buildBotSelfOverwrite } from "@utils/channelOverwrites.js";

// ── communityOverwrites ──────────────────────────────────────────────
// What:  the ONE home of every permission overwrite shape a managed channel
//        gets (public text, introductions, admin, voice), plus the boot
//        reconcile that moves an existing channel onto its shape when the
//        guild's Discord Community state changes (2026-10 item 247 Phase 1).
//        It never gives a member a role: Discord Onboarding does that.
// Who:   GuildSetupManager: createChannels (fresh install and forced rebuild),
//        buildSingleChannel (every repair, so ChannelDeleteWatcher too),
//        applyAdminRole (the member role grant) and ensureHomebase (the
//        reconcile, every boot).
// When:  the branch is read LIVE from guild.features on every call and never
//        cached, because an owner can switch Community on at any moment and
//        the next repair or boot has to see it.
// Where: beside its only consumer. The bot's own entry still comes from
//        @utils/channelOverwrites, the list game rooms share.
// How:   on a Community guild whose /setup named a member role, @everyone
//        loses ViewChannel on the public text channels and on both voice rooms
//        and the member role gets it back, so someone who has not finished
//        Onboarding sees only introductions. Every other guild gets exactly the
//        shapes it got before this module existed. Introductions and the admin
//        channels read the same either way.

// ── kinds and inputs ─────────────────────────────────────────────────

/** Which overwrite shape a managed channel takes. CHANNEL_SPECS' kind, with introductions split out of "public". */
// "adminLog" is the bot write only audit channel (post-launch plan item 11).
// "commandOutput" is 💬dero-commands, the public channel members also write in
// (2026-10 item 257 Phase 2a).
export type ManagedOverwriteKind = "public" | "intro" | "admin" | "adminLog" | "voice" | "commandOutput";

/** One overwrite entry, in the form guild.channels.create and permissionOverwrites.set both accept. */
export interface IOverwriteEntry {
	id: string;
	allow?: bigint[];
	deny?: bigint[];
}

export interface IOverwriteOwner {
	ownerId: string;
}

/** The roles /setup names. Both null on a fresh install and on a legacy row that never ran it. */
export interface IOverwriteRoles {
	memberRoleId: string | null;
	adminRoleId: string | null;
}

// ── constants ────────────────────────────────────────────────────────

const { ViewChannel, SendMessages, ReadMessageHistory, Connect, Speak } = PermissionFlagsBits;
const JOIN_AND_SPEAK = [ViewChannel, Connect, Speak];
const COMMUNITY_FEATURE = "COMMUNITY";

// The member role's allow on the kinds it is granted on, shared by the shapes
// below and by memberRoleGrant, so /setup's grant and a rebuilt channel's entry
// cannot disagree.
const MEMBER_VOICE_ALLOW = JOIN_AND_SPEAK;
const MEMBER_GATED_TEXT_ALLOW = [ViewChannel];
// 💬dero-commands is where members run commands, so a gated member role sends there too.
const MEMBER_GATED_CHAT_ALLOW = [ViewChannel, SendMessages];

// The admin role's allow on each text kind, layered on once /setup has named it.
// applyAdminRole keeps its own option-form copy of these two (left as it was by
// the plan's decision), so a change here is a change there too.
const ADMIN_TEXT_ALLOW = [ViewChannel, SendMessages];
const ADMIN_PRIVATE_ALLOW = [ViewChannel, SendMessages, ReadMessageHistory];
// The audit channel's read only grant: admins and the owner read it, nobody but the
// bot writes, so the trail cannot be padded or answered in place. applyAdminRole
// keeps its option-form copy beside the other two.
const ADMIN_LOG_READ_ALLOW = [ViewChannel, ReadMessageHistory];
const ADMIN_LOG_WRITE_DENY = [SendMessages];
const ADMIN_VOICE_ALLOW = [...JOIN_AND_SPEAK, SendMessages];

// ── the branch ───────────────────────────────────────────────────────

/** True when the member role gates this guild's public channels right now. */
export function isMemberRoleGated(guild: Guild, memberRoleId: string | null | undefined): boolean {
	// A real Guild always carries the array; a partial one (a guild payload not yet
	// hydrated, a test fake) has none, and the open shape is the safe reading.
	if (!(guild.features ?? []).includes(COMMUNITY_FEATURE)) return false;
	// No member role (before /setup) would leave nobody able to see in, and a member
	// role that IS @everyone (the /setup picker allows it) gates nothing. Both keep
	// the open shape rather than locking a server out of its own channels.
	return Boolean(memberRoleId) && memberRoleId !== guild.roles.everyone.id;
}

/** The overwrite kind a CHANNEL_SPECS row takes: its own, except introductions, the one public channel members may write in. */
export function overwriteKindOf(spec: { configField: string; kind: "public" | "admin" | "adminLog" | "voice" }): ManagedOverwriteKind {
	if (spec.configField === "introChannelId") return "intro";
	// 💬dero-commands is a "public" spec everywhere a spec's kind is read (the admin
	// grant, the visibility list), but it is the one public channel members may send in.
	if (spec.configField === "commandOutputChannelId") return "commandOutput";
	return spec.kind;
}

/** Whether a kind's shape changes with the Community branch. Introductions and the admin channels read the same either way. */
export function dependsOnCommunityState(kind: ManagedOverwriteKind): boolean {
	return kind === "public" || kind === "voice" || kind === "commandOutput";
}

// ── the shapes ───────────────────────────────────────────────────────
// Every shape carries the bot's own entry. Without it an @everyone deny reaches
// the bot through its @everyone membership: a SendMessages deny suppresses its
// own posts and a ViewChannel deny hides the channel from it, and both surface
// at post time, long after the create reported success. guild.client.user is
// asserted non-null because every caller runs after login (guildCreate, the boot
// sweep, a delete event), and the User on the Client is populated before any of
// them, unlike guild.members.me on the very first tick of guildCreate.

/** The member-facing text channels other than introductions: read only for members, hidden from everyone without the member role on a gated guild. */
export function publicCommunityOverwrites(guild: Guild, config: IOverwriteOwner, roles: IOverwriteRoles): IOverwriteEntry[] {
	const gated = isMemberRoleGated(guild, roles.memberRoleId);
	// The gated @everyone entry keeps its SendMessages deny. Dropping it would let
	// the member role's ViewChannel grant fall through to the guild-wide base
	// permission, which allows sending in almost every server, so the read only
	// channels would quietly open to chatter.
	const everyone: IOverwriteEntry = gated
		? { id: guild.roles.everyone.id, deny: [ViewChannel, SendMessages] }
		: { id: guild.roles.everyone.id, allow: [ViewChannel], deny: [SendMessages] };
	const overwrites: IOverwriteEntry[] = [
		everyone,
		buildBotSelfOverwrite(guild.client.user!.id),
		{ id: config.ownerId, allow: [ViewChannel, SendMessages] },
	];
	if (gated) grant(overwrites, roles.memberRoleId!, MEMBER_GATED_TEXT_ALLOW);
	if (roles.adminRoleId) grant(overwrites, roles.adminRoleId, ADMIN_TEXT_ALLOW);
	return overwrites;
}

/** Introductions: open to @everyone on every guild, because it is where a newcomer answers the greeter and clears Onboarding. */
export function introCommunityOverwrites(guild: Guild, config: IOverwriteOwner, roles: IOverwriteRoles): IOverwriteEntry[] {
	const overwrites: IOverwriteEntry[] = [
		{ id: guild.roles.everyone.id, allow: [ViewChannel, SendMessages] },
		buildBotSelfOverwrite(guild.client.user!.id),
		{ id: config.ownerId, allow: [ViewChannel, SendMessages] },
	];
	if (roles.adminRoleId) grant(overwrites, roles.adminRoleId, ADMIN_TEXT_ALLOW);
	return overwrites;
}

/**
 * 💬dero-commands (2026-10 item 257 Phase 2a): the member facing channel members also
 * write in, because they run their commands there. Open to everyone on an ungated
 * guild; on a gated one, hidden from everyone without the member role, like every
 * public channel, so a newcomer who has not finished Onboarding sees only introductions.
 */
export function commandOutputCommunityOverwrites(guild: Guild, config: IOverwriteOwner, roles: IOverwriteRoles): IOverwriteEntry[] {
	const gated = isMemberRoleGated(guild, roles.memberRoleId);
	const everyone: IOverwriteEntry = gated
		? { id: guild.roles.everyone.id, deny: [ViewChannel] }
		: { id: guild.roles.everyone.id, allow: [ViewChannel, SendMessages] };
	const overwrites: IOverwriteEntry[] = [everyone, buildBotSelfOverwrite(guild.client.user!.id), { id: config.ownerId, allow: [ViewChannel, SendMessages] }];
	if (gated) grant(overwrites, roles.memberRoleId!, MEMBER_GATED_CHAT_ALLOW);
	if (roles.adminRoleId) grant(overwrites, roles.adminRoleId, ADMIN_TEXT_ALLOW);
	return overwrites;
}

/** The admin channels and 🏰 DERO HEADQUARTERS itself: hidden from @everyone on every guild. */
export function adminCommunityOverwrites(guild: Guild, config: IOverwriteOwner, roles: IOverwriteRoles): IOverwriteEntry[] {
	const overwrites: IOverwriteEntry[] = [
		{ id: guild.roles.everyone.id, deny: [ViewChannel] },
		buildBotSelfOverwrite(guild.client.user!.id),
		{ id: config.ownerId, allow: [ViewChannel, SendMessages, ReadMessageHistory] },
	];
	if (roles.adminRoleId) grant(overwrites, roles.adminRoleId, ADMIN_PRIVATE_ALLOW);
	return overwrites;
}

/**
 * 🗒️admin-log (post-launch plan item 11): hidden from @everyone like the admin
 * channels, readable by the owner and the admin role, and writable by the bot alone.
 * The SendMessages deny on the owner and admin role is explicit rather than a missing
 * allow, because a server's own permissions can otherwise grant it through the role.
 * A member holding Administrator still bypasses every overwrite; Discord allows no
 * channel to refuse one.
 */
export function adminLogCommunityOverwrites(guild: Guild, config: IOverwriteOwner, roles: IOverwriteRoles): IOverwriteEntry[] {
	const overwrites: IOverwriteEntry[] = [
		{ id: guild.roles.everyone.id, deny: [ViewChannel, SendMessages] },
		buildBotSelfOverwrite(guild.client.user!.id),
		{ id: config.ownerId, allow: ADMIN_LOG_READ_ALLOW, deny: ADMIN_LOG_WRITE_DENY },
	];
	if (!roles.adminRoleId) return overwrites;
	// Replaced rather than appended when the id is already present, as grant() does, so
	// an admin role picked as @everyone yields one entry rather than a rejected pair.
	const adminEntry: IOverwriteEntry = { id: roles.adminRoleId, allow: ADMIN_LOG_READ_ALLOW, deny: ADMIN_LOG_WRITE_DENY };
	const index = overwrites.findIndex((entry) => entry.id === adminEntry.id);
	if (index === -1) overwrites.push(adminEntry);
	else overwrites[index] = adminEntry;
	return overwrites;
}

/**
 * Both voice rooms (2026-10 item 235, owner decision D3, member role only): @everyone
 * may not connect or speak, and on a gated guild may not see the room either. The
 * member role, the owner and the admin role can join.
 */
export function voiceCommunityOverwrites(guild: Guild, config: IOverwriteOwner, roles: IOverwriteRoles): IOverwriteEntry[] {
	const gated = isMemberRoleGated(guild, roles.memberRoleId);
	const bot = buildBotSelfOverwrite(guild.client.user!.id);
	const overwrites: IOverwriteEntry[] = [
		gated
			? { id: guild.roles.everyone.id, deny: [ViewChannel, Connect, Speak] }
			: { id: guild.roles.everyone.id, allow: [ViewChannel], deny: [Connect, Speak] },
		// Connect and Speak on top of the shared self overwrite, or the @everyone
		// Connect deny reaches the bot through its @everyone membership and a room an
		// admin later allowlists through /dero-config gives a join that silently waits
		// out its timeout. Holding the bit listens to nothing: the voice feature gates that.
		{ id: bot.id, allow: [...bot.allow, Connect, Speak] },
		{ id: config.ownerId, allow: JOIN_AND_SPEAK },
	];
	// Granted on every guild, gated or not: without it nobody but the owner and the
	// admin role could join. A member role that IS @everyone replaces the Connect deny
	// above (see grant), which opens the room to all, as the picker intends.
	if (roles.memberRoleId) grant(overwrites, roles.memberRoleId, MEMBER_VOICE_ALLOW);
	if (roles.adminRoleId) grant(overwrites, roles.adminRoleId, ADMIN_VOICE_ALLOW);
	return overwrites;
}

/**
 * 🏰 DERO HEADQUARTERS itself (2026-10 item 257 Phase 2a): the admin channels' shape
 * on the category, so the category is hidden from members too, with ONE departure.
 * The bot's entry here is view, send and read history only, not the shared self
 * overwrite: runAutoSetup's category comment records a category create that refused
 * with 50013 when its bot entry carried Manage Roles and Manage Channels. The bot's
 * ViewChannel allow is still required, or the @everyone deny reaches it through its
 * @everyone membership and every child create under the category fails.
 */
export function headquartersCategoryOverwrites(guild: Guild, config: IOverwriteOwner, roles: IOverwriteRoles): IOverwriteEntry[] {
	const botId = guild.client.user!.id;
	return adminCommunityOverwrites(guild, config, roles).map((entry) => (entry.id === botId ? { id: botId, allow: ADMIN_PRIVATE_ALLOW } : entry));
}

/** The shape for any kind; the one call the create, repair and reconcile paths share. */
export function communityOverwritesFor(kind: ManagedOverwriteKind, guild: Guild, config: IOverwriteOwner, roles: IOverwriteRoles): IOverwriteEntry[] {
	switch (kind) {
		case "public":
			return publicCommunityOverwrites(guild, config, roles);
		case "intro":
			return introCommunityOverwrites(guild, config, roles);
		case "admin":
			return adminCommunityOverwrites(guild, config, roles);
		case "adminLog":
			return adminLogCommunityOverwrites(guild, config, roles);
		case "voice":
			return voiceCommunityOverwrites(guild, config, roles);
		case "commandOutput":
			return commandOutputCommunityOverwrites(guild, config, roles);
	}
}

/**
 * The member role's own overwrite on one managed channel, in the option form
 * permissionOverwrites.create takes (applyAdminRole), or null where it gets none:
 * always on a voice room, on a public text channel only while the member role gates it.
 */
export function memberRoleGrant(guild: Guild, kind: ManagedOverwriteKind, memberRoleId: string): PermissionOverwriteOptions | null {
	if (kind === "voice") return allowOptions(MEMBER_VOICE_ALLOW);
	if (kind === "public" && isMemberRoleGated(guild, memberRoleId)) return allowOptions(MEMBER_GATED_TEXT_ALLOW);
	if (kind === "commandOutput" && isMemberRoleGated(guild, memberRoleId)) return allowOptions(MEMBER_GATED_CHAT_ALLOW);
	return null;
}

// ── the boot reconcile ───────────────────────────────────────────────

/**
 * Move one existing managed channel onto the shape its kind takes for the guild's
 * CURRENT Community state. Resolves true when it wrote, false when the channel was
 * already there (no API call). Throws what Discord throws, so the caller can count it.
 */
export async function reconcileChannelOverwrite(
	guild: Guild,
	channel: TextChannel | VoiceChannel,
	kind: ManagedOverwriteKind,
	stored: { memberRoleId?: string | null; adminRoleId?: string | null }
): Promise<boolean> {
	if (!dependsOnCommunityState(kind)) return false;

	const roles = { memberRoleId: stored.memberRoleId ?? null, adminRoleId: stored.adminRoleId ?? null };
	const gated = isMemberRoleGated(guild, roles.memberRoleId);
	const current = channel.permissionOverwrites.cache;
	if (isOnBranch(current, guild.roles.everyone.id, roles.memberRoleId, gated)) return false;

	// Dero's own entries are replaced with the resolved shape; every other entry
	// (a role an owner added by hand) is carried over untouched. A bare set() of the
	// shape alone would delete those on every guild the first time it gated.
	const desired = communityOverwritesFor(kind, guild, { ownerId: guild.ownerId }, roles);
	const managedIds = new Set(desired.map((entry) => entry.id));
	const foreign = [...current.values()].filter((overwrite) => !managedIds.has(overwrite.id));
	await channel.permissionOverwrites.set([...desired, ...foreign]);
	return true;
}

// ── helpers ──────────────────────────────────────────────────────────

// Replace, never append, when an id is already present. Two overwrites with one id
// fight each other: a member role that IS @everyone has to REPLACE the @everyone
// entry, and an admin role that doubles as the member role ends on the wider grant.
function grant(overwrites: IOverwriteEntry[], id: string, allow: bigint[]): void {
	const index = overwrites.findIndex((entry) => entry.id === id);
	if (index === -1) overwrites.push({ id, allow });
	else overwrites[index] = { id, allow };
}

// Whether a channel already sits on the requested side of the branch, read from the
// two entries the branch decides: @everyone's ViewChannel and the member role's.
// Deliberately NOT a full comparison of every entry. That would rewrite, on every
// boot, any channel whose other bits an owner tuned by hand (or whose bot entry
// predates a newer self overwrite), which would change non-Community guilds that
// this phase must leave exactly as they are. A channel only moves when its side of
// the branch is wrong, and then it moves onto the whole resolved shape.
function isOnBranch(
	current: ReadonlyMap<string, { allow: Readonly<PermissionsBitField>; deny: Readonly<PermissionsBitField> }>,
	everyoneId: string,
	memberRoleId: string | null,
	gated: boolean
): boolean {
	const everyoneHidden = current.get(everyoneId)?.deny.has(ViewChannel, false) ?? false;
	if (!gated) return !everyoneHidden;
	const memberSees = memberRoleId ? (current.get(memberRoleId)?.allow.has(ViewChannel, false) ?? false) : false;
	return everyoneHidden && memberSees;
}

// Bit flags to the { ViewChannel: true, ... } form permissionOverwrites.create takes.
function allowOptions(bits: bigint[]): PermissionOverwriteOptions {
	const options: PermissionOverwriteOptions = {};
	for (const name of new PermissionsBitField(bits).toArray()) options[name] = true;
	return options;
}
