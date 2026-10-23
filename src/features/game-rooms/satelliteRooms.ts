import {
	ActionRowBuilder,
	ChannelType,
	DiscordAPIError,
	escapeMarkdown,
	type AttachmentBuilder,
	type ButtonBuilder,
	type CategoryChannel,
	type Client,
	type ColorResolvable,
	type EmbedBuilder,
	type Guild,
	type TextChannel,
} from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { SATELLITE_ACTIONS, parseGameRoomCustomId } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { buildRoomChannelName, resolveRoomChannelName } from "./roomNaming.js";
import { buildSatelliteOverwrites, type RoomPhase } from "./roomPermissions.js";
import { NON_TERMINAL_ROOM_STATUSES, type SatelliteRoom } from "./roomTypes.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── satelliteRooms ───────────────────────────────────────────────────
// What:  a network table's windows in other servers (2026-10 item 244 Phase 5a). Opens a
//        satellite channel in a remote guild, relays the table and its moves into every
//        satellite after the host room has them, locks every satellite when the match
//        ends, deletes every satellite with the host room, and names players by display
//        name and server tag where a network table shows them.
// Who:   openSatellite: satelliteSeats.openSatelliteWithTable (and Phase 5b's join flow).
//        relayState: the Hold'em redraw. relayMove: roomTrail.postMove. lockSatellites:
//        roomLifecycle.finish. deleteSatellites: roomLifecycle.archiveRoom, the one delete
//        path the archive sweep and Archive now share. The labels: postMove, the Hold'em
//        redraw and finish.
// Does NOT: decide who may sit down (Phase 5b's join flow and joinGate), seat anybody out
//        (satelliteSeats, which needs the Hold'em table and so sits above this module), or
//        relay anything a member typed: chat stays in the server it was typed in.
// Where: ⚠️ A SATELLITE IS A CHILD OF THE HOST ROW, NEVER A ROOM. Nothing here writes a
//        status, a winner, archiveAt or the transcript, so the host row stays the single
//        source of truth, roomLifecycle.finish stays the only writer of the archive clock,
//        and the one open room per host index never sees a satellite. Every relay runs
//        AFTER the host room already has what it relays, and a failure is logged per
//        satellite and swallowed, so no satellite can hold up, undo or fail the host room.
// How:   ① one ordered chain of relays per room, so every satellite reads the moves and
//        the table in the order the host room did; ② each satellite inside a step is
//        isolated, so one deleted channel or one server that removed the bot never stops
//        the next; ③ names instead of mentions, because a mention of a member of another
//        server does not resolve there.

const words = rokCommanderCopy.arcadeSatellites;

// Nothing a relay posts pings anybody. The host room already pinged whoever its own line
// pings; a second ping from a mirror in another server would be noise at best.
const NO_PINGS = { parse: [] };

// ── naming players at a network table ─────────────────────────────────
// A user mention with or without the legacy nickname "!" form.
const USER_MENTION = /<@!?(\d+)>/g;

/**
 * How a network table names one player: their Discord display name, plus the server tag
 * they wear when they wear one. Markdown in either is escaped, so a name cannot restyle
 * the table it sits in. A player Discord cannot resolve is "a player", never a raw id.
 */
export async function playerLabel(client: Client, userId: string): Promise<string> {
	const user = client.users.cache.get(userId) ?? (await client.users.fetch(userId).catch(() => null));
	if (!user) return words.unknownPlayer;
	const identity = user.primaryGuild;
	const tag = identity?.identityEnabled && identity.tag ? escapeMarkdown(identity.tag) : null;
	return words.playerLabel(escapeMarkdown(user.displayName), tag);
}

/**
 * Replace every user mention in a bot composed line with that player's label. One pass
 * over the text, so a display name that itself looks like a mention is never rewritten
 * a second time. Each player is resolved once per line, from the client's cache first.
 */
export async function labelMentions(client: Client, text: string): Promise<string> {
	const userIds = [...new Set([...text.matchAll(USER_MENTION)].map((match) => match[1]))];
	if (userIds.length === 0) return text;
	const labels = new Map<string, string>();
	for (const userId of userIds) labels.set(userId, await playerLabel(client, userId));
	return text.replace(USER_MENTION, (_mention, userId: string) => labels.get(userId) ?? words.unknownPlayer);
}

/** A line as a room shows it: labelled at a network table, untouched everywhere else. */
export async function labelForRoom(client: Client, room: Pick<IGameRoom, "network">, text: string): Promise<string> {
	return room.network ? labelMentions(client, text) : text;
}

