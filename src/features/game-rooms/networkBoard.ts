import {
	ActionRowBuilder,
	StringSelectMenuBuilder,
	TextChannel,
	escapeMarkdown,
	type Client,
	type ColorResolvable,
	type EmbedBuilder,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { networkBanStore } from "@db/stores/networkBanStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { INetworkBan } from "@db/models/NetworkBan.js";
import { hasLateSeatFree, livePlayers, seatCapOf, type HoldemTable } from "@features/games/holdemTable.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { blocksEachOther, isGuildBanned, isOnNetwork, isUserBanned, type NetworkGuildConfig } from "./networkRules.js";
import { consentingAmong } from "./networkConsent.js";
import { playerLabel } from "./satelliteRooms.js";
import type { RatingBand } from "./roomTypes.js";

// ── networkBoard ─────────────────────────────────────────────────────
// What:  the network board (2026-10 item 244 Phase 5b): ONE message per network server,
//        in its challenges channel, edited in place, listing the tables other network
//        servers are hosting that still take players, with a select to ask for a seat.
// Who:   main.ts starts it at boot (startNetworkBoards). Every change that could move a
//        listing asks for a refresh: a network table's redraw, its finish, an admin's
//        reach or block list, the owner's bans, a satellite opening. The select itself
//        is answered by networkJoin, which re-checks everything this file filtered.
// Does NOT: seat anybody, or decide whether a member may sit (networkJoin and joinGate
//        do, on the fresh row, at the press). A listing is a suggestion, not a gate.
//
// ⚠️ ONE ROUND OF EDITS PER BURST, AND NONE FOR NOTHING. A busy table redraws on every
// action, and each redraw asks for a refresh; the asks collapse into one refresh after
// BOARD_REFRESH_DEBOUNCE_MS, a refresh never overlaps another (an ask during one queues
// exactly one more), and a server whose board would read the same as last time is not
// edited at all. Nothing runs until startNetworkBoards has been handed the client, so
// tests and scripts that only load this module never start a timer.

const words = rokCommanderCopy.arcadeNetwork;
const bandWords = rokCommanderCopy.arcadeHostControls.band;
const NETWORK = BOT_CONSTANTS.NETWORK;

// The select's customId prefix. Registered by networkJoin.
export const NETWORK_BOARD_PREFIX = "networkBoard";
export const NETWORK_BOARD_SELECT_ID = `${NETWORK_BOARD_PREFIX}:join`;

/** The slice of a GuildConfig row a board refresh reads. */
export interface BoardGuildConfig extends NetworkGuildConfig {
	arcadeChallengesChannelId?: string | null;
	networkBoardMessageId?: string | null;
}

/** How a table still takes players: buying in before the first deal, or open seats between hands. */
export type TablePhase = "joining" | "seatsOpen";

/** A table the board may list, with everything any server's board needs to show it. */
export interface BoardTable {
	roomId: string;
	hostGuildId: string;
	hostId: string;
	game: IGameRoom["game"];
	phase: TablePhase;
	seated: number;
	cap: number;
	ratingBand: RatingBand;
	requireApproval: boolean;
	// The host's name and worn tag, escaped for an embed (satelliteRooms.playerLabel), and
	// the plain name for the select, where markdown does not render.
	hostLabel: string;
	hostName: string;
	serverName: string;
}

// ── which tables take players ─────────────────────────────────────────
/**
 * How a live network Hold'em table still takes players, or null when it takes nobody:
 * buying in while it is joining and a seat is free, or the host's open seats while it
 * plays and a late seat is free. The same two doors the table's own Buy in serves.
 */
export function takingPlayers(room: Pick<IGameRoom, "secret" | "seatsOpen">): { phase: TablePhase; seated: number; cap: number } | null {
	const table = (room.secret as HoldemTable | null) ?? null;
	if (!table) return null;
	const cap = seatCapOf(table);
	if (table.status === "joining") {
		return table.seats.length < cap ? { phase: "joining", seated: table.seats.length, cap } : null;
	}
	if (table.status === "playing" && room.seatsOpen && hasLateSeatFree(table)) {
		return { phase: "seatsOpen", seated: livePlayers(table).length + (table.pendingSeats ?? []).length, cap };
	}
	return null;
}

/**
 * The tables one server's board lists: never its own, never one from a server it and
 * the host keep off each other (a block reaches both ways), at most BOARD_MAX_TABLES.
 * Bans and the host's own standing are already applied to `tables` (collectTables), so
 * this is the per viewer half only.
 */
export function boardTablesFor(
	viewer: NetworkGuildConfig,
	tables: readonly BoardTable[],
	hostConfigs: ReadonlyMap<string, NetworkGuildConfig>
): BoardTable[] {
	return tables
		.filter((table) => table.hostGuildId !== viewer.guildId && !blocksEachOther(viewer, hostConfigs.get(table.hostGuildId)))
		.slice(0, NETWORK.BOARD_MAX_TABLES);
}

// ── the board message ─────────────────────────────────────────────────
/** One board message, and a signature that changes only when what it shows changes. */
export interface BoardView {
	embeds: EmbedBuilder[];
	components: ActionRowBuilder<StringSelectMenuBuilder>[];
	signature: string;
}

// What a table's host has set, after its line, when anything is set.
function tableNotes(table: BoardTable): string {
	const notes: string[] = [];
	if (table.ratingBand !== "any") notes.push(words.board.bandNote(bandWords.options[table.ratingBand].label));
	if (table.requireApproval) notes.push(words.board.approvalNote);
	return notes.length > 0 ? ` (${notes.join(", ")})` : "";
}

/** The board as one server reads it. `closed` is a server the owner banned from the network. */
export function buildBoardView(tables: readonly BoardTable[], closed: boolean): BoardView {
	const lines = closed
		? [words.board.closedHere]
		: tables.map(
				(table, index) =>
					`${index + 1}. ${words.board.tableLine(gameRoomsCopy.gameLabel(table.game), table.hostLabel, escapeMarkdown(table.serverName), table.seated, table.cap, table.phase)}${tableNotes(table)}`
		  );
	const body = closed || tables.length > 0 ? `${words.board.description}\n\n${lines.join("\n")}` : `${words.board.description}\n\n${words.board.empty}`;
	const embed = infoEmbed(words.board.title, body, COLORS.ARCADE as ColorResolvable);

	const options = closed ? [] : tables.map((table) => selectOption(table));
	const components =
		options.length > 0
			? [
					new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
						new StringSelectMenuBuilder().setCustomId(NETWORK_BOARD_SELECT_ID).setPlaceholder(words.board.placeholder).setMinValues(1).setMaxValues(1).addOptions(options)
					),
			  ]
			: [];
	return { embeds: [embed], components, signature: JSON.stringify({ body, options }) };
}

