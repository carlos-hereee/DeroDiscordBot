import { TextChannel, type Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { mapWithConcurrency } from "@utils/mapWithConcurrency.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { expireTurn } from "@features/games/battleshipState.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import {
	deserializeMatch,
	serializeMatch,
	publicBoardEmbed,
	battleshipRows,
	type StoredBattleship,
} from "./roomBattleship.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomTurnSweep ────────────────────────────────────────────────────
// What:  forfeits a battleship turn nobody took, and the MATCH after two in a row.
// Who:   the 5 minute room cron, beside the archive sweep.
// When:  every tick, over every live battleship match in every guild.
// Where: ⚠️ THIS IS THE THING THAT MAKES AN ABANDONED MATCH TERMINATE AT ALL, and
//        without it the failure is not "a slow game" but a permanent one: a player
//        who closes Discord leaves their opponent unable to fire, the room never
//        reaches `finish`, `archiveAt` is therefore never stamped (it has exactly
//        one writer), the archive sweep never sees the room, and it holds its
//        host's one-room slot forever. Every other game here resolves in a single
//        press or when its word is guessed, so battleship is the only one that can
//        be abandoned MID-match, which is why this sweep is game-scoped.
// How:   compare the last move's timestamp against the turn budget, call the pure
//        `expireTurn`, and either pass the turn or end the match.

export interface TurnSweepSummary {
	turnsExpired: number;
	matchesForfeited: number;
}

// When this match last saw activity. The move trail is the record of that: every
// shot appends one entry, so its last timestamp is the last time somebody played.
//
// A match with NO moves falls back to `startedAt`, which is what gives the first
// player a full turn budget rather than an instant expiry on the next tick.
function lastActivityAt(room: IGameRoom): number {
	const moves = room.moves ?? [];
	const last = moves.length > 0 ? moves[moves.length - 1]?.at : null;
	const stamp = last ?? room.startedAt;
	return stamp ? new Date(stamp).getTime() : 0;
}

async function redrawBoard(client: Client, room: IGameRoom, stored: StoredBattleship): Promise<void> {
	if (!stored.boardMessageId || !room.channelId) return;
	const channel = await client.channels.fetch(room.channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return;
	const message = await channel.messages.fetch(stored.boardMessageId).catch(() => null);
	if (!message) return;

	const state = deserializeMatch(stored);
	await message
		.edit({ embeds: [publicBoardEmbed(state)], components: battleshipRows(room.roomId, state) })
		.catch((error) => console.warn("[game-rooms] turn sweep failed to redraw the board", error));
}

export async function sweepBattleshipTurns(client: Client, now: Date = new Date()): Promise<TurnSweepSummary> {
	const rooms = await gameRoomStore.findPlayingByGame("battleship");
	if (rooms.length === 0) return { turnsExpired: 0, matchesForfeited: 0 };

	let turnsExpired = 0;
	let matchesForfeited = 0;

	await mapWithConcurrency(rooms, BOT_CONSTANTS.SCHEDULER_GUILD_CONCURRENCY, async (room) => {
		try {
			const stored = room.secret as StoredBattleship | null;
			// A room whose match never started, or whose secret is some other game's
			// shape, is not this sweep's business.
			if (!stored?.players) return;

			const idleFor = now.getTime() - lastActivityAt(room);
			if (idleFor < BOT_CONSTANTS.GAME_ROOM_TURN_TIMEOUT_MS) return;

			const state = deserializeMatch(stored);
			if (state.status !== "playing") return;

			// Whose turn is being forfeited, captured BEFORE expireTurn mutates the
			// state, because it passes the turn to the other player.
			const loserId = state.players[state.turn].userId;
			const result = expireTurn(state);
			const next = serializeMatch(state, { pending: stored.pending, boardMessageId: stored.boardMessageId });
			await gameRoomStore.update(room.guildId, room.roomId, { secret: next as never });

			// The expiry is a MOVE: it belongs in the transcript that is the product,
			// and it is the only record of why the match ended the way it did.
			await roomTrail.postMove(client, room, {
				actorId: loserId,
				kind: "system",
				text: result.forfeited
					? gameRoomsCopy.battleship.forfeitedMatch(loserId)
					: gameRoomsCopy.battleship.forfeitedTurn(loserId),
				meta: { expired: true },
			});

			await redrawBoard(client, room, next);

			if (!result.forfeited) {
				turnsExpired++;
				return;
			}

			matchesForfeited++;
			await roomLifecycle.finish(client, room, { winnerId: result.winnerId });

			// The win still pays, because the opponent turning up and the other player
			// not is exactly the behaviour being rewarded. No sink bonus is involved:
			// nothing was sunk by walking away.
			const [a, b] = room.playerIds;
			awardTwoPlayerResult({
				client,
				guildId: room.guildId,
				channelId: room.channelId,
				game: "battleship",
				challenger: { id: a } as never,
				opponent: { id: b } as never,
				winner: result.winnerId === a ? "challenger" : "opponent",
			});
		} catch (error) {
			// Isolated per ROOM. This runs on a cron with nobody watching, so a throw
			// would be swallowed by the tick wrapper while every other stalled match
			// stayed stalled.
			console.error("[game-rooms] turn sweep failed for one room", {
				guildId: room.guildId,
				roomId: room.roomId,
				error,
			});
		}
	});

	if (turnsExpired > 0 || matchesForfeited > 0) {
		console.log(`[game-rooms] turn sweep: ${turnsExpired} turn(s) expired, ${matchesForfeited} match(es) forfeited`);
	}
	return { turnsExpired, matchesForfeited };
}
