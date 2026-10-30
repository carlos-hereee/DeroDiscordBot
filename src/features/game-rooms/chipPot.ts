import type { Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { ChipPot, IGameRoom } from "@db/models/GameRoom.js";
import { returnChips } from "@features/economy/chipWallet.js";
import type { MonopolySeat } from "@features/games/monopolyState.js";
import { refundSeatsDirectly, type PaidSeats } from "./holdemDraftBuyIn.js";
import type { ChipPayout } from "./holdemChips.js";
import { roomTrail } from "./roomTrail.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { GameSlug } from "./roomTypes.js";

// ── chipPot ──────────────────────────────────────────────────────────
// What:  the winner takes all pot of a ranked Monopoly match (a fixed buy in per seat, owner
//        decision D4) and a ranked Battleship match with a wager (both captains, D10), 2026-10
//        item 276: opened on the row as the room opens, paid out once when the room finishes.
// Who:   RoomProvisioner.seedRoom (openChipPot, with the seats the start claim left) and
//        roomLifecycle.finish (settleChipPot, with the row its claim returned).
// Does NOT: charge anybody (the draft ledger in holdemDraftBuyIn did, on Join and at Start) or
//        touch a Hold'em or Blackjack table, whose chips live on their own tables.
//
// ⚠️ A LEAVER'S BUY IN STAYS IN THE POT (owner decisions D3 and D12). A surrender, a removal,
// an idle forfeit or leaving the server takes the seat out of the match and pays it nothing,
// so its buy in is simply part of what the winner collects. Nothing is burned and nothing is
// minted: the pot pays out exactly what its payers paid in, once. A match with no winner (the
// idle sweep, a deleted channel, a restart) shares the pot among the payers still in it, so a
// forfeited buy in still goes to the seats that stayed.
//
// ⚠️ MONOPOLY DOLLARS ARE NEVER CHIPS (owner decision D7). GO salary, the cards and the bank
// create Monopoly dollars without limit, so paying a seat's money or net worth out would mint
// chips, reward stalling round the board and inflate the coin market. The pot is the only payout.

/** The games whose ranked match holds its buy ins in a pot on the row. */
export const POT_GAMES = ["monopoly", "battleship"] as const satisfies readonly GameSlug[];
export const isPotGame = (game: GameSlug): boolean => (POT_GAMES as readonly GameSlug[]).includes(game);

/** Every chip a pot holds: each payer's buy in. */
export const potTotalOf = (pot: ChipPot): number => pot.buyIn * pot.userIds.length;

/**
 * Open a ranked match's pot as its room opens, from the seats the start claim left: every payer
 * the room seated goes in, and a payer it did not seat (gone from the server while the room was
 * built) has their buy in back. Answers the pot written, or null for a free match.
 *
 * The write matches a row still playing (gameRoomStore.openChipPot): a finish that landed first
 * paid out a row with no pot, so the buy ins go straight back. A write that THREW is logged and
 * refunds nothing, since it may have landed, and a refund on top of a pot the finish pays would
 * mint chips; a crash here loses buy ins and never mints them, the order every chip path keeps.
 */
export async function openChipPot(room: Pick<IGameRoom, "guildId" | "roomId" | "game">, seats: PaidSeats, playerIds: readonly string[]): Promise<ChipPot | null> {
	if (!isPotGame(room.game) || !seats.charged) return null;
	const seated = seats.userIds.filter((userId) => playerIds.includes(userId));
	const unseated = seats.userIds.filter((userId) => !playerIds.includes(userId));
	if (unseated.length > 0) await refundSeatsDirectly({ ...seats, userIds: unseated });
	if (seated.length === 0) return null;

	const pot: ChipPot = { buyIn: seats.buyIn, userIds: seated };
	try {
		if (await gameRoomStore.openChipPot(room.guildId, room.roomId, pot)) return pot;
	} catch (error) {
		console.error(`[game-rooms] the chip pot of room ${room.roomId} could not be written; its ${potTotalOf(pot)} chips are owed by hand`, error);
		return null;
	}
	await refundSeatsDirectly({ ...seats, userIds: seated });
	return null;
}

/**
 * Who a finished match's pot pays: the whole pot to a winner who paid into it, or, with no such
 * winner, an even share to each payer still in the match (the remainder to the first in seat
 * order), or to every payer when nobody is still in. Pure, so the tests read the rule directly.
 */
export function potPayouts(room: Pick<IGameRoom, "game" | "chipPot" | "secret">, winnerId: string | null, abandoned: boolean): ChipPayout[] {
	const pot = room.chipPot;
	if (!pot || pot.userIds.length === 0) return [];
	const total = potTotalOf(pot);
	if (!abandoned && winnerId && pot.userIds.includes(winnerId)) return [{ userId: winnerId, amount: total }];

	const stillIn = payersStillIn(room, pot);
	const sharers = stillIn.length > 0 ? stillIn : pot.userIds;
	const share = Math.floor(total / sharers.length);
	const remainder = total - share * sharers.length;
	return sharers.map((userId, index) => ({ userId, amount: share + (index === 0 ? remainder : 0) }));
}

// The payers a match still holds: in Monopoly every seat that is not bankrupt, which is how a
// surrender, a removal, an idle forfeit and a server leave all end (monopolyDebts.applyForfeit).
// Battleship ends with no winner only when nobody forfeited, so both captains are still in.
function payersStillIn(room: Pick<IGameRoom, "game" | "secret">, pot: ChipPot): string[] {
	if (room.game !== "monopoly") return pot.userIds;
	const seats = (room.secret as { seats?: MonopolySeat[] } | null)?.seats;
	if (!seats) return pot.userIds;
	const solvent = new Set(seats.filter((seat) => !seat.bankrupt).map((seat) => seat.userId));
	return pot.userIds.filter((userId) => solvent.has(userId));
}

/** What a settled pot paid: its total and who got what. */
export interface PotSettlement {
	total: number;
	payouts: ChipPayout[];
}

/**
 * Pay a finished match's pot, then say so in the room's trail. Called by roomLifecycle.finish
 * with the row its claim returned, so it runs once per room whatever ended it. Never throws: a
 * failed payment is logged by name and amount, and the rest still pay.
 */
export async function settleChipPot(client: Client, room: IGameRoom, winnerId: string | null, abandoned: boolean): Promise<PotSettlement | null> {
	const pot = room.chipPot;
	if (!pot || !isPotGame(room.game)) return null;
	const payouts = potPayouts(room, winnerId, abandoned);
	for (const payout of payouts) {
		try {
			await returnChips({ userId: payout.userId }, payout.amount);
		} catch (error) {
			console.error(`[game-rooms] the pot payout of ${payout.amount} chips to ${payout.userId} in room ${room.roomId} failed`, error);
		}
	}
	const settlement = { total: potTotalOf(pot), payouts };
	if (payouts.length > 0) {
		await roomTrail
			.postMove(client, room, { actorId: room.hostId, kind: "system", text: potTrailLine(settlement, winnerId) })
			.catch((error) => console.error(`[game-rooms] posting the pot line for room ${room.roomId} failed`, error));
	}
	return settlement;
}

/** The line a settled pot posts: the winner's prize, or the shares when nobody won it. */
export function potTrailLine(settlement: PotSettlement, winnerId: string | null): string {
	const words = gameRoomsCopy.chipPot;
	const [only] = settlement.payouts;
	if (settlement.payouts.length === 1 && only.userId === winnerId) return words.winnerTakes(only.userId, settlement.total);
	return words.shared(settlement.total, settlement.payouts);
}
