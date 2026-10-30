import type { IGameRoom } from "@db/models/GameRoom.js";
import { isRankedMatch } from "@features/ratings/ratingEngine.js";

// ── chipMatch ────────────────────────────────────────────────────────
// What:  the one rule for whether a match moves wallet chips, before the server's chip switch
//        is read (2026-10 item 276, owner decision D1). Pure, with no store and no discord.js.
// Who:   holdemChips.chipTableFor (which adds the server's switch, and which every charge and
//        seed reads) and challengeBoardEmbeds (a card names a buy in only where one is charged).
// Why its own module: holdemChips reaches challengeBoardEmbeds through roomTrail, so the card
//        could not import the rule from there without an import cycle.
//
// ⚠️ CHIPS MOVE ONLY IN RANKED MATCHES. A casual match never charges a buy in and never pays a
// chip, whatever the server's switch says, and plays on a pretend stack. A network table seats
// members of other servers, and a table with a Dero bot would pay a human chips the bot never
// paid in, so both play free too (2026-10 item 250 Phase 5, question 1). A game that is never
// ranked (a solo Blackjack table against Dero) never moves chips.

/** The slice of a room the chip rule reads: its game, its match and whether it is a network table. */
export type ChipMatch = Pick<IGameRoom, "game" | "network"> & Partial<Pick<IGameRoom, "casual">>;

/** Whether a match moves wallet chips where chips are on: a ranked match (ratingEngine.isRankedMatch) that is not a network table. */
export function movesChips(match: ChipMatch, botCount: number): boolean {
	return isRankedMatch(match.game, botCount, match.casual ?? false) && !match.network;
}
