import type { BaseMessageOptions, TextChannel } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { roomTrail, type RoomMoveInput } from "./roomTrail.js";

// ── roomBoardRepost ──────────────────────────────────────────────────
// What:  posts a game's table as a FRESH message at the bottom of its room and retires the
//        old one (2026-10 item 257 Phase 4a). A table that is only ever edited in place ends
//        up buried under the turn lines and prompts that post after it; reposting it when a
//        round reveals something keeps the live table where the players are looking.
// Who:   Monopoly (roomMonopolyBoard, every turn change, exactly as before), Hold'em (every
//        street and every showdown) and Battleship (every shot). Blackjack posts its result
//        the same way from its own in memory table.
// Where: the board's message id lives on the match, `secret.boardMessageId`, claimed through
//        gameRoomStore.moveBoardMessage by one conditional dotted write.
//
// ⚠️ THE NEW BOARD IS CLAIMED BEFORE THE OLD ONE IS DELETED. A crash between the two leaves two
// boards, both of whose buttons still work (a control carries the room id, not the message id)
// and the newer of which the row points at; the reverse order would leave a room with no board.

/** What a repost may also write or record. */
export interface RepostOptions {
	/** Transcript lines the fresh board carries, appended once the board is claimed. */
	carried?: readonly RoomMoveInput[];
	/** Extra dotted fields written in the SAME claim as the board id (Hold'em's reveal stamp). */
	alsoSet?: Record<string, unknown>;
}

/**
 * ① send, ② claim the id (null when another placement moved it first, in which case the
 * newcomer is withdrawn and nothing is recorded), ③ record what it carries, ④ delete the old
 * board. Pings nobody: a board names players in its embed, which never pings. Answers the new
 * message's id, or null when the claim was lost.
 */
export async function repostRoomBoard(
	channel: TextChannel,
	room: Pick<IGameRoom, "guildId" | "roomId">,
	fromId: string | null,
	payload: BaseMessageOptions,
	options: RepostOptions = {}
): Promise<string | null> {
	const posted = await channel.send({ ...payload, allowedMentions: { parse: [] } });
	const claimed = options.alsoSet
		? await gameRoomStore.moveBoardMessage(room.guildId, room.roomId, fromId, posted.id, options.alsoSet)
		: await gameRoomStore.moveBoardMessage(room.guildId, room.roomId, fromId, posted.id);
	if (!claimed) {
		await posted.delete().catch(() => undefined);
		return null;
	}
	await roomTrail.recordCarriedMoves(room, options.carried ?? []);
	if (!fromId) return posted.id;
	const old = await channel.messages.fetch(fromId).catch(() => null);
	// Logged rather than thrown: a leftover board still works, and the row points past it.
	await old?.delete().catch((error: unknown) => console.warn("[game-rooms] the old board could not be deleted", { roomId: room.roomId, error }));
	return posted.id;
}
