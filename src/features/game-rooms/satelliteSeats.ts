import { DiscordAPIError, Events, RESTJSONErrorCodes, type Client, type Guild } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { roomTrail } from "./roomTrail.js";
import { redrawTable, removeFromTable } from "./roomHoldemHandlers.js";
import {
	deleteSatellites,
	openSatellite,
	rebuildSatelliteOverwrites,
	satelliteAt,
	satelliteIn,
	type SatelliteOpenResult,
} from "./satelliteRooms.js";
import { NON_TERMINAL_ROOM_STATUSES, type SatelliteRoom } from "./roomTypes.js";
import type { DepartedMember } from "./guildMemberRemoveWatcher.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── satelliteSeats ───────────────────────────────────────────────────
// What:  what happens to the seats a network table's satellites hold (2026-10 item 244
//        Phase 5a): a satellite opens with the table already drawn in it, and its players
//        are seated out of the table when they leave their own server, when their server
//        removes Dero, or when the satellite channel is deleted, live and at boot. The
//        owner's network ban and a server's block list (Phase 5c) do the same to the
//        players they name who already sit at a network table, and stop relays to them.
// Who:   openSatelliteWithTable: networkJoin (a seat asked for from the network board,
//        and the host accepting one from Requests), and the test helper script.
//        The watchers: main.ts, beside the room departure and channel delete watchers.
//        The boot reconcile: main.ts, right after recoverGameRoomsOnBoot.
//        The ban and block sweeps: /platform network ban and /arcade server block.
// Does NOT: open, relay to, lock or delete a satellite channel (satelliteRooms does, and
//        sits below this module because this one needs the Hold'em table), or end the host
//        room on a departure: a remote player leaving is not the host room's player leaving.
// Where: ⚠️ A SEAT OUT IS A REMOVAL, NOT A FORFEIT. A member who leaves the HOST server
//        ends the match (guildMemberRemoveWatcher). A member of a satellite's server who
//        leaves gets exactly what the host's Remove a player gives (hostControls): out of
//        every list, onto kickedIds so no door lets them back and no rating counts them,
//        then off the table the way Leave table takes a seat off. The table plays on.
// How:   the row write first (gameRoomStore.seatOutSatellitePlayers, one atomic write),
//        then a trail line per player, then the table, one player at a time from a fresh
//        read, so every removal a finish could set off already carries every kickedIds.

const words = rokCommanderCopy.arcadeSatellites;

export type SeatOutReason = keyof typeof words.seatOut;

const isLive = (room: Pick<IGameRoom, "status">): boolean => (NON_TERMINAL_ROOM_STATUSES as readonly string[]).includes(room.status);

// What a remote server's audit log reads when a ban or a block deletes a satellite channel.
// Admin facing and neutral: it never carries the owner's ban note.
const SEAT_OUT_DELETE_REASON = "network table link ended by a network ban or block";

/** How a seat out treats the satellite its players sat in. */
export interface SeatOutOptions {
	// The satellite entry leaves the row too, so no relay or archive reaches it again.
	endSatellite: boolean;
	// The channel is still in Dero's reach and the members must lose it as well (a network ban
	// or a block, Phase 5c): an ended satellite's channel is deleted at once (owner decision
	// 2026-10-24, since nothing deletes a channel no row points at), and a satellite that stays
	// is rebuilt from the players left in it, or ends when nobody is left. The departures never
	// pass it: their channel is already gone or out of reach, or the member left that server.
	revokeAccess?: boolean;
}

// ── opening a satellite with its table ────────────────────────────────
/**
 * Seat members of a remote guild at a live network table and draw the table in their
 * satellite at once, so the channel never sits empty waiting for the next move. The
 * draw is the Hold'em redraw, which relays to every satellite after the host room.
 */
