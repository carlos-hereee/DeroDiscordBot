import { randomUUID } from "node:crypto";
import { TextChannel, type ButtonInteraction, type Client } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { closeChipReceipt, refundChipReceipt, takeChipsWithReceipt } from "@features/economy/chipWallet.js";
import { dropLateSeat, holdLateSeat, lateSeatRefusalOf, payLateSeat, sharedTableSeatsOf, type LateSeatRefusal } from "@features/games/blackjackHandler.js";
import { gamesCopy } from "@features/games/gamesCopy.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";
import { cashOutBlackjackSeat } from "./blackjackChips.js";
import { refreshTableCard } from "./challengeCard.js";
import { isSharedBlackjackTable } from "./chipMatch.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { judgeJoin } from "./joinGate.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { roomTrail } from "./roomTrail.js";

// ── blackjackLateSeat ────────────────────────────────────────────────
// What:  the one door into a ranked Blackjack table that is already dealing (2026-10 item 276,
//        owner decision D14): the open card's Join (action `bjoin`), and the host accepting a
//        join request at that table. Both pass joinGate.judgeJoin, the gate every door into a
//        room passes, then take a seat through claimLateSeat, so a press and an accept seat a
//        member the same way, the way Hold'em's Take a seat and its accepted requests share
//        roomHoldemHandlers.claimSeat.
// Who:   gameRoomHandlers (the `bjoin` press) and hostControls (an accepted request).
// Does NOT: deal anybody in (blackjackHandler deals a paid late seat in at the next hand's bets),
//        or cash a seat out (Leave, at the table, is a cash out, D9).
//
// ⚠️ THE SEAT IS HELD BEFORE ANY CHIP MOVES, AND NO MOMENT LEAVES A BUY IN NOBODY OWES BACK.
// ① holdLateSeat holds the seat in the table's process synchronously, so a double press or two
// members racing for the last seat are refused before anything is charged; ② on a chip table the
// row holds the charge (gameRoomStore.holdLateSeatCharge) BEFORE the wallet is touched, and ③ the
// buy in leaves the wallet with a receipt in the same write; ④ one conditional write puts the
// seat's ledger entry and its playerIds place on the row and takes the held charge off, only
// while the room plays and the member is not removed; a write that applies nothing gives the
// chips back through the receipt; ⑤ the receipt is closed, ⑥ the room's overwrites are set again
// from that row, so the member can see and play the room, and ⑦ the seat is marked paid, and a
// table that ended meanwhile pays the entry back through the ledger claim, once. A crash between
// ③ and ④ leaves the held charge on the row, which finish refunds through the receipt, so the buy
// in comes back once and only if it was taken (2026-10 item 276, audit P3; before this the window
// lost the buy in).

const hostWords = rokCommanderCopy.arcadeHostControls;

const LATE_SEAT_REFUSALS: Record<LateSeatRefusal, string> = {
	noTable: gameRoomsCopy.board.lateSeat.tableClosed,
	alreadySeated: gameRoomsCopy.board.lateSeat.alreadySeated,
	alreadyPlayed: gameRoomsCopy.board.lateSeat.alreadyPlayed,
	full: gameRoomsCopy.board.lateSeat.full,
};

/** A late seat that landed (what it cost, and whether the table plays for wallet chips), or why not. */
type LateSeatClaim = { ok: true; buyIn: number; chips: boolean } | { ok: false; refusal: string };

/**
 * The open card's Join while the table deals: refused for a table that takes no stranger (not a
 * ranked table, not playing, Invite only), then the host's say (judgeJoin: a removed member and a
 * rating outside the band are refused, a host who approves each joiner gets a request), then the
 * seat itself.
 */
