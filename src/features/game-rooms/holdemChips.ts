import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { isChipEconomyOn, returnChips, takeChips } from "@features/economy/chipWallet.js";
import { chipsBackOnCallOff, startingStackOf, type HoldemTable, type TableChips } from "@features/games/holdemTable.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { roomTrail } from "./roomTrail.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── holdemChips ──────────────────────────────────────────────────────
// What:  every move of wallet chips at a Hold'em table (2026-10 item 250 Phase 5): the
//        one buy in each player pays to sit, the stack a leaver walks away with, and
//        what every seat holds when the table ends, back to the wallets.
// Who:   roomHoldemHandlers (a buy in, a leave, a removal, a withdrawn late seat),
//        RoomProvisioner.seedRoom (whether a new table plays for chips at all), and
//        roomLifecycle.finish (the end of the table, on every path that ends one).
// Does NOT: decide the cards, the pots or the stacks; the engine owns those and reads
//        no balance. This only moves chips between a wallet and a table that carries
//        `chips`; a free play table never reaches a wallet.
//
// ⚠️ THE TABLE IS THE LEDGER, AND EVERY PAYMENT RIDES A CLAIM THAT LANDS ONCE. A leave
// or a removal pays the stack the compare and swap that zeroed the seat just wrote, and
// only the write that landed pays. The end of the table pays from the row finish
// claimed, which happens once per room. A seat already paid holds nothing (out, stack
// zero), so the end can never pay it twice. The order is always claim first, pay
// second: a crash between the two loses a cash out, and never mints one.

const ECONOMY = BOT_CONSTANTS.ECONOMY;

/** What a seat holds at the end of a table, paid back to its wallet. */
export interface ChipPayout {
	userId: string;
	amount: number;
}

/** The chips a new table plays for (the server it is in; every wallet is global), or null for a free play table. */
export async function chipTableFor(room: Pick<IGameRoom, "guildId" | "network">, hasBotSeats: boolean): Promise<TableChips | null> {
	// A network table seats members of other servers, and a table with a Dero bot would
	// pay a human chips the bot never paid in, so both play free by the owner's decision
	// (Phase 5, question 1). The wallets are global, but the network rule still stands.
	if (room.network || hasBotSeats) return null;
	const config = await guildConfigStore.findByGuildId(room.guildId);
	if (!config || !isChipEconomyOn(config)) return null;
	return tableChipsOf(room.guildId);
}

/** The chips a table in this server plays for, once something has decided it plays for chips at all. */
export const tableChipsOf = (guildId: string): TableChips => ({ guildId });

/** Whether a buy in amount is one the host may set: a whole number of chips inside the table's bounds. */
export function isValidBuyIn(amount: number): boolean {
	return Number.isSafeInteger(amount) && amount >= ECONOMY.HOLDEM_MIN_BUY_IN && amount <= ECONOMY.HOLDEM_MAX_BUY_IN;
}

/** Take the table's buy in from a player's wallet. True when paid, or when the table is free play. */
export async function payBuyIn(table: HoldemTable, userId: string): Promise<boolean> {
	if (!table.chips) return true;
	return takeChips({ userId }, startingStackOf(table));
}

/** Give a buy in back: a seat that never landed, a late seat withdrawn before its deal. Never throws. */
export async function refundBuyIn(table: HoldemTable, userId: string, amount: number = startingStackOf(table)): Promise<void> {
	await payOut(table.chips, { userId, amount }, "refund");
}

/** Pay a leaver's stack back to their wallet. Never throws. */
export async function cashOut(table: HoldemTable, userId: string, amount: number): Promise<void> {
	await payOut(table.chips, { userId, amount }, "cash out");
}

/**
 * What each seat holds at the end of a table: a seat still in keeps its stack plus
 * what a hand that never settled gives back as it is called off (chipsBackOnCallOff,
 * the same rule End table uses, so a leaver's chips in that hand are shared out rather
 * than lost), and a late seat still waiting gets its buy in back. Seats that are out
 * hold nothing: they busted, or were paid when they left. Seats with nothing are left out.
 */
export function chipsOwedAtEnd(table: HoldemTable): ChipPayout[] {
	const owed: ChipPayout[] = [];
	const back = chipsBackOnCallOff(table);
	for (const seat of table.seats) {
		if (seat.out) continue;
		const amount = seat.stack + (back.get(seat.userId) ?? 0);
		if (amount > 0) owed.push({ userId: seat.userId, amount });
	}
	for (const waiting of table.pendingSeats ?? []) owed.push({ userId: waiting.userId, amount: startingStackOf(table) });
	return owed;
}

/**
 * Pay every seat of an ended chip table back to its wallet, then say so in the room's
 * trail. Called by roomLifecycle.finish with the row its claim returned, which holds the
 * table as it was last persisted, so it runs once per table whatever ended it. Never
 * throws: a failed payment is logged by name and the rest still pay.
 */
export async function settleTableChips(client: Client, room: IGameRoom): Promise<ChipPayout[]> {
	if (room.game !== "holdem") return [];
	const table = (room.secret as HoldemTable | null) ?? null;
	if (!table?.chips) return [];

	const owed = chipsOwedAtEnd(table);
	for (const payout of owed) await payOut(table.chips, payout, "end of table");
	if (owed.length > 0) {
		await roomTrail
			.postMove(client, room, { actorId: room.hostId, kind: "system", text: gameRoomsCopy.holdem.chipsReturned(owed) })
			.catch((error) => console.error(`[game-rooms] posting the chips returned line for room ${room.roomId} failed`, error));
	}
	return owed;
}

// One credit to the member's global wallet, logged by what it was for. A failure costs the
// member their chips until the owner credits them by hand, so the line names the guild the
// table was in, the member and the amount.
async function payOut(chips: TableChips | undefined, payout: ChipPayout, reason: string): Promise<void> {
	if (!chips || payout.amount <= 0) return;
	try {
		await returnChips({ userId: payout.userId }, payout.amount);
	} catch (error) {
		console.error(`[game-rooms] Hold'em ${reason} of ${payout.amount} chips to ${payout.userId} in guild ${chips.guildId} failed`, error);
	}
}
