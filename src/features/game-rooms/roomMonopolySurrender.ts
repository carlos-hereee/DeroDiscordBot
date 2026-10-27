import type { ButtonInteraction, Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { acknowledgeConfirm, showConfirm, showNotice, type ConfirmInteraction } from "@utils/textModal.js";
import { applyForfeit, type MonopolyResult, type MonopolyState } from "@features/games/monopolyState.js";
import { confirmCustomId } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isBotSeatId } from "./botSeat.js";
import { isTurnHandoffLine } from "./roomMonopolyBoard.js";
import { commitMonopolyMove, monopolyStateOf } from "./roomMonopolyHandlers.js";

// ── roomMonopolySurrender ────────────────────────────────────────────
// What:  Surrender, every seat's way out of a Monopoly match (2026-10 item 254, Arcade
//        12): the board's button opens the shared confirm, and its Submit takes the seat out
//        through applyForfeit, the forfeit the host's Remove a player and the idle sweep
//        already use. Two presses in all.
// Who:   gameRoomHandlers routes `msurrender` and `msurrenderok` here, after playersOnly.
// When:  any time the match runs, whoever's turn it is.
// Where: a host who surrenders hands hosting to the next member in turn order who hosts
//        no other open room (the one room per host index decides that), so the match goes
//        on and the old host is free to open another. The match ends only when Dero bots
//        alone would be left, or when every member left already hosts another room; then
//        it ends on the standings as they are (the owner's decision 20a).
// How:   ① hand hosting on first, since a host who surrendered must not hold the room,
//        ② commit the forfeit with the surrender line ahead of the engine's, retried
//        like a removal when a move lands first, ③ end on the standings when the move
//        leaves only bots or nobody to host.
//
// ⚠️ A SURRENDER IS A LOSS, NEVER A REMOVAL. The seat is not written to kickedIds, so a
// rated match rates it like any seat out of the match, and it may join the next one.

// ── the two presses ───────────────────────────────────────────────────
/** The first press: the shared confirm (showConfirm, 2026-10 item 257), whose Submit surrenders. */
export async function handleMsurrender(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const words = gameRoomsCopy.monopoly;
	const refusal = surrenderRefusal(monopolyStateOf(room), interaction.user.id);
	if (refusal) {
		await showNotice(interaction, { title: words.surrenderConfirmTitle, sections: [refusal] });
		return;
	}
	await showConfirm(interaction, { title: words.surrenderConfirmTitle, sections: [words.surrenderConfirmPrompt], confirmId: confirmCustomId("msurrenderok", room.roomId) });
}

/** The confirm's Submit, or the fallback reply's button: surrender, then say how it went. */
export async function handleMsurrenderConfirm(interaction: ConfirmInteraction, room: IGameRoom): Promise<void> {
	// Acknowledged first: the surrender re-reads, may hand hosting on and redraws the board.
	await acknowledgeConfirm(interaction);
	const outcome = await surrenderMonopolySeat(interaction.client, room, interaction.user.id);
	const words = gameRoomsCopy.monopoly;
	const answers: Record<SurrenderOutcome, string> = { surrendered: words.surrenderDone, busy: words.surrenderStillSeated, notInMatch: words.matchOver };
	const answer = outcome === "notInMatch" ? (surrenderRefusal(monopolyStateOf(room), interaction.user.id) ?? answers.notInMatch) : answers[outcome];
	// The confirm was acknowledged above, so no notice can open; the answer posts in
	// 💬dero-commands (2026-10 item 257 Phase 5) instead of a private reply.
	await answerInChannel(interaction, "member", { content: answer });
}

// Why a seat cannot surrender now, or null when it can.
function surrenderRefusal(state: MonopolyState | null, userId: string): string | null {
	const words = gameRoomsCopy.monopoly;
	if (!state) return words.noBoard;
	if (state.phase === "finished") return words.matchOver;
	const seat = state.seats.find((candidate) => candidate.userId === userId);
	if (!seat) return words.notSeated;
	return seat.bankrupt ? words.inventoryOut : null;
}

// ── the surrender ─────────────────────────────────────────────────────
/** How a surrender went: done, nothing to surrender (already out, or the match is over), or still seated after every retry. */
export type SurrenderOutcome = "surrendered" | "notInMatch" | "busy";

/**
 * Take `userId`'s seat out of the match as a surrender. Retried up to
 * GAME_ROOM_KICK_ATTEMPTS times when a move lands first, like the host's removal.
 */
