import { randomUUID } from "node:crypto";
import { LabelBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, type ModalSubmitInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { closeChipReceipt, parseChipAmount, refundChipReceipt, returnChips, takeChips, takeChipsWithReceipt } from "@features/economy/chipWallet.js";
import { chipTableFor } from "./holdemChips.js";
import { stakeOf } from "./chipMatch.js";
import { GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isBuyInGame } from "./roomTypes.js";

// ── holdemDraftBuyIn ─────────────────────────────────────────────────
// What:  the buy in of a chip match, for Hold'em (2026-10 item 257 Phase 4a, owner item 13),
//        Blackjack (2026-10 item 267, owner decision 6), and ranked Monopoly's fixed buy in and
//        Battleship's wager (2026-10 item 276, D4 and D10), keyed by the room's game: the
//        host sets the amount on the draft, every joiner pays it from their wallet when they
//        press Join (or an invited member's Accept and buy in), and whoever the host declines
//        or removes, or a cancelled draft, gets it back. The room then opens with those seats
//        already paid. A solo Blackjack table against Dero is never ranked, so since 2026-10
//        item 276 (owner decision D1) it plays free on the standard pretend stack and its press
//        takes nothing (chargeSoloTable asks the one chip rule), and a Blackjack rematch charges
//        every returning player again (chargeSeats). The file keeps its Hold'em name because Hold'em is where it started.
// Who:   challengeBoard (the host's press and its modal, the Join charge, an invited member's
//        Accept and buy in, the cancel refund, the seats at Start, a rematch's charge),
//        hostControls (decline and remove refunds), RoomProvisioner (seating a paid Hold'em
//        table), soloRooms (seating a paid Blackjack table) and arcadeHost (the solo press).
// Does NOT: decide the cards or the stacks (each engine seats a paid member at the buy in)
//        or move chips at a running table (holdemChips and blackjackChips do that).
//
// ⚠️ THE ROW IS THE LEDGER. `buyInPaidBy` lists the members whose wallet was charged and
// has not been given back, and every refund CLAIMS its entry first (takeBuyInPaid, one
// conditional $pull) and pays second, so a decline racing a cancel pays once. A charge is
// RECORDED BEFORE IT IS TAKEN (2026-10 item 278, gap G3): the row holds it in `buyInCharges`,
// the wallet pays it with a receipt, and one write moves it onto `buyInPaidBy` (chargeOntoLedger
// has the steps). Before this the chips left the wallet first, and a crash before the record lost
// them. Network tables and tables with a Dero bot play free, and so does a casual match (2026-10
// item 276, owner decision D1: chips move only in ranked matches), so nobody pays on a draft that
// chipTableFor refuses.

/** The two fields of the buy in modal: the preset select and the typed amount. */
export const BUY_IN_FIELDS = { preset: "preset", custom: "custom" } as const;

/**
 * The buy in a draft will charge, by the one stake rule (chipMatch.stakeOf): what the host set,
 * the standard stack, Monopoly's fixed buy in or Battleship's wager. A Battleship card with no
 * wager charges nobody (isChipDraft is false), so the standard stack it answers is never taken.
 */
export const draftBuyInOf = (room: Pick<IGameRoom, "game" | "holdemBuyIn">): number => stakeOf(room)?.amount ?? BOT_CONSTANTS.HOLDEM_STARTING_STACK;

/** The bounds a host's stake must sit inside: Battleship's wager, or a table's buy in. */
export function stakeBoundsOf(game: IGameRoom["game"]): { min: number; max: number } {
	const economy = BOT_CONSTANTS.ECONOMY;
	if (game === "battleship") return { min: economy.BATTLESHIP_MIN_WAGER, max: economy.BATTLESHIP_MAX_WAGER };
	return { min: economy.HOLDEM_MIN_BUY_IN, max: economy.HOLDEM_MAX_BUY_IN };
}

/** Whether a buy in amount is one the host may set: a whole number of chips inside the game's bounds. */
export function isValidDraftBuyIn(amount: number, game: IGameRoom["game"] = "holdem"): boolean {
	const { min, max } = stakeBoundsOf(game);
	return Number.isSafeInteger(amount) && amount >= min && amount <= max;
}

/**
 * Whether this draft will open as a chip table, the same question the provisioner asks
 * (holdemChips.chipTableFor): a ranked match, chips on in the server, no network table and no
 * Dero bot seat, so a casual card charges nobody (2026-10 item 276, owner decision D1). Read
 * fresh on every charge, so an admin switching chips off mid draft stops charging joiners at once.
 */
export async function isChipDraft(room: Pick<IGameRoom, "game" | "guildId" | "network" | "botSeats" | "casual" | "holdemBuyIn">): Promise<boolean> {
	if (stakeOf(room) === null) return false;
	return playsForChips(room);
}

/**
 * Whether this draft's match moves chips at all, before asking what it stakes: the question a
 * host setting a stake needs answered, since a ranked Battleship card stakes nothing until its
 * wager is set (2026-10 item 276, D10) and must still accept one.
 */
export async function playsForChips(room: Pick<IGameRoom, "game" | "guildId" | "network" | "botSeats" | "casual">): Promise<boolean> {
	if (!isBuyInGame(room.game)) return false;
	return (await chipTableFor(room, room.botSeats ?? 0)) !== null;
}

// ── the host's modal ──────────────────────────────────────────────────
/**
 * The host's buy in modal: the presets as a select with the draft's current buy in
 * chosen, and a field for any other amount, which wins when it is filled.
 */
export function buyInModal(roomId: string, current: number): ModalBuilder {
	const copy = gameRoomsCopy.holdem;
	const presets = [...new Set([...BOT_CONSTANTS.ECONOMY.HOLDEM_BUY_IN_PRESETS, current])].sort((first, second) => first - second);
	return new ModalBuilder()
		.setCustomId(`${GAME_ROOM_MODAL_PREFIX}:hbuyin:${roomId}`)
		.setTitle(copy.buyInModalTitle)
		.addLabelComponents(
			new LabelBuilder().setLabel(copy.buyInPresetLabel).setStringSelectMenuComponent(
				new StringSelectMenuBuilder()
					.setCustomId(BUY_IN_FIELDS.preset)
					.setMinValues(1)
					.setMaxValues(1)
					.addOptions(presets.map((amount) => ({ label: copy.buyInPresetOption(amount), value: String(amount), default: amount === current })))
			),
			new LabelBuilder().setLabel(copy.buyInCustomLabel).setTextInputComponent(
				new TextInputBuilder().setCustomId(BUY_IN_FIELDS.custom).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12).setPlaceholder(copy.buyInCustomPlaceholder)
			)
		);
}

