import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";

// ── authorizer ────────────────────────────────────────────────────────────
// What:  the single rule for who may give Dero a task: the guild owner, or a
//        member holding any role on the guild's allowedRoleIds.
// Who:   /dero (before a job is made, and for /dero status) and the executor
//        (again, at execution time, against a freshly fetched member).
// When:  twice per task on purpose. A job can wait up to 20 seconds, and a role
//        removed in that gap must stop the action.
// Where: pure. It reads the Discord member and the stored allowlist and NOTHING
//        the brain sent, which is what "the brain proposes, the bot decides"
//        means in code.
//
// ⚠️ THE ADMIN ROLE DOES NOT AUTHORIZE BY ITSELF. Admins configure Dero; being
// one is not a standing permission to make Dero post. An admin who should give
// tasks puts a role on the allowlist like anyone else (owner decision).

/** The slice of a GuildMember the rule needs. A discord.js GuildMember fits it. */
export interface AuthorizableMember {
	id: string;
	guild: { id: string };
	roles: { cache: { has(roleId: string): boolean } };
}

export interface AuthorizeInput {
	member: AuthorizableMember | null;
	guildOwnerId: string;
	voiceConfig: Pick<IDeroVoiceConfig, "guildId" | "allowedRoleIds">;
}

/** True when this member may give Dero tasks in the config's guild. */
export function isAuthorizedSpeaker({ member, guildOwnerId, voiceConfig }: AuthorizeInput): boolean {
	if (!member) return false;
	// A member of another guild never borrows this guild's allowlist, even if a
	// role id collided.
	if (member.guild.id !== voiceConfig.guildId) return false;
	if (member.id === guildOwnerId) return true;
	return voiceConfig.allowedRoleIds.some((roleId) => member.roles.cache.has(roleId));
}
