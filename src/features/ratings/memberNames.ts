import type { Guild } from "discord.js";
import type { NameResolver } from "./ratingBoards.js";

// ── memberNames ──────────────────────────────────────────────────────
// Builds the NameResolver the arcade boards rank with (2026-10 item 244 Phase 3b):
// for a list of user ids, the display names of the ones who are still members of
// this guild and are not bots. /rating board, /rating luck and the monthly arcade
// post call it; ratingBoards.ts stays free of discord.js because of it.
//
// Names come from the member cache first and one gateway member request for the
// rest, never one REST call per player. A failed request names nobody it did not
// already have cached, so those players sit out one board rather than failing it.

// The gateway member request waits two minutes by default when Discord never
// answers; a board read by a member mid command should give up long before that.
const MEMBER_FETCH_TIMEOUT_MS = 10_000;

/** A resolver over this guild's current members, cache first. */
export function memberNameResolver(guild: Guild): NameResolver {
	return async (userIds) => {
		const names = new Map<string, string>();
		const uncached: string[] = [];
		for (const userId of userIds) {
			const cached = guild.members.cache.get(userId);
			if (!cached) uncached.push(userId);
			else if (!cached.user.bot) names.set(userId, cached.displayName);
		}
		if (uncached.length === 0) return names;

		try {
			// An array always takes discord.js's many member path, so the answer is a
			// collection even for one id, and ids that left are simply missing from it.
			const fetched = await guild.members.fetch({ user: uncached, time: MEMBER_FETCH_TIMEOUT_MS });
			for (const member of fetched.values()) {
				if (!member.user.bot) names.set(member.id, member.displayName);
			}
		}
		catch (error) {
			console.warn(`[ratings] reading ${uncached.length} member names in guild ${guild.id} failed, so they sit out this board`, error);
		}
		return names;
	};
}