/** The amount a buy in modal was submitted with: the typed amount wins when filled, otherwise the preset. Null when neither reads as chips. */
export function submittedBuyIn(interaction: ModalSubmitInteraction): number | null {
	const typed = interaction.fields.getTextInputValue(BUY_IN_FIELDS.custom).trim();
	if (typed) return parseChipAmount(typed);
	const preset = interaction.fields.getStringSelectValues(BUY_IN_FIELDS.preset)[0];
	return preset ? parseChipAmount(preset) : null;
}

// ── paying and getting it back ────────────────────────────────────────
// The charges this process is making right now, by draft and member. A charge on the row that is
// not in here was left by a press that died (a restart empties this set), so the member's next
// press may settle it; one that is in here is a double press, refused before anything is written.
const chargesInFlight = new Set<string>();

/** How a charge onto the draft ledger ended: paid, the wallet short, already paid, or refused by the row. */
type LedgerCharge = "paid" | "short" | "alreadyPaid" | "refused";

/**
 * Charge `userId` the draft's buy in onto its ledger, so a crash at any step leaves a record a
 * refund can settle once (2026-10 item 278, gap G3). ① Any charge a dead press left for this member
 * is settled first, so a crash never locks them out of the card; ② the row holds the charge,
 * refused for a member already paid or holding one; ③ the wallet pays it with a receipt in one
 * write, a short wallet letting the hold go; ④ one write moves the charge onto `buyInPaidBy`, only
 * while the draft is open at the same buy in and no refund released the charge, and a refusal
 * gives the chips back through the receipt; ⑤ the receipt is closed. A crash before ④ leaves the
 * held charge for every refund path (refundBuyInCharges), and the receipt pays only a charge taken.
 */
