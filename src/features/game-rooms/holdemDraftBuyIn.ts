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
// Who:   challengeBoard (the host's press and its modal, the Join charge, the cancel refund),
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
	if (!(await takeChips({ guildId: room.guildId, userId }, buyIn))) return gameRoomsCopy.holdem.notEnoughChips(buyIn);

	const recorded = await gameRoomStore.addBuyInPaid(room.guildId, room.roomId, userId, room.holdemBuyIn ?? null);
	if (recorded) return null;
	// The host changed the amount (or the draft closed) between the charge and the record.
	await returnChips({ guildId: room.guildId, userId }, buyIn);
	return gameRoomsCopy.board.buyInChangedJoining;
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
			if (claimed) await returnChips({ guildId: room.guildId, userId }, buyIn);
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
/** What the room opens with: the amount, and who sits down already paid (the host first). */
export interface PaidSeats {
	buyIn: number;
	userIds: string[];
}

/**
 * Settle a Hold'em draft's buy ins as the room opens. A chip draft charges the host (their seat
 * is paid like everyone's) and answers the members who paid on Join and are still in the pool,
 * host first; a draft that is free play by now (chips switched off meanwhile) gives every
 * payment back and answers none. A refusal means the host's wallet is short, and nothing was
 * taken.
 */
export async function settleDraftBuyIns(room: IGameRoom, pool: readonly string[]): Promise<{ ok: true; seats: PaidSeats | null } | { ok: false; reason: string }> {
	if (room.game !== "holdem") return { ok: true, seats: null };
	if (!(await isChipDraft(room))) {
		await refundAllJoiners(room);
		return { ok: true, seats: null };
	}
	const buyIn = draftBuyInOf(room);
	if (!(await takeChips({ guildId: room.guildId, userId: room.hostId }, buyIn))) return { ok: false, reason: gameRoomsCopy.holdem.notEnoughChips(buyIn) };

	const inPool = new Set(pool);
	const paid = (room.buyInPaidBy ?? []).filter((userId) => inPool.has(userId));
	return { ok: true, seats: { buyIn, userIds: [room.hostId, ...paid] } };
}

/** The room did not open: give the host and every paid seat their buy in back. */
export async function refundOpenedSeats(room: IGameRoom, seats: PaidSeats): Promise<void> {
	await returnChips({ guildId: room.guildId, userId: room.hostId }, seats.buyIn);
	await refundJoiners(room, seats.userIds.filter((userId) => userId !== room.hostId));
}
