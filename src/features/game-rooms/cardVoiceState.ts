// ── cardVoiceState ───────────────────────────────────────────────────
// What:  what a challenge card knows about its own Dero voice request (2026-10 item 267,
//        decisions 11 and 12): Dero busy elsewhere, so the host may queue the card, or the
//        card's request waiting at a place in line. Plus which rooms already asked for Dero,
//        so the room that opens from a card does not ask a second time.
// Who:   cardVoice.ts writes it; challengeCard.cardStateFor reads it for the card's line and
//        its Queue Dero button; roomReferee.startRoomReferee reads `wasRequested`.
// Does NOT: import anything. It is its own module so the card renderer can read it without
//        importing cardVoice, which imports the card renderer back.
// Where: memory only, beside the voice queue it mirrors: a restart empties both, and a card
//        redrawn after one simply shows no voice line.

/** A card's voice line: Dero busy in another call, or the card's request waiting in line. */
export type CardVoiceState =
	| { kind: "busy"; guildId: string; busyChannelId: string }
	| { kind: "queued"; guildId: string; requestId: string; place: number; total: number };

const states = new Map<string, CardVoiceState>();
// Rooms whose card already asked for Dero. Cleared when the card closes; a card that became
// a room keeps its entry until a restart, a few bytes per match, so the room never asks again.
const requested = new Set<string>();

export const cardVoiceState = {
	get: (roomId: string): CardVoiceState | null => states.get(roomId) ?? null,
	set: (roomId: string, state: CardVoiceState): void => {
		states.set(roomId, state);
	},
	clear: (roomId: string): void => {
		states.delete(roomId);
	},
	/** Every card of one guild whose request waits, by room id. */
	queuedIn: (guildId: string): Array<[string, Extract<CardVoiceState, { kind: "queued" }>]> =>
		[...states.entries()].filter((entry): entry is [string, Extract<CardVoiceState, { kind: "queued" }>] => entry[1].kind === "queued" && entry[1].guildId === guildId),
	markRequested: (roomId: string): void => {
		requested.add(roomId);
	},
	wasRequested: (roomId: string): boolean => requested.has(roomId),
	/** The card closed: forget everything about it. */
	forget: (roomId: string): void => {
		states.delete(roomId);
		requested.delete(roomId);
	},
	/** Test seam. */
	_reset: (): void => {
		states.clear();
		requested.clear();
	},
};