async function chargeOntoLedger(room: IGameRoom, userId: string, buyIn: number): Promise<LedgerCharge> {
	const pressKey = `${room.guildId}:${room.roomId}:${userId}`;
	if (chargesInFlight.has(pressKey)) return "alreadyPaid";
	chargesInFlight.add(pressKey);
	try {
		await settleStaleCharges(room, userId);
		const charge = { userId, buyIn, chargeId: randomUUID() };
		const expectedBuyIn = room.holdemBuyIn ?? null;
		if (!(await gameRoomStore.holdBuyInCharge(room.guildId, room.roomId, charge, expectedBuyIn))) return chargeRefusalFor(room, userId);
		if (!(await takeChipsWithReceipt({ userId }, buyIn, charge.chargeId))) {
			await gameRoomStore.dropBuyInCharge(room.guildId, room.roomId, charge.chargeId);
			return "short";
		}
		if (!(await gameRoomStore.recordBuyInCharge(room.guildId, room.roomId, charge, expectedBuyIn))) {
			// A refund that released the charge meanwhile has paid it or will: the receipt pays once.
			await refundChipReceipt({ userId }, buyIn, charge.chargeId);
			await gameRoomStore.dropBuyInCharge(room.guildId, room.roomId, charge.chargeId);
			return chargeRefusalFor(room, userId);
		}
		await closeChipReceipt({ userId }, charge.chargeId);
		return "paid";
	} finally {
		chargesInFlight.delete(pressKey);
	}
}

// ① A charge on the row for this member that no press in this process is making died with the
// process that held it. Read fresh, since a charge the room snapshot shows may since have been
// recorded, its receipt still open. Each is given back through its receipt, which pays only a
// charge really taken, and only then let go, so a crash in between leaves it for the next refund.
async function settleStaleCharges(room: IGameRoom, userId: string): Promise<void> {
	const fresh = await gameRoomStore.findByRoomId(room.guildId, room.roomId);
	for (const stale of (fresh?.buyInCharges ?? []).filter((charge) => charge.userId === userId)) {
		await refundChipReceipt({ userId }, stale.buyIn, stale.chargeId);
		await gameRoomStore.dropBuyInCharge(room.guildId, room.roomId, stale.chargeId);
	}
}

// Why the row would not hold or record a charge: the member is on the ledger already (a double
// press whose first charge stands), or the draft closed or its buy in changed.
async function chargeRefusalFor(room: IGameRoom, userId: string): Promise<LedgerCharge> {
	const fresh = await gameRoomStore.findByRoomId(room.guildId, room.roomId);
	return (fresh?.buyInPaidBy ?? []).includes(userId) ? "alreadyPaid" : "refused";
}

/**
 * Charge a joiner the draft's buy in. Answers the refusal worded for them, or null when they
 * paid (or the draft is free play, where there is nothing to pay).
 */
export async function chargeJoiner(room: IGameRoom, userId: string): Promise<string | null> {
	if (!(await isChipDraft(room))) return null;
	const buyIn = draftBuyInOf(room);
	const charged = await chargeOntoLedger(room, userId, buyIn);
	if (charged === "paid") return null;
	if (charged === "short") return gameRoomsCopy.holdem.notEnoughChips(buyIn);
	return charged === "alreadyPaid" ? gameRoomsCopy.holdem.buyInAlreadyPaid : gameRoomsCopy.board.buyInChangedJoining;
}

/**
 * Give the buy in back to each of `userIds` who paid it, or whose charge is still held. Each refund
 * claims its entry on the row first, so a member listed twice, or a decline racing a cancel, is
 * paid once. Never throws: a refund is a side effect of the decision that triggered it.
 */
export async function refundJoiners(room: Pick<IGameRoom, "guildId" | "roomId" | "game" | "holdemBuyIn">, userIds: readonly string[]): Promise<void> {
	const buyIn = draftBuyInOf(room);
	const members = [...new Set(userIds)];
	for (const userId of members) {
		try {
			const claimed = await gameRoomStore.takeBuyInPaid(room.guildId, room.roomId, userId);
			if (claimed) await returnChips({ userId }, buyIn);
		} catch (error) {
			console.error("[game-rooms] a table buy in could not be refunded", { guildId: room.guildId, roomId: room.roomId, userId, error });
		}
	}
	if (members.length > 0) await refundBuyInCharges(room, members);
}

/**
 * Give back every charge still held on the row for `userIds` (every member's when null): a press
 * that a crash, a removal or the end of its draft caught between its hold and its record (2026-10
 * item 278, gap G3). The charges are released in one write first, so no press records them
 * afterwards, then each is paid back through its wallet receipt, which pays only a charge really
 * taken and only once, so a press refunding its own charge and this one never both pay. The
 * charges stay on the row, released: a press that dies after taking its chips is then refunded by
 * the next path that ends the room. Called by refundJoiners, refundAllJoiners (and through it by
 * finish) and the start claim (RoomProvisioner.seedRoom). Never throws.
 */
