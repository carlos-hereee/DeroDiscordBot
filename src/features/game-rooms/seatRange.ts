import { MAX_SEATS as MONOPOLY_MAX_SEATS, MIN_SEATS as MONOPOLY_MIN_SEATS } from "@features/games/monopolyBoard.js";
import { MAX_SEATS as BLACKJACK_MAX_SEATS } from "@features/games/blackjackHandler.js";
import type { GameSlug } from "./roomTypes.js";

// ── seatRange ────────────────────────────────────────────────────────
// What:  how many seats a room of each game can open with, Dero bots counting, read by the two
//        paths that seat a room from a list someone else wrote: the rematch check (the finished
//        match's players) and RoomProvisioner.seedRoom (the players the start claim still held).
// Why:   a room seeded outside its range is a stuck room, not a short one (2026-10 item 276,
//        audit P1-5): Monopoly's engine throws on one seat AFTER the row is playing, and no sweep
//        reads a Monopoly row with no board, so the host's one room slot was held for good. So a
//        rematch is refused before any write, and a seed the claim left short closes its room.
// Does NOT: gate a challenge card's Start, which keeps its own refusals (challengeBoard
//        startRefusal and holdemSeatRefusal) with words of their own for the card.
//
// A Hold'em room's players are everyone the card gathered, payers or not, and its TABLE seats
// only those who bought in, under its own cap (holdemTable.seatCapOf); a rematch opens a joining
// table whose players buy in in the room. So one player opens a Hold'em room and no count of
// players is too many for it. A Blackjack table plays against the house, so one seat plays, and its
// card caps the gathered players at the table's seats. Hangman needs the host plus a guesser, and
// takes everyone the card gathered; every head to head game seats exactly two.

/** The fewest and the most seats a room of a game opens with, Dero bots counting. */
export interface SeatRange {
	min: number;
	max: number;
}

const HEAD_TO_HEAD: SeatRange = { min: 2, max: 2 };
const ONE_SEAT: SeatRange = { min: 1, max: 1 };

/** The seat range of `game`; see the module header for each game's reason. */
export function seatRangeOf(game: GameSlug): SeatRange {
	switch (game) {
		case "monopoly":
			return { min: MONOPOLY_MIN_SEATS, max: MONOPOLY_MAX_SEATS };
		case "holdem":
			return { min: 1, max: Number.POSITIVE_INFINITY };
		case "blackjack":
			return { min: 1, max: BLACKJACK_MAX_SEATS };
		case "hangman":
			return { min: 2, max: Number.POSITIVE_INFINITY };
		case "battleship":
		case "coinflip":
		case "diceroll":
		case "rps":
			return HEAD_TO_HEAD;
		case "solo-hangman":
		case "solo-blackjack":
		case "solo-coinflip":
		case "solo-diceroll":
		case "solo-rps":
			return ONE_SEAT;
	}
}

/** Whether `seats` (members plus Dero bots) fits the game's range. */
export const seatsFit = (game: GameSlug, seats: number): boolean => {
	const range = seatRangeOf(game);
	return seats >= range.min && seats <= range.max;
};
