import type { Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { blackjackSeatHoldersOf, sharedTableSeatsOf } from "@features/games/blackjackHandler.js";
import type { HoldemTable } from "@features/games/holdemTable.js";
import { isRankedMatch } from "@features/ratings/ratingEngine.js";
import { botSeatIdsFor, isBotSeatId } from "./botSeat.js";
import { cardStateFor, refreshCard, refreshTableCard } from "./challengeCard.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { roomOpenerEmbed, roomOpenerLogo } from "./gameRoomsEmbeds.js";
import { monopolyStateOf } from "./roomMonopolyBoard.js";
import { resolveRoomChannel, roomTrail } from "./roomTrail.js";

// ── hostHandoff ──────────────────────────────────────────────────────
// What:  moving the hosting of a match in play from one member to another (2026-10 item 276,
//        owner decision D17): Pass host, where the host picks, and the handoff when a host
//        leaves a match that goes on, where the next seat in turn order takes it. Both move
//        hosting through gameRoomStore.transferHost, one conditional write, and then name the
//        new host on the room's trail, its pinned opener and its challenge card.
// Who:   hostControls (Pass host), roomDeparture (a Hold'em or Blackjack host who leaves the
//        server, or forfeits a table that plays on) and roomMonopolySurrender (a host who
//        surrenders), so a host changes one way however it happens.
// Does NOT: decide whether the match goes on without the old host (each game's departure does),
//        or take anyone's seat. Passing hosting keeps the old host seated.
// Why this shape: a host may pass only to a member who could press a host control here, so
//        never a Dero bot (nobody presses for one) and never a player seated from another
//        server (their room is a satellite, where host controls do not run). The one room per
//        host partial unique index refuses a member who already hosts an open room; that is
//        "taken", and the room keeps the host it had.

/** Whether a room is a ranked match: rated, no Dero bots, not casual (ratingEngine.isRankedMatch). */
export const isRankedRoom = (room: Pick<IGameRoom, "game" | "botSeats" | "casual">): boolean => isRankedMatch(room.game, room.botSeats ?? 0, room.casual ?? false);

// ── who may host next ─────────────────────────────────────────────────
/**
 * The members who could take hosting from `hostId`, in turn order from the host's own seat where
 * the game has one: every human still in the match and on this room's own players, never `hostId`
 * itself and never a member the host removed. Empty when nobody can.
 */
export function hostCandidatesOf(room: IGameRoom, hostId: string = room.hostId): string[] {
	const ownPlayers = new Set(room.playerIds ?? []);
	const removed = new Set(room.kickedIds ?? []);
	const inTurnOrder = rotateFrom(seatsStillIn(room), hostId);
	return [...new Set(inTurnOrder)].filter((userId) => userId !== hostId && !isBotSeatId(userId) && ownPlayers.has(userId) && !removed.has(userId));
}

// Every seat still in the match, in the game's seat order, the host's included.
function seatsStillIn(room: IGameRoom): string[] {
	switch (room.game) {
		case "monopoly":
			return (monopolyStateOf(room)?.seats ?? []).filter((seat) => !seat.bankrupt).map((seat) => seat.userId);
		case "holdem": {
			const table = room.secret as unknown as HoldemTable | null;
			const seated = (table?.seats ?? []).filter((seat) => !seat.out).map((seat) => seat.userId);
			return [...seated, ...(table?.pendingSeats ?? []).map((entry) => entry.userId)];
		}
		case "blackjack":
			return room.channelId ? blackjackSeatHoldersOf(room.channelId) : [];
		case "battleship":
			return ((room.secret as { players?: { userId: string }[] } | null)?.players ?? []).map((player) => player.userId);
		default:
			return room.playerIds ?? [];
	}
}

// The seats after `hostId`'s, wrapping round, so the next seat in turn order comes first. A host
// with no seat of their own keeps the game's own order.
function rotateFrom(seats: readonly string[], hostId: string): string[] {
	const at = seats.indexOf(hostId);
	return at < 0 ? [...seats] : [...seats.slice(at + 1), ...seats.slice(0, at)];
}

/**
 * The first candidate who could host, read and never written: one who already hosts an open room
 * cannot take a second. Null when nobody can. Lets a caller name the next host in the same move
 * that takes the old one out (Monopoly's surrender rides the forfeit's board with it).
 */
export async function nextFreeHost(room: Pick<IGameRoom, "guildId">, candidates: readonly string[]): Promise<string | null> {
	for (const userId of candidates) {
		if (!(await gameRoomStore.findOpenByHost(room.guildId, userId))) return userId;
	}
	return null;
}

// ── moving it ─────────────────────────────────────────────────────────
/** How a Pass host went: moved (with the row it wrote), the pick hosts a room already, or the room moved on. */
export type HostPass = { kind: "passed"; room: IGameRoom } | { kind: "taken" } | { kind: "gone" };

/** The host's own Pass host to `toUserId`, named on the trail, the opener and the card once it moved. */
export async function passHosting(client: Client, room: IGameRoom, toUserId: string): Promise<HostPass> {
	const fromHostId = room.hostId;
	const moved = await gameRoomStore.transferHost(room.guildId, room.roomId, fromHostId, toUserId);
	if (moved === "taken") return { kind: "taken" };
	if (!moved) return { kind: "gone" };
	await announceNewHost(client, moved, { actorId: fromHostId, text: gameRoomsCopy.hostPass.trailLine(fromHostId, toUserId) });
	return { kind: "passed", room: moved };
}

/**
 * Hand hosting on from a host who left a match that goes on: to each candidate in turn (the
 * index refuses one who opened a room of their own meanwhile), saying so on the trail unless
 * `announced` already did for that member. With nobody able to host, the trail says the match
 * plays on hostless; the idle sweep, or the match's own end, frees the old host's slot. Answers
 * the new host, or null. A room no longer hosted by `leaverId` (someone else moved it) is left.
 */
export async function handHostingOn(client: Client, room: IGameRoom, leaverId: string, candidates: readonly string[] = hostCandidatesOf(room, leaverId), announced: string | null = null): Promise<string | null> {
	for (const userId of candidates) {
		const moved = await gameRoomStore.transferHost(room.guildId, room.roomId, leaverId, userId);
		if (moved === "taken") continue;
		if (!moved) return null;
		const line = userId === announced ? null : { actorId: leaverId, text: gameRoomsCopy.hostPass.handedOn(userId) };
		await announceNewHost(client, moved, line);
		return userId;
	}
	console.warn("[game-rooms] a departed host could hand the room to nobody", { roomId: room.roomId, hostId: leaverId });
	await roomTrail.postMove(client, room, { actorId: leaverId, kind: "system", text: gameRoomsCopy.hostPass.noHostLeft });
	return null;
}

// The new host on the trail (unless the caller's own board already said it), on the pinned
// opener, which names the host, and on the challenge card, which draws the host's face. The two
// redraws are cosmetic: the row already holds the new host, and every host control reads it.
async function announceNewHost(client: Client, room: IGameRoom, line: { actorId: string; text: string } | null): Promise<void> {
	if (line) await roomTrail.postMove(client, room, { ...line, kind: "system" });
	await redrawOpener(client, room);
	await redrawCard(client, room);
}

async function redrawOpener(client: Client, room: IGameRoom): Promise<void> {
	if (!room.openerMessageId) return;
	try {
		const channel = await resolveRoomChannel(client, room.channelId);
		const opener = channel ? await channel.messages.fetch(room.openerMessageId) : null;
		if (!opener) return;
		const players = [...room.playerIds, ...botSeatIdsFor(room.game, room.playerIds.length, room.botSeats ?? 0)];
		// Embeds only: an edit that names no files keeps the opener's logo, which the ref points at.
		const embed = roomOpenerEmbed(room.game, room.hostId, players, room.visibility, room.spectatorMode ?? null, room.inviteCode ?? null, roomOpenerLogo(room.game)?.ref);
		await opener.edit({ embeds: [embed] });
	} catch (error) {
		console.warn("[game-rooms] could not name the new host on the room's opener", { roomId: room.roomId, error });
	}
}

async function redrawCard(client: Client, room: IGameRoom): Promise<void> {
	try {
		// A ranked table's card is still open (D14) and draws its seats, so it redraws as a table.
		const table = room.game === "blackjack" && room.channelId ? sharedTableSeatsOf(room.channelId) : null;
		if (table) {
			await refreshTableCard(client, room, table);
			return;
		}
		const guild = client.guilds.cache.get(room.guildId) ?? (await client.guilds.fetch(room.guildId).catch(() => null));
		if (guild && room.channelId) await refreshCard(guild, room, cardStateFor(room, { visibility: room.visibility, pool: [], startedChannelId: room.channelId }));
	} catch (error) {
		console.warn("[game-rooms] could not name the new host on the challenge card", { roomId: room.roomId, error });
	}
}
