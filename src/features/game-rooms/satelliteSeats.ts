import { DiscordAPIError, Events, RESTJSONErrorCodes, type Client, type Guild } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { roomTrail } from "./roomTrail.js";
import { redrawTable, removeFromTable } from "./roomHoldemHandlers.js";
import { openSatellite, satelliteAt, satelliteIn, type SatelliteOpenResult } from "./satelliteRooms.js";
import { NON_TERMINAL_ROOM_STATUSES, type SatelliteRoom } from "./roomTypes.js";
import type { DepartedMember } from "./guildMemberRemoveWatcher.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── satelliteSeats ───────────────────────────────────────────────────
// What:  what happens to the seats a network table's satellites hold (2026-10 item 244
//        Phase 5a): a satellite opens with the table already drawn in it, and its players
//        are seated out of the table when they leave their own server, when their server
//        removes Dero, or when the satellite channel is deleted, live and at boot.
// Who:   openSatelliteWithTable: networkJoin (a seat asked for from the network board,
//        and the host accepting one from Requests), and the test helper script.
//        The watchers: main.ts, beside the room departure and channel delete watchers.
//        The boot reconcile: main.ts, right after recoverGameRoomsOnBoot.
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
 * `endSatellite`, the satellite entry goes too (its channel is out of reach for good).
 * Answers how many members were seated out: zero when the room had already closed.
 */
export async function seatOutSatellitePlayers(
	client: Client,
	room: IGameRoom,
	satelliteGuildId: string,
	userIds: readonly string[],
	reason: SeatOutReason,
	options: { endSatellite: boolean }
): Promise<number> {
	const leaving = [...new Set(userIds)];
	const updated = await gameRoomStore.seatOutSatellitePlayers(room.guildId, room.roomId, satelliteGuildId, leaving, options);
	if (!updated) return 0;

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
	handleSatelliteMemberRemove,
	handleSatelliteGuildDelete,
	handleSatelliteChannelDelete,
	registerSatelliteWatchers,
	reconcileSatellitesOnBoot,
};
