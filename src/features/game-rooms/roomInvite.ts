import type { Client, TextChannel } from "discord.js";
import { effectiveSpectatorMode } from "./roomPermissions.js";
import type { RoomVisibility, SpectatorMode } from "./roomTypes.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomInvite ───────────────────────────────────────────────────────
// What:  the life of a room's server invite (2026-10 item 254, Arcade 10): whether a room
//        gets one, minting it at open, and deleting it the moment the match finishes.
// Who:   RoomProvisioner.seedRoom mints (a first match and a rematch alike, so a rematch
//        follows the same rule as an open); roomLifecycle.finish revokes, after it has
//        persisted and locked.
// Does NOT: write the room row or any clock. The code rides the row because seedRoom's
//        own status write stores it; revoking leaves the row exactly as it was, so this
//        module can never become a third writer of archiveAt or slow a finish down.
//
// ⚠️ A GUILD INVITE, NOT A ROOM GRANT. The link brings a stranger into the SERVER pointing
// at the room; it touches no permission overwrite. So only a room EVERYONE may watch gets
// one: a link into a channel the newcomer cannot see would be a lie in URL form, and an
// unlimited link that outlived its match would keep letting anybody into the whole server
// for as long as the channel stood (up to four hours after the match, or days for a
// Monopoly match). Hence one for a public room open to spectators, deleted at finish, and
// none for an invite only room, a solo room or a room the host closed to spectators.

/**
 * Whether a room of this visibility and spectator setting gets an invite link: a public
 * room everyone may watch, and nothing else.
 */
export function roomTakesInvite(visibility: RoomVisibility, spectatorMode: SpectatorMode | null | undefined): boolean {
	return visibility === "public" && effectiveSpectatorMode(visibility, spectatorMode) === "open";
}

/**
 * Mint the room's invite and answer its code, or null when the room takes none or the
 * mint failed. Never throws: the members can already see the channel, so a failed mint
 * (typically 50013 when the bot lacks CreateInstantInvite) degrades to a room without a
 * link rather than a failed open. maxAge and maxUses stay 0 because finish deletes the
 * invite itself; unique stops Discord handing back somebody else's cached invite.
 */
export async function mintRoomInvite(
	channel: TextChannel,
	room: Pick<IGameRoom, "roomId" | "guildId">,
	visibility: RoomVisibility,
	spectatorMode: SpectatorMode | null | undefined
): Promise<string | null> {
	if (!roomTakesInvite(visibility, spectatorMode)) return null;
	try {
		const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: `game room ${room.roomId}` });
		return invite?.code ?? null;
	} catch (error) {
		console.error("[game-rooms] failed to mint invite", { guildId: room.guildId, roomId: room.roomId, error });
		return null;
	}
}

/**
 * Delete a finished room's invite. Fire and forget by contract (house rule 7): it runs
 * after finish's persist and lock, never throws, and a failed delete is logged and left,
 * since the invite dies with the channel at the archive sweep anyway. An invite somebody
 * already deleted by hand answers 10006 (unknown invite), which is the end state wanted.
 */
export async function revokeRoomInvite(client: Client, room: Pick<IGameRoom, "roomId" | "guildId" | "inviteCode">): Promise<void> {
	if (!room.inviteCode) return;
	try {
		const guild = client.guilds.cache.get(room.guildId) ?? (await client.guilds.fetch(room.guildId).catch(() => null));
		if (!guild) return;
		await guild.invites.delete(room.inviteCode, `game room ${room.roomId} finished`);
	} catch (error) {
		console.error("[game-rooms] failed to delete a finished room's invite", { guildId: room.guildId, roomId: room.roomId, error });
	}
}
