import type { Client } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── networkXp ────────────────────────────────────────────────────────
// What:  where a Hold'em player's XP lands at a network table (owner decision
//        2026-10-23 in chat, after 2026-10 item 244 Phase 5a, revised the same day;
//        built in Phase 5b). The answer is a guild and, when that guild has one, the
//        channel the level up announcement may use.
// Who:   roomHoldemHandlers' two Hold'em awards, the per hand award in settleOutcome
//        and the placement award in payPlacements. Nothing else at a network table pays
//        XP per player: finish's room rate top up stays with the host room's own rules.
// Does NOT: award anything (awardXp does), or decide how much (the callers do).
//
// The rule, per player:
//   ① a player of the HOST server keeps the host server and the host room's channel;
//   ② a player seated through a satellite earns in the server whose tag they WEAR
//      (primaryGuild.identityGuildId with identityEnabled true) when Dero is in that
//      server, with no channel, since the table has none there;
//   ③ otherwise (no tag, a hidden tag, or Dero is not in their tag's server) they earn
//      in the server they clicked from, their satellite's guild, with the satellite's
//      channel.
//
// ⚠️ THE TAG IS READ WHEN THE XP IS AWARDED, NOT WHEN THEY SAT DOWN (the owner's rule):
// a player who changes their tag mid tournament earns the next hand for the new one.
// It reads the client's user cache first, which the gateway keeps current for every
// member Dero shares a server with, and asks Discord only when the user is not cached.

/** Where one award lands. A null channel announces nowhere in particular, as awardXp allows. */
export interface XpDestination {
	guildId: string;
	channelId: string | null;
}

/** The slice of a room row the resolver reads. */
export type XpRoom = Pick<IGameRoom, "guildId" | "channelId" | "satellites">;

/**
 * The host room's destination when no satellite seats `userId`, without any lookup, or
 * null when they play through a satellite and the tag decides. A player no satellite
 * seats is a host server player. That includes a remote player already seated out (they
 * left their server, it removed Dero, or the channel went): their satellite no longer
 * lists them, so their last placement stays with the host, as every award did before
 * network tables. Synchronous so an ordinary table pays exactly when it always did.
 */
export function hostDestinationFor(room: XpRoom, userId: string): XpDestination | null {
	if ((room.satellites ?? []).some((entry) => entry.userIds.includes(userId))) return null;
	return { guildId: room.guildId, channelId: room.channelId };
}

/** Where `userId`'s Hold'em XP lands at this table, by the rule in the header. */
export async function resolveHoldemXpDestination(client: Client, room: XpRoom, userId: string): Promise<XpDestination> {
	// ①
	const local = hostDestinationFor(room, userId);
	if (local) return local;
	const host: XpDestination = { guildId: room.guildId, channelId: room.channelId };
	const satellite = (room.satellites ?? []).find((entry) => entry.userIds.includes(userId));
	if (!satellite) return host;

	const tagGuildId = await wornTagGuildId(client, userId);
	// ② Their tag's server, when Dero is there to keep the record. The host server and the
	// satellite's server keep their own channels; any other server has no table channel.
	if (tagGuildId && client.guilds.cache.has(tagGuildId)) {
		if (tagGuildId === room.guildId) return host;
		return { guildId: tagGuildId, channelId: tagGuildId === satellite.guildId ? satellite.channelId : null };
	}
	// ③ The server they clicked from.
	return { guildId: satellite.guildId, channelId: satellite.channelId };
}

// The server whose tag the player wears and shows, or null. A lookup that fails reads as
// no tag, so the award falls back to the server they clicked from rather than failing.
async function wornTagGuildId(client: Client, userId: string): Promise<string | null> {
	const user = client.users.cache.get(userId) ?? (await client.users.fetch(userId).catch(() => null));
	const identity = user?.primaryGuild;
	if (!identity?.identityEnabled || !identity.identityGuildId) return null;
	return identity.identityGuildId;
}
