import type { ButtonInteraction, Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { acknowledgeConfirm, showConfirm, showNotice, type ConfirmInteraction } from "@utils/textModal.js";
import { applyForfeit, netWorth, type MonopolyResult, type MonopolyState } from "@features/games/monopolyState.js";
import { confirmCustomId } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isBotSeatId } from "./botSeat.js";
import { isTurnHandoffLine } from "./roomMonopolyBoard.js";
import { commitMonopolyMove, monopolyStateOf } from "./roomMonopolyHandlers.js";
import { handHostingOn, hostCandidatesOf, nextFreeHost } from "./hostHandoff.js";

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
// How:   ① find who would host next, writing nothing, ② commit the forfeit with the
//        surrender line (and who hosts now) ahead of the engine's, retried like a removal
//        when a move lands first, ③ end on the standings when the move leaves only bots or
//        nobody to host, ④ only then hand hosting on, since a host who surrendered must not
//        hold the room. Hosting moves AFTER the forfeit lands (2026-10 item 276, audit P3): the
//        other order left a host whose forfeit lost every retry seated without hosting.
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
	// A ranked match says the buy in stays in the pot before Submit (2026-10 item 276, D6).
	const prompt = room.chipPot ? words.surrenderConfirmRanked(room.chipPot.buyIn) : words.surrenderConfirmPrompt;
	await showConfirm(interaction, { title: words.surrenderConfirmTitle, sections: [prompt], confirmId: confirmCustomId("msurrenderok", room.roomId) });
}

/** The confirm's Submit, or the fallback reply's button: surrender, then say how it went. */
export async function handleMsurrenderConfirm(interaction: ConfirmInteraction, room: IGameRoom): Promise<void> {
	// Acknowledged first: the surrender re-reads, may hand hosting on and redraws the board.
	await acknowledgeConfirm(interaction);
	const outcome = await surrenderMonopolySeat(interaction.client, room, interaction.user.id);
	const words = gameRoomsCopy.monopoly;
	const answers: Record<SurrenderOutcome, string> = { surrendered: words.surrenderDone, busy: words.surrenderStillSeated, notInMatch: words.matchOver };
	const answer = outcome === "notInMatch" ? (surrenderRefusal(monopolyStateOf(room), interaction.user.id) ?? answers.notInMatch) : answers[outcome];
	// The confirm was acknowledged above, so no notice can open; the answer posts
	// where it was pressed (2026-10 item 257 Phase 5) instead of a private reply.
	await answerInChannel(interaction, "here", { content: answer });
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
 * GAME_ROOM_KICK_ATTEMPTS times when a move lands first, like the host's removal. The one way a
 * seat leaves of its own accord: Surrender's confirm, and a member leaving the server
 * (roomDeparture, 2026-10 item 276 audit P1-4), whose `leadLine` says why instead of the
 * surrender line.
 */
export async function surrenderMonopolySeat(client: Client, room: IGameRoom, userId: string, leadLine: string = gameRoomsCopy.monopoly.surrendered(userId)): Promise<SurrenderOutcome> {
	for (let attempt = 0; attempt < BOT_CONSTANTS.GAME_ROOM_KICK_ATTEMPTS; attempt++) {
		const fresh = (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? room;
		const state = monopolyStateOf(fresh);
		if (fresh.status !== "playing" || surrenderRefusal(state, userId) || !state) return "notInMatch";

		// ① Only a host leaving a match that goes on needs a successor; with one seat left the
		// forfeit itself ends the match and frees the slot. Read afresh every attempt and nothing
		// written, so a busy board that wins every retry leaves the host hosting and seated.
		const hosting = fresh.hostId === userId && seatsStillIn(state, userId).length > 1;
		const successorId = hosting ? await nextFreeHost(fresh, hostCandidatesOf(fresh, userId)) : null;
		const leadLines = [leadLine, ...(successorId ? [gameRoomsCopy.monopoly.hostHandedOn(successorId)] : [])];

		// ② ③
		const outcome = await commitMonopolyMove(
			client,
			fresh,
			userId,
			(current) => surrenderMove(current, userId, leadLines, hosting && !successorId),
			{ onTurnOnly: false, kind: "forfeit" }
		);
		if (outcome.ok) {
			// ④ The seat is out, so the room is handed on, unless the forfeit ended the match.
			// To the member ① named, else the next in turn order, since the named one may have opened
			// a room of their own meanwhile (the index refuses that move as "taken"). The surrender's
			// board already said who hosts, so only a different member gets a line of their own.
			if (successorId && outcome.state.phase !== "finished") {
				const fallbacks = hostCandidatesOf(fresh, userId).filter((candidate) => candidate !== successorId);
				await handHostingOn(client, fresh, userId, [successorId, ...fallbacks], successorId);
			}
			return "surrendered";
		}
		if (outcome.reason !== gameRoomsCopy.monopoly.boardBusy) return "notInMatch";
	}
	return "busy";
}

const seatsStillIn = (state: MonopolyState, exceptId: string) => state.seats.filter((seat) => !seat.bankrupt && seat.userId !== exceptId);

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
 * driver uses for a match of bots alone (botTurns). Poorest is by net worth (chips, lots
 * and buildings, the engine's netWorth), never chips alone, or a seat that spent its cash
 * on a full set of hotels would lose to one that bought nothing. A tie goes against the
 * later seat. The engine's turn handoffs in between are dropped, since no turn is played.
 */
export function finishOnStandings(state: MonopolyState): { state: MonopolyState; lines: string[] } {
	let current = state;
	const lines: string[] = [];
	while (current.phase !== "finished") {
		const standings = current;
		const poorest = standings.seats
			.map((seat, index) => ({ seat, index, worth: netWorth(standings, seat.userId) }))
			.filter(({ seat }) => !seat.bankrupt)
			.sort((first, second) => first.worth - second.worth || second.index - first.index)[0];
		const result = poorest ? applyForfeit(current, poorest.seat.userId) : null;
		if (!result?.ok) break;
		current = result.state;
		lines.push(...result.trailLines.filter((line) => !isTurnHandoffLine(line)));
	}
	return { state: current, lines };
}

export const roomMonopolySurrender = { handleMsurrender, handleMsurrenderConfirm };