export async function joinBlackjackTable(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const notice = (text: string) => showNotice(interaction, { title: gamesCopy.notices.blackjack, sections: [text] });
	if (room.status !== "playing" || !room.channelId || !isSharedBlackjackTable(room)) return notice(gameRoomsCopy.board.lateSeat.tableClosed);
	if (room.visibility !== "public") return notice(gameRoomsCopy.board.lateSeat.inviteOnly);

	const userId = interaction.user.id;
	// The table's own answer first, read in memory: the host, a seated member and a full table
	// are refused before the host is asked anything.
	const seatRefusal = lateSeatRefusalOf(room.channelId, userId);
	if (seatRefusal) return notice(LATE_SEAT_REFUSALS[seatRefusal]);
	const verdict = await judgeJoin(room, userId, { alreadyApproved: false });
	if (verdict.kind === "refuse") {
		return notice(verdict.reason === "kicked" ? hostWords.kick.refusedRejoin : hostWords.band.refused(gameRoomsCopy.gameLabel(room.game)));
	}
	if (verdict.kind === "ask") {
		await askHostForTableSeat(interaction, room);
		return;
	}

	const claim = await claimLateSeat(interaction.client, room, userId, memberDisplayName(interaction));
	if (!claim.ok) return notice(claim.refusal);
	// A held seat is work done, so it is an answer where it was pressed (owner rule 1, R3-11).
	await answerInChannel(interaction, "here", { content: gameRoomsCopy.board.lateSeat.held(claim.buyIn, claim.chips) });
}

/**
 * Seat a member the host accepted at a dealing table, the way their own Join would have. Answers
 * null once their seat is held for the next hand, or the reason it was not, for the host's summary.
 */
export async function seatAcceptedBlackjackPlayer(client: Client, room: IGameRoom, userId: string, username: string): Promise<string | null> {
	const claim = await claimLateSeat(client, room, userId, username);
	return claim.ok ? null : claim.refusal;
}

/** Redraw a dealing table's open card from its row, for a host control that changed only the room (a request filed or answered). */
export async function redrawTableCard(client: Client, room: IGameRoom): Promise<void> {
	const seats = room.channelId ? sharedTableSeatsOf(room.channelId) : null;
	if (seats) await refreshTableCard(client, room, seats);
}

// ① to ⑦, see the header.
async function claimLateSeat(client: Client, room: IGameRoom, userId: string, username: string): Promise<LateSeatClaim> {
	const channelId = room.channelId;
	if (!channelId) return { ok: false, refusal: gameRoomsCopy.board.lateSeat.tableClosed };
	const hold = holdLateSeat(channelId, { userId, username });
	if (!hold.ok) return { ok: false, refusal: LATE_SEAT_REFUSALS[hold.refusal] };
	const chargeId = hold.chips ? randomUUID() : null;

	try {
		if (chargeId) {
			const charge = await chargeLateSeat(room, userId, hold.buyIn, chargeId);
			if (charge !== "charged") {
				dropLateSeat(channelId, userId);
				return { ok: false, refusal: charge === "short" ? gameRoomsCopy.holdem.notEnoughChips(hold.buyIn) : await seatRefusalFor(room, userId) };
			}
		}
		const entry = chargeId ? { userId, buyIn: hold.buyIn, stack: hold.buyIn } : null;
		const seated = await gameRoomStore.addLateBlackjackSeat(room.guildId, room.roomId, userId, entry, chargeId);
		if (!seated) {
			dropLateSeat(channelId, userId);
			if (chargeId) await giveLateChargeBack(room, userId, hold.buyIn, chargeId);
			return { ok: false, refusal: await seatRefusalFor(room, userId) };
		}
		if (chargeId) void closeChipReceipt({ userId }, chargeId).catch((error: unknown) => console.warn("[game-rooms] a late seat's receipt could not be closed", { roomId: room.roomId, userId, error }));
		await grantRoomAccess(client, seated);
		if (!payLateSeat(channelId, userId, client)) {
			// The table ended between the ledger write and now; whichever of this and finish claims
			// the entry first pays it, once.
			if (hold.chips) await cashOutBlackjackSeat(room, userId, hold.buyIn);
			return { ok: false, refusal: gameRoomsCopy.board.lateSeat.tableClosed };
		}
	} catch (error) {
		// A write that threw may or may not have landed, so nothing is refunded here: an entry that
		// landed is paid by the table's end, and a charge still held is refunded by finish through its
		// receipt, only if it was taken.
		dropLateSeat(channelId, userId);
		console.error(`[game-rooms] a late Blackjack seat for ${userId} in room ${room.roomId} failed`, error);
		return { ok: false, refusal: gameRoomsCopy.board.lateSeat.tableClosed };
	}

	void roomTrail
		.postMove(client, room, { actorId: userId, kind: "join", text: gamesCopy.blackjack.lateSeatHeldTrail(userId, hold.buyIn, hold.chips) })
		.catch((error) => console.warn("[game-rooms] the late seat line could not be posted", { roomId: room.roomId, error }));
	return { ok: true, buyIn: hold.buyIn, chips: hold.chips };
}

