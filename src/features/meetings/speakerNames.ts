import type { Client } from "discord.js";

// ── speakerNames ────────────────────────────────────────────────────────────
// What:  the names a meeting's consenting speakers go by in their server (2026-11 item 388
//        Phase 4): the display name the summary job hands the launcher, and the username an
//        action item may name instead.
// Who:   summaryJobs (the job body's speaker list) and summaryResult (matching an action
//        item's assignee to a speaker).
// Does NOT: read anyone who is not in the list it is given, so a member who never agreed is
//        never named to the launcher.

/** How one speaker is known: the server display name, and the account's username. */
export interface SpeakerName {
	displayName: string;
	username: string | null;
}

/**
 * Resolve each id to its names in `guildId`. A member who left the server falls back to the
 * account's own names; an account Discord no longer returns is left out, and the caller
 * labels it by its speaker label alone.
 */
export async function resolveSpeakerNames(client: Client, guildId: string, userIds: readonly string[]): Promise<Map<string, SpeakerName>> {
	const names = new Map<string, SpeakerName>();
	const guild = client.guilds.cache.get(guildId) ?? null;
	for (const userId of userIds) {
		const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
		if (member) {
			names.set(userId, { displayName: member.displayName, username: member.user.username });
			continue;
		}
		const user = await client.users.fetch(userId).catch(() => null);
		if (user) names.set(userId, { displayName: user.globalName ?? user.username, username: user.username });
	}
	return names;
}

const normalized = (name: string): string => name.trim().toLocaleLowerCase();

/**
 * The speaker an action item's assignee names, matched case insensitively and exactly to a
 * display name or a username (D12). Null for no name, no match, or a name two speakers share,
 * because a guess would hand someone else's task to the wrong member.
 */
export function matchAssignee(assignee: string | null, speakers: ReadonlyMap<string, SpeakerName>): string | null {
	if (!assignee) return null;
	const wanted = normalized(assignee);
	if (!wanted) return null;
	const matches = [...speakers.entries()].filter(([, name]) => normalized(name.displayName) === wanted || (name.username !== null && normalized(name.username) === wanted));
	return matches.length === 1 ? matches[0][0] : null;
}
