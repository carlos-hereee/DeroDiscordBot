import type { Client, Guild } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import type { NameResolver } from "./ratingBoards.js";

// ── memberNames ──────────────────────────────────────────────────────
// Builds the NameResolver the arcade boards rank with (2026-10 item 244 Phase 3b):
// for a list of user ids, the display names of the ones who are still members of
// this guild and are not bots. /rating board, /rating luck and the monthly arcade
// post call it; ratingBoards.ts stays free of discord.js because of it. The network
// scope boards (Phase 5b) use networkNameResolver instead, over consenting players
// wherever they play.
//
// Names come from the member cache first and one gateway member request for the
// rest, never one REST call per player. A failed request names nobody it did not
// already have cached, so those players sit out one board rather than failing it.

// The gateway member request waits two minutes by default when Discord never
// answers; a board read by a member mid command should give up long before that.
const MEMBER_FETCH_TIMEOUT_MS = 10_000;

/**
 * A resolver over every consenting player on the network (2026-10 item 244 Phase 5b),
 * for the network scope boards: a player's Discord display name, plus the server tag
 * they wear when they show one, the way a network table names them. Not escaped: the
 * board escapes every name it prints. A bot, or a user Discord cannot find, is absent,
 * so they sit out the board like a departed member does on a server board.
 *
 * Cache first, then one REST read per uncached player. The boards ask for one board's
 * length at a time (ratingBoards.keepCurrentMembers), so that is at most ten reads.
 */
export function networkNameResolver(client: Client): NameResolver {
	return async (userIds) => {
		const names = new Map<string, string>();
		for (const userId of userIds) {
			const user = client.users.cache.get(userId) ?? (await client.users.fetch(userId).catch(() => null));
			if (!user || user.bot) continue;
			const identity = user.primaryGuild;
			const tag = identity?.identityEnabled && identity.tag ? identity.tag : null;
			names.set(userId, rokCommanderCopy.arcadeSatellites.playerLabel(user.displayName, tag));
		}
		return names;
	};
}

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
