import {
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type Client,
	type ModalSubmitInteraction,
} from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { ownableTileName } from "@features/games/monopolyBoard.js";
import { closeAuction, placeBid, type AuctionState, type MonopolyResult, type MonopolyState } from "@features/games/monopolyState.js";
import { monopolyAuctionView, renderAuctionCard } from "@features/games/monopolyRenderer.js";
import { withRenderFallback } from "@features/renderer/index.js";
import { GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { auctionClosesAt } from "./roomMonopoly.js";
import {
	applyMonopolyOutcome,
	commitMonopolyMove,
	loadSeatedRoom,
	monopolyStateOf,
	parseWholeCount,
	persistIfUnchanged,
} from "./roomMonopolyHandlers.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { showNotice } from "@utils/textModal.js";

// ── roomMonopolyAuction ──────────────────────────────────────────────
// What:  the room side of a Monopoly auction: the bid button's sealed bid modal,
//        the submit that places the bid, and the sweep that closes a round once
//        its MONOPOLY_AUCTION_ROUND_MS is up.
// Who:   gameRoomHandlers routes the `mauction` button and the `mbid` modal here;
//        main.ts runs sweepMonopolyAuctions on its own short interval.
// When:  only while a match is "in-auction", which applySkip enters when the host
//        opened the match with auctions on and the seat on the clock passes.
// Where: the round lives on the stored match (pendingAuction.roundOpenedAt), not
//        in a timer, so a Railway deploy mid round costs nothing: the next tick
//        after the boot closes it.
// How:   every bid and the close go through the same compare and swap as any
//        move. Bids are sealed: the reply with the amount is ephemeral, and the
//        engine's public trail line for a bid names the bidder and never the
//        amount, until the close says who won and for how much.

const PRIVATE = { flags: MessageFlags.Ephemeral } as const;

// The modal's one field.
const BID_FIELD = "amount";
// Nine digits, the same ceiling parseWholeCount accepts.
const BID_MAX_LENGTH = 9;

// ── the bid ───────────────────────────────────────────────────────────
/** The board's bid button: opens the sealed bid modal for the round on the button. */
export async function handleMauction(interaction: ButtonInteraction, room: IGameRoom, roundArg: string): Promise<void> {
	const state = monopolyStateOf(room);
	const auction = state?.pendingAuction;
	if (!state || state.phase !== "in-auction" || !auction) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.monopoly.noAuction] });
		return;
	}
	if (!isSameRound(auction, roundArg) || Date.now() >= auctionClosesAt(auction)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.monopoly.auctionOver] });
		return;
	}
	const seat = state.seats.find((candidate) => candidate.userId === interaction.user.id && !candidate.bankrupt);
	if (!seat) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.monopoly.inventoryOut] });
		return;
	}

	// The modal must be the FIRST response to the press, so nothing above defers.
	const amount = new TextInputBuilder()
		.setCustomId(BID_FIELD)
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMaxLength(BID_MAX_LENGTH)
		.setPlaceholder(gameRoomsCopy.monopoly.bidAmountPlaceholder(seat.chips));
	const modal = new ModalBuilder()
		.setCustomId(`${GAME_ROOM_MODAL_PREFIX}:mbid:${room.roomId}:${auction.roundOpenedAt}`)
		.setTitle(gameRoomsCopy.monopoly.bidModalTitle)
		.addLabelComponents(
			new LabelBuilder().setLabel(gameRoomsCopy.monopoly.bidAmountLabel(ownableTileName(auction.tileId))).setTextInputComponent(amount)
		);
	await interaction.showModal(modal);
}

