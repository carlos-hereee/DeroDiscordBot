import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── startCountdownState ──────────────────────────────────────────────
// What:  which drafts are counting in right now (2026-10 item 267, decision 13), and how long the
//        count is in the seconds the card says.
// Who:   startCountdown.ts writes it; challengeCard.cardStateFor and the card's embed read it.
// Does NOT: import anything that runs. It is its own module so the card renderer can read it
//        without importing startCountdown, whose speech pulls the whole voice path in.
// Where: memory only: a restart empties it, and a card redrawn after one shows no count.

type DraftKey = { guildId: string; roomId: string };

/** One draft's count: the timer that ends it, and what runs at its end. */
export interface HeldCount {
	timer: NodeJS.Timeout;
	end: () => Promise<void>;
}

const counting = new Map<string, HeldCount>();

const keyOf = (room: DraftKey): string => `${room.guildId}:${room.roomId}`;

/** The countdown's length in the whole seconds the card and Dero say. */
export const countdownSeconds = (): number => Math.round(BOT_CONSTANTS.START_COUNTDOWN_MS / 1000);

export const startCountdownState = {
	/** Whether this draft is counting in: the card's line, and a second Start's refusal. */
	isCountingDown: (room: DraftKey): boolean => counting.has(keyOf(room)),
	/** Mark the draft as counting in. */
	hold: (room: DraftKey, count: HeldCount): void => {
		counting.set(keyOf(room), count);
	},
	/** The count ended: the draft no longer counts. */
	release: (room: DraftKey): void => {
		counting.delete(keyOf(room));
	},
	/** Every count still running, for the test seam that runs them out. */
	held: (): HeldCount[] => [...counting.values()],
	/** Test seam: forget every count and its timer. */
	_reset: (): void => {
		for (const count of counting.values()) clearTimeout(count.timer);
		counting.clear();
	},
};
