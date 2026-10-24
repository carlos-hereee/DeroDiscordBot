import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";

// ── authorizer ────────────────────────────────────────────────────────────
// What:  the single rule for who may give Dero a task: the guild owner, a member
//        holding the guild's admin role (GuildConfig.adminRoleId, named by /setup),
//        or a member holding any role on the guild's allowedRoleIds.
// Who:   /dero (before a job is made, and for /dero status), the executor (again,
//        at execution time, against a freshly fetched member), the Hold'em rules
//        card, and the voice listener, turn loop and voice room controls.
// When:  twice per task on purpose. A job can wait up to 20 seconds, and a role
//        removed in that gap must stop the action.
// Where: pure. It reads the Discord member, the stored allowlist and the admin role
//        id the caller read off GuildConfig, and NOTHING the brain sent, which is
//        what "the brain proposes, the bot decides" means in code.
//
// ⚠️ THE ADMIN ROLE AUTHORIZES BY ITSELF (post-launch plan item 12, the owner's
// decision reversing the earlier "admins configure, the allowlist authorizes"
// rule). Owners and admins kept hitting "you are not on the list" on their own
// server. adminRoleId is REQUIRED in the input, not optional, so a new call site
// that forgets it fails to compile instead of silently locking admins out again;
// null is the honest value for a guild that never ran /setup.

/** The slice of a GuildMember the rule needs. A discord.js GuildMember fits it. */
export interface AuthorizableMember {
	id: string;
	guild: { id: string };
	roles: { cache: { has(roleId: string): boolean } };
}

export interface AuthorizeInput {
	member: AuthorizableMember | null;
	guildOwnerId: string;
	// GuildConfig.adminRoleId for the config's guild, null before /setup names one.
	adminRoleId: string | null;
	voiceConfig: Pick<IDeroVoiceConfig, "guildId" | "allowedRoleIds">;
}

/** True when this member may give Dero tasks in the config's guild. */
export function isAuthorizedSpeaker({ member, guildOwnerId, adminRoleId, voiceConfig }: AuthorizeInput): boolean {
	if (!member) return false;
	// A member of another guild never borrows this guild's allowlist, even if a
	// role id collided.
	if (member.guild.id !== voiceConfig.guildId) return false;
	if (member.id === guildOwnerId) return true;
	if (adminRoleId && member.roles.cache.has(adminRoleId)) return true;
	return voiceConfig.allowedRoleIds.some((roleId) => member.roles.cache.has(roleId));
}