/** An embed as a room shows it: its description labelled at a network table, untouched everywhere else. */
export async function labelEmbedForRoom(client: Client, room: Pick<IGameRoom, "network">, embed: EmbedBuilder): Promise<EmbedBuilder> {
	const description = embed.data.description;
	if (!room.network || !description) return embed;
	return embed.setDescription(await labelMentions(client, description));
}

// ── finding a satellite ───────────────────────────────────────────────
const isLive = (room: Pick<IGameRoom, "status">): boolean => (NON_TERMINAL_ROOM_STATUSES as readonly string[]).includes(room.status);

/** The satellite a room keeps in one guild, or null. A room keeps at most one per guild. */
export function satelliteIn(room: Pick<IGameRoom, "satellites">, guildId: string): SatelliteRoom | null {
	return (room.satellites ?? []).find((satellite) => satellite.guildId === guildId) ?? null;
}

/** The satellite a press came from, matched on both its guild and its channel, or null. */
export function satelliteAt(room: Pick<IGameRoom, "satellites">, guildId: string, channelId: string): SatelliteRoom | null {
	return (room.satellites ?? []).find((satellite) => satellite.guildId === guildId && satellite.channelId === channelId) ?? null;
}

async function resolveSatelliteChannel(client: Client, satellite: SatelliteRoom): Promise<TextChannel | null> {
	const channel = await client.channels.fetch(satellite.channelId).catch(() => null);
	if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
	return channel as TextChannel;
}

// ── the relay chain ───────────────────────────────────────────────────
// ⚠️ ONE CHAIN PER ROOM, AND EVERY RELAY RIDES IT. A move line and the table edit that
// follows it are queued in the order the host room produced them, and each step starts
// only after the one before it has finished in every satellite. Without it, two quick
// actions race their relays and a satellite can show the table from before the latest
// move, or a move posted under the table it caused. The chain lives in memory on
// purpose: a redeploy loses nothing that matters, because the next redraw carries the
// whole table and the transcript lives on the host row.
const relayChains = new Map<string, Promise<void>>();

// The mirrored table message in each satellite channel, as soon as a relay posts it.
// The row learns the id too, but a room read before that write still carries null, and
// relaying from that read would post a second table under the first.
const tableMessageIds = new Map<string, string>();

function enqueueRelay(roomId: string, step: () => Promise<void>): Promise<void> {
	const previous = relayChains.get(roomId) ?? Promise.resolve();
	const next = previous
		.then(step)
		.catch((error) => console.error("[game-rooms] satellite relay step failed", { roomId, error }));
	relayChains.set(roomId, next);
	void next.then(() => {
		if (relayChains.get(roomId) === next) relayChains.delete(roomId);
	});
	return next;
}

/** Resolves once every relay queued for this room so far has run, in every satellite. */
export function whenRelayed(roomId: string): Promise<void> {
	return relayChains.get(roomId) ?? Promise.resolve();
}

// Run one relay for every satellite, in the room's order, each isolated: a satellite
// whose channel is gone, or whose server removed the bot, is logged and skipped.
function relayToEach(
	room: Pick<IGameRoom, "roomId" | "satellites">,
	what: string,
	relay: (satellite: SatelliteRoom) => Promise<void>
): Promise<void> {
	const satellites = [...(room.satellites ?? [])];
	if (satellites.length === 0) return Promise.resolve();
	return enqueueRelay(room.roomId, async () => {
		for (const satellite of satellites) {
			try {
				await relay(satellite);
			} catch (error) {
				console.warn(`[game-rooms] satellite ${what} relay failed`, {
					roomId: room.roomId,
					guildId: satellite.guildId,
					channelId: satellite.channelId,
					error,
				});
			}
		}
	});
}

// ── relaying the table ────────────────────────────────────────────────
/** The table message as the host room just drew it. */
export interface SatelliteTableMessage {
	embeds: EmbedBuilder[];
	components: ActionRowBuilder<ButtonBuilder>[];
	files: AttachmentBuilder[];
}

/**
 * The table's controls as a satellite shows them: only the buttons a seated player may
 * press there (SATELLITE_ACTIONS), with any row left empty dropped. The host's own
 * controls would only ever answer "not here", so they are not offered.
 */
export function satelliteComponents(rows: readonly ActionRowBuilder<ButtonBuilder>[]): ActionRowBuilder<ButtonBuilder>[] {
	const kept: ActionRowBuilder<ButtonBuilder>[] = [];
	for (const row of rows) {
		const buttons = row.components.filter(isSatelliteControl);
		if (buttons.length > 0) kept.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));
	}
	return kept;
}