// ②③ The row holds the charge, then the wallet pays it with a receipt. "refused" when the row would
// not hold it (the room ended, or the member was removed), "short" when the wallet did not cover it;
// either way nothing is left charged or held.
async function chargeLateSeat(room: IGameRoom, userId: string, buyIn: number, chargeId: string): Promise<"charged" | "short" | "refused"> {
	if (!(await gameRoomStore.holdLateSeatCharge(room.guildId, room.roomId, { userId, buyIn, chargeId }))) return "refused";
	if (await takeChipsWithReceipt({ userId }, buyIn, chargeId)) return "charged";
	await gameRoomStore.dropLateSeatCharge(room.guildId, room.roomId, chargeId);
	return "short";
}

// A seat the row refused after its charge: the buy in back through the receipt (a finish that got
// there first already did, and then this pays nothing), then the held charge off the row.
async function giveLateChargeBack(room: IGameRoom, userId: string, buyIn: number, chargeId: string): Promise<void> {
	await refundChipReceipt({ userId }, buyIn, chargeId);
	await gameRoomStore.dropLateSeatCharge(room.guildId, room.roomId, chargeId);
}

// Why the row would not take the seat: the host removed the member, or the table closed.
async function seatRefusalFor(room: IGameRoom, userId: string): Promise<string> {
	const fresh = await gameRoomStore.findByRoomId(room.guildId, room.roomId);
	return fresh && (fresh.kickedIds ?? []).includes(userId) ? hostWords.kick.refusedRejoin : gameRoomsCopy.board.lateSeat.tableClosed;
}

// The room's overwrites set again from the row the seat was written to, so the new player can
// see the room and play in it (the one matrix every phase writes, roomLifecycle.applyRoomPhase).
async function grantRoomAccess(client: Client, room: IGameRoom): Promise<void> {
	const channel = room.channelId ? await client.channels.fetch(room.channelId).catch(() => null) : null;
	if (channel instanceof TextChannel) await roomLifecycle.applyRoomPhase(client, channel, room, "playing");
}

// The host approves each joiner: the member waits on the room's request list for the host's
// Requests button on the open card, and nothing is charged until the host accepts (the way a
// Hold'em table's late seat request waits). The store refuses a member removed since the read.
async function askHostForTableSeat(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	if ((room.pendingJoinIds ?? []).includes(interaction.user.id)) {
		await showNotice(interaction, { title: gamesCopy.notices.blackjack, sections: [hostWords.approval.alreadyAsked] });
		return;
	}
	const updated = await gameRoomStore.addPendingJoin(room.guildId, room.roomId, interaction.user.id);
	if (!updated) {
		await showNotice(interaction, { title: gamesCopy.notices.blackjack, sections: [hostWords.kick.refusedRejoin] });
		return;
	}
	// A request filed is work done, so it is an answer (owner rule 1, R3-11).
	await answerInChannel(interaction, "here", { content: hostWords.approval.asked });
	await redrawTableCard(interaction.client, updated);
}

const memberDisplayName = (interaction: ButtonInteraction): string =>
	interaction.guild?.members.cache.get(interaction.user.id)?.displayName ?? interaction.user.globalName ?? interaction.user.username;