export async function surrenderMonopolySeat(client: Client, room: IGameRoom, userId: string): Promise<SurrenderOutcome> {
	// Decided once: a retry after a busy board must not hand hosting on a second time,
	// and must still say who hosts now.
	let handOff: HandOff | null = null;
	for (let attempt = 0; attempt < BOT_CONSTANTS.GAME_ROOM_KICK_ATTEMPTS; attempt++) {
		const fresh = (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? room;
		const state = monopolyStateOf(fresh);
		if (fresh.status !== "playing" || surrenderRefusal(state, userId) || !state) return "notInMatch";

		// ① Only a host leaving a match that goes on needs a successor; with one seat
		// left the forfeit itself ends the match and frees the slot.
		handOff ??= fresh.hostId === userId && seatsStillIn(state, userId).length > 1 ? await handHostingOn(fresh, state, userId) : { kind: "notHost" };
		const decided = handOff;
		const leadLines = [gameRoomsCopy.monopoly.surrendered(userId), ...(decided.kind === "handedOn" ? [gameRoomsCopy.monopoly.hostHandedOn(decided.successorId)] : [])];

		// ② ③
		const outcome = await commitMonopolyMove(
			client,
			fresh,
			userId,
			(current) => surrenderMove(current, userId, leadLines, decided.kind === "nobodyToHost"),
			{ onTurnOnly: false, kind: "forfeit" }
		);
		if (outcome.ok) return "surrendered";
		if (outcome.reason !== gameRoomsCopy.monopoly.boardBusy) return "notInMatch";
	}
	return "busy";
}

const seatsStillIn = (state: MonopolyState, exceptId: string) => state.seats.filter((seat) => !seat.bankrupt && seat.userId !== exceptId);

type HandOff = { kind: "notHost" } | { kind: "handedOn"; successorId: string } | { kind: "nobodyToHost" } | { kind: "notHostAnyMore" };

// The members still in the match after the host, in turn order from the host's seat, each
// tried until one takes the room: a member who already hosts an open room is skipped, and
// the index's refusal of a race is read the same way. A room no longer hosted by the
// surrendering member (someone else changed it) is left as it is.
async function handHostingOn(room: IGameRoom, state: MonopolyState, hostId: string): Promise<HandOff> {
	const hostIndex = state.seats.findIndex((seat) => seat.userId === hostId);
	const inTurnOrder = state.seats.map((_, step) => state.seats[(hostIndex + 1 + step) % state.seats.length]);
	const members = inTurnOrder.filter((seat) => !seat.bankrupt && seat.userId !== hostId && !isBotSeatId(seat.userId));
	for (const { userId } of members) {
		if (await gameRoomStore.findOpenByHost(room.guildId, userId)) continue;
		const moved = await gameRoomStore.transferHost(room.guildId, room.roomId, hostId, userId);
		if (moved === "taken") continue;
		return moved ? { kind: "handedOn", successorId: userId } : { kind: "notHostAnyMore" };
	}
	// No member left to host (bots alone, or every member hosts elsewhere): the move ends
	// the match, which frees the host's slot by finishing the room.
	return { kind: "nobodyToHost" };
}

/**
 * The surrender as one move against the stored match: the seat forfeits, and when that
 * leaves Dero bots alone or nobody to host, the match ends on its standings. Pure, and
 * re-run by every retry against the fresh state.
 */
export function surrenderMove(state: MonopolyState, userId: string, leadLines: readonly string[], nobodyToHost: boolean): MonopolyResult {
	const forfeit = applyForfeit(state, userId);
	if (!forfeit.ok) return forfeit;
	const lines = [...leadLines, ...forfeit.trailLines];
	if (forfeit.state.phase === "finished") return { ...forfeit, trailLines: lines };

	const botsAlone = seatsStillIn(forfeit.state, userId).every((seat) => isBotSeatId(seat.userId));
	if (!botsAlone && !nobodyToHost) return { ...forfeit, trailLines: lines };
	const ended = finishOnStandings(forfeit.state);
	const reason = botsAlone ? gameRoomsCopy.monopoly.botsAloneEnd : gameRoomsCopy.monopoly.noHostLeftEnd;
	// The surrender's own handoff goes too: no turn is played before the match ends.
	return { ok: true, state: ended.state, trailLines: [...lines.filter((line) => !isTurnHandoffLine(line)), reason, ...ended.lines] };
}

/**
 * End a match on its standings: the poorest seat still in forfeits, then the next, until
 * the richest stands alone and the engine names it the winner, the same order the bot
 * driver uses for a match of bots alone (botTurns). A tie on chips goes against the later
 * seat. The engine's turn handoffs in between are dropped, since no turn is played.
 */
export function finishOnStandings(state: MonopolyState): { state: MonopolyState; lines: string[] } {
	let current = state;
	const lines: string[] = [];
	while (current.phase !== "finished") {
		const poorest = current.seats
			.map((seat, index) => ({ seat, index }))
			.filter(({ seat }) => !seat.bankrupt)
			.sort((first, second) => first.seat.chips - second.seat.chips || second.index - first.index)[0];
		const result = poorest ? applyForfeit(current, poorest.seat.userId) : null;
		if (!result?.ok) break;
		current = result.state;
		lines.push(...result.trailLines.filter((line) => !isTurnHandoffLine(line)));
	}
	return { state: current, lines };
}

export const roomMonopolySurrender = { handleMsurrender, handleMsurrenderConfirm };