function isSatelliteControl(button: ButtonBuilder): boolean {
	const customId = "custom_id" in button.data ? button.data.custom_id : undefined;
	const parsed = customId ? parseGameRoomCustomId(customId) : null;
	return parsed !== null && SATELLITE_ACTIONS.has(parsed.action);
}

/**
 * Post or edit the same table message in every satellite, after the host room drew it.
 * Fire and forget for the caller: it resolves when the relay has run, never rejects, and
 * a satellite that fails is logged and skipped.
 */
export function relayState(client: Client, room: Pick<IGameRoom, "guildId" | "roomId" | "satellites">, table: SatelliteTableMessage): Promise<void> {
	const mirrored = { ...table, components: satelliteComponents(table.components) };
	return relayToEach(room, "table", (satellite) => relayTableTo(client, room, satellite, mirrored));
}

async function relayTableTo(
	client: Client,
	room: Pick<IGameRoom, "guildId" | "roomId">,
	satellite: SatelliteRoom,
	table: SatelliteTableMessage
): Promise<void> {
	const channel = await resolveSatelliteChannel(client, satellite);
	if (!channel) throw new Error(`satellite channel ${satellite.channelId} is unreachable`);

	const knownId = tableMessageIds.get(satellite.channelId) ?? satellite.tableMessageId;
	const existing = knownId ? await channel.messages.fetch(knownId).catch(() => null) : null;
	if (existing) {
		// `attachments: []` drops the last card, which an edit otherwise keeps, as the host's redraw does.
		await existing.edit({ content: null, embeds: table.embeds, components: table.components, files: table.files, attachments: [] });
		return;
	}

	// First relay here, or the table message was deleted: post it and remember it.
	const posted = await channel.send({ embeds: table.embeds, components: table.components, files: table.files, allowedMentions: NO_PINGS });
	tableMessageIds.set(satellite.channelId, posted.id);
	await gameRoomStore.setSatelliteTableMessage(room.guildId, room.roomId, satellite.channelId, posted.id);
}

// ── relaying a move ───────────────────────────────────────────────────
/**
 * Post one move line in every satellite, after the host room posted it. `text` is the
 * line as the host room showed it, already labelled. Only lines the bot composed reach
 * this, through roomTrail.postMove; nothing a member typed does.
 */
export function relayMove(client: Client, room: Pick<IGameRoom, "roomId" | "satellites">, text: string): Promise<void> {
	return relayToEach(room, "move", async (satellite) => {
		const channel = await resolveSatelliteChannel(client, satellite);
		if (!channel) throw new Error(`satellite channel ${satellite.channelId} is unreachable`);
		await channel.send({ content: text, allowedMentions: NO_PINGS });
	});
}

// ── the end of a match ────────────────────────────────────────────────
/** The result card as the host room posted it, without its buttons. */
export interface SatelliteResult {
	embed: EmbedBuilder;
	files: AttachmentBuilder[];
}

/**
 * Lock every satellite and post the result there, queued behind every relay the match
 * already set off, so the last table and the last move land before the lock. Called by
 * roomLifecycle.finish after it persisted the finish and locked the host room.
 *
 * The result carries no buttons: Rematch and Archive now belong to the host room, and a
 * press of either from here would only be refused.
 */
export function lockSatellites(client: Client, room: Pick<IGameRoom, "roomId" | "satellites">, result: SatelliteResult): Promise<void> {
	return relayToEach(room, "lock", async (satellite) => {
		const channel = await resolveSatelliteChannel(client, satellite);
		if (!channel) throw new Error(`satellite channel ${satellite.channelId} is unreachable`);
		await applySatellitePhase(client, channel, satellite, "finished");
		await channel.send({ embeds: [result.embed], files: result.files, allowedMentions: NO_PINGS });
	});
}

/**
 * Delete every satellite channel, for the one delete path the archive sweep and Archive
 * now share (roomLifecycle.archiveRoom), before it closes the row. A channel already gone
 * is a success, the same way archiveRoom treats its own. Each satellite is isolated, so a
 * server that removed the bot never stops the rest, or the host room after them.
 */
export async function deleteSatellites(client: Client, room: Pick<IGameRoom, "roomId" | "satellites">): Promise<void> {
	for (const satellite of room.satellites ?? []) {
		tableMessageIds.delete(satellite.channelId);
		const channel = await resolveSatelliteChannel(client, satellite).catch(() => null);
		if (!channel) continue;
		await channel.delete("game room archived").catch((error) =>
			console.error("[game-rooms] satellite channel delete failed", {
				roomId: room.roomId,
				guildId: satellite.guildId,
				channelId: satellite.channelId,
				error,
			})
		);
	}
}

