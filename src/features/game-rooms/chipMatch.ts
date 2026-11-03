import type { IGameRoom } from "@db/models/GameRoom.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { isRankedMatch } from "@features/ratings/ratingEngine.js";

// ── chipMatch ────────────────────────────────────────────────────────
// What:  the one rule for whether a match moves wallet chips, before the server's chip switch
//        is read (2026-10 item 276, owner decision D1). Pure, with no store and no discord.js.
// Who:   holdemChips.chipTableFor (which adds the server's switch, and which every charge and
//        seed reads) and challengeBoardEmbeds (a card names a buy in only where one is charged).
//        stakeOf below is the one answer to what a seat stakes, read by the draft ledger
//        (holdemDraftBuyIn), the card's settings line and picture, and the leave confirms.
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

/**
 * Whether a Blackjack match is a shared table (2026-10 item 276, owner decisions D13 and D14): a
 * ranked match, so it needs BLACKJACK_RANKED_MIN_SEATS human seats to Start and its card stays
 * open while it plays, taking late seats. Beside movesChips because both read the one ranked rule;
 * a shared table on a server with chips off still shares, on a pretend stack.
 */
export function isSharedBlackjackTable(match: ChipMatch): boolean {
	return match.game === "blackjack" && isRankedMatch(match.game, 0, match.casual ?? false) && !match.network;
}

/** How a buy in game's stake reads: a table's buy in, Monopoly's winner takes all buy in, or Battleship's wager. */
export type StakeKind = "buyIn" | "pot" | "wager";

/** What one seat of a chip match pays to play, and how it reads. */
export interface Stake {
	kind: StakeKind;
	amount: number;
}

/**
 * What one seat stakes in this game's chip match, or null when it stakes nothing (2026-10 item
 * 276): a Hold'em or Blackjack table's buy in (the host's, or the standard stack), ranked
 * Monopoly's fixed buy in (owner decision D4), or a ranked Battleship card's wager, which the
 * host may leave unset so the match is chip free (D10). Whether chips move at all is still
 * movesChips' and the server's switch's call; this only says how much.
 */
export function stakeOf(match: Pick<IGameRoom, "game"> & Partial<Pick<IGameRoom, "holdemBuyIn">>): Stake | null {
	const kind = stakeKindOf(match.game);
	if (kind === "buyIn") return { kind, amount: match.holdemBuyIn ?? BOT_CONSTANTS.HOLDEM_STARTING_STACK };
	if (kind === "pot") return { kind, amount: BOT_CONSTANTS.ECONOMY.MONOPOLY_RANKED_BUY_IN };
	if (kind === "wager" && match.holdemBuyIn != null) return { kind, amount: match.holdemBuyIn };
	return null;
}

/** How a game's ranked match stakes chips, before any amount is set: what its creation modal says a Rated match plays for. */
export function stakeKindOf(game: IGameRoom["game"]): StakeKind | null {
	if (game === "holdem" || game === "blackjack") return "buyIn";
	if (game === "monopoly") return "pot";
	if (game === "battleship") return "wager";
	return null;
}

/** Whether a stake is one the host sets (a table's buy in, Battleship's wager), rather than the fixed Monopoly buy in. */
export const hostSetsStake = (game: IGameRoom["game"]): boolean => game === "holdem" || game === "blackjack" || game === "battleship";
