import { TextChannel, type ButtonInteraction, type Client } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { returnChips, takeChips } from "@features/economy/chipWallet.js";
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
// ⚠️ THE SEAT IS HELD BEFORE ANY CHIP MOVES, AND THE CHIPS LEAVE BEFORE THE LEDGER HOLDS THEM.
// ① holdLateSeat holds the seat in the table's process synchronously, so a double press or two
// members racing for the last seat are refused before anything is charged; ② the buy in leaves
// the wallet (a chip table only); ③ one conditional write puts the seat's ledger entry and its
// playerIds place on the row, only while the room plays and the member is not removed, and a
// write that applies nothing gives the chips straight back; ④ the room's overwrites are set
// again from that row, so the member can see and play the room; ⑤ the seat is marked paid, and
// a table that ended meanwhile pays the entry back through the ledger claim, once. A crash
// between ② and ③ loses the buy in and never mints one: the same window as the table's own open
// (blackjackChips, the Phase 7 box on Blackjack's charge to ledger crash windows).

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

// ①② to ⑤, see the header.
async function claimLateSeat(client: Client, room: IGameRoom, userId: string, username: string): Promise<LateSeatClaim> {
	const channelId = room.channelId;
	if (!channelId) return { ok: false, refusal: gameRoomsCopy.board.lateSeat.tableClosed };
	const hold = holdLateSeat(channelId, { userId, username });
	if (!hold.ok) return { ok: false, refusal: LATE_SEAT_REFUSALS[hold.refusal] };

	try {
		if (hold.chips && !(await takeChips({ userId }, hold.buyIn))) {
			dropLateSeat(channelId, userId);
			return { ok: false, refusal: gameRoomsCopy.holdem.notEnoughChips(hold.buyIn) };
		}
		const entry = hold.chips ? { userId, buyIn: hold.buyIn, stack: hold.buyIn } : null;
		const seated = await gameRoomStore.addLateBlackjackSeat(room.guildId, room.roomId, userId, entry);
		if (!seated) {
			dropLateSeat(channelId, userId);
			if (hold.chips) await returnChips({ userId }, hold.buyIn);
			const fresh = await gameRoomStore.findByRoomId(room.guildId, room.roomId);
			return { ok: false, refusal: fresh && (fresh.kickedIds ?? []).includes(userId) ? hostWords.kick.refusedRejoin : gameRoomsCopy.board.lateSeat.tableClosed };
		}
		await grantRoomAccess(client, seated);
		if (!payLateSeat(channelId, userId, client)) {
			// The table ended between the ledger write and now; whichever of this and finish claims
			// the entry first pays it, once.
			if (hold.chips) await cashOutBlackjackSeat(room, userId, hold.buyIn);
			return { ok: false, refusal: gameRoomsCopy.board.lateSeat.tableClosed };
		}
	} catch (error) {
		// A write that threw may or may not have landed, so nothing is refunded here: an entry that
		// landed is paid by the table's end, and one that did not loses the buy in, never mints it.
		dropLateSeat(channelId, userId);
		console.error(`[game-rooms] a late Blackjack seat for ${userId} in room ${room.roomId} failed`, error);
		return { ok: false, refusal: gameRoomsCopy.board.lateSeat.tableClosed };
	}

	void roomTrail
		.postMove(client, room, { actorId: userId, kind: "join", text: gamesCopy.blackjack.lateSeatHeldTrail(userId, hold.buyIn, hold.chips) })
		.catch((error) => console.warn("[game-rooms] the late seat line could not be posted", { roomId: room.roomId, error }));
	return { ok: true, buyIn: hold.buyIn, chips: hold.chips };
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
