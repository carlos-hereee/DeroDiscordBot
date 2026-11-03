import type { BaseMessageOptions, Message, TextChannel } from "discord.js";
import { gameRoomStore, type BoardMessageField } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { roomTrail, type RoomMoveInput } from "./roomTrail.js";
import { setTurnBlock } from "./turnLog.js";

// ── turnBoard ────────────────────────────────────────────────────────
// What:  the one shared turn board (2026-10 item 263 R3-29 and R3-4): a new turn posts its
//        board as a FRESH message at the bottom of the room, carrying that turn's This turn
//        block, and the previous turn's board STAYS in the room with its controls taken off,
//        so the room reads as the match's log and the only live buttons are on the newest
//        board. Moves inside a turn edit that turn's board in place; that is each game's own
//        edit, not this module.
// Who:   every game with a board: Monopoly (roomMonopolyBoard, each turn change), Hold'em
//        (each street, hand end and new hand), Battleship (each shot), Blackjack (a room
//        table's result) and Hangman (each guess's gallows card). No game keeps or deletes a
//        board any other way.
// Where: the board's message id lives on the match (`secret.boardMessageId`, Hangman's
//        `secret.gallowsMessageId`), claimed through gameRoomStore.moveBoardMessage by one
//        conditional dotted write (risk R17: Hold'em's writes still match that id). A room's
//        Blackjack table lives in this process's memory with one writer, so it claims nothing.
// How:   ① send the new board, ② claim it, ③ retire the old board: one edit that drops its
//        components and, when the turn ended on this move, writes the turn's last lines into
//        its block, ④ record what the new board carries. A move the block shows reaches the
//        transcript through recordCarriedMoves after the message showing it was sent or
//        edited (roomTrail's send first rule), and is never also posted as its own line.
//
// ⚠️ THE NEW BOARD IS CLAIMED BEFORE THE OLD ONE IS RETIRED. A crash between the two leaves two
// boards with live controls (a control carries the room id, not the message id), the newer of
// which the row points at; the reverse order would leave a room with no live board.

// Discord's ceiling on a message's content; a send past it is refused whole.
const DISCORD_MESSAGE_LENGTH = 2000;

/** What a new turn's board also writes, records, or leaves on the board it replaces. */
export interface TurnBoardOptions {
	/** Moves the new board's block shows that the transcript does not hold yet, recorded once it is claimed. */
	carried?: readonly RoomMoveInput[];
	/** Extra dotted fields written in the SAME claim as the board id (Hold'em's reveal stamp). */
	alsoSet?: Record<string, unknown>;
	/**
	 * The finished turn's last look: its whole block (already labelled the way the room shows
	 * lines) for the board it ran on, and the moves in it no message showed yet. Set when the
	 * move that ended a turn has lines of its own (Monopoly's last lines before the handoff,
	 * the bet that closed a Hold'em street, the Blackjack action that ended the hand).
	 */
	closing?: { block: readonly string[]; moves: readonly RoomMoveInput[] };
	/** Where the match keeps its board's id; null for a table held in this process (Blackjack). */
	boardField?: BoardMessageField | null;
}

/**
 * Post a new turn's board and retire the previous one. Pings nobody: a board names players in
 * its embed, which never pings. Answers the new message's id, or null when the claim was lost
 * (another placement moved the board first). A lost claim KEEPS the newcomer with its controls
 * off and still records what it carries, because the moves on it were shown and a deleted
 * board would take them out of the room and the transcript both (risk R6).
 */
export async function postTurnBoard(
	channel: TextChannel,
	room: Pick<IGameRoom, "guildId" | "roomId">,
	fromId: string | null,
	payload: BaseMessageOptions,
	options: TurnBoardOptions = {}
): Promise<string | null> {
	const posted = await channel.send({ ...payload, allowedMentions: { parse: [] } });
	if (!(await claimBoard(room, fromId, posted.id, options))) {
		await retireBoard(posted, null, room);
		await roomTrail.recordCarriedMoves(room, options.carried ?? []);
		return null;
	}
	const old = fromId ? await channel.messages.fetch(fromId).catch(() => null) : null;
	const closed = old ? await retireBoard(old, options.closing?.block ?? null, room) : false;
	if (options.closing && options.closing.moves.length > 0) {
		if (closed) await roomTrail.recordCarriedMoves(room, options.closing.moves);
		else await postClosingLines(channel, room, options.closing);
	}
	await roomTrail.recordCarriedMoves(room, options.carried ?? []);
	return posted.id;
}

