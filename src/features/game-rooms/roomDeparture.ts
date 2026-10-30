import type { Client } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { leaveBlackjackRoomSeat } from "@features/games/blackjackHandler.js";
import { roomTrail, type RoomMoveInput } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { surrenderMonopolySeat } from "./roomMonopolySurrender.js";
import { removeFromTable } from "./roomHoldemHandlers.js";
import { forfeitBattleship } from "./roomBattleshipHandlers.js";
import { giveUpHangmanRound, isHangmanRoom, leaveHangmanRound } from "./roomHangman.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { refundJoiners } from "./holdemDraftBuyIn.js";
import { refreshDraftCard } from "./challengeBoard.js";

// ── roomDeparture ────────────────────────────────────────────────────
// What:  a player leaving a match in play, game by game (2026-10 item 276, audit P1-4, P2-4
//        and P2-6). Each game's departure is the function its own button already plays:
//        Monopoly's Surrender, Hold'em's and Blackjack's Leave, Battleship's rated forfeit,
//        Hangman's Give up, and the plain forfeit of the one press games.
// Who:   the Forfeit (Surrender, Give up) confirm in gameRoomHandlers, and the server leave
//        watcher (guildMemberRemoveWatcher), so a departure has one path whoever reaches it.
// Why:   the watcher used to finish ANY playing room with the one other human as winner, which
//        ended a Monopoly match or a Hold'em table for everyone over one leave, named the wrong
//        winner and skipped the game's own rating and payout. A member who leaves the server
//        forfeits exactly as if they had pressed Leave or Surrender (owner decision D12).
// What it does NOT do: a solo room, or a draft its HOST left, which the watcher closes as
//        abandoned, since neither has a match left to score. A draft a joiner left goes on
//        without them (leaveDraft below).

/** Why the player is leaving: their own confirmed Forfeit, or leaving the server. */
export type DepartureCause = "forfeit" | "leftServer";

/**
 * Take `userId` out of a match in play through the game's own departure. Each game decides
 * whether the match goes on without them or ends, and who wins. Runs before anything finishes
 * the room, since a Hold'em leave writes only to a playing room (2026-10 item 276 Phase 1).
 */
export async function departMatch(client: Client, room: IGameRoom, userId: string, cause: DepartureCause): Promise<void> {
	const reason = reasonLine(userId, cause);
	switch (room.game) {
		case "monopoly": {
			// The reason rides the turn's board with the forfeit it causes, so it lands once, in
			// that turn's This turn block; it posts on its own only when no seat was taken out.
			const outcome = await surrenderMonopolySeat(client, room, userId, reason.text);
			if (outcome !== "surrendered") await roomTrail.postMove(client, room, reason);
			if (outcome === "busy") console.warn("[game-rooms] a departing seat stayed in its Monopoly match after every retry", { roomId: room.roomId, userId });
			return;
		}
		case "holdem": {
			await roomTrail.postMove(client, room, reason);
			const removal = await removeFromTable(client, room, userId, userId);
			if (removal === "busy") console.warn("[game-rooms] a departing seat stayed at its Hold'em table after every retry", { roomId: room.roomId, userId });
			return;
		}
		case "blackjack":
			await roomTrail.postMove(client, room, reason);
			// No live table in this process means a restart lost it, and boot recovery closes the
			// room and pays its stored stacks; nothing is left here to leave.
			if (room.channelId) await leaveBlackjackRoomSeat(room.channelId, userId);
			return;
		case "battleship":
			await roomTrail.postMove(client, room, reason);
			await forfeitBattleship(client, room, userId);
			return;
		default:
			break;
	}
	if (isHangmanRoom(room)) {
		// Give up says its own result line, the word shown, so it posts no forfeit line.
		if (cause === "forfeit") {
			await giveUpHangmanRound(client, room);
			return;
		}
		await roomTrail.postMove(client, room, reason);
		await leaveHangmanRound(client, room, userId);
		return;
	}
	// The one press games (a coin flip, a dice roll, rock paper scissors): the winner is whoever
	// did not leave, and only when exactly one player remains, so a room losing one of three
	// players resolves to no winner rather than to an arbitrary survivor.
	await roomTrail.postMove(client, room, reason);
	const remaining = room.playerIds.filter((id) => id !== userId);
	await roomLifecycle.finish(client, room, { winnerId: remaining.length === 1 ? remaining[0] : null, outcome: { bucket: "forfeit" } });
}

/**
 * A member who waited in a draft (a joiner, an invitee, a join request, or a player of a draft
 * being built) left the server (2026-10 item 276, found in Phase 2): they leave the draft, their buy
 * in comes back, and the card is redrawn, while everyone else keeps waiting. Closing the whole
 * draft as abandoned refunded and turned away every other joiner over one leave. The refund claims
 * the ledger entry first (refundJoiners), so it pays once whoever else refunds. Answers whether the
 * member was taken out; a draft that started or closed meanwhile is left to its own paths.
 */
export async function leaveDraft(client: Client, room: IGameRoom, userId: string): Promise<boolean> {
	const updated = await gameRoomStore.leaveDraftPool(room.guildId, room.roomId, userId);
	if (!updated) return false;
	await refundJoiners(updated, [userId]);
	const guild = client.guilds.cache.get(room.guildId);
	if (guild) await refreshDraftCard(guild, updated);
	return true;
}

// The line that says why the seat left: a forfeit is a move the player made, a server leave is
// the room telling everyone why the board moved without anyone pressing anything.
function reasonLine(userId: string, cause: DepartureCause): RoomMoveInput {
	if (cause === "forfeit") return { actorId: userId, kind: "forfeit", text: gameRoomsCopy.trail.forfeited(userId) };
	return { actorId: userId, kind: "system", text: gameRoomsCopy.trail.playerLeftGuild(userId) };
}