/**
 * Replace a satellite channel's whole overwrite set with the matrix for one phase, the
 * way applyRoomPhase does for the host room. Logs and resolves on failure.
 */
async function applySatellitePhase(client: Client, channel: TextChannel, satellite: SatelliteRoom, phase: RoomPhase): Promise<void> {
	const config = await guildConfigStore.findByGuildId(satellite.guildId).catch(() => null);
	await channel.permissionOverwrites
		.set(
			buildSatelliteOverwrites({
				everyoneRoleId: channel.guild.roles.everyone.id,
				botId: client.user!.id,
				playerIds: satellite.userIds,
				phase,
				adminRoleId: (config as { adminRoleId?: string | null } | null)?.adminRoleId ?? null,
			})
		)
		.catch((error) => console.error(`[game-rooms] failed to set the satellite's ${phase} overwrites`, { channelId: satellite.channelId, error }));
}

// ── opening a satellite ───────────────────────────────────────────────
export type SatelliteRefusal = keyof typeof words.refusals;

export type SatelliteOpenResult = { ok: true; room: IGameRoom; channelId: string } | { ok: false; reason: SatelliteRefusal };

/** The refusal's words, for whoever asked for the seat. */
export function describeSatelliteRefusal(reason: SatelliteRefusal, room: Pick<IGameRoom, "game">): string {
	if (reason === "notNetworkGame") return words.refusals.notNetworkGame(gameRoomsCopy.gameLabel(room.game));
	return words.refusals[reason];
}

/**
 * Seat members of a remote guild at a live network table, through a satellite channel
 * in that guild's arcade category: a new one, or the one the table already keeps there.
 *
 * ① Refuse what the row alone can refuse; ② refuse a member who is not in the remote
 * guild, or who is in the host guild (they play in the host room); ③ resolve the remote
 * arcade category, refusing honestly when that guild has not run /setup; ④ open the
 * channel and claim it on the row, or add the members to the satellite already there.
 *
 * Draws no table: the caller relays one (satelliteSeats.openSatelliteWithTable), because
 * the table belongs to the game, which sits above this module.
 */
export async function openSatellite(room: IGameRoom, remoteGuild: Guild, userIds: readonly string[]): Promise<SatelliteOpenResult> {
	const seated = [...new Set(userIds)];
	const refusal = refuseFromRow(room, remoteGuild, seated) ?? (await refuseByMembership(room, remoteGuild, seated));
	if (refusal) return { ok: false, reason: refusal };

	const category = await resolveArcadeCategory(remoteGuild);
	if (!category) return { ok: false, reason: "notSetUp" };

	const existing = satelliteIn(room, remoteGuild.id);
	if (existing) return seatInSatellite(room, remoteGuild, seated);
	return createSatellite(room, remoteGuild, category, seated);
}

function refuseFromRow(room: IGameRoom, remoteGuild: Guild, seated: readonly string[]): SatelliteRefusal | null {
	if (!room.network) return "notNetwork";
	if (!(BOT_CONSTANTS.NETWORK_GAMES as readonly string[]).includes(room.game)) return "notNetworkGame";
	if (!isLive(room)) return "roomClosed";
	if (remoteGuild.id === room.guildId) return "sameServer";
	if (seated.length === 0) return "noPlayers";
	if (seated.includes(room.hostId)) return "inHostServer";
	if (seated.some((userId) => (room.kickedIds ?? []).includes(userId))) return "removed";
	return null;
}

// Every seated member must belong to the remote guild, since a member overwrite there
// needs a member there, and none may belong to the host guild: they can already see the
// host room, and seating them through a satellite as well would put one player behind
// two doors with two sets of rules.
async function refuseByMembership(room: IGameRoom, remoteGuild: Guild, seated: readonly string[]): Promise<SatelliteRefusal | null> {
	const hostGuild = remoteGuild.client.guilds.cache.get(room.guildId) ?? null;
	for (const userId of seated) {
		const member = await remoteGuild.members.fetch(userId).catch(() => null);
		if (!member) return "notMember";
		const atHost = hostGuild ? await hostGuild.members.fetch(userId).catch(() => null) : null;
		if (atHost) return "inHostServer";
	}
	return null;
}

async function resolveArcadeCategory(remoteGuild: Guild): Promise<CategoryChannel | null> {
	const config = await guildConfigStore.findByGuildId(remoteGuild.id).catch(() => null);
	const categoryId = (config as { gamesCategoryId?: string | null } | null)?.gamesCategoryId;
	if (!categoryId) return null;
	const category = await remoteGuild.channels.fetch(categoryId).catch(() => null);
	return category && category.type === ChannelType.GuildCategory ? category : null;
}