export async function openSatelliteWithTable(room: IGameRoom, remoteGuild: Guild, userIds: readonly string[]): Promise<SatelliteOpenResult> {
	const opened = await openSatellite(room, remoteGuild, userIds);
	if (opened.ok) await redrawTable(remoteGuild.client, opened.room);
	return opened;
}

// ── seating players out ───────────────────────────────────────────────
/**
 * Seat members of one satellite out of a live network table, for `reason`. With
 * `endSatellite`, the satellite entry goes too; with `revokeAccess`, the members lose the
 * channel itself (see SeatOutOptions). Answers how many members were seated out: zero when
 * the room had already closed.
 */
export async function seatOutSatellitePlayers(
	client: Client,
	room: IGameRoom,
	satelliteGuildId: string,
	userIds: readonly string[],
	reason: SeatOutReason,
	options: SeatOutOptions
): Promise<number> {
	const leaving = [...new Set(userIds)];
	const updated = await gameRoomStore.seatOutSatellitePlayers(room.guildId, room.roomId, satelliteGuildId, leaving, {
		endSatellite: options.endSatellite,
	});
	if (!updated) return 0;
	// Before the transcript and the table: a member a ban took off a table must not go on
	// watching it for as long as the removal below takes.
	if (options.revokeAccess) await revokeSatelliteAccess(client, room, updated, satelliteGuildId, options.endSatellite);

	for (const userId of leaving) {
		// The line first, then the table, so the transcript reads in the order the room
		// lived it: the player is gone, therefore their seat goes.
		await roomTrail.postMove(client, updated, { actorId: userId, kind: "system", text: words.seatOut[reason](userId) });
		if (updated.game !== "holdem") continue;
		// A fresh read per player: the previous removal moved the table, and the removal's
		// own compare and swap would otherwise spend its retries rediscovering that.
		const current = (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? updated;
		const removal = await removeFromTable(client, current, userId, userId);
		// Nothing to take off the table (a member seated through the satellite who never
		// bought in) still changes the room's lists, so the table redraws either way, as
		// it does after the host's own removal.
		if (removal === "notAtTable") await redrawTable(client, current);
		// Every retry lost to a busy table. Unlike the host's removal nobody can press
		// again here, but the row already refuses the player everywhere, so the seat
		// left behind can only time out and sit out like any absent player's.
		if (removal === "busy") console.warn("[game-rooms] satellite seat out left a seat at a busy table", { roomId: room.roomId, userId });
	}
	return leaving.length;
}

// After a ban or a block took members off a satellite: an ended satellite's channel goes,
// and one that stays is rebuilt from the players left in it, or ends when none is left.
async function revokeSatelliteAccess(client: Client, before: IGameRoom, after: IGameRoom, satelliteGuildId: string, ended: boolean): Promise<void> {
	if (ended) {
		const original = satelliteIn(before, satelliteGuildId);
		if (original) await deleteSatellites(client, { roomId: before.roomId, satellites: [original] }, SEAT_OUT_DELETE_REASON);
		return;
	}
	const kept = satelliteIn(after, satelliteGuildId);
	if (!kept) return;
	if (kept.userIds.length > 0) {
		await rebuildSatelliteOverwrites(client, kept);
		return;
	}
	// Nobody is left to play from it, so it ends, unless a member sat down through it in the
	// same tick: then the conditional write matches nothing and the newcomer keeps the window.
	if (await gameRoomStore.endEmptySatellite(after.guildId, after.roomId, satelliteGuildId)) {
		await deleteSatellites(client, { roomId: after.roomId, satellites: [kept] }, SEAT_OUT_DELETE_REASON);
		return;
	}
	const fresh = await gameRoomStore.findByRoomId(after.guildId, after.roomId);
	const refilled = fresh && isLive(fresh) ? satelliteIn(fresh, satelliteGuildId) : null;
	if (refilled) await rebuildSatelliteOverwrites(client, refilled);
}

// ── the departure watchers ────────────────────────────────────────────
/**
 * A member left a guild: seat them out of every live network table that seats them
 * through a satellite in THAT guild. One indexed read for the ordinary departure that
 * touches no table (the partial satellites.userIds index).
 */
export async function handleSatelliteMemberRemove(client: Client, member: DepartedMember): Promise<number> {
	const rooms = await gameRoomStore.findOpenBySatellitePlayer(member.guild.id, member.id);
	let seatedOut = 0;
	for (const room of rooms) {
		seatedOut += await seatOutSatellitePlayers(client, room, member.guild.id, [member.id], "leftServer", { endSatellite: false });
	}
	return seatedOut;
}

/**
 * A guild removed the bot: end every satellite it held and seat out everybody those
 * satellites seated. The channels stay behind in that guild, out of the bot's reach, so
 * the entries go from the row too and no relay or archive tries them again.
 *
 * discord.js raises GuildDelete only for a real removal; a guild an outage made
 * unavailable raises GuildUnavailable instead, so an outage never seats anybody out.
 */
export async function handleSatelliteGuildDelete(client: Client, guild: { id: string }): Promise<number> {
	const rooms = await gameRoomStore.findOpenBySatelliteGuild(guild.id);
	let seatedOut = 0;
	for (const room of rooms) {
		const satellite = satelliteIn(room, guild.id);
		if (!satellite) continue;
		seatedOut += await seatOutSatellitePlayers(client, room, guild.id, satellite.userIds, "serverRemovedDero", { endSatellite: true });
	}
	return seatedOut;
}

/**
 * A channel was deleted: when it was a live network table's satellite, end that
 * satellite and seat out its players, who have nowhere left to play from.
 *
 * A FINISHED room is left alone, and that is not only tidiness: the archive deletes every
 * satellite with its host room, and each of those deletes arrives here as this event.
 */
export async function handleSatelliteChannelDelete(client: Client, channel: { id: string; guildId: string }): Promise<number> {
	const room = await gameRoomStore.findBySatelliteChannel(channel.guildId, channel.id);
	if (!room || !isLive(room)) return 0;
	const satellite = satelliteAt(room, channel.guildId, channel.id);
	if (!satellite) return 0;
	return seatOutSatellitePlayers(client, room, channel.guildId, satellite.userIds, "channelGone", { endSatellite: true });
}

/**
 * Bind the satellite departure watchers. Called once at boot from main.ts.
 *
 * ⚠️ THESE ARE SECOND LISTENERS ON GuildMemberRemove AND ChannelDelete, ON PURPOSE.
 * guildMemberRemoveWatcher ends the rooms a member of the HOST guild played in, and
 * ChannelDeleteWatcher closes a deleted host room and repairs the homebase; neither
 * knows satellites, and a satellite's departures follow another rule (a seat out, see
 * the header). Keeping them apart keeps both of those paths exactly as they were. Both
 * files point back here.
 */
export function registerSatelliteWatchers(client: Client): void {
	client.on(Events.GuildMemberRemove, (member) => {
		void handleSatelliteMemberRemove(client, member).catch((error) =>
			console.error("[game-rooms] satellite member-remove failed", { guildId: member.guild.id, userId: member.id, error })
		);
	});
	client.on(Events.GuildDelete, (guild) => {
		void handleSatelliteGuildDelete(client, guild).catch((error) =>
			console.error("[game-rooms] satellite guild-delete failed", { guildId: guild.id, error })
		);
	});
	client.on(Events.ChannelDelete, (channel) => {
		if (!("guild" in channel) || !channel.guild) return;
		void handleSatelliteChannelDelete(client, { id: channel.id, guildId: channel.guild.id }).catch((error) =>
			console.error("[game-rooms] satellite channel-delete failed", { channelId: channel.id, error })
		);
	});
}

// ── network bans and blocks (2026-10 item 244 Phase 5c) ───────────────
// Owner decision 2026-10-24: a network ban or a block list entry reaches seats already
// taken. Each sweep goes through seatOutSatellitePlayers with revokeAccess, so a seat out
// by a ban is the same removal as every other (off every list, onto kickedIds, excluded
// from ratings, off the table) and the member also loses the channel. An ended satellite
// leaves the row, so no relay reaches it again; the host room plays on. Unban and unblock
// restore nothing: the member is on that table's kickedIds, like every seat out.

/**
 * The owner banned a member from the network: seat them out of every live network table
 * that seats them through a satellite, in any server, and end every satellite of the live
 * network tables they host. A satellite they leave keeps its other players and loses only
 * them; one they leave with nobody ends.
 *
 * ⚠️ A MEMBER IN THEIR OWN SERVER'S HOST ROOM KEEPS THAT SEAT. A network ban reaches the
 * network only (NetworkBan's header). A table hosted in the member's own server seats them
 * through its room, never through a satellite, so no read here finds them there.
 */
export async function seatOutBannedMember(client: Client, userId: string): Promise<number> {
	let seatedOut = 0;
	for (const room of await gameRoomStore.findOpenBySatelliteUser(userId)) {
		const satellite = (room.satellites ?? []).find((entry) => entry.userIds.includes(userId));
		if (!satellite) continue;
		seatedOut += await perTable(room, () =>
			seatOutSatellitePlayers(client, room, satellite.guildId, [userId], "banned", { endSatellite: false, revokeAccess: true })
		);
	}
	// Live network rooms are few, and one host's tables can sit in several servers, so the
	// boot reconcile's read filtered here beats spending an index on hostId alone.
	const hosted = (await gameRoomStore.findOpenNetwork()).filter((room) => room.hostId === userId);
	for (const room of hosted) seatedOut += await endEverySatellite(client, room, "banned");
	return seatedOut;
}

/**
 * The owner banned a server from the network: end every satellite it keeps at a live
 * network table, seating out its players (the shape of a server removing Dero), and end
 * every satellite of every live network table it hosts. Every host room plays on.
 */
export async function seatOutBannedServer(client: Client, guildId: string): Promise<number> {
	let seatedOut = 0;
	for (const room of await gameRoomStore.findOpenBySatelliteGuild(guildId)) seatedOut += await endSatelliteIn(client, room, guildId, "banned");
	for (const room of await gameRoomStore.findOpenNetworkHostedIn(guildId)) seatedOut += await endEverySatellite(client, room, "banned");
	return seatedOut;
}

/**
 * One server blocked another: end the blocked server's satellites at the tables the
 * blocking server hosts, and the blocking server's satellites at the tables the blocked
 * one hosts, because a block reaches both ways (networkRules.blocksEachOther).
 */
export async function seatOutBlockedServers(client: Client, blockingGuildId: string, blockedGuildId: string): Promise<number> {
	let seatedOut = 0;
	const directions: [hostGuildId: string, satelliteGuildId: string][] = [
		[blockingGuildId, blockedGuildId],
		[blockedGuildId, blockingGuildId],
	];
	for (const [hostGuildId, satelliteGuildId] of directions) {
		for (const room of await gameRoomStore.findOpenNetworkHostedIn(hostGuildId)) {
			seatedOut += await endSatelliteIn(client, room, satelliteGuildId, "blocked");
		}
	}
	return seatedOut;
}

// End the satellite a room keeps in one guild, seating out everybody it seats.
async function endSatelliteIn(client: Client, room: IGameRoom, satelliteGuildId: string, reason: SeatOutReason): Promise<number> {
	const satellite = satelliteIn(room, satelliteGuildId);
	if (!satellite) return 0;
	return perTable(room, () =>
		seatOutSatellitePlayers(client, room, satelliteGuildId, satellite.userIds, reason, { endSatellite: true, revokeAccess: true })
	);
}

async function endEverySatellite(client: Client, room: IGameRoom, reason: SeatOutReason): Promise<number> {
	let seatedOut = 0;
	for (const satellite of [...(room.satellites ?? [])]) seatedOut += await endSatelliteIn(client, room, satellite.guildId, reason);
	return seatedOut;
}

// One table at a time and each isolated, so a table whose write or Discord call failed
// never stops the rest of a sweep. The ban or block already stands either way.
async function perTable(room: IGameRoom, seatOut: () => Promise<number>): Promise<number> {
	try {
		return await seatOut();
	} catch (error) {
		console.error("[game-rooms] network ban or block seat out failed for one table", { roomId: room.roomId, error });
		return 0;
	}
}

// ── the boot reconcile ────────────────────────────────────────────────
/**
 * Catch up on the satellite departures that happened while the bot was down, once per
 * boot: a server that removed the bot, a satellite channel deleted, a seated member who
 * left their server. The same seat outs the watchers make live.
 *
 * ⚠️ ONLY A POSITIVE ANSWER SEATS ANYBODY OUT. A guild missing from the client is a
 * removal; a guild present but unavailable is an outage and is skipped; a channel or a
 * member counts as gone only on Discord's own Unknown Channel or Unknown Member error,
 * never on a timeout or a rate limit, which would otherwise seat out a whole table for a
 * network blip.
 */
export async function reconcileSatellitesOnBoot(client: Client): Promise<number> {
	const rooms = await gameRoomStore.findOpenNetwork().catch((error) => {
		console.error("[game-rooms] satellite boot reconcile scan failed", error);
		return [];
	});

	let seatedOut = 0;
	for (const room of rooms) {
		for (const satellite of [...(room.satellites ?? [])]) {
			try {
				seatedOut += await reconcileSatellite(client, room, satellite);
			} catch (error) {
				// Per satellite, so one unreachable server cannot stop the rest of the boot.
				console.error("[game-rooms] satellite boot reconcile failed for one satellite", {
					roomId: room.roomId,
					guildId: satellite.guildId,
					error,
				});
			}
		}
	}
	if (seatedOut > 0) console.log(`[game-rooms] satellite boot reconcile: ${seatedOut} player(s) seated out`);
	return seatedOut;
}

async function reconcileSatellite(client: Client, room: IGameRoom, satellite: SatelliteRoom): Promise<number> {
	const guild = client.guilds.cache.get(satellite.guildId);
	if (!guild) return seatOutSatellitePlayers(client, room, satellite.guildId, satellite.userIds, "serverRemovedDero", { endSatellite: true });
	if (!guild.available) return 0;

	if (await isGone(() => client.channels.fetch(satellite.channelId), RESTJSONErrorCodes.UnknownChannel)) {
		return seatOutSatellitePlayers(client, room, satellite.guildId, satellite.userIds, "channelGone", { endSatellite: true });
	}

	const departed: string[] = [];
	for (const userId of satellite.userIds) {
		if (await isGone(() => guild.members.fetch(userId), RESTJSONErrorCodes.UnknownMember)) departed.push(userId);
	}
	if (departed.length === 0) return 0;
	return seatOutSatellitePlayers(client, room, satellite.guildId, departed, "leftServer", { endSatellite: false });
}

// True only when Discord answered that the thing does not exist.
async function isGone(fetch: () => Promise<unknown>, unknownCode: number): Promise<boolean> {
	try {
		await fetch();
		return false;
	} catch (error) {
		return error instanceof DiscordAPIError && error.code === unknownCode;
	}
}

export const satelliteSeats = {
	openSatelliteWithTable,
	seatOutSatellitePlayers,
	seatOutBannedMember,
	seatOutBannedServer,
	seatOutBlockedServers,
	handleSatelliteMemberRemove,
	handleSatelliteGuildDelete,
	handleSatelliteChannelDelete,
	registerSatelliteWatchers,
	reconcileSatellitesOnBoot,
};
