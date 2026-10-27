import { type ActionRowBuilder, type ButtonBuilder, type Client, type Message, type TextChannel } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { labelForRoom, relayMove } from "./satelliteRooms.js";
import type { RoomMoveKind } from "./roomTypes.js";
import { memberIdsOnly } from "./botSeat.js";

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
//        Monopoly is the one game that gathers lines (postMoveLog, recordCarriedMoves),
//        so its board can stay the last message; the same order binds both.

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
			// A Dero bot seat's id is not a snowflake, and Discord refuses the whole send
			// when allowed_mentions names one (2026-10 item 250 Phase 5), so a bot's move pings nobody.
			allowedMentions: { users: memberIdsOnly([move.actorId]) },
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

// ── the turn prompt line (2026-10 item 257 Phase 4a) ──
/**
 * Post the line that pings the member on the clock, with the buttons it carries. The same
 * sending rules as postMove: the channel is resolved first, the line is labelled for the room,
 * and the mention allowlist names exactly the one member whose turn it is, so no other text in
 * the line can ping anybody. Writes NOTHING to the transcript: a prompt is not a move, and the
 * move it asks for lands there when it is played. Answers the sent message (its id is what the
 * prompt is edited through later) or null when it never reached the channel. Never throws.
 */
export async function postTurnPrompt(
	client: Client,
	room: Pick<IGameRoom, "guildId" | "roomId" | "channelId"> & Partial<Pick<IGameRoom, "network">>,
	prompt: { playerId: string; text: string; components: ActionRowBuilder<ButtonBuilder>[] }
): Promise<Message | null> {
	const channel = await resolveRoomChannel(client, room.channelId);
	if (!channel) return null;
	try {
		const shown = await labelForRoom(client, { network: room.network ?? false }, prompt.text);
		return await channel.send({ content: shown, components: prompt.components, allowedMentions: { users: memberIdsOnly([prompt.playerId]) } });
	} catch (error) {
		console.error("[game-rooms] the turn prompt could not be sent", { guildId: room.guildId, roomId: room.roomId, error });
		return null;
	}
}

// ── several moves in one message (2026-10 item 254, Arcade 8) ─────────
// Monopoly gathers a turn's lines rather than posting one message per line, so its
// board can stay the last message in the room. The rule above holds unchanged: a
// line reaches the transcript only after the message carrying it was sent or edited.

// Discord's ceiling on a message's content.
const MAX_CONTENT_LENGTH = 2000;

// The lines packed into as few messages as fit. One turn almost always fits in one;
// a turn long enough not to (a run of bids and trades) takes a second rather than
// losing its tail to Discord's refusal of the whole send.
function packLines(lines: readonly string[]): string[] {
	const messages: string[] = [];
	let current = "";
	for (const line of lines) {
		const clipped = line.slice(0, MAX_CONTENT_LENGTH);
		const joined = current ? `${current}\n${clipped}` : clipped;
		if (joined.length <= MAX_CONTENT_LENGTH) {
			current = joined;
			continue;
		}
		messages.push(current);
		current = clipped;
	}
	if (current) messages.push(current);
	return messages;
}

/**
 * Append moves that a message the CALLER already sent or edited shows, in order. For a
 * surface that carries its lines itself, such as the Monopoly board: call it only after
 * that send or edit resolved, which is what keeps the send first rule. Never throws.
 */
export async function recordCarriedMoves(room: Pick<IGameRoom, "guildId" | "roomId">, moves: readonly RoomMoveInput[]): Promise<void> {
	for (const move of moves) {
		try {
			await gameRoomStore.appendMove(room.guildId, room.roomId, { actorId: move.actorId, at: new Date(), kind: move.kind, text: move.text, meta: move.meta });
		} catch (error) {
			// The same tolerable direction as postMove: the players saw the line.
			console.error("[game-rooms] carried move shown but transcript append failed", { guildId: room.guildId, roomId: room.roomId, error });
		}
	}
}

/**
 * Post several lines as one message (two only past Discord's length limit), then
 * append `moves`, the lines among them the transcript does not hold yet. `shown` may
 * open with lines already recorded when an earlier message carried them, such as a
 * Monopoly turn's lines that rode the board while the turn ran. Pings nobody: a log
 * of a finished turn is read, not answered. False, with nothing appended, when a
 * message did not reach the channel.
 */
export async function postMoveLog(
	client: Client,
	room: Pick<IGameRoom, "guildId" | "roomId" | "channelId"> & Partial<Pick<IGameRoom, "network" | "satellites">>,
	log: { shown: readonly string[]; moves: readonly RoomMoveInput[] }
): Promise<boolean> {
	if (log.shown.length === 0) return true;
	const channel = await resolveRoomChannel(client, room.channelId);
	if (!channel) {
		console.warn("[game-rooms] move log dropped, room channel unresolvable", { guildId: room.guildId, roomId: room.roomId, channelId: room.channelId });
		return false;
	}

	const labelled = await Promise.all(log.shown.map((line) => labelForRoom(client, { network: room.network ?? false }, line)));
	const messages = packLines(labelled);
	try {
		// The same pin as postMove's, emptied: a log names players, and none of them is asked to act on it.
		for (const content of messages) await channel.send({ content, allowedMentions: { parse: [] } });
	} catch (error) {
		console.error("[game-rooms] move log send failed, transcript deliberately not written", { guildId: room.guildId, roomId: room.roomId, error });
		return false;
	}

	await recordCarriedMoves(room, log.moves);
	if (room.satellites?.length) for (const content of messages) void relayMove(client, { roomId: room.roomId, satellites: room.satellites }, content);
	return true;
}

export const roomTrail = { postMove, postMoveLog, postTurnPrompt, recordCarriedMoves };