async function createSatellite(room: IGameRoom, remoteGuild: Guild, category: CategoryChannel, seated: string[]): Promise<SatelliteOpenResult> {
	const client = remoteGuild.client;
	const config = await guildConfigStore.findByGuildId(remoteGuild.id).catch(() => null);
	const hostName = (await client.users.fetch(room.hostId).catch(() => null))?.displayName ?? "";
	const takenNames = new Set(category.children.cache.map((child) => child.name));
	const name = resolveRoomChannelName(buildRoomChannelName(room.game, hostName, room.hostId), (candidate) => takenNames.has(candidate));

	let channel: TextChannel;
	try {
		channel = (await remoteGuild.channels.create({
			name,
			type: ChannelType.GuildText,
			parent: category.id,
			permissionOverwrites: buildSatelliteOverwrites({
				everyoneRoleId: remoteGuild.roles.everyone.id,
				botId: client.user!.id,
				playerIds: seated,
				phase: "playing",
				adminRoleId: (config as { adminRoleId?: string | null } | null)?.adminRoleId ?? null,
			}),
		})) as TextChannel;
	} catch (error) {
		// 50013, as in the provisioner: the bot cannot build in this arcade category, which
		// only that server's admin can fix. Said honestly and never retried.
		if (error instanceof DiscordAPIError && error.code === 50013) return { ok: false, reason: "missingPermissions" };
		console.error("[game-rooms] satellite channel create failed", { roomId: room.roomId, guildId: remoteGuild.id, error });
		return { ok: false, reason: "createFailed" };
	}

	// The row AFTER the channel, as the provisioner orders it: a satellite on the row
	// always points at a channel that was built. A lost claim means another member of this
	// guild sat down in the same tick, so this channel goes and the members join theirs.
	const claimed = await gameRoomStore
		.addSatellite(room.guildId, room.roomId, { guildId: remoteGuild.id, channelId: channel.id, userIds: seated, tableMessageId: null })
		.catch((error) => {
			console.error("[game-rooms] satellite claim write failed", { roomId: room.roomId, guildId: remoteGuild.id, error });
			return null;
		});
	if (!claimed) {
		await channel.delete("satellite claim lost").catch(() => undefined);
		const fresh = await gameRoomStore.findByRoomId(room.guildId, room.roomId).catch(() => null);
		if (!fresh || !isLive(fresh) || !satelliteIn(fresh, remoteGuild.id)) return { ok: false, reason: "roomClosed" };
		return seatInSatellite(fresh, remoteGuild, seated);
	}

	await postOpener(channel, room, seated);
	return { ok: true, room: claimed, channelId: channel.id };
}

// The table already keeps a satellite in this guild: the members join its list and the
// channel's overwrites are rebuilt to let them in.
async function seatInSatellite(room: IGameRoom, remoteGuild: Guild, seated: readonly string[]): Promise<SatelliteOpenResult> {
	const updated = await gameRoomStore.addSatellitePlayers(room.guildId, room.roomId, remoteGuild.id, seated).catch(() => null);
	const satellite = updated ? satelliteIn(updated, remoteGuild.id) : null;
	if (!updated || !satellite) return { ok: false, reason: "roomClosed" };
	const channel = await resolveSatelliteChannel(remoteGuild.client, satellite);
	if (channel) await applySatellitePhase(remoteGuild.client, channel, satellite, "playing");
	return { ok: true, room: updated, channelId: satellite.channelId };
}

// The first message in a new satellite: what this channel is, and that chat stays here.
// The seated members are named in the content so the ping tells them where their seat
// is; the opener is pinned, best effort, like a room's.
async function postOpener(channel: TextChannel, room: IGameRoom, seated: readonly string[]): Promise<void> {
	const opener = await channel
		.send({
			content: seated.map((userId) => `<@${userId}>`).join(" "),
			embeds: [infoEmbed(words.opener.title, words.opener.description(gameRoomsCopy.gameLabel(room.game), seated), COLORS.ARCADE as ColorResolvable)],
			allowedMentions: { users: [...seated] },
		})
		.catch((error) => {
			console.warn("[game-rooms] satellite opener failed to post", { roomId: room.roomId, channelId: channel.id, error });
			return null;
		});
	await opener?.pin().catch(() => undefined);
}

export const satelliteRooms = {
	openSatellite,
	relayState,
	relayMove,
	lockSatellites,
	deleteSatellites,
	whenRelayed,
};
