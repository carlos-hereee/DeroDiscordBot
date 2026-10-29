import type { Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { returnChips } from "@features/economy/chipWallet.js";
import { isBlackjackRoomGame } from "./roomTypes.js";
import { roomTrail } from "./roomTrail.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { ChipPayout } from "./holdemChips.js";
import type { PaidSeats } from "./holdemDraftBuyIn.js";

// ── blackjackChips ───────────────────────────────────────────────────
// What:  every move of wallet chips at a Blackjack room table once it has opened (2026-10
//        item 267, risk R5): the stacks ledger written as the table opens and after every
//        settle, a leaver's cash out, and what every seat holds when the room ends.
// Who:   soloRooms (the ledger at open), blackjackHandler (the stacks after a settle, a
//        leave), and roomLifecycle.finish (the end of the table, on every path that ends one:
//        the table's own end, a restart's boot recovery, the idle sweep, a deleted channel).
// Does NOT: charge a buy in (holdemDraftBuyIn does, on the card or at a solo press) or decide
//        a bet or a payout (blackjackState does, and reads no wallet).
//
// ⚠️ THE ROW IS THE LEDGER, AND EVERY CASH OUT CLAIMS ITS ENTRY FIRST. The table lives in
// blackjackHandler's process Map, which a restart loses, so the row's `blackjackStacks` holds
// every seat's stack as of the last settle. A cash out pulls the seat's entry (one conditional
// $pull) and pays second, so a leave racing a finish pays once; a crash between the two loses
// a cash out and never mints one. The stacks write after a settle is positional, so it can
// never put a claimed seat back. A free table writes no ledger, so it never reaches a wallet.
//
// ⚠️ CHIPS PAID OUT ABOVE A BUY IN ARE NEW CHIPS FROM THE HOUSE. The dealer is not a member
// with a wallet, so a seat that wins pays itself out of nothing, the way the daily claim does;
// a seat that loses gives its chips to nobody. That is the owner's design (decision 6), and it
// is why the payout rules in blackjackState are the money invariant here.

/**
 * Write the ledger as a chip table opens: every paid seat at its buy in. Answers false when the
 * write failed, and the caller then gives the buy ins back itself, since nothing on the row
 * would. A free table owes nobody and writes nothing.
 */
export async function openBlackjackLedger(room: Pick<IGameRoom, "guildId" | "roomId">, seats: PaidSeats): Promise<boolean> {
	if (!seats.charged) return true;
	try {
		const entries = seats.userIds.map((userId) => ({ userId, buyIn: seats.buyIn, stack: seats.buyIn }));
		return (await gameRoomStore.openBlackjackStacks(room.guildId, room.roomId, entries, new Date())) !== null;
	} catch (error) {
		console.error(`[game-rooms] the Blackjack stacks ledger for room ${room.roomId} could not be written`, error);
		return false;
	}
}

/**
 * Write every seat's stack after a settle, and when a member last acted, so a restart pays what
 * the table held after its last settled hand. Never throws: the table in memory plays on, and
 * the next settle writes again.
 */
export async function saveBlackjackStacks(room: Pick<IGameRoom, "guildId" | "roomId">, stacks: readonly { userId: string; stack: number }[], actedAt: Date | null): Promise<void> {
	try {
		await gameRoomStore.saveBlackjackStacks(room.guildId, room.roomId, stacks, actedAt);
	} catch (error) {
		console.error(`[game-rooms] the Blackjack stacks for room ${room.roomId} could not be saved`, error);
	}
}

/**
 * A seat leaves with `amount`: claim its entry, then credit the wallet. Answers whether this
 * call paid, so a second leave or a finish that got there first pays nothing. Never throws.
 */
export async function cashOutBlackjackSeat(room: Pick<IGameRoom, "guildId" | "roomId">, userId: string, amount: number): Promise<boolean> {
	try {
		const claimed = await gameRoomStore.takeBlackjackStack(room.guildId, room.roomId, userId);
		if (!claimed) return false;
		if (amount > 0) await returnChips({ userId }, amount);
		return true;
	} catch (error) {
		console.error(`[game-rooms] a Blackjack cash out of ${amount} chips to ${userId} in room ${room.roomId} failed`, error);
		return false;
	}
}

/**
 * Pay every seat still on the ledger back to its wallet, at the stack the last settle wrote,
 * then say so in the room's trail. Called by roomLifecycle.finish with the row its claim
 * returned, so it runs once per room whatever ended it; each entry is claimed again here, so a
 * leave in the same moment still pays once. Never throws: a failed payment is logged by name.
 */
export async function settleBlackjackStacks(client: Client, room: IGameRoom): Promise<ChipPayout[]> {
	if (!isBlackjackRoomGame(room.game)) return [];
	const paid: ChipPayout[] = [];
	for (const entry of room.blackjackStacks ?? []) {
		try {
			const claimed = await gameRoomStore.takeBlackjackStack(room.guildId, room.roomId, entry.userId);
			if (!claimed || claimed.stack <= 0) continue;
			await returnChips({ userId: claimed.userId }, claimed.stack);
			paid.push({ userId: claimed.userId, amount: claimed.stack });
		} catch (error) {
			console.error(`[game-rooms] the Blackjack end of table payout to ${entry.userId} in room ${room.roomId} failed`, error);
		}
	}
	if (paid.length > 0) {
		await roomTrail
			.postMove(client, room, { actorId: room.hostId, kind: "system", text: gameRoomsCopy.trail.blackjackChipsReturned(paid) })
			.catch((error) => console.error(`[game-rooms] posting the Blackjack stacks returned line for room ${room.roomId} failed`, error));
	}
	return paid;
}
