import { MessageMentionOptions } from "discord.js";

// ── audience mention builder ─────────────────────────────────────────────
// Single source of truth for the @mention `content` string AND its matching
// `allowedMentions`. The two MUST agree: Discord only actually pings a role that
// is BOTH named in `content` and whitelisted in `allowedMentions`, and a loose
// `allowedMentions` is exactly how a malicious event note or announcement body
// could smuggle an @everyone. Returning both from one place means a call site
// cannot let them drift (the bug this guards against was real: the ping content
// and the whitelist were maintained as two parallel expressions at every site).
//
// Audience model (chosen by the owner 2026-06-29, "mention both roles"): an
// explicit override targets exactly that one role, a deliberate narrow audience
// (a stream-notif or leadership role), so we do NOT broaden it. Otherwise the
// default audience is the guild member role PLUS the opt-in "🔔 Announcements"
// role (notificationsRoleId, self-assigned via the Toggle pings power-up),
// deduped. So opting in ADDS you to the ping without removing the whole-member
// reach, and a guild that never created the opt-in role (null) pings exactly the
// member role as before. An empty set (legacy guild with neither role) falls
// back to @here.
export function buildAudienceMention(opts: {
	overrideRoleId?: string | null;
	memberRoleId?: string | null;
	notificationsRoleId?: string | null;
}): { content: string; allowedMentions: MessageMentionOptions } {
	const { overrideRoleId, memberRoleId, notificationsRoleId } = opts;

	// Override wins outright (deliberate narrow target). Otherwise member role +
	// opt-in role, deduped via Set so an accidental equality (notificationsRoleId
	// === memberRoleId) is never mentioned twice.
	const roleIds = overrideRoleId
		? [overrideRoleId]
		: [...new Set([memberRoleId, notificationsRoleId].filter((id): id is string => Boolean(id)))];

	// No role to ping (legacy guild predating /setup requiring a member role).
	if (roleIds.length === 0) {
		return { content: "@here", allowedMentions: { parse: ["everyone"] } };
	}

	return {
		content: roleIds.map((id) => `<@&${id}>`).join(" "),
		allowedMentions: { roles: roleIds },
	};
}
