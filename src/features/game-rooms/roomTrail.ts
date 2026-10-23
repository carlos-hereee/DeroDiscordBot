import { type Client, type TextChannel } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { labelForRoom, relayMove } from "./satelliteRooms.js";
import type { RoomMoveKind } from "./roomTypes.js";

// ── roomTrail ────────────────────────────────────────────────────────
// What:  posts one move into the room's channel AND appends it to the room's
//        transcript, in that order, as a single operation.
// Who:   THE function every game in a room calls. Hangman's guess handler, rps's pick,
//        the forfeit control, and the join notice all go through this and nothing else.
// When:  once per move.
// Where: this is requirement F8's single source of truth. The Discord scroll and the
//        Mongo transcript are two renderings of one history, and the only way they
//        cannot disagree is if exactly one function writes both (house rule 17).
// How:   send FIRST, append SECOND, and never the reverse. See the ordering note below.

export interface RoomMoveInput {
	actorId: string;
	kind: RoomMoveKind;
	// Already composed by the caller: "played E", "revealed a hint". The trail renders
	// it verbatim, which is what keeps each game's voice with the game.
	text: string;
	// Persisted for the future dashboard, never rendered into Discord.
	meta?: Record<string, unknown>;
}

// Resolve the room's channel, or null when it is gone. A non-null channelId does NOT
// prove the channel still exists: an admin can delete a room channel at any moment,
// and the row outlives the channel by design. Exported for the room surfaces that
// post or edit something other than a move (hangman's opener and gallows card).
export async function resolveRoomChannel(client: Client, channelId: string | null): Promise<TextChannel | null> {
	if (!channelId) return null;
	const channel = await client.channels.fetch(channelId).catch(() => null);
	if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
	return channel as TextChannel;
}

// Post a move and record it. Returns false when the move never reached the channel,
// in which case NOTHING was written to the transcript.
//
// A network table (2026-10 item 244 Phase 5a) shows the line with its players NAMED
// rather than mentioned, since a mention of a member of another server does not resolve,
// and then relays that same line to every satellite. The transcript keeps the line with
// its ids, which is the history; the names are only how a channel shows it.
export async function postMove(
	client: Client,
	room: Pick<IGameRoom, "guildId" | "roomId" | "channelId"> & Partial<Pick<IGameRoom, "network" | "satellites">>,
	move: RoomMoveInput
): Promise<boolean> {
	const channel = await resolveRoomChannel(client, room.channelId);
	if (!channel) {
		console.warn("[game-rooms] move dropped, room channel unresolvable", {
			guildId: room.guildId,
			roomId: room.roomId,
			channelId: room.channelId,
		});
		return false;
	}

	const shown = await labelForRoom(client, { network: room.network ?? false }, move.text);
	try {
		// ⚠️ THE ALLOWED MENTIONS PIN IS A SECURITY CONTROL, NOT A COURTESY. Move text is
		// composed from user input in places (a hangman hint the host authored, a display
		// name), and an unpinned send would let "@everyone" inside that text ping the
		// whole server from the bot's mouth. The allowlist names exactly one user id, so
		// every role mention, @everyone and @here in the text renders as inert plain text.
		//
		// ⚠️ AND NEVER A `files` ATTACHMENT. A move is a line of text by definition; an
		// attachment path here would be an unbounded upload surface driven by whatever a
		// game passed in, on a per-move cadence.
		await channel.send({
			content: shown,
			allowedMentions: { users: [move.actorId] },
		});
	} catch (error) {
		// The send failed, so the append must not happen. A transcript row for a move the
		// players never saw is UNRECOVERABLE: the dashboard would show a move that is
		// absent from the channel and nobody could tell which one lied. A missing row
		// after a successful send is merely a gap, which is the tolerable direction.
		console.error("[game-rooms] move send failed, transcript deliberately not written", {
			guildId: room.guildId,
			roomId: room.roomId,
			error,
		});
		return false;
	}

	try {
		await gameRoomStore.appendMove(room.guildId, room.roomId, {
			actorId: move.actorId,
			at: new Date(),
			kind: move.kind,
			text: move.text,
			meta: move.meta,
		});
	} catch (error) {
		// Loud, and then continue. The players saw the move; the room is still playable,
		// and failing the caller here would make a Mongo blip look like a rejected move.
		console.error("[game-rooms] move posted but transcript append failed", {
			guildId: room.guildId,
			roomId: room.roomId,
			error,
		});
	}

	// The satellites last, after the host room has the line: never awaited, and a
	// satellite that fails cannot turn a move the players saw into a rejected one.
	if (room.satellites?.length) void relayMove(client, { roomId: room.roomId, satellites: room.satellites }, shown);

	return true;
}

export const roomTrail = { postMove };