export async function refundBuyInCharges(room: Pick<IGameRoom, "guildId" | "roomId">, userIds: readonly string[] | null = null): Promise<void> {
	try {
		const released = await gameRoomStore.releaseBuyInCharges(room.guildId, room.roomId, userIds);
		for (const charge of released?.buyInCharges ?? []) {
			if (userIds && !userIds.includes(charge.userId)) continue;
			if (await refundChipReceipt({ userId: charge.userId }, charge.buyIn, charge.chargeId)) {
				console.warn(`[game-rooms] a held buy in of ${charge.buyIn} went back to ${charge.userId} in room ${room.roomId}`);
			}
		}
	} catch (error) {
		console.error("[game-rooms] a held buy in could not be given back", { guildId: room.guildId, roomId: room.roomId, userIds, error });
	}
}

/** The ledgers the start claim moves a pot match's or a Hold'em table's buy ins onto (gameRoomStore.StartLedger). */
export type ClaimedLedger = "chipPot" | "heldBuyIns";

/**
 * Give the buy in back to each of `userIds` that the start claim moved onto `ledger` (2026-10 item
 * 278): a payer the room seated nowhere, or a Hold'em table's held seat a finish found unsaved.
 * Each refund pulls its entry first and pays only when the pull landed, as refundJoiners does, so
 * a finish and an open refunding the same payer pay once. A pot refuses the pull once the room has
 * finished, since that finish paid the pot out (gameRoomStore.takePotPayer). Never throws.
 */
export async function refundClaimedPayers(room: Pick<IGameRoom, "guildId" | "roomId">, ledger: ClaimedLedger, buyIn: number, userIds: readonly string[]): Promise<void> {
	const pullEntry = (userId: string) =>
		ledger === "chipPot" ? gameRoomStore.takePotPayer(room.guildId, room.roomId, userId) : gameRoomStore.takeHeldBuyIn(room.guildId, room.roomId, userId);
	for (const userId of new Set(userIds)) {
		try {
			if (await pullEntry(userId)) await returnChips({ userId }, buyIn);
		} catch (error) {
			console.error(`[game-rooms] a claimed buy in of ${buyIn} chips could not be given back to ${userId}`, { guildId: room.guildId, roomId: room.roomId, ledger, error });
		}
	}
}

/**
 * Refund every Hold'em buy in still held on a finished row (2026-10 item 278, gap G2): a crash, or a
 * finish that landed first, left them between the start claim and the opening table's write.
 * Called by roomLifecycle.finish with the row its claim returned. Never throws.
 */
export async function refundHeldBuyIns(room: Pick<IGameRoom, "guildId" | "roomId" | "heldBuyIns">): Promise<void> {
	const held = room.heldBuyIns;
	if (!held || held.userIds.length === 0) return;
	await refundClaimedPayers(room, "heldBuyIns", held.buyIn, held.userIds);
}

/** Refund everybody the draft still holds a buy in for, paid or held: a cancelled or replaced draft, or a finish. */
export async function refundAllJoiners(room: Pick<IGameRoom, "guildId" | "roomId" | "game" | "holdemBuyIn" | "buyInPaidBy">): Promise<void> {
	await refundJoiners(room, room.buyInPaidBy ?? []);
	await refundBuyInCharges(room);
}

// ── opening the table ─────────────────────────────────────────────────
/** Who sits down as the room opens (the host first), and whether their seats were paid for. */
export interface PaidSeats {
	buyIn: number;
	userIds: string[];
	// True on a chip table, where the host and every one of userIds paid `buyIn` from their
	// wallet; false on a table that plays free, where nobody paid and every seat is free.
	charged: boolean;
	// True once the start claim wrote these seats to a Blackjack table's stacks ledger in its own
	// write (gameRoomStore.claimForPlay, 2026-10 item 276), so the table must not write them again.
	ledgered?: boolean;
}

