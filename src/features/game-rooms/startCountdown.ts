import type { Client } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { announceToMatch } from "./roomAnnouncer.js";
import { countdownSeconds, startCountdownState } from "./startCountdownState.js";

// ── startCountdown ───────────────────────────────────────────────────
// What:  the host's Start counts the match in (2026-10 item 267, owner decision 13): for
//        START_COUNTDOWN_MS the card says the match starts in ten seconds and Dero says it in the
//        card's call, then the draft is read again and the room opens through the existing
//        provision path only if it is still a draft.
// Who:   challengeBoard's two start paths (Start's confirm and the opponent picker's Submit) begin
//        it and hand in how to open; the card reads startCountdownState for its line.
// Does NOT: open a room, charge a buy in or redraw the card. Opening stays challengeBoard's one
//        provision path, which checks every refusal again on the draft as it stands at the end.
// Where: memory only. ⚠️ A RESTART DURING THE COUNT OPENS NOTHING: the timer dies with the
//        process, the draft stays a draft (its buy ins still on the card's ledger), and the host
//        presses Start again. The card's countdown line goes on its next redraw, because the
//        state starts empty.
//
// Call it off during the count closes the draft (challengeBoard.cancelDraft), and the end of the
// count finds no draft to open: the re-read is the guard, so no cancel path has to find this timer.

/** What a countdown runs when its time is up. */
export interface CountdownStart {
	client: Client;
	/** The draft as the Start read it. */
	room: IGameRoom;
	/** Open the room from the draft as it stands at the end; called only while it is still a draft. */
	open(draft: IGameRoom): Promise<void>;
	/** The draft closed during the count (Call it off, a replaced draft): nothing opens. */
	calledOff(): Promise<void>;
}

/** Whether this draft is counting in right now. */
export const isCountingDown = (room: Pick<IGameRoom, "guildId" | "roomId">): boolean => startCountdownState.isCountingDown(room);

/**
 * Begin the count, or answer false when this draft already counts (a second Start, which the
 * caller answers with a state notice). Synchronous up to the claim, so a caller that checked
 * isCountingDown and begins with no await between cannot start two.
 */
export function beginStartCountdown(start: CountdownStart): boolean {
	if (startCountdownState.isCountingDown(start.room)) return false;
	const end = (): Promise<void> => endCountdown(start);
	startCountdownState.hold(start.room, { timer: setTimeout(() => void end(), BOT_CONSTANTS.START_COUNTDOWN_MS), end });
	void announceToMatch(start.client, start.room, "countdown", deroBrainCopy.dealer.countdown(countdownSeconds()));
	return true;
}

async function endCountdown(start: CountdownStart): Promise<void> {
	startCountdownState.release(start.room);
	try {
		const draft = await gameRoomStore.findByRoomId(start.room.guildId, start.room.roomId);
		if (!draft || draft.status !== "draft") {
			await start.calledOff();
			return;
		}
		await start.open(draft);
	} catch (error) {
		console.error("[game-rooms] the start countdown could not open the room", { roomId: start.room.roomId, error });
	}
}

/**
 * Test seam: end every running count now, as its timer would, and resolve once each has opened
 * its room or found it called off. Lets a suite about what Start opens skip the ten seconds.
 */
export async function _runStartCountdownsOut(): Promise<void> {
	const running = startCountdownState.held();
	for (const count of running) clearTimeout(count.timer);
	await Promise.all(running.map((count) => count.end()));
}