// Discord caps a select option's label and description at 100 characters.
const OPTION_TEXT_LIMIT = 100;

function selectOption(table: BoardTable): { label: string; description: string; value: string } {
	return {
		label: words.board.optionLabel(gameRoomsCopy.gameLabel(table.game), table.serverName).slice(0, OPTION_TEXT_LIMIT),
		description: words.board.optionDescription(table.hostName, table.seated, table.cap).slice(0, OPTION_TEXT_LIMIT),
		// The host guild rides beside the roomId because a roomId alone is looked up inside
		// one guild (invariant 2), and networkJoin re-checks every word of it.
		value: `${table.hostGuildId}:${table.roomId}`,
	};
}

// ── collecting the tables ─────────────────────────────────────────────
/**
 * Every listable table, once for every server's board: a network game, still taking
 * players, hosted in a server on the network that is not banned, by a host who is not
 * banned and accepted the network notice (their name is what the board shows elsewhere).
 * Oldest table first, so a table waiting longest for players stays at the top.
 */
export async function collectTables(
	client: Client,
	rooms: readonly IGameRoom[],
	hostConfigs: ReadonlyMap<string, NetworkGuildConfig>,
	bans: readonly INetworkBan[]
): Promise<BoardTable[]> {
	const open = rooms
		.filter((room) => (BOT_CONSTANTS.NETWORK_GAMES as readonly string[]).includes(room.game))
		.filter((room) => isOnNetwork(client, hostConfigs.get(room.guildId)))
		.filter((room) => !isGuildBanned(bans, room.guildId) && !isUserBanned(bans, room.hostId))
		.flatMap((room) => {
			const seats = takingPlayers(room);
			return seats ? [{ room, seats }] : [];
		})
		.sort((first, second) => startedAtOf(first.room) - startedAtOf(second.room));

	const consenting = await consentingAmong(open.map(({ room }) => room.hostId));
	const tables: BoardTable[] = [];
	for (const { room, seats } of open) {
		if (!consenting.has(room.hostId)) continue;
		const host = client.users.cache.get(room.hostId) ?? (await client.users.fetch(room.hostId).catch(() => null));
		tables.push({
			roomId: room.roomId,
			hostGuildId: room.guildId,
			hostId: room.hostId,
			game: room.game,
			...seats,
			ratingBand: room.ratingBand ?? "any",
			requireApproval: room.requireApproval ?? false,
			hostLabel: await playerLabel(client, room.hostId),
			hostName: host?.displayName ?? rokCommanderCopy.arcadeSatellites.unknownPlayer,
			serverName: client.guilds.cache.get(room.guildId)?.name ?? "",
		});
	}
	return tables;
}