// The pool members a chip table seats: the ones who paid on the card (Join, or an invited
// member's Accept and buy in). An invited member who never accepted sits nowhere.
function paidPoolMembers(room: Pick<IGameRoom, "hostId" | "buyInPaidBy">, pool: readonly string[]): string[] {
	const inPool = new Set(pool);
	return (room.buyInPaidBy ?? []).filter((userId) => inPool.has(userId) && userId !== room.hostId);
}

/**
 * How many seats a Hold'em draft would open with, Dero bots counted (2026-10 item 263 R3-27):
 * on a chip table the host and every payer still in the pool, on a free table the host, every
 * pool member and every bot. The card's Start refuses below BOT_CONSTANTS.HOLDEM_MIN_SEATS.
 */
export async function seatsAtStart(room: IGameRoom, pool: readonly string[]): Promise<number> {
	if (await isChipDraft(room)) return 1 + paidPoolMembers(room, pool).length;
	return 1 + pool.filter((userId) => userId !== room.hostId).length + (room.botSeats ?? 0);
}

/**
 * Settle a Hold'em or Blackjack draft's buy ins as the room opens. A chip draft charges the host (their seat
 * is paid like everyone's) and answers the members who paid on the card and are still in the
 * pool, host first, giving back any payment whose member left the pool. A draft that plays free
 * (chips off, a network table, or a Dero bot seat, which the rulebook says plays free) gives
 * every payment back and seats the host and every pool member free. A refusal means the host's
 * wallet is short, and nothing was taken.
 *
 * ⚠️ A FREE TABLE STILL SEATS EVERYBODY (2026-10 item 263 risk R8). This used to answer no seats
 * when the draft was not a chip draft, and isChipDraft is false whenever a bot sits, so a card
 * with Dero bots opened with the bots alone and the host unseated.
 *
 * The pool is who the match seats beside the host: the whole pool at a table or a Monopoly match,
 * the chosen opponent alone in Battleship, so every other payer on a wager card is given their
 * wager back. everyonePays refuses the start, before the host is charged, when one of them has
 * not paid: a Battleship captain who never paid would otherwise sit at a match whose pot holds
 * the host's wager alone (2026-10 item 276, D10).
 */
export async function settleDraftBuyIns(
	room: IGameRoom,
	pool: readonly string[],
	options: { everyonePays?: boolean } = {}
): Promise<{ ok: true; seats: PaidSeats | null } | { ok: false; reason: string }> {
	if (!isBuyInGame(room.game)) return { ok: true, seats: null };
	const buyIn = draftBuyInOf(room);
	if (!(await isChipDraft(room))) {
		await refundAllJoiners(room);
		const members = pool.filter((userId) => userId !== room.hostId);
		return { ok: true, seats: { buyIn, userIds: [room.hostId, ...members], charged: false } };
	}
	if (options.everyonePays) {
		const paid = new Set(room.buyInPaidBy ?? []);
		const unpaid = pool.find((userId) => userId !== room.hostId && !paid.has(userId));
		if (unpaid) return { ok: false, reason: gameRoomsCopy.holdem.opponentNotPaid(unpaid, buyIn) };
	}
	// ⚠️ THE HOST'S SEAT GOES ON THE LEDGER LIKE A JOINER'S (2026-10 item 276, audit P3), through the
	// same held charge (2026-10 item 278, gap G3). Start's charge used to sit outside every ledger
	// while the room was built, seconds in which a crash lost it and Call it off could not reach it.
	// On the ledger, every refund a draft has pays it once, and the start claim carries it on with
	// the joiners' (a Blackjack table's stacks among them).
	const hostCharge = await chargeOntoLedger(room, room.hostId, buyIn);
	if (hostCharge === "short") return { ok: false, reason: gameRoomsCopy.holdem.notEnoughChips(buyIn) };
	if (hostCharge !== "paid") return { ok: false, reason: gameRoomsCopy.board.draftGone };

	// A payer who is no longer in the pool would otherwise lose the buy in for good, since the
	// ledger is cleared once the room opens. Refunded only after the host's charge landed, so a
	// short host leaves the ledger as it was for the cancel that follows.
	const paid = paidPoolMembers(room, pool);
	const strays = (room.buyInPaidBy ?? []).filter((userId) => !paid.includes(userId));
	if (strays.length > 0) await refundJoiners(room, strays);
	return { ok: true, seats: { buyIn, userIds: [room.hostId, ...paid], charged: true } };
}

