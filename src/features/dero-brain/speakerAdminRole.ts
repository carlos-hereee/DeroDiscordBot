import { guildConfigStore } from "@db/stores/guildConfigStore.js";

// ── speakerAdminRole ──────────────────────────────────────────────────────
// What:  the guild's admin role id, read for isAuthorizedSpeaker (post-launch plan
//        item 12: the admin role may give Dero tasks without being on the list).
// Who:   every authorizer call site: /dero, the executor, the Hold'em rules card,
//        the voice listener and turn loop, and the voice room controls.
// When:  per check, uncached. Each caller already reads the voice config per check,
//        and a cache here would let a role an owner just demoted keep authorizing
//        for its lifetime, which is the gap the authorizer's double check exists to close.
// How:   a failed read answers null, so a database hiccup FAILS CLOSED to the
//        allowlist and the owner check rather than opening the gate or throwing into
//        a voice turn.

/** GuildConfig.adminRoleId for this guild, or null when there is none or it cannot be read. */
export async function readSpeakerAdminRoleId(guildId: string): Promise<string | null> {
	try {
		const config = await guildConfigStore.findByGuildId(guildId);
		return (config as unknown as { adminRoleId?: string | null } | null)?.adminRoleId ?? null;
	} catch (error) {
		console.warn(`[dero-brain] reading the admin role for guild ${guildId} failed; checking the allowlist only`, error);
		return null;
	}
}
