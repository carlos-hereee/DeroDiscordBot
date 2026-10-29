import { LabelBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, type ModalSubmitInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { parseChipAmount, returnChips, takeChips } from "@features/economy/chipWallet.js";
import { chipTableFor } from "./holdemChips.js";
import { GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── holdemDraftBuyIn ─────────────────────────────────────────────────
// What:  the Hold'em buy in on the CHALLENGE CARD (2026-10 item 257 Phase 4a, owner item 13):
//        the host sets the amount on the draft, every joiner pays it from their wallet when
//        they press Join, and whoever the host declines or removes, or a cancelled draft,
//        gets it back. The room then opens with those seats already paid. The in room Set
//        the buy in row this replaces is gone.
// Who:   challengeBoard (the host's press and its modal, the Join charge, an invited member's
//        Accept and buy in, the cancel refund, the seats at Start),
//        hostControls (decline and remove refunds), and RoomProvisioner (seating the paid).
// Does NOT: decide the cards or the stacks (the engine seats a paid member at the buy in
//        through joinTable) or move chips at a running table (holdemChips does that).
//
// ⚠️ THE ROW IS THE LEDGER. `buyInPaidBy` lists the members whose wallet was charged and
// has not been given back, and every refund CLAIMS its entry first (takeBuyInPaid, one
// conditional $pull) and pays second, so a decline racing a cancel pays once. The order for
// a charge is the reverse of a refund and for the same reason: take the chips, record the
// payment against the buy in that was charged (a host who changed the amount meanwhile makes
// the record refuse), and give the chips back if it did. Network tables and tables with a
// Dero bot play free, so nobody pays on a draft that chipTableFor refuses.

/** The two fields of the buy in modal: the preset select and the typed amount. */
export const BUY_IN_FIELDS = { preset: "preset", custom: "custom" } as const;

/** The buy in a draft will charge: what the host set, or the standard stack. */
export const draftBuyInOf = (room: Pick<IGameRoom, "holdemBuyIn">): number => room.holdemBuyIn ?? BOT_CONSTANTS.HOLDEM_STARTING_STACK;

/** Whether a buy in amount is one the host may set: a whole number of chips inside the table's bounds. */
export function isValidDraftBuyIn(amount: number): boolean {
	const economy = BOT_CONSTANTS.ECONOMY;
	return Number.isSafeInteger(amount) && amount >= economy.HOLDEM_MIN_BUY_IN && amount <= economy.HOLDEM_MAX_BUY_IN;
}

/**
 * Whether this draft will open as a chip table, the same question the provisioner asks:
 * chips on in the server, no network table and no Dero bot seat. Read fresh on every
 * charge, so an admin switching chips off mid draft stops charging joiners at once.
 */
export async function isChipDraft(room: Pick<IGameRoom, "game" | "guildId" | "network" | "botSeats">): Promise<boolean> {
	if (room.game !== "holdem") return false;
	return (await chipTableFor(room, (room.botSeats ?? 0) > 0)) !== null;
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
/**
 * Charge a joiner the draft's buy in. Answers the refusal worded for them, or null when they
 * paid (or the draft is free play, where there is nothing to pay).
 */
export async function chargeJoiner(room: IGameRoom, userId: string): Promise<string | null> {
	if (!(await isChipDraft(room))) return null;
	const buyIn = draftBuyInOf(room);
	if (!(await takeChips({ userId }, buyIn))) return gameRoomsCopy.holdem.notEnoughChips(buyIn);

	const recorded = await gameRoomStore.addBuyInPaid(room.guildId, room.roomId, userId, room.holdemBuyIn ?? null);
	if (recorded) return null;
	// The record refused: this member was already on the ledger (a double press, whose first
	// charge stands), or the host changed the amount or the draft closed since the charge.
	await returnChips({ userId }, buyIn);
	const fresh = await gameRoomStore.findByRoomId(room.guildId, room.roomId);
	return (fresh?.buyInPaidBy ?? []).includes(userId) ? gameRoomsCopy.holdem.buyInAlreadyPaid : gameRoomsCopy.board.buyInChangedJoining;
}

/**
 * Give the buy in back to each of `userIds` who paid it. Each refund claims its entry on the
 * row first, so a member listed twice, or a decline racing a cancel, is paid once. Never
 * throws: a refund is a side effect of the decision that triggered it.
 */
export async function refundJoiners(room: Pick<IGameRoom, "guildId" | "roomId" | "holdemBuyIn">, userIds: readonly string[]): Promise<void> {
	const buyIn = draftBuyInOf(room);
	for (const userId of new Set(userIds)) {
		try {
			const claimed = await gameRoomStore.takeBuyInPaid(room.guildId, room.roomId, userId);
			if (claimed) await returnChips({ userId }, buyIn);
		} catch (error) {
			console.error("[game-rooms] a hold em buy in could not be refunded", { guildId: room.guildId, roomId: room.roomId, userId, error });
		}
	}
}

/** Refund everybody the draft still holds a buy in for: a cancelled or replaced draft. */
export async function refundAllJoiners(room: Pick<IGameRoom, "guildId" | "roomId" | "holdemBuyIn" | "buyInPaidBy">): Promise<void> {
	await refundJoiners(room, room.buyInPaidBy ?? []);
}

// ── opening the table ─────────────────────────────────────────────────
/** Who sits down as the room opens (the host first), and whether their seats were paid for. */
export interface PaidSeats {
	buyIn: number;
	userIds: string[];
	// True on a chip table, where the host and every one of userIds paid `buyIn` from their
	// wallet; false on a table that plays free, where nobody paid and every seat is free.
	charged: boolean;
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
 * Settle a Hold'em draft's buy ins as the room opens. A chip draft charges the host (their seat
 * is paid like everyone's) and answers the members who paid on the card and are still in the
 * pool, host first, giving back any payment whose member left the pool. A draft that plays free
 * (chips off, a network table, or a Dero bot seat, which the rulebook says plays free) gives
 * every payment back and seats the host and every pool member free. A refusal means the host's
 * wallet is short, and nothing was taken.
 *
 * ⚠️ A FREE TABLE STILL SEATS EVERYBODY (2026-10 item 263 risk R8). This used to answer no seats
 * when the draft was not a chip draft, and isChipDraft is false whenever a bot sits, so a card
 * with Dero bots opened with the bots alone and the host unseated.
 */
export async function settleDraftBuyIns(room: IGameRoom, pool: readonly string[]): Promise<{ ok: true; seats: PaidSeats | null } | { ok: false; reason: string }> {
	if (room.game !== "holdem") return { ok: true, seats: null };
	const buyIn = draftBuyInOf(room);
	if (!(await isChipDraft(room))) {
		await refundAllJoiners(room);
		const members = pool.filter((userId) => userId !== room.hostId);
		return { ok: true, seats: { buyIn, userIds: [room.hostId, ...members], charged: false } };
	}
	if (!(await takeChips({ userId: room.hostId }, buyIn))) return { ok: false, reason: gameRoomsCopy.holdem.notEnoughChips(buyIn) };

	// A payer who is no longer in the pool would otherwise lose the buy in for good, since the
	// ledger is cleared once the room opens. Refunded only after the host's charge landed, so a
	// short host leaves the ledger as it was for the cancel that follows.
	const paid = paidPoolMembers(room, pool);
	const strays = (room.buyInPaidBy ?? []).filter((userId) => !paid.includes(userId));
	if (strays.length > 0) await refundJoiners(room, strays);
	return { ok: true, seats: { buyIn, userIds: [room.hostId, ...paid], charged: true } };
}

/** The room did not open: give the host and every paid seat their buy in back. A free table owes nobody. */
export async function refundOpenedSeats(room: IGameRoom, seats: PaidSeats): Promise<void> {
	if (!seats.charged) return;
	await returnChips({ userId: room.hostId }, seats.buyIn);
	await refundJoiners(room, seats.userIds.filter((userId) => userId !== room.hostId));
}