/**
 * The seats a card's table opens with, read against the buy in ledger as the start claim found it
 * (2026-10 item 276, audit P2-13). Start answered its seats from the card as it read it, and the
 * room takes seconds to build: a joiner the host removed meanwhile was refunded and is off the
 * ledger, so they do not sit, and a joiner who paid after Start's read is on the ledger but not
 * in the seats, so they are owed their buy in back (`unseatedPayers`): from the pot or the held
 * seats the claim moved them onto (refundClaimedPayers, 2026-10 item 278), or straight back where
 * the claim moved them nowhere. The host always sits: their seat went on the ledger at Start, and
 * a claim that found it gone (Call it off refunded it) never landed. A free table seats everyone
 * it named, and any payer still on its ledger is owed their buy in back.
 */
export function seatsAtClaim(seats: PaidSeats, hostId: string, ledgerAtClaim: readonly string[]): { seats: PaidSeats; unseatedPayers: string[] } {
	if (!seats.charged) return { seats, unseatedPayers: [...new Set(ledgerAtClaim)] };
	const stillPaid = new Set(ledgerAtClaim);
	const seated = seats.userIds.filter((userId) => userId === hostId || stillPaid.has(userId));
	const unseatedPayers = [...stillPaid].filter((userId) => !seated.includes(userId));
	return { seats: { ...seats, userIds: seated }, unseatedPayers };
}

/**
 * The room did not open: give the host and every paid seat their buy in back, each by claiming its
 * ledger entry first (the host's is there since Start, 2026-10 item 276), so a cancel that already
 * refunded someone pays them nothing twice. A free table owes nobody.
 */
export async function refundOpenedSeats(room: IGameRoom, seats: PaidSeats): Promise<void> {
	if (!seats.charged) return;
	await refundJoiners(room, seats.userIds);
}

/**
 * Give every seat its buy in straight back, for seats no row ledger holds any more: a solo
 * press whose room did not open, or a Blackjack table whose stacks ledger could not be
 * written. Never throws: each refund is logged by name when it fails.
 */
export async function refundSeatsDirectly(seats: PaidSeats): Promise<void> {
	if (!seats.charged) return;
	for (const userId of seats.userIds) {
		try {
			await returnChips({ userId }, seats.buyIn);
		} catch (error) {
			console.error(`[game-rooms] a buy in of ${seats.buyIn} chips could not be given back to ${userId}`, error);
		}
	}
}

// ── a Blackjack table charged outside a card (2026-10 item 267) ──────
/**
 * A solo Blackjack table's buy in, asked at the press through the one chip rule
 * (holdemChips.chipTableFor). A solo table against Dero is never a ranked match, so since
 * 2026-10 item 276 (owner decision D1) it always answers free seats on the standard pretend
 * stack and takes nothing; a member who wants to play for chips alone opens a ranked Blackjack
 * card and starts it with nobody else. Kept on the rule rather than hard coded free, so the
 * press can never charge where the rule says a table plays free, or the reverse.
 */
export async function chargeSoloTable(guildId: string, userId: string): Promise<{ ok: true; seats: PaidSeats } | { ok: false; reason: string }> {
	const buyIn = BOT_CONSTANTS.HOLDEM_STARTING_STACK;
	if (!(await chipTableFor({ guildId, network: false, game: "solo-blackjack" }, 0))) return { ok: true, seats: { buyIn, userIds: [userId], charged: false } };
	if (!(await takeChips({ userId }, buyIn))) return { ok: false, reason: gameRoomsCopy.holdem.notEnoughChips(buyIn) };
	return { ok: true, seats: { buyIn, userIds: [userId], charged: true } };
}

/**
 * Charge each of `userIds` the buy in, in order: the ones whose wallet covered it, and the ones
 * it did not, who were charged nothing. A Blackjack rematch charges its returning players here.
 * Never throws: a debit that fails counts that member as short, because a throw out of here would
 * lose the caller the list of members already charged, and with it every refund it owes them.
 */
export async function chargeSeats(userIds: readonly string[], buyIn: number): Promise<{ paid: string[]; short: string[] }> {
	const paid: string[] = [];
	const short: string[] = [];
	for (const userId of userIds) {
		const charged = await takeChips({ userId }, buyIn).catch((error: unknown) => {
			console.error(`[game-rooms] a buy in of ${buyIn} chips could not be taken from ${userId}`, error);
			return false;
		});
		if (charged) paid.push(userId);
		else short.push(userId);
	}
	return { paid, short };
}