/** The bid modal's submit: place the sealed bid, and tell only the bidder what they bid. */
export async function handleBidModal(interaction: ModalSubmitInteraction): Promise<void> {
	const [, , roomId, roundArg] = interaction.customId.split(":");
	const room = await loadSeatedRoom(interaction, roomId);
	if (!room) return;

	// Ephemeral from the start: the confirmation carries the amount, which is sealed.
	await interaction.deferReply(PRIVATE);
	const amount = parseWholeCount(interaction.fields.getTextInputValue(BID_FIELD));
	if (amount === null) {
		await interaction.editReply({ embeds: [errorEmbed(gameRoomsCopy.monopoly.bidNotANumber)] });
		return;
	}

	const now = Date.now();
	const outcome = await commitMonopolyMove(interaction.client, room, interaction.user.id, (state, actorId) => bidInRound(state, actorId, amount, roundArg, now), {
		onTurnOnly: false,
	});
	const auction = outcome.ok ? outcome.state.pendingAuction : null;
	if (!outcome.ok || !auction) {
		await interaction.editReply({ embeds: [errorEmbed(outcome.ok ? gameRoomsCopy.monopoly.auctionOver : outcome.reason)] });
		return;
	}
	// The auction card rides the confirmation when it draws (2026-10 item 243 Phase 3).
	// This reply is ephemeral and the card never cached, because it shows the sealed
	// bid; the line alone is the fallback, the reply as it was before the card.
	const card = await withRenderFallback(
		() => renderAuctionCard(monopolyAuctionView(auction, amount)),
		() => null
	);
	await interaction.editReply({
		content: gameRoomsCopy.monopoly.bidPlaced(amount, ownableTileName(auction.tileId), auctionClosesAt(auction)),
		...(card ? { files: [card.attachment] } : {}),
	});
}

// A bid counts only for the round the modal was opened on, and only before that
// round's close, even when the sweep has not got to it yet: the board told every
// seat when bidding ends, so a late bid would be unfair to the seats that believed it.
function bidInRound(state: MonopolyState, bidderId: string, amount: number, roundArg: string, now: number): MonopolyResult {
	const auction = state.pendingAuction;
	if (!auction || !isSameRound(auction, roundArg) || now >= auctionClosesAt(auction)) {
		return { ok: false, reason: gameRoomsCopy.monopoly.auctionOver };
	}
	return placeBid(state, bidderId, amount);
}

const isSameRound = (auction: AuctionState, roundArg: string): boolean => String(auction.roundOpenedAt) === roundArg;

// ── the close ─────────────────────────────────────────────────────────
export interface AuctionSweepSummary {
	auctionsClosed: number;
}

// ⚠️ ONE SWEEP AT A TIME, for hold em's reason: the interval fires whether or not the
// last tick finished, and a tick stalled behind a 429 while posting trail lines would
// otherwise re-enter on the same rows. The compare and swap would refuse the second
// close anyway; this keeps the second tick from even trying.
let sweepInFlight = false;

/**
 * Close every Monopoly auction whose round has run out: the highest bid its bidder
 * can still pay buys the lot, or the bank keeps it, and the seller's turn carries
 * on. Errors are isolated per room, since this runs on a timer with nobody watching.
 */
export async function sweepMonopolyAuctions(client: Client, now: Date = new Date()): Promise<AuctionSweepSummary> {
	if (sweepInFlight) return { auctionsClosed: 0 };
	sweepInFlight = true;
	try {
		const rooms = await gameRoomStore.findPlayingByGame("monopoly");
		let auctionsClosed = 0;
		for (const room of rooms) {
			try {
				if (await closeExpiredAuction(client, room, now.getTime())) auctionsClosed++;
			} catch (error) {
				console.error("[game-rooms] closing a monopoly auction failed", { roomId: room.roomId, error });
			}
		}
		return { auctionsClosed };
	} finally {
		sweepInFlight = false;
	}
}

async function closeExpiredAuction(client: Client, room: IGameRoom, now: number): Promise<boolean> {
	const state = monopolyStateOf(room);
	const auction = state?.pendingAuction;
	if (!state || state.phase !== "in-auction" || !auction || now < auctionClosesAt(auction)) return false;

	const result = closeAuction(state);
	if (!result.ok) return false;
	// A bid that landed after this sweep read the row wins the compare and swap, and
	// the next tick closes the round with that bid counted.
	const written = await persistIfUnchanged(room, state, result.state, result.trailLines);
	if (!written) return false;

	// "system": no player pressed anything; the close happens because the clock ran out.
	const sellerId = written.seats[written.activeSeatIndex].userId;
	await applyMonopolyOutcome(client, room, state, written, { actorId: sellerId, kind: "system", lines: result.trailLines });
	return true;
}

export const roomMonopolyAuction = { handleMauction, handleBidModal, sweepMonopolyAuctions };
