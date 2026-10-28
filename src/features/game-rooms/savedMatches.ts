import { type Client, type RepliableInteraction, type User } from "discord.js";
import { beginChannelAnswer } from "@utils/answerInChannel.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { confirmSelectValues, showNotice, type ConfirmInteraction, type ConfirmSelect } from "@utils/textModal.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { botSeatIdsFor } from "./botSeat.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { labelForRoom } from "./satelliteRooms.js";

// ── savedMatches ─────────────────────────────────────────────────────
// What:  a player keeping a finished match on their profile (2026-10 item 257 Phase 3b,
//        owner item 23): the choice in the archive confirm, the write it causes, and
//        /account view:saved, the last matches a member kept.
// Who:   gameRoomHandlers (the archive confirm and its Submit) and commands/fun/account.ts.
// Does NOT: archive anything or change a result. The archive runs exactly as before; the
//        save is one more write ahead of it.
//
// ⚠️ Rows that network leave (2026-10 item 248) or the 12 month history window (item 249)
// later remove simply drop out of the list: this view reads GameRoom rows and keeps no copy
// of its own, so neither item has anything here to clean up.

/** The archive confirm select's field id, which the Submit reads the choice back by. */
export const SAVE_FIELD_ID = "savematch";

const SAVE_YES = "yes";
const SAVE_NO = "no";

/** How many saved matches /account view:saved lists. */
export const SAVED_MATCHES_SHOWN = 10;

const copy = gameRoomsCopy.saved;

/** Whether the presser may keep this match: a finished match, and one they played in. */
export function canSaveMatch(room: Pick<IGameRoom, "status" | "playerIds">, userId: string): boolean {
	return room.status === "finished" && room.playerIds.includes(userId);
}

/** The archive confirm's choice, defaulting to no so an untouched Submit archives and saves nothing. */
export function archiveSaveSelect(): ConfirmSelect {
	const words = gameRoomsCopy.confirms.saveToProfile;
	return {
		fieldId: SAVE_FIELD_ID,
		label: words.label,
		options: [
			{ label: words.yes, value: SAVE_YES },
			{ label: words.no, value: SAVE_NO, isDefault: true },
		],
	};
}

/**
 * On the archive Submit: when the presser chose yes, and may, add them to the room's savedBy.
 * Runs BEFORE the archive, which never waits on it and never fails because of it: a failed
 * save is logged and the archive goes on. The room was read again by the confirm's gate, and
 * the store's own playerIds filter holds the rule if it changed since.
 */
export async function saveMatchIfChosen(interaction: ConfirmInteraction, room: IGameRoom): Promise<void> {
	if (!confirmSelectValues(interaction, SAVE_FIELD_ID).includes(SAVE_YES)) return;
	if (!canSaveMatch(room, interaction.user.id)) return;
	try {
		await gameRoomStore.addSavedBy(room.guildId, room.roomId, interaction.user.id);
	} catch (error) {
		console.error("[saved-matches] saving the match to the profile failed", { roomId: room.roomId, userId: interaction.user.id, error });
	}
}

// ── the view ─────────────────────────────────────────────────────────

/** How a match read for one member: they won, someone else did, or the room recorded no winner. */
export function resultFor(room: Pick<IGameRoom, "winnerId">, userId: string): string {
	if (room.winnerId === userId) return copy.results.won;
	return room.winnerId === null ? copy.results.noWinner : copy.results.lost;
}

/** The fields of a room one saved line reads, so a lean row from the store fits it. */
type SavedMatchRow = Pick<IGameRoom, "game" | "playerIds" | "botSeats" | "winnerId" | "endedAt" | "network">;

// The opponents as mentions: the other players, then the Dero bots that sat down. A bot seat
// never lives in playerIds, so its ids are rebuilt the way the seed built them.
function opponentMentions(room: SavedMatchRow, userId: string): string[] {
	const people = room.playerIds.filter((id) => id !== userId);
	const bots = botSeatIdsFor(room.game, room.playerIds.length, room.botSeats);
	return [...people, ...bots].map((id) => `<@${id}>`);
}

/** One saved match as a line: game, result for this member, opponents, finish date. */
export async function savedMatchLine(client: Client, room: SavedMatchRow, userId: string): Promise<string> {
	const mentions = opponentMentions(room, userId);
	const against = mentions.length > 0 ? mentions.join(", ") : room.game.startsWith("solo-") ? "Dero" : "";
	const named = against ? await labelForRoom(client, room, copy.versus(against)) : "";
	const date = room.endedAt ? `<t:${Math.floor(room.endedAt.getTime() / 1000)}:D>` : "";
	return copy.line({ game: gameRoomsCopy.gameLabel(room.game), result: resultFor(room, userId), opponents: named, date });
}

/**
 * Answer /account view:saved with the target's last saved matches, newest finish first, the
 * way /account's other views answer: in 💬dero-commands (2026-10 item 257 Phase 5), acknowledged
 * first because the opponent labels may fetch. Never throws; a failed read answers with the
 * pack's error line.
 */
export async function showSavedMatches(interaction: RepliableInteraction, target: User): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.savedMatches, sections: [copy.outsideGuild] });
		return;
	}
	if (target.bot) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.savedMatches, sections: [copy.botMember] });
		return;
	}

	const answer = await beginChannelAnswer(interaction, "member");
	try {
		const rooms = await gameRoomStore.findSavedBy(guildId, target.id, SAVED_MATCHES_SHOWN);
		const member = interaction.guild?.members.cache.get(target.id) ?? null;
		const name = member?.displayName ?? target.globalName ?? target.username;
		if (rooms.length === 0) {
			await answer.send({ embeds: [infoEmbed(copy.title(name), copy.empty)] });
			return;
		}
		const lines = await Promise.all(rooms.map((room) => savedMatchLine(interaction.client, room, target.id)));
		await answer.send({ embeds: [infoEmbed(copy.title(name), `${lines.join("\n")}\n\n${copy.footer(rooms.length)}`)] });
	} catch (error) {
		console.error("[saved-matches] reading the saved matches failed", { guildId, userId: target.id, error });
		// send never throws: the read already failed and was logged, and a failed answer is logged too.
		await answer.send({ content: copy.readFailed });
	}
}