/**
 * The finished turn's last lines when its board is gone (an admin deleted it, or the match never
 * stored one): posted as one plain message instead, so each line is still in the room once and
 * in the transcript once (risk R6). Its tail of the block is exactly those lines, already
 * labelled, since a block shows its newest lines last. Pings nobody. Never throws.
 */
async function postClosingLines(channel: TextChannel, room: Pick<IGameRoom, "guildId" | "roomId">, closing: NonNullable<TurnBoardOptions["closing"]>): Promise<void> {
	const lines = closing.block.slice(-closing.moves.length);
	try {
		await channel.send({ content: lines.join("\n").slice(0, DISCORD_MESSAGE_LENGTH), allowedMentions: { parse: [] } });
	} catch (error) {
		// Send first, so a line nobody saw is never recorded (roomTrail's rule).
		console.warn("[game-rooms] a finished turn's last lines could not be posted", { roomId: room.roomId, error });
		return;
	}
	await roomTrail.recordCarriedMoves(room, closing.moves);
}

// ② The claim, by the field the match keeps its board in. A table held in memory has one
// writer, its own process, so its board is claimed by being posted.
async function claimBoard(room: Pick<IGameRoom, "guildId" | "roomId">, fromId: string | null, toId: string, options: TurnBoardOptions): Promise<boolean> {
	const field = options.boardField === undefined ? "boardMessageId" : options.boardField;
	if (field === null) return true;
	const claimed = await gameRoomStore.moveBoardMessage(room.guildId, room.roomId, fromId, toId, options.alsoSet ?? {}, field);
	return Boolean(claimed);
}

/**
 * Take a kept board's controls off, and when `block` is given write it into the board's This
 * turn block. Answers whether the edit landed. Logged rather than thrown: a board that keeps its
 * buttons still works (the row points past it), and a board an admin deleted is simply gone.
 * `content: null` takes off the drawing status the new turn's redraw put on this board while it
 * drew (drawingPause shows it on the board the room is looking at), which a kept board would
 * otherwise show for good.
 *
 * ⚠️ AN EDITED EMBED MUST POINT ITS PICTURE BACK AT THE ATTACHMENT BY NAME. The embed read off
 * a posted message carries the picture's CDN address, and an edit that sends the embed with
 * that address unbinds the attachment, which Discord then shows a second time loose under the
 * embed. `attachment://<name>` binds it again, and an edit that names no files keeps the file.
 */
async function retireBoard(board: Message, block: readonly string[] | null, room: Pick<IGameRoom, "roomId">): Promise<boolean> {
	try {
		const embed = block ? board.embeds?.[0] : undefined;
		if (!embed) {
			await board.edit({ content: null, components: [] });
			return block === null;
		}
		const updated = setTurnBlock(embed, block ?? []);
		const picture = attachedPictureName(board, updated.data.image?.url);
		if (picture) updated.setImage(`attachment://${picture}`);
		await board.edit({ content: null, embeds: [updated], components: [] });
		return true;
	} catch (error) {
		console.warn("[game-rooms] a kept board could not be retired", { roomId: room.roomId, error });
		return false;
	}
}

// The name of the message's own attachment the embed's picture shows, or null when the picture
// is not one of them (a text board, or an image hosted elsewhere).
function attachedPictureName(board: Message, imageUrl: string | undefined): string | null {
	if (!imageUrl || imageUrl.startsWith("attachment://")) return null;
	const path = imageUrl.split("?")[0];
	for (const attachment of board.attachments?.values() ?? []) {
		if (path.endsWith(`/${attachment.name}`)) return attachment.name;
	}
	return null;
}