const startedAtOf = (room: Pick<IGameRoom, "startedAt" | "createdAt">): number => (room.startedAt ?? room.createdAt ?? new Date(0)).getTime();

// ── refreshing ────────────────────────────────────────────────────────
let activeClient: Client | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshRunning = false;
let refreshQueued = false;
// What each server's board last showed, so an unchanged board is not edited again. Lost
// on a redeploy, which costs one edit per server on the boot refresh, nothing more.
const lastShown = new Map<string, string>();

/** Hand the board the client and draw every board once. Called once at boot from main.ts. Never throws. */
export async function startNetworkBoards(client: Client): Promise<void> {
	activeClient = client;
	await refreshNetworkBoards(client);
}

/**
 * Ask for a refresh of every network board, debounced. Fire and forget: safe to call on
 * every redraw, and a no op until startNetworkBoards has run.
 */
export function scheduleNetworkBoardRefresh(): void {
	const client = activeClient;
	if (!client || refreshTimer) return;
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		void refreshNetworkBoards(client);
	}, NETWORK.BOARD_REFRESH_DEBOUNCE_MS);
	// A pending refresh must never hold the process open on shutdown.
	refreshTimer.unref?.();
}

/** Redraw every network board now. One at a time: an ask during a refresh runs once more after it. Never throws. */
export async function refreshNetworkBoards(client: Client): Promise<void> {
	if (refreshRunning) {
		refreshQueued = true;
		return;
	}
	refreshRunning = true;
	try {
		do {
			refreshQueued = false;
			await runRefresh(client).catch((error) => console.error("[game-rooms] network board refresh failed", error));
		} while (refreshQueued);
	} finally {
		refreshRunning = false;
	}
}

async function runRefresh(client: Client): Promise<void> {
	const [configs, rooms, bans] = await Promise.all([
		guildConfigStore.findNetworkBoardConfigs() as Promise<BoardGuildConfig[]>,
		gameRoomStore.findPlayingNetwork(),
		networkBanStore.findAll(),
	]);
	const byGuild = new Map<string, NetworkGuildConfig>(configs.map((config) => [config.guildId, config]));
	const tables = await collectTables(client, rooms, byGuild, bans);

	for (const config of configs) {
		// Per server, so one server whose channel is gone or whose permissions changed never
		// stops the boards after it.
		try {
			if (isOnNetwork(client, config)) await showBoard(client, config, buildBoardView(boardTablesFor(config, tables, byGuild), isGuildBanned(bans, config.guildId)));
			else await retireBoard(client, config);
		} catch (error) {
			console.warn("[game-rooms] network board refresh failed for one server", { guildId: config.guildId, error });
		}
	}
}

// Post or edit this server's board message. A deleted message is posted again and its new
// id remembered, the way the schedule board recovers.
async function showBoard(client: Client, config: BoardGuildConfig, view: BoardView): Promise<void> {
	if (config.networkBoardMessageId && lastShown.get(config.guildId) === view.signature) return;
	const channel = await challengesChannelOf(client, config);
	if (!channel) return;

	const payload = { embeds: view.embeds, components: view.components };
	const existing = config.networkBoardMessageId ? await channel.messages.fetch(config.networkBoardMessageId).catch(() => null) : null;
	if (existing) {
		await existing.edit(payload);
	}
	else {
		const posted = await channel.send(payload);
		await guildConfigStore.update(config.guildId, { networkBoardMessageId: posted.id });
	}
	lastShown.set(config.guildId, view.signature);
}

// A server that left the network (its admin lowered the reach, or Dero left it) loses its
// board: the message goes and its id is cleared, so a stale list never invites a seat.
async function retireBoard(client: Client, config: BoardGuildConfig): Promise<void> {
	lastShown.delete(config.guildId);
	if (!config.networkBoardMessageId) return;
	const channel = await challengesChannelOf(client, config);
	const message = channel ? await channel.messages.fetch(config.networkBoardMessageId).catch(() => null) : null;
	await message?.delete().catch(() => undefined);
	await guildConfigStore.update(config.guildId, { networkBoardMessageId: null });
}

async function challengesChannelOf(client: Client, config: BoardGuildConfig): Promise<TextChannel | null> {
	if (!config.arcadeChallengesChannelId) return null;
	const channel = await client.channels.fetch(config.arcadeChallengesChannelId).catch(() => null);
	return channel instanceof TextChannel ? channel : null;
}

/** Forget the client, any pending refresh and every remembered board. For tests only. */
export function _resetNetworkBoardsForTests(): void {
	activeClient = null;
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = null;
	refreshRunning = false;
	refreshQueued = false;
	lastShown.clear();
}

export const networkBoard = {
	startNetworkBoards,
	scheduleNetworkBoardRefresh,
	refreshNetworkBoards,
};
