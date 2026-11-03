import type { Client, TextChannel } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { registerDealerTable } from "@features/dero-brain/dealerNarration.js";
import { isVoiceEnabled } from "@features/voice/callAnnouncer.js";
import { voiceQueue } from "@features/voice/voiceQueue.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import type { VoicePriorityCategory } from "@features/voice/voicePriority.js";
import { cardVoiceState } from "./cardVoiceState.js";
import { challengeBadge } from "./challengeBoardEmbeds.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { postRefereeLine, postRefereeNotice } from "./roomMonopolyRefereeNotice.js";
import { offersReferee, refereeOn } from "./roomTypes.js";

// ── roomReferee ──────────────────────────────────────────────────────
// What:  Dero as a match's voice referee, on the games that have voice lines (Monopoly and
//        Hold'em, roomTypes.REFEREE_GAMES), from the moment the match starts (2026-10 item
//        257 Phase 4b, owner item 9, decision 13): the start step that registers Hold'em's
//        dealer as a voice table and asks the voice queue for the host's call. The flag
//        itself is read through roomTypes.refereeOn everywhere.
// Who:   RoomProvisioner.seedRoom, for a first match and a rematch alike.
// Does NOT: speak a line. Monopoly's key moments stay roomMonopolyReferee's, Hold'em's stay
//        the dealer narration's; this only puts Dero where they can be heard.
// Where: this SUPERSEDES 2026-10 item 254 decision 16 ("the referee never joins a call by
//        itself") for these two games, by the item 257 assumption the owner locked in: with
//        the referee on and voice switched on, the match start asks for the HOST's own call,
//        through voiceQueue.requestVoice, so a call Dero is already in is never left. With
//        the host in no call, the existing silent notice and its fix button post instead.

/**
 * The queue category a match's request waits in: one helper decides rated against casual
 * for the badge, so the queue can never rank a match differently from what its card said.
 * Shared by the referee and the challenge card's own request (cardVoice.ts).
 */
export function matchCategory(room: IGameRoom): VoicePriorityCategory {
	return challengeBadge(room.game, room.botSeats ?? 0, room.casual ?? false) === "rated" ? "rated-match" : "casual-match";
}

/**
 * Start the referee of a match that just opened, when the host turned it on. Fire and
 * forget (rulebook convention 7): it never throws, and the caller does not wait for a voice
 * join that can take seconds. `room` is the row as it stands once playing, so it carries
 * the room's channel id.
 */
export async function startRoomReferee(client: Client, room: IGameRoom, channel: TextChannel): Promise<void> {
	if (!offersReferee(room.game) || !refereeOn(room)) return;
	try {
		// ① Registered first and synchronously, so the table's first action already narrates.
		// A voice table: the dealer speaks only when a call exists at the moment of speaking,
		// so a table whose call comes later (the queue below) starts speaking then.
		if (room.game === "holdem") registerDealerTable({ roomId: room.roomId, guildId: room.guildId, channelId: channel.id, voice: true });

		// One call per card (2026-10 item 267 decision 11): the card this room opened from
		// already asked for Dero, so he is in the call it brought him into, waits in line for
		// it, or was refused with a line on the card. A second request would only repeat it.
		if (cardVoiceState.wasRequested(room.roomId)) return;

		// ② Voice switched off: the notice whose button an admin presses to switch it on.
		if (!(await isVoiceEnabled(room.guildId))) {
			await postRefereeNotice(client, room, "voiceOff");
			return;
		}

		// ③ The host in no call: the notice and its Bring Dero into the call, unless Dero is
		// already in a call, which a player can join (Monopoly's referee says so on a move).
		const hostCallId = channel.guild.voiceStates.cache.get(room.hostId)?.channelId ?? null;
		const call = voiceSessions.get(room.guildId);
		if (!hostCallId) {
			if (!call) await postRefereeNotice(client, room, "noCall");
			return;
		}
		if (call?.channelId === hostCallId) return;

		// ④ The request, at the match's own priority. It joins at once when Dero is free and
		// otherwise waits its place, which the room is told, as a /dero join requester is.
		// A game's request: the runner skips the task speaker list (narrating a match is not a
		// task) and says on this room's channel why a join it could not make did not happen.
		const place = await voiceQueue.requestVoice({
			guild: channel.guild,
			requesterId: room.hostId,
			channelId: hostCallId,
			controlChannelId: channel.id,
			category: matchCategory(room),
			gameVoice: { roomId: room.roomId, followsHost: true, subject: gameRoomsCopy.cardVoice.roomSubject(room.game, channel.id) },
		});
		if (place) {
			await postRefereeLine(client, room, { content: gameRoomsCopy.monopoly.refereeQueued(place.place, place.total), allowedMentions: { parse: [] } });
			return;
		}
		// The join notice lands in the room below the board, which stays where it is: a turn keeps ONE board (2026-10 item 263).
	} catch (error) {
		console.error("[game-rooms] the referee could not start", { roomId: room.roomId, error });
	}
}
