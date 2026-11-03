import { type Client, type RepliableInteraction, type User } from "discord.js";
import { beginChannelAnswer } from "@utils/answerInChannel.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { showNotice } from "@utils/textModal.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { botSeatIdsFor } from "./botSeat.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { labelForRoom } from "./satelliteRooms.js";

// ── savedMatches ─────────────────────────────────────────────────────
// What:  a member's match history (2026-10 item 263 decision 2): /account view:saved lists the
//        last matches they finished in this server, read straight from the GameRoom rows they
//        played in, with no save step. Every finished match lands there automatically, and its
//        full turn by turn log is the row's `moves`, which the shared turn board records.
// Who:   commands/fun/account.ts.
// Does NOT: write anything, or show the log itself (watching or previewing a match is a later
//        item). `GameRoom.savedBy`, the old Save this match choice (item 257 Phase 3b), stays
//        in the schema unread: a match a member saved is one they played, so it lists anyway.
//
// ⚠️ Members only, by `playerIds`: a Dero bot seat never lives there, so it never has a history,
// and a spectator watched rather than played. Rows that network leave (2026-10 item 248) or the
// 12 month history window (item 249) later remove simply drop out of the list: this view reads
// GameRoom rows and keeps no copy of its own, so neither item has anything here to clean up.

/** How many finished matches /account view:saved lists. */
export const MATCH_HISTORY_SHOWN = 10;

const copy = gameRoomsCopy.saved;

// ── the view ─────────────────────────────────────────────────────────

/** How a match read for one member: they won, someone else did, or the room recorded no winner. */
export function resultFor(room: Pick<IGameRoom, "winnerId">, userId: string): string {
	if (room.winnerId === userId) return copy.results.won;
	return room.winnerId === null ? copy.results.noWinner : copy.results.lost;
}

/** The fields of a room one history line reads, so a lean row from the store fits it. */
type SavedMatchRow = Pick<IGameRoom, "game" | "playerIds" | "botSeats" | "winnerId" | "endedAt" | "network">;

// The opponents as mentions: the other players, then the Dero bots that sat down. A bot seat
// never lives in playerIds, so its ids are rebuilt the way the seed built them.
function opponentMentions(room: SavedMatchRow, userId: string): string[] {
	const people = room.playerIds.filter((id) => id !== userId);
	const bots = botSeatIdsFor(room.game, room.playerIds.length, room.botSeats);
	return [...people, ...bots].map((id) => `<@${id}>`);
}

/** One finished match as a line: game, result for this member, opponents, finish date. */
export async function savedMatchLine(client: Client, room: SavedMatchRow, userId: string): Promise<string> {
	const mentions = opponentMentions(room, userId);
	const against = mentions.length > 0 ? mentions.join(", ") : room.game.startsWith("solo-") ? "Dero" : "";
	const named = against ? await labelForRoom(client, room, copy.versus(against)) : "";
	const date = room.endedAt ? `<t:${Math.floor(room.endedAt.getTime() / 1000)}:D>` : "";
	return copy.line({ game: gameRoomsCopy.gameLabel(room.game), result: resultFor(room, userId), opponents: named, date });
}

/**
 * Answer /account view:saved with the target's match history, their last finished matches in
 * this server, newest finish first, the way /account's other views answer: in 💬dero-commands
 * (2026-10 item 257 Phase 5), acknowledged first because the opponent labels may fetch. Never
 * throws; a failed read answers with the pack's error line.
 */
export async function showMatchHistory(interaction: RepliableInteraction, target: User): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.matchHistory, sections: [copy.outsideGuild] });
		return;
	}
	if (target.bot) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.matchHistory, sections: [copy.botMember] });
		return;
	}

	const answer = await beginChannelAnswer(interaction, "member");
	try {
		const rooms = await gameRoomStore.findByUserInGuild(guildId, target.id, MATCH_HISTORY_SHOWN);
		const member = interaction.guild?.members.cache.get(target.id) ?? null;
		const name = member?.displayName ?? target.globalName ?? target.username;
		if (rooms.length === 0) {
			await answer.send({ embeds: [infoEmbed(copy.title(name), copy.empty)] });
			return;
		}
		const lines = await Promise.all(rooms.map((room) => savedMatchLine(interaction.client, room, target.id)));
		await answer.send({ embeds: [infoEmbed(copy.title(name), `${lines.join("\n")}\n\n${copy.footer(rooms.length)}`)] });
	} catch (error) {
		console.error("[saved-matches] reading the match history failed", { guildId, userId: target.id, error });
		// send never throws: the read already failed and was logged, and a failed answer is logged too.
		await answer.send({ content: copy.readFailed });
	}
}
