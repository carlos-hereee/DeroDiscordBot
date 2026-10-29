import { MessageFlags, TextChannel, type ButtonInteraction, type Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { buildPots, potTotal, type PlayerCommitment } from "@features/games/holdemPots.js";
import {
	actionsFor,
	joinTable,
	dealHand,
	act,
	forceFold,
	leaveTable,
	endTable,
	returnToTable,
	requestLateSeat,
	withdrawLateSeat,
	handInProgress,
	clockStartOf,
	presentPlayers,
	placements,
	startingStackOf,
	whoActs,
	type ActionOutcome,
	type HoldemTable,
	type JoinResult,
	type LateSeatResult,
	type ReturnResult,
} from "@features/games/holdemTable.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { awardXp, type AwardXpInput } from "@features/leveling/awardXp.js";
import { awardForResult } from "@features/economy/deroCoins.js";
import { announceDealer, toPublicView, type PublicView } from "@features/dero-brain/dealerNarration.js";
import { holdemLiveView, renderHoldemLiveCard } from "@features/dero-brain/dealerShowdownRenderer.js";
import { recordMatchRatings } from "@features/ratings/recordMatchRatings.js";
import { recordShowdownHand } from "@features/ratings/gameResultCounts.js";
import { isRatedHoldemSession } from "@features/ratings/ratingEngine.js";
import { secureRandom } from "@utils/secureRng.js";
import { parseChipAmount } from "@features/economy/chipWallet.js";
import { cashOut, payBuyIn, refundBuyIn } from "./holdemChips.js";
import { botViewOf, decideHoldemMove } from "@features/games/holdemBot.js";
import { isBotSeatId } from "./botSeat.js";
import type { BettingAction } from "@features/games/holdemBetting.js";
import { showPrivateView } from "./privateView.js";
import { chipsAtHandStart, holdemOutcome, shareOf, type FinishCause, type OutcomeBucket } from "./matchOutcome.js";
import { HAND_CATEGORIES } from "@features/games/holdemHand.js";
import { roomTrail, type RoomMoveInput } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isClockExpired, pausedDeadline, roomDrawingKey, withDrawingPause } from "./drawingPause.js";
import { judgeJoin } from "./joinGate.js";
import { labelEmbedForRoom, labelForRoom, relayMove, relayState } from "./satelliteRooms.js";
import { consentPrompt } from "./networkRules.js";
import { scheduleNetworkBoardRefresh } from "./networkBoard.js";
import { hostDestinationFor, resolveHoldemXpDestination } from "./networkXp.js";
import {
	tableEmbed,
	holeCardsEmbed,
	holeCardsView,
	holdemTurnView,
	joiningRows,
	betweenHandsRows,
	bettingRows,
	aggressiveActionFor,
	resolveRaiseAmount,
	tableHostStateOf,
} from "./roomHoldem.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { acknowledgeConfirm, showNotice, type ConfirmInteraction } from "@utils/textModal.js";
import { syncTurnPrompt, type TurnAdapter } from "./turnPrompt.js";
import { syncTurnClocks, type TurnClockGame } from "./turnClock.js";
import { postTurnBoard } from "./turnBoard.js";
import { splitTurnAt, turnBlockLines } from "./turnLog.js";

// ── roomHoldemHandlers ───────────────────────────────────────────────
// What:  every hold em interaction: buying in, dealing, acting, peeking at your
//        own cards, leaving or ending the table, coming back from sitting out, and
//        the clock that folds for a player who vanished and deals the next hand.
//        Plus the table half of the host controls (2026-10 item 244 Phase 4): the
//        join gate on Buy in, late seats while the host has seats open, the seat
//        toggle, and taking a removed player off the table.
// Who:   routed from gameRoomHandlers; main.ts runs the clock on its own interval.
// When:  many times per tournament.
// Where: the table lives on the room row, so a deploy mid-hand costs nothing. Its
//        chips live NOWHERE ELSE, which is the whole of A9/R22.
// How:   every path ends by persisting the table and redrawing its board, with the live
//        table card, behind the drawing pause. A street is a turn (2026-10 item 263
//        R3-29): every bet of a street edits that street's table message in place with
//        the bet in its This turn block, and a new street, a hand's end or a new hand
//        posts a new table message through the shared turn board while the street before
//        stays in the room with its buttons off. A bet, a forced fold and a hand's result
//        are lines in a block, recorded once the message showing them landed; a seat
//        taken, a leave, an end and a host's toggle still post as lines of their own,
//        since they are no bet of a street. The three paths that
//        change a hand (a deal, an action, a clock fold) then hand a public view of
//        the table before and after to announceDealer, fire and forget, which
//        narrates only the tables Dero opened and deals. At a network table the
//        redraw then relays the same board to every satellite in another server
//        (satelliteRooms, 2026-10 item 244 Phase 5a), and a press from a satellite
//        reaches these handlers with the host row, exactly like a press at home.
//        Since Phase 5b a satellite player's XP is paid in the server networkXp
//        names, a network table's door asks for the network notice first, and
//        every redraw of one asks the network board to refresh.
//
// ⚠️ EVERY CALL THAT CAN REACH THE SHUFFLE PASSES secureRandom. The engine's own
// default is the fast, predictable generator and stays that way for its tests;
// the secure source is chosen here, and secureRng.test.ts fails any dealHand call
// that leaves it out, and any mention of that default in this file.

const PRIVATE = { flags: MessageFlags.Ephemeral } as const;

// The host controls' words, shared by every pack (see roomHoldem.ts), so the default
// pack serves every guild without a config read on the table's hot path.
const hostWords = rokCommanderCopy.arcadeHostControls;

const tableOf = (room: IGameRoom): HoldemTable | null => (room.secret as HoldemTable | null) ?? null;

const currentPot = (table: HoldemTable): number =>
	potTotal(
		buildPots(
			table.seats
				.filter((seat) => seat.totalCommitted > 0)
				.map((seat): PlayerCommitment => ({ userId: seat.userId, committed: seat.totalCommitted, folded: seat.folded }))
		)
	);

// Persist the table ONLY if nobody else has acted since the caller read it.
//
// ⚠️ `lastActionAt` IS THE VERSION STAMP AND EVERY ENGINE MUTATION MOVES IT, so
// matching on the value the caller read is a compare and swap over the whole table
// without adding a field to it. An unconditional write is what let two clicks on one
// seat, or the turn clock racing the player it was about to fold, both land: `secret`
// is a single Mixed field, so the second writer replaces the first one's work
// wholesale. A null return means somebody else won and THEIR action is the real one.
//
// The stamp is millisecond resolution, so two writes inside the same millisecond
// would both match. That is not the window this closes: the real gap is the tens of
// milliseconds between a read and a write, and the whoActs check upstream already
// covers the rest.
async function persistIfUnchanged(room: IGameRoom, table: HoldemTable, readAt: number) {
	return gameRoomStore.updateSecretIf(room.guildId, room.roomId, { "secret.lastActionAt": readAt, ...sameBoard(table) }, table);
}

// ⚠️ EVERY TABLE WRITE ALSO MATCHES THE BOARD MESSAGE ID (risk R13, 2026-10 item 257 Phase 4a;
// R17 of item 263). A reveal posts a new table message and moves `secret.boardMessageId` with
// one dotted write that leaves lastActionAt alone, so a write keyed only on the stamp would let
// an action read before that write the OLD board id back with the rest of the blob, and the
// table would point at a kept street's message whose buttons are off. Monopoly's
// turnFingerprint does the same. The loser of the race answers "the table changed" and the
// player presses again. `table.boardMessageId` is still the id the caller read: only a redraw
// changes it, and only after its own claim landed.
const sameBoard = (table: HoldemTable): Record<string, unknown> => ({ "secret.boardMessageId": table.boardMessageId ?? null });

// ── the street's lines (2026-10 item 263 R3-29) ───────────────────────
/** What a move adds to the boards: the street it closed, if it closed one, and the street now showing. */
interface HoldemTurn {
	// The closed street's whole block for its kept table message, or null while the street runs on.
	finishedShown: string[] | null;
	// This move's lines that belong to the closed street.
	finishedNew: RoomMoveInput[];
	// This move's lines that belong to the street the table now shows.
	currentNew: RoomMoveInput[];
}

const NO_NEW_LINES: HoldemTurn = { finishedShown: null, finishedNew: [], currentNew: [] };

/** A move's lines, by when they happened: at the table the move was made at, and after it. */
interface HoldemMoveLines {
	// The move itself, then the seats sitting out it folded on the way: the street it was made on.
	played: RoomMoveInput[];
	// What the move set off once the betting closed: chips handed back, the showdown, the pots
	// won, the busts. They belong to the table it left, a hand's end when it ended one.
	after: RoomMoveInput[];
}

/**
 * The lines one engine outcome adds, led by `lead` (the move's own line: the engine's narration,
 * or the clock's timeout line, which replaces it). The same lines and kinds the room posted one
 * message each before item 263, so the transcript reads as it always did.
 */
function holdemMoveLines(outcome: ActionOutcome, lead: readonly RoomMoveInput[]): HoldemMoveLines {
	const holdem = gameRoomsCopy.holdem;
	const played: RoomMoveInput[] = [
		...lead,
		// Seats the action reached while they sit out, folded by the engine, each in the room's
		// own words rather than the engine's plain "folds".
		...(outcome.sittingOutFolds ?? []).map((userId): RoomMoveInput => ({ actorId: userId, kind: "system", text: holdem.sittingOutFolded(userId) })),
	];
	if (!outcome.handOver) return { played, after: [] };
	// The uncalled chips come back before the awards, which is the order it happens at a real
	// table, and as a line of its own: a hand history that credits somebody with chips they
	// were never at risk of losing is one players argue about.
	const returned = outcome.returned;
	const after: RoomMoveInput[] = [
		...(returned ? [{ actorId: returned.userId, kind: "system" as const, text: holdem.uncalledReturned(returned.userId, returned.amount) }] : []),
		...(outcome.showdown ?? []).map((shown): RoomMoveInput => ({ actorId: shown.userId, kind: "system", text: holdem.showdownLine(shown.userId, shown.hand) })),
		...(outcome.awards ?? []).filter((award) => award.amount > 0).map((award): RoomMoveInput => ({ actorId: award.userId, kind: "system", text: holdem.handWon(award.userId, award.amount) })),
		...(outcome.busted ?? []).map((bustedId): RoomMoveInput => ({ actorId: bustedId, kind: "system", text: holdem.busted(bustedId) })),
	];
	return { played, after };
}

/** The engine's own line for an action as the room's first line of it, when it narrated one. */
const narrationLead = (outcome: ActionOutcome, actorId: string): RoomMoveInput[] => (outcome.narration ? [{ actorId, kind: "guess", text: outcome.narration }] : []);

/**
 * Stamp a move's lines onto `table.turnLog` BEFORE the move's compare and swap writes it, and
 * answer where each line lands. `revealBefore` is the table's reveal key as the move read it.
 * When the move changed what the table shows (a street dealt, a hand over, a new hand), the
 * street it was played on closes: its `played` lines finish that street's block on its kept
 * message, and its `after` lines open the new message's block. `opensNewStreet` puts every line
 * on the new message (a deal: its blind and deal lines open the hand).
 *
 * ⚠️ BOTH KEYS COME FROM THE TABLE ITSELF, never from `table.revealKey`, which is what the board
 * last SHOWED and only moves when a redraw claims a new message. An action read after another
 * action closed the street but before that redraw landed would otherwise see a reveal it did not
 * make and close a street that is already closed.
 */
function stampHoldemTurn(table: HoldemTable, revealBefore: string, lines: HoldemMoveLines, opensNewStreet = false): HoldemTurn {
	const moves = [...lines.played, ...lines.after];
	const changed = holdemRevealKey(table) !== revealBefore;
	const cut = changed ? (opensNewStreet ? 0 : lines.played.length) : null;
	const split = splitTurnAt(table.turnLog ?? [], moves.map((move) => move.text), cut);
	table.turnLog = split.current;
	const finishedCount = split.finishedNew.length;
	return { finishedShown: split.finishedShown, finishedNew: moves.slice(0, finishedCount), currentNew: moves.slice(finishedCount) };
}

// Redraw the table's board behind the drawing pause: the live table card (every table, every
// action) in the table embed's image slot, or the embed alone when the card does not draw, while
// the clock holds. `turn` is what the move that called this added (stampHoldemTurn). Cosmetic, so
// a failure is logged and swallowed: the row is the truth and the next action catches up.
async function redraw(client: Client, room: IGameRoom, table: HoldemTable, turn: HoldemTurn = NO_NEW_LINES): Promise<void> {
	if (!table.boardMessageId || !room.channelId) return;
	const channel = await client.channels.fetch(room.channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return;
	// Null when an admin deleted it: the table then posts a fresh message rather than lose the
	// lines this move added along with the deleted one.
	const message = await channel.messages.fetch(table.boardMessageId).catch(() => null);

	const pot = currentPot(table);
	// The host controls the rows show (2026-10 item 244 Phase 4) come from the row this
	// redraw was handed. A row read a moment before a toggle can draw the old label
	// until the next redraw; the press itself is safe either way, because each toggle
	// button carries the value it sets and the handler re-reads the room.
	const host = tableHostStateOf(room);
	// Four states, not three. The one that was missing is BETWEEN hands: the
	// tournament is still "playing" but the last hand has settled, so there is nothing
	// to act on and the host needs the deal control back. Falling through to
	// bettingRows there rendered five disabled buttons and no way forward, which is
	// what dead ended every tournament after hand one.
	const components =
		table.status === "finished"
			? []
			: table.status === "joining"
			  ? joiningRows(room.roomId, table.seats.length, table, host)
			  : handInProgress(table)
			    ? bettingRows(table, room.roomId, pot, host)
			    : betweenHandsRows(room.roomId, table, host);

	await withDrawingPause({
		gameKey: roomDrawingKey(room),
		showStatus: async (status) => {
			await message?.edit({ content: status });
		},
		// The view is built inside the render, so a view that throws costs the card,
		// not the board. It reads the public view only: no seat's own cards.
		render: () => renderHoldemLiveCard(holdemLiveView(toPublicView(table), pot)),
		fallback: () => null,
		swapIn: async (card) => {
			const prompted = promptTable(table);
			// A network table names its players rather than mentioning them (satelliteRooms).
			const embed = await labelEmbedForRoom(client, room, tableEmbed(table, pot, clockLine(table)));
			const embeds = [card ? embed.setImage(card.ref) : embed];
			const files = card ? [card.attachment] : [];
			// ① A reveal (a street dealt, a hand over, a new hand) is a new turn: the table posts a new
			// message through the shared turn board, and the street before keeps its message, with the
			// bet that closed it written into its block (2026-10 item 263 R3-29); ② anything else edits
			// the street's own message in place.
			const reveal = holdemRevealKey(table);
			if (reveal !== (table.revealKey ?? JOINING_REVEAL) || !message) {
				const closing = turn.finishedShown && turn.finishedNew.length > 0 ? { block: await labelledBlock(client, room, turn.finishedShown), moves: turn.finishedNew } : undefined;
				const postedId = await postTurnBoard(channel, room, table.boardMessageId, { embeds, components, files }, { alsoSet: { "secret.revealKey": reveal }, carried: turn.currentNew, ...(closing ? { closing } : {}) });
				if (postedId) {
					table.boardMessageId = postedId;
					table.revealKey = reveal;
				}
				// A satellite keeps ONE table message, edited, so the closing bet its table never
				// showed is relayed as a line, the way every move reached it before.
				if (closing && room.satellites?.length) for (const move of closing.moves) void labelForRoom(client, room, move.text).then((line) => relayMove(client, room, line));
			} else {
				await message.edit({
					content: null,
					embeds,
					components,
					files,
					// `attachments: []` drops the last action's card, which an edit otherwise keeps.
					attachments: [],
				});
				await roomTrail.recordCarriedMoves(room, turn.currentNew);
			}
			if (prompted) await rememberPrompt(room, table);
			// The same table into every satellite of a network table (2026-10 item 244 Phase
			// 5a), after the host room has it and never awaited, so a satellite in another
			// server can neither slow this board nor fail it.
			if (room.satellites?.length) void relayState(client, room, { embeds, components, files });
			// A network table's seats and phase are what the network board lists (2026-10 item
			// 244 Phase 5b), so every redraw asks for a board refresh, debounced there.
			if (room.network) scheduleNetworkBoardRefresh();
		},
	}).catch((error) => console.warn("[game-rooms] failed to redraw the hold em table", error));
	// The line that pings whoever the hand is waiting on, below the table that was just drawn, and
	// their turn clock (2026-10 item 267), counted from when this board showed them the turn.
	await syncTurnPrompt(client, room, holdemTurnAdapter);
	await syncTurnClocks(client, room, [holdemTurnClock]);
}

// A closed street's block as the room shows lines: a network table names its players.
async function labelledBlock(client: Client, room: IGameRoom, lines: readonly string[]): Promise<string[]> {
	return Promise.all(turnBlockLines(lines).map((line) => labelForRoom(client, room, line)));
}

// What the table message on the board shows of the hand. It changes when a street is dealt, when
// a hand ends (showdown or everyone folded) and when the next hand is dealt; it holds still for
// every action in between, which edit the table in place. A joining table is the baseline.
const JOINING_REVEAL = "joining";

/** The key a table message is shown under; exported for the tests that seed a table already on the board. */
export function holdemRevealKey(table: HoldemTable): string {
	if (table.status === "joining") return JOINING_REVEAL;
	return `${table.handNumber}.${table.board.length}.${handInProgress(table) ? "live" : "settled"}.${table.status}`;
}

// ── the prompt ────────────────────────────────────────────────────────
// The first time a board shows a playing table in a new state is when the clock on
// that state starts (clockStartOf): the turn clock for the player to act, the delay
// before the next hand between hands. So the trail lines and the render ahead of the
// board never eat into a player's minute. Stamped just before the edit, so the
// countdown the board shows is the clock the sweep enforces.
//
// Only while playing. A joining table runs no clock, and a buy in moves no action
// stamp, so a write keyed on that stamp could erase a seat that landed meanwhile.
function promptTable(table: HoldemTable, now: number = Date.now()): boolean {
	if (table.status !== "playing" || table.turnPrompt?.stamp === table.lastActionAt) return false;
	table.turnPrompt = { stamp: table.lastActionAt, shownAt: now };
	return true;
}

// Kept only while the table is still in the state that was shown: while playing,
// every move moves the stamp, so a move that landed since makes this write lose, and
// that move's own redraw prompts its own state.
async function rememberPrompt(room: IGameRoom, table: HoldemTable): Promise<void> {
	await gameRoomStore.updateSecretIf(room.guildId, room.roomId, { "secret.lastActionAt": table.lastActionAt, "secret.status": "playing", ...sameBoard(table) }, table);
}

// The line under the header that counts down: whose turn it is and when it runs out,
// or when the next hand deals itself. None while joining or once the table is over.
function clockLine(table: HoldemTable): string | null {
	if (table.status !== "playing") return null;
	const start = clockStartOf(table);
	if (handInProgress(table)) {
		const acting = whoActs(table);
		return acting ? gameRoomsCopy.holdem.turnClockLine(acting, start + BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS) : null;
	}
	if (!canDealItself(table)) return gameRoomsCopy.holdem.nextHandWaitingLine;
	return gameRoomsCopy.holdem.nextHandLine(start + BOT_CONSTANTS.HOLDEM_NEXT_HAND_DELAY_MS);
}

// ⚠️ THE NEXT HAND DEALS ITSELF ONLY WHILE TWO PLAYERS ARE AT THE TABLE. A hand dealt
// to seats that all sit out would fold itself round and round with nobody there,
// blinding absent players off and paying out a tournament nobody played. The host's
// Next hand still deals, and the idle sweep closes a table nobody comes back to.
//
// And only while a MEMBER is among them (2026-10 item 250 Phase 5): Dero bots alone at the
// table would deal and play hand after hand for nobody. The bot driver ends a table no
// member is left in; this keeps the deal waiting while the members sit out.
const canDealItself = (table: HoldemTable): boolean => {
	const present = presentPlayers(table);
	return present.length >= BOT_CONSTANTS.HOLDEM_MIN_SEATS && present.some((seat) => !isBotSeatId(seat.userId));
};

// ── buying in, and taking a late seat ─────────────────────────────────
// One button for both (`hjoin`): Buy in while the table is joining, Take a seat once
// it plays and the host has seats open (2026-10 item 244 Phase 4). Both are a member
// asking for a seat, so both pass the host's join gate first, in this one handler.
export async function handleBuyIn(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const userId = interaction.user.id;

	// ① The host's say over who sits down. A member the room already let in (the
	// challenge's pool, an invitee, an accepted request) is in playerIds and passed
	// the band and the host's answer on the way in, so they are not asked twice.
	const verdict = await judgeJoin(room, userId, { alreadyApproved: room.playerIds.includes(userId) });
	if (verdict.kind === "refuse") {
		// A network table's seat needs the network notice first (2026-10 item 244 Phase 5b):
		// the member gets the notice where it was pressed (2026-10 item 257 Phase 5), and presses
		// Buy in again once they accept it.
		if (verdict.reason === "noConsent") {
			await answerInChannel(interaction, "here", consentPrompt({ kind: "again" }));
			return;
		}
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [joinRefusalText(room, verdict.reason)] });
		return;
	}
	if (verdict.kind === "ask") {
		await askHostForSeat(interaction, room);
		return;
	}

	// ② The seat itself.
	const claim = await claimSeat(room, userId, memberDisplayName(interaction));
	if (!claim.ok) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [claim.refusal] });
		return;
	}
	if (claim.late) {
		// A held seat is work done, so it is an answer (owner rule 1, 2026-10 item 263 R3-11):
		// it posts where it was pressed and pings the member it seated.
		await answerInChannel(interaction, "here", { content: hostWords.seats.heldReply(startingStackOf(claim.table)) });
	} else {
		await interaction.deferUpdate();
	}
	await announceSeat(interaction.client, claim.room, claim, userId);
}

const memberDisplayName = (interaction: ButtonInteraction): string =>
	interaction.guild?.members.cache.get(interaction.user.id)?.displayName ?? interaction.user.globalName ?? interaction.user.username;

function joinRefusalText(room: IGameRoom, reason: "kicked" | "outsideBand"): string {
	return reason === "kicked" ? hostWords.kick.refusedRejoin : hostWords.band.refused(gameRoomsCopy.gameLabel(room.game));
}

// The host approves each joiner and this member is not yet in: the request goes on
// the room's waiting list for the host's Requests button, and the board redraws so
// the button's count moves. The filter on kickedIds refuses a member removed in the
// moment between the gate above and this write.
async function askHostForSeat(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	if ((room.pendingJoinIds ?? []).includes(interaction.user.id)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [hostWords.approval.alreadyAsked] });
		return;
	}
	const updated = await gameRoomStore.addPendingJoin(room.guildId, room.roomId, interaction.user.id);
	if (!updated) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [hostWords.kick.refusedRejoin] });
		return;
	}
	// A request filed is work done, so it is an answer (owner rule 1, R3-11).
	await answerInChannel(interaction, "here", { content: hostWords.approval.asked });
	const table = tableOf(updated);
	if (table) await redraw(interaction.client, updated, table);
}

/** A seat that landed, the room it landed in, and whether it waits for the next deal. */
type SeatClaim = { ok: true; room: IGameRoom; table: HoldemTable; late: boolean } | { ok: false; refusal: string };

// One attempt at a seat against one read of the table: landed, refused for good, or
// lost a race to another write (so re-read and go again).
type SeatAttempt = { outcome: "landed"; table: HoldemTable } | { outcome: "refused"; refusal: string } | { outcome: "lost" };

/**
 * Take a seat for `userId`: a buy in while the table is joining, a late seat while it
 * plays with the host's seats open. Shared by the member's own press and the host
 * accepting their request, so an accepted request seats a player exactly the way a
 * press would. Writes nothing to the trail; announceSeat does that.
 */
export async function claimSeat(room: IGameRoom, userId: string, username: string): Promise<SeatClaim> {
	const table = tableOf(room);
	if (!table?.chips || table.status === "finished") return claimSeatOnTable(room, userId, username, null);

	// ⚠️ A CHIP TABLE'S BUY IN LEAVES THE WALLET BEFORE THE SEAT IS CLAIMED (2026-10 item
	// 250 Phase 5), and goes back when the seat never lands. The other order would seat a
	// player whose debit could still fail, holding chips that came from nowhere. A seat
	// the table would refuse anyway (taken, full, closed) is refused before any debit.
	const refusal = seatRefusalFor(room, table, userId, username);
	if (refusal) return { ok: false, refusal };
	const buyIn = startingStackOf(table);
	if (!(await payBuyIn(table, userId))) return { ok: false, refusal: gameRoomsCopy.holdem.notEnoughChips(buyIn) };

	const claim = await claimSeatOnTable(room, userId, username, buyIn);
	if (claim.ok) return claim;
	await refundBuyIn(table, userId, buyIn);
	return { ok: false, refusal: `${claim.refusal} ${gameRoomsCopy.holdem.buyInBack}` };
}

// What the table would answer this seat, on a copy, so a chip table refuses a seat it
// cannot give before any chips move. The same engine calls the claim makes for real.
function seatRefusalFor(room: IGameRoom, table: HoldemTable, userId: string, username: string): string | null {
	const probe = structuredClone(table);
	if (probe.status === "playing") {
		if (!room.seatsOpen) return hostWords.seats.closedRefused;
		const late = requestLateSeat(probe, userId, username);
		return late.ok ? null : LATE_SEAT_REFUSALS[late.reason];
	}
	const joined = joinTable(probe, userId, username);
	return joined.ok ? null : joinRefusalFor(joined);
}

// The claim loop. `paidBuyIn` is what a chip table's player already paid, or null at a
// free table: a re-read that finds the host changed the buy in meanwhile refuses rather
// than seat a player at a stack they did not pay for.
async function claimSeatOnTable(room: IGameRoom, userId: string, username: string, paidBuyIn: number | null): Promise<SeatClaim> {
	let current: IGameRoom = room;
	for (let attempt = 0; attempt < BOT_CONSTANTS.HOLDEM_SEAT_CLAIM_ATTEMPTS; attempt++) {
		const table = tableOf(current);
		if (!table || table.status === "finished") return { ok: false, refusal: gameRoomsCopy.holdem.tournamentOver };
		if (paidBuyIn !== null && startingStackOf(table) !== paidBuyIn) return { ok: false, refusal: gameRoomsCopy.holdem.buyInChanged };

		const late = table.status === "playing";
		const result = late ? await tryLateSeat(current, table, userId, username) : await tryBuyIn(current, table, userId, username);
		if (result.outcome === "landed") return { ok: true, room: current, table: result.table, late };
		if (result.outcome === "refused") return { ok: false, refusal: result.refusal };

		current = (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? current;
	}
	return { ok: false, refusal: gameRoomsCopy.holdem.tableBusy };
}

// ⚠️ COMPARE AND SWAP WITH A RETRY, because buying in is the one hold em write two
// people genuinely race rather than a theoretical one: the table opens with ZERO
// seats and a public room offers Buy in to everybody at once. Both readers saw the
// same seat list, so the plain write this replaces let the second one erase the
// first player's seat AND their thousand chips, after the trail had already
// announced them to the channel. The dropped player then failed the playersOnly
// gate on every later control with "this is not your match", and once the host
// dealt, joinTable refused them for good.
//
// Matching on the seat COUNT the caller read means the loser writes nothing,
// re-reads, and seats themselves on top of the winner's table instead of over it.
// playerIds rides the same write as an $addToSet so a seat and the permission that
// follows it can never disagree. The kickedIds match is the no-rejoin guarantee: a
// member the host removed after this read cannot be written back onto the table.
async function tryBuyIn(room: IGameRoom, table: HoldemTable, userId: string, username: string): Promise<SeatAttempt> {
	const result = joinTable(table, userId, username);
	if (!result.ok) return { outcome: "refused", refusal: joinRefusalFor(result) };
	const written = await gameRoomStore.updateSecretIf(
		room.guildId,
		room.roomId,
		{ "secret.seats": { $size: table.seats.length - 1 }, kickedIds: { $ne: userId }, ...sameBoard(table) },
		table,
		{ $addToSet: { playerIds: userId } }
	);
	return written ? { outcome: "landed", table } : { outcome: "lost" };
}

const JOIN_REFUSALS: Record<Exclude<JoinResult, { ok: true }>["reason"], string> = {
	alreadySeated: gameRoomsCopy.holdem.alreadySeated,
	tableFull: gameRoomsCopy.holdem.tableFull,
	started: gameRoomsCopy.holdem.alreadyStarted,
};

const joinRefusalFor = (result: Exclude<JoinResult, { ok: true }>): string => JOIN_REFUSALS[result.reason];

const LATE_SEAT_REFUSALS: Record<Exclude<LateSeatResult, { ok: true }>["reason"], string> = {
	notPlaying: hostWords.seats.notPlaying,
	alreadySeated: hostWords.seats.alreadyPlayed,
	alreadyWaiting: hostWords.seats.alreadyWaiting,
	tableFull: gameRoomsCopy.holdem.tableFull,
};

// A seat mid tournament: it WAITS in the table's pendingSeats and the next deal seats
// it (holdemTable.seatLatePlayers), so nothing here can put a seat into a hand. The
// write matches the action stamp, which requestLateSeat moves, so a move racing it
// loses instead of writing the waiting list away; seatsOpen, so a Close seats that
// landed since this read refuses; and kickedIds, the no-rejoin guarantee. playerIds is
// NOT added here: the deal that seats the player adds it, so a waiting player cannot
// press a player's control before they have a seat to press it from.
async function tryLateSeat(room: IGameRoom, table: HoldemTable, userId: string, username: string): Promise<SeatAttempt> {
	if (!room.seatsOpen) return { outcome: "refused", refusal: hostWords.seats.closedRefused };
	const readAt = table.lastActionAt;
	const result = requestLateSeat(table, userId, username);
	if (!result.ok) return { outcome: "refused", refusal: LATE_SEAT_REFUSALS[result.reason] };
	const written = await gameRoomStore.updateSecretIf(
		room.guildId,
		room.roomId,
		{ "secret.lastActionAt": readAt, seatsOpen: true, kickedIds: { $ne: userId }, ...sameBoard(table) },
		table
	);
	return written ? { outcome: "landed", table } : { outcome: "lost" };
}

// The trail line and the redraw for a seat that landed: bought in now, or held for
// the next deal.
async function announceSeat(client: Client, room: IGameRoom, claim: Extract<SeatClaim, { ok: true }>, userId: string): Promise<void> {
	await roomTrail.postMove(client, room, {
		actorId: userId,
		kind: "join",
		text: claim.late ? hostWords.seats.heldLine(userId) : seatTakenLine(claim.table, userId),
	});
	await redraw(client, room, claim.table);
}

// A chip table says what the seat cost; a free table keeps the line it always had.
function seatTakenLine(table: HoldemTable, userId: string): string {
	if (table.chips) return gameRoomsCopy.holdem.chipsSeatTaken(userId, startingStackOf(table), table.seats.length);
	return gameRoomsCopy.holdem.seatTaken(userId, table.seats.length);
}

/**
 * Seat a member the host just accepted, the way their own press would have. Answers
 * null once seated (or held for the next deal), or the table's reason they were not,
 * for the host's summary. The accept already put them in playerIds.
 */
export async function seatAcceptedPlayer(client: Client, room: IGameRoom, userId: string, username: string): Promise<string | null> {
	const claim = await claimSeat(room, userId, username);
	if (!claim.ok) return claim.refusal;
	await announceSeat(client, claim.room, claim, userId);
	return null;
}

// ── dealing ───────────────────────────────────────────────────────────
export async function handleDeal(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const table = tableOf(room);
	if (!table) return;

	// ⚠️ REFUSE A DEAL WHILE A HAND IS LIVE, and note the status check below cannot do
	// this job. `dealHand` is not a restart: it reshuffles and zeroes every seat's
	// committed chips while their stacks stay debited, so dealing over a running hand
	// vaporises the pot standing in it. The joining branch sets the status to "playing"
	// one line before the status test, so the test always passes and never saw this.
	if (handInProgress(table)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.holdem.handInProgress] });
		return;
	}

	if (table.status === "joining") {
		if (table.seats.length < BOT_CONSTANTS.HOLDEM_MIN_SEATS) {
			await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.holdem.needMorePlayers] });
			return;
		}
		table.status = "playing";
	}
	if (table.status !== "playing") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.holdem.tournamentOver] });
		return;
	}

	const deal = await claimDeal(room, table, interaction.user.id);
	if (!deal) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.holdem.handInProgress] });
		return;
	}

	await interaction.deferUpdate();
	await announceDeal(interaction.client, room, table, deal, interaction.user.id);
}

/**
 * Deal the first hand of a table a challenge card opened already seated (2026-10 item 263
 * R3-27): RoomProvisioner.seedRoom calls this once the table is on the row, so the room opens
 * on a dealt hand with no Buy in or Start press. The same claim and announcement the host's
 * Start uses, with the host as the actor. Answers whether the deal landed; a table that is not
 * joining any more (somebody's press won) answers false and changes nothing.
 */
export async function dealOpeningHand(client: Client, room: IGameRoom): Promise<boolean> {
	const fresh = await gameRoomStore.findByRoomId(room.guildId, room.roomId).catch(() => null);
	const table = fresh ? tableOf(fresh) : null;
	if (!fresh || !table || table.status !== "joining" || table.seats.length < BOT_CONSTANTS.HOLDEM_MIN_SEATS) return false;
	table.status = "playing";
	const deal = await claimDeal(fresh, table, fresh.hostId);
	if (!deal) return false;
	await announceDeal(client, fresh, table, deal, fresh.hostId);
	return true;
}

/** A deal that won its claim: the table as it stood before, what the deal set off, and the new hand's lines. */
interface ClaimedDeal {
	before: PublicView;
	outcome: ActionOutcome;
	turn: HoldemTurn;
}

// Deal the next hand and claim it. Shared by the host's button and the clock's
// automatic deal, which race each other exactly the way a double click races itself:
// each read the room, so each saw the same hand number and each would otherwise deal.
// Exactly one write can match it, and null means somebody else's write landed.
//
// The action stamp is matched too, because the clock decides against a read taken
// seconds earlier: a leave or an I'm back between hands moves the stamp and not the
// hand number, and a deal from the older read would write that seat straight back.
//
// The deal is also where a late seat becomes a seat (dealHand seats the waiting list
// before anything about the hand exists), so its write carries those players into
// playerIds in the same claim, and the playersOnly gate opens for them exactly when
// they have cards to play. A waiting seat whose player the host removed is dropped
// first, a backstop for a removal that raced this read.
//
// A new hand is a new turn on the board (2026-10 item 263 R3-29): the blinds and deal lines,
// and anything the deal set off, open the new hand's block, stamped into this same write.
async function claimDeal(room: IGameRoom, table: HoldemTable, actorId: string): Promise<ClaimedDeal | null> {
	const expected = { "secret.handNumber": table.handNumber, "secret.lastActionAt": table.lastActionAt, ...sameBoard(table) };
	const blindsBefore = table.bigBlind;
	const before = toPublicView(table);
	const revealBefore = holdemRevealKey(table);
	const dropped = dropRemovedLateSeats(table, room);
	const outcome = dealHand(table, secureRandom);
	const lateSeated = outcome.lateSeated ?? [];
	const dealt = holdemMoveLines(outcome, dealLines(table, blindsBefore, actorId));
	const turn = stampHoldemTurn(table, revealBefore, dealt, true);
	const written =
		lateSeated.length > 0
			? await gameRoomStore.updateSecretIf(room.guildId, room.roomId, expected, table, { $addToSet: { playerIds: { $each: lateSeated } } })
			: await gameRoomStore.updateSecretIf(room.guildId, room.roomId, expected, table);
	if (!written) return null;
	// A late seat the host removed paid its buy in at a chip table; the deal that dropped
	// it is the claim, so it is refunded only once this write landed.
	for (const userId of dropped) await refundBuyIn(table, userId);
	return { before, outcome, turn };
}

// A new hand's opening lines: the blinds going up when they did, then the deal.
function dealLines(table: HoldemTable, blindsBefore: number, actorId: string): RoomMoveInput[] {
	const holdem = gameRoomsCopy.holdem;
	const blindsUp: RoomMoveInput[] = table.bigBlind !== blindsBefore ? [{ actorId, kind: "system", text: holdem.blindsUp(table.smallBlind, table.bigBlind) }] : [];
	return [...blindsUp, { actorId, kind: "system", text: holdem.handDealt(table.handNumber, table.smallBlind, table.bigBlind) }];
}

// Answers the ids it dropped, for the refund once the deal's write lands.
function dropRemovedLateSeats(table: HoldemTable, room: IGameRoom): string[] {
	const removed = new Set(room.kickedIds ?? []);
	if (removed.size === 0 || !table.pendingSeats?.length) return [];
	const dropped = table.pendingSeats.filter((entry) => removed.has(entry.userId)).map((entry) => entry.userId);
	table.pendingSeats = table.pendingSeats.filter((entry) => !removed.has(entry.userId));
	return dropped;
}

// Everything after a deal landed, whoever dealt it: the late seats' join lines, then the same
// settle path an action takes, which settles a hand the deal's sit out folds ended and posts the
// new hand's table with its blinds and deal lines in its block.
async function announceDeal(client: Client, room: IGameRoom, table: HoldemTable, deal: ClaimedDeal, actorId: string): Promise<void> {
	// The late seats first: they sat down before the cards went round. A seat taken is no bet
	// of a street, so it stays a line of its own.
	for (const userId of deal.outcome.lateSeated ?? []) {
		await roomTrail.postMove(client, room, { actorId: userId, kind: "join", text: hostWords.seats.seatedLine(userId, startingStackOf(table)) });
	}
	await settleOutcome(client, room, table, deal.outcome, actorId, { cause: "played", handStartChips: chipsAtHandStart(table.seats) }, deal.turn);
	announceDealer({ client, roomId: room.roomId, before: deal.before, after: toPublicView(table), outcome: deal.outcome });
}

// ── acting ────────────────────────────────────────────────────────────
// The button key to what the player MEANT. Note the three size presets resolve to
// "aggress" rather than to an engine action: how much is resolveRaiseAmount's job,
// and what the engine CALLS it is aggressiveActionFor's, because it depends on the
// street. Naming "raise" here is what broke every post-flop bet.
type HoldemPreset = "fold" | "check" | "call" | "allIn" | "aggress";

const PRESET_ACTIONS: Record<string, HoldemPreset> = {
	fold: "fold",
	check: "check",
	call: "call",
	allin: "allIn",
	min: "aggress",
	half: "aggress",
	pot: "aggress",
};

export async function handleMove(interaction: ButtonInteraction, room: IGameRoom, preset: string): Promise<void> {
	const refusal = await playHoldemMove(interaction.client, room, interaction.user.id, { preset }, () => interaction.deferUpdate());
	if (refusal) await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [refusal] });
}

/** A decision as the board's buttons and the turn modal both name it: a preset key, and for a raise a typed total. */
export interface HoldemMoveRequest {
	preset: string;
	/** A typed raise TOTAL, clamped into the legal band; absent means the preset's own size. */
	amount?: number;
}

/**
 * One member's decision at the table, from a board button or the turn modal: the SAME path, so
 * a move never has two implementations (item 257 Phase 4a). `acknowledge` runs once the move is
 * claimed, where the button's deferUpdate always ran. Answers the refusal worded for the
 * member, or null when the move landed.
 */
export async function playHoldemMove(client: Client, room: IGameRoom, userId: string, request: HoldemMoveRequest, acknowledge: () => Promise<unknown>): Promise<string | null> {
	const table = tableOf(room);
	if (!table || table.status !== "playing") return gameRoomsCopy.holdem.tournamentOver;
	if (whoActs(table) !== userId) return gameRoomsCopy.holdem.notYourTurn;

	const preset = request.preset;
	const choice = PRESET_ACTIONS[preset];
	if (!choice) return gameRoomsCopy.errors.controlRetired;

	// ⚠️ ASK THE ENGINE WHAT THE AGGRESSIVE ACTION IS CALLED. It is "bet" when there
	// is no bet to raise and "raise" when there is, and every street after preflop
	// opens at a current bet of zero, so post-flop the legal label is "bet".
	// Dispatching a hardcoded "raise" made applyAction's `legal.find` miss on the flop,
	// turn and river, so the only aggression that ever worked after preflop was All in,
	// and the refusal came back as the not-your-turn copy to the one player whose turn
	// it actually was.
	const aggressive = choice === "aggress" ? aggressiveActionFor(table, userId) : undefined;
	if (choice === "aggress" && !aggressive) return gameRoomsCopy.holdem.illegalMove;
	const action = aggressive ? aggressive.action : (choice as Exclude<HoldemPreset, "aggress">);
	const amount = aggressive ? raiseTotalFor(table, userId, preset, request.amount) : 0;

	const landed = await applySeatMove(client, room, table, userId, action, amount, acknowledge);
	// Says what actually happened. Answering an illegal action with "it is not your turn"
	// is how the raise bug stayed invisible: the message blamed the player for something
	// that was not true and named nothing that could be searched for.
	if (landed === "illegal") return gameRoomsCopy.holdem.illegalMove;
	if (landed === "busy") return gameRoomsCopy.holdem.tableBusy;
	return null;
}

// A typed raise total wins over the preset's size, clamped into the legal band like a preset is:
// the modal's player named a number, and a number outside the band should play as the nearest
// legal raise rather than be refused for a rule they had no way to read off the field.
function raiseTotalFor(table: HoldemTable, userId: string, preset: string, typed: number | undefined): number {
	const raise = aggressiveActionFor(table, userId);
	if (typed === undefined || !raise) return resolveRaiseAmount(table, userId, preset, currentPot(table));
	return Math.max(raise.min ?? 0, Math.min(raise.max ?? 0, typed));
}

/** How one seat's decision went: it landed, the engine refused it, or another write won. */
type SeatMoveResult = "landed" | "illegal" | "busy";

/**
 * One seat's decision against the table, whoever made it: a member's press, or a Dero
 * bot's turn (playHoldemBotTurn, 2026-10 item 250 Phase 5), so a bot's move is claimed,
 * narrated and settled exactly like a member's. `acknowledge` runs once the move is
 * claimed, where the button's deferUpdate always ran.
 */
async function applySeatMove(
	client: Client,
	room: IGameRoom,
	table: HoldemTable,
	userId: string,
	action: BettingAction,
	amount: number,
	acknowledge: () => Promise<unknown>
): Promise<SeatMoveResult> {
	const readAt = table.lastActionAt;
	const before = toPublicView(table);
	const handStartChips = chipsAtHandStart(table.seats);
	const revealBefore = holdemRevealKey(table);
	const outcome = act(table, userId, action, amount, secureRandom);
	if (!outcome.ok) return "illegal";
	// The move's lines ride its own write, so the street's block can never lose them to a racing move.
	const turn = stampHoldemTurn(table, revealBefore, holdemMoveLines(outcome, narrationLead(outcome, userId)));

	// Claim it BEFORE announcing it. Two clicks arrive as two interactions that both
	// read the same table and both clear the whoActs check, and the turn clock may be
	// mid-forceFold on this very seat. Only one write matches; the loser says nothing
	// rather than posting a trail line for a move that never landed.
	const written = await persistIfUnchanged(room, table, readAt);
	if (!written) return "busy";

	await acknowledge();
	await settleOutcome(client, room, table, outcome, userId, { cause: "played", handStartChips }, turn);
	announceDealer({ client, roomId: room.roomId, before, after: toPublicView(table), outcome });
	return "landed";
}

// ── Dero bot seats (2026-10 item 250 Phase 5) ─────────────────────────
// What:  a Dero bot's turn at a table, and the end of a table no member is left in.
// Who:   botTurns.sweepBotTurns, on its tick; nothing a member presses reaches here.
// How:   the bot waits BOT_CONSTANTS.BOT_TURNS.THINK_MS from when the board showed it the
//        turn (the same clock a member's turn counts from), decides from its own view
//        (holdemBot.botViewOf: its two cards and the public table, never another hand),
//        and moves through applySeatMove like any seat.

const hasLiveMember = (table: HoldemTable): boolean => table.seats.some((seat) => !seat.out && !isBotSeatId(seat.userId));

/** Play the bot on the clock, or end a table only bots are left at. Answers whether anything landed. */
export async function playHoldemBotTurn(client: Client, room: IGameRoom, now: Date = new Date()): Promise<boolean> {
	const table = tableOf(room);
	if (!table || table.status !== "playing") return false;
	if (!hasLiveMember(table)) return (await closeTable(client, room, table, room.hostId, gameRoomsCopy.holdem.botsOnlyEnded)) === "ended";
	if (!handInProgress(table)) return false;

	const actor = whoActs(table);
	if (!actor || !isBotSeatId(actor)) return false;
	if (!isClockExpired(roomDrawingKey(room), clockStartOf(table), BOT_CONSTANTS.BOT_TURNS.THINK_MS, now.getTime())) return false;
	const view = botViewOf(table, actor);
	if (!view) return false;
	const move = decideHoldemMove(view);
	return (await applySeatMove(client, room, table, actor, move.action, move.amount, async () => undefined)) === "landed";
}

// How a tournament that ends on this action ended, for the closed challenge card
// (post-launch plan item 21): what caused the action, and every seat's chips when the
// final hand began, captured by the caller before the engine moved them.
interface HoldemEnding {
	cause: FinishCause;
	handStartChips: ReadonlyMap<string, number>;
}

// Everything that happens after any action, whoever caused it. Shared by the button path, the
// turn clock, a deal, a leave and a removal, so a forced fold reads exactly like a real one.
// The action's lines are already on `turn` (stamped into its own write, stampHoldemTurn), and
// they reach the room and the transcript through the board the redraw posts or edits, once
// (2026-10 item 263 R3-29, risk R6).
async function settleOutcome(
	client: Client,
	room: IGameRoom,
	table: HoldemTable,
	outcome: ActionOutcome,
	actorId: string,
	ending: HoldemEnding,
	turn: HoldemTurn
): Promise<void> {
	if (outcome.handOver) {
		if (outcome.showdown?.length) {
			// The winning hand, counted for the monthly post (2026-10 item 244). Once per
			// showdown, because only the action that won the table's compare and swap gets
			// here. Fire and forget: a count never holds up the table.
			void recordShowdownHand({ guildId: room.guildId, table, shownUserIds: outcome.showdown.map((shown) => shown.userId) });
		}
		for (const award of outcome.awards ?? []) {
			if (award.amount <= 0) continue;
			// Per HAND, so a long tournament pays out along the way rather than only
			// at the end. Deliberately omits `game`, for the same reason battleship's
			// sink bonus does: awardXp increments games.<slug>.played for any call
			// naming a game, and a 30 hand tournament would record 30 plays.
			awardHoldemXp(client, room, {
				userId: award.userId,
				// undefined, NOT the raw snowflake. A seat rebuilt from Mongo after a Railway
				// restart can legitimately miss its username, and awardXp $sets whatever it is
				// given, so a fallback here renders a string of digits on both leaderboards.
				username: table.seats.find((seat) => seat.userId === award.userId)?.username,
				amount: BOT_CONSTANTS.LEVELING.HOLDEM_HAND_WIN_XP,
				source: "game",
			});
		}
	}

	// Drawn before a finish too: the last hand's result lines ride its final table message, and
	// the finished table loses its controls before the result card is the room's last word.
	await redraw(client, room, table, turn);
	if (!outcome.tournamentOver) return;

	await payPlacements(client, room, table);
	const claimed = await roomLifecycle.finish(client, room, { winnerId: table.winnerId, outcome: { bucket: holdemEndingBucket(table, outcome, ending) } });
	// One rating update per finished session, by finishing order: the winner, then the
	// reverse bust order (a seat that left counts as a bust, since leaveTable records
	// it in bustOrder). Only the call that won finish's claim rates, so a racing clock
	// fold cannot rate the session twice. A session under 10 dealt hands is recorded
	// unrated (2026-10 item 244). A player the host removed sits in that bust order
	// too (removal is a leave), and is excluded, so their result never moves a rating;
	// the removal writes kickedIds before it touches the table, so the room a removal
	// itself finishes always carries them.
	if (claimed) void recordMatchRatings(room, placements(table), room.kickedIds ?? [], { rated: isRatedHoldemSession(table.handNumber) });
}

// The bucket for a tournament that ended on `outcome`. The winner's made hand is read
// off the showdown the engine already reported, so nothing is evaluated twice.
function holdemEndingBucket(table: HoldemTable, outcome: ActionOutcome, ending: HoldemEnding): OutcomeBucket {
	const shown = outcome.showdown?.find((entry) => entry.userId === table.winnerId)?.hand;
	const winnerHandCategory = HAND_CATEGORIES.find((category) => category === shown) ?? null;
	return holdemOutcome({
		cause: ending.cause,
		bustedInFinalHand: outcome.busted?.length ?? 0,
		winnerHandCategory,
		winnerShare: shareOf(ending.handStartChips, table.winnerId),
	});
}

// The real prize. Scaled by finishing position so second place is worth
// meaningfully less than first without being worth nothing, which is what keeps a
// short stack playing rather than folding out.
async function payPlacements(client: Client, room: IGameRoom, table: HoldemTable): Promise<void> {
	const order = placements(table);
	for (const [index, userId] of order.entries()) {
		const amount = Math.floor(BOT_CONSTANTS.LEVELING.HOLDEM_PLACEMENT_XP / (index + 1));
		if (amount <= 0) continue;
		awardHoldemXp(client, room, {
			userId,
			// undefined rather than the raw id, same reason as the per-hand payout above.
			username: table.seats.find((seat) => seat.userId === userId)?.username,
			amount,
			source: "game",
			// The ONE call that records the match, so /account shows a hold em played
			// once per tournament rather than once per hand.
			game: "holdem",
			outcome: index === 0 ? "won" : "lost",
		});
	}

	// The session's Dero coins (2026-10 item 257, Phase 3a), beside the one XP call that
	// records the match: the winner wins, every other seat played. Keyed by the room, so
	// the clock fold and a press racing to the same end pay once (risk R3). Every seat is
	// handed over, bots included, so a table with a Dero bot pays the play amount only.
	// Fire and forget: awardForResult logs and never throws.
	void awardForResult({
		guildId: room.guildId,
		game: "holdem",
		resultKey: room.roomId,
		players: order.map((userId, index) => ({ userId, outcome: index === 0 ? "won" : "played" })),
	});
}

// One Hold'em award, paid in the server the player earns it in (networkXp, 2026-10 item
// 244 Phase 5b): the host server for its own players, the server whose tag a satellite
// player wears or the one they clicked from for theirs. A player no satellite seats is
// paid at once, exactly as before network tables, so an ordinary table never waits on a
// lookup; a satellite player's award waits on their tag. Fire and forget either way, like
// every award: awardXp swallows its own failures, and a failed lookup is logged here.
function awardHoldemXp(client: Client, room: IGameRoom, award: Omit<AwardXpInput, "client" | "guildId" | "channelId">): void {
	const local = hostDestinationFor(room, award.userId);
	if (local) {
		void awardXp({ ...award, client, guildId: local.guildId, channelId: local.channelId });
		return;
	}
	void resolveHoldemXpDestination(client, room, award.userId)
		.then((destination) => awardXp({ ...award, client, guildId: destination.guildId, channelId: destination.channelId }))
		.catch((error) => console.warn("[game-rooms] hold em XP destination lookup failed", { roomId: room.roomId, userId: award.userId, error }));
}

// ── leaving and ending ────────────────────────────────────────────────
// Both writes are a compare and swap on the action stamp AND the seat count. The
// stamp catches a racing action or clock fold; the count catches a racing buy in,
// which moves no stamp, so a leave or an end can never erase a seat that landed
// between this handler's read and its write.
function persistLeaveOrEnd(room: IGameRoom, table: HoldemTable, readAt: number, seatsRead: number) {
	return gameRoomStore.updateSecretIf(
		room.guildId,
		room.roomId,
		{ "secret.lastActionAt": readAt, "secret.seats": { $size: seatsRead }, ...sameBoard(table) },
		table
	);
}

/**
 * Why a member cannot leave this table, or null when they can: the same reading on the Leave
 * press, which refuses before its confirm opens, and on the confirm's Submit, which meets a
 * refusal only when the table moved while the confirm stood open (2026-10 item 263 R3-6).
 */
function leaveRefusal(room: IGameRoom, userId: string): string | null {
	const table = tableOf(room);
	if (!table || table.status === "finished") return gameRoomsCopy.holdem.tournamentOver;
	const seat = table.seats.find((candidate) => candidate.userId === userId);
	return !seat || seat.out ? gameRoomsCopy.holdem.notSeated : null;
}

/** Why this table cannot be ended, or null when it can: read on the End press and again on its Submit (R3-6). */
function endRefusal(room: IGameRoom): string | null {
	const table = tableOf(room);
	return !table || table.status === "finished" ? gameRoomsCopy.holdem.tournamentOver : null;
}

/** Leave table's confirm (2026-10 item 257): its Submit, or the fallback reply's button. The press only asks, after leaveRefusal. */
export async function handleLeaveTable(interaction: ConfirmInteraction, room: IGameRoom): Promise<void> {
	const refusal = leaveRefusal(room, interaction.user.id);
	const table = tableOf(room);
	if (refusal || !table) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [refusal ?? gameRoomsCopy.holdem.tournamentOver] });
		return;
	}

	const readAt = table.lastActionAt;
	const seatsRead = table.seats.length;
	const before = toPublicView(table);
	const handStartChips = chipsAtHandStart(table.seats);
	const revealBefore = holdemRevealKey(table);
	const outcome = leaveTable(table, interaction.user.id, secureRandom);
	if (!outcome.ok) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.holdem.notSeated] });
		return;
	}
	// The leave's own line posts below (a leave is no bet of a street); what its fold set off
	// rides the street's block, stamped into the leave's own write.
	const turn = stampHoldemTurn(table, revealBefore, holdemMoveLines(outcome, []));

	const written = await persistLeaveOrEnd(room, table, readAt, seatsRead);
	if (!written) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.holdem.tableBusy] });
		return;
	}

	await acknowledgeConfirm(interaction);
	// A chip table pays the stack the write above zeroed back to the wallet (2026-10 item
	// 250 Phase 5); that write was the claim, so this runs once.
	if (table.chips) await cashOut(table, interaction.user.id, outcome.stackLeft ?? 0);
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "system",
		text: leftTableLine(table, interaction.user.id, outcome.foldedHand ?? false, outcome.stackLeft ?? 0),
	});
	// The same settle path a fold takes, so a leave that ends the hand pays the pot and
	// one that leaves a single seat ends the tournament exactly the way a bust does.
	await settleOutcome(interaction.client, room, table, outcome, interaction.user.id, { cause: "forfeit", handStartChips }, turn);
	if (outcome.foldedHand) {
		announceDealer({ client: interaction.client, roomId: room.roomId, before, after: toPublicView(table), outcome });
	}
}

// A chip table's leave says what went back to the wallet; a free table's keeps its line.
function leftTableLine(table: HoldemTable, userId: string, foldedHand: boolean, stackLeft: number): string {
	if (table.chips) return gameRoomsCopy.holdem.chipsLeftTable(userId, foldedHand, stackLeft);
	return gameRoomsCopy.holdem.leftTable(userId, foldedHand);
}

// ⚠️ NO PLACEMENT XP ON AN ENDED TABLE. payPlacements prizes a tournament that was
// played out to its last bust; an ended table was not, and paying its standings
// would turn "deal one hand, press End" into a prize that skips the game. The hands
// that were played already paid their per hand XP as they settled.
//
// The RATING is different, by owner decision 2026-10-23 (2026-10 item 244): an ended
// table is rated exactly like a finished session, ranked by its standings, and the
// same 10 hand floor that keeps "deal, bust, repeat" unrated keeps "deal one hand,
// press End" unrated too.
// End table's confirm (2026-10 item 257): its Submit, or the fallback reply's button.
export async function handleEndTable(interaction: ConfirmInteraction, room: IGameRoom): Promise<void> {
	const refusal = endRefusal(room);
	const table = tableOf(room);
	if (refusal || !table) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [refusal ?? gameRoomsCopy.holdem.tournamentOver] });
		return;
	}
	const ended = await closeTable(interaction.client, room, table, interaction.user.id, null, () => acknowledgeConfirm(interaction));
	if (ended === "busy") await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.holdem.tableBusy] });
}

/**
 * End the table now on its standings: the host's End table, or Dero closing a table only
 * bots are left at (2026-10 item 250 Phase 5), whose trail line `endedLine` says so
 * instead of naming an actor who ended it. `acknowledge` runs once the end is claimed.
 */
async function closeTable(
	client: Client,
	room: IGameRoom,
	table: HoldemTable,
	actorId: string,
	endedLine: string | null,
	acknowledge: () => Promise<unknown> = async () => undefined
): Promise<"ended" | "busy"> {
	const readAt = table.lastActionAt;
	const seatsRead = table.seats.length;
	const revealBefore = holdemRevealKey(table);
	const order = endTable(table);
	// The ended table is a new message with an empty block: the street it ended keeps its own.
	const turn = stampHoldemTurn(table, revealBefore, { played: [], after: [] }, true);
	const written = await persistLeaveOrEnd(room, table, readAt, seatsRead);
	if (!written) return "busy";

	await acknowledge();
	const standings = order.map((userId) => {
		const seat = table.seats.find((entry) => entry.userId === userId);
		return { userId, stack: seat && !seat.out ? seat.stack : null };
	});
	await roomTrail.postMove(client, room, {
		actorId,
		kind: "system",
		text: endedLine ?? gameRoomsCopy.holdem.tableEnded(actorId, standings, table.handNumber > 0),
	});
	// Redrawn before the finish so the board loses its controls; the result card that
	// finish posts is the room's last word.
	await redraw(client, room, table, turn);
	// Judged on the standings the table stopped at: a dominant chip lead reads decisive.
	const endedBucket = holdemOutcome({ cause: "ended", bustedInFinalHand: 0, winnerHandCategory: null, winnerShare: shareOf(chipsAtHandStart(table.seats), table.winnerId) });
	const claimed = await roomLifecycle.finish(client, room, { winnerId: table.winnerId, outcome: { bucket: endedBucket } });
	// Ranked by the standings endTable answered: chips first, then the reverse bust
	// order. Only the call that won finish's claim records it, and a table ended before
	// its first deal records nothing, because no match was played. Fire and forget.
	if (claimed && table.handNumber > 0) void recordMatchRatings(room, order, room.kickedIds ?? [], { rated: isRatedHoldemSession(table.handNumber) });
	return "ended";
}

// ── coming back ───────────────────────────────────────────────────────
const RETURN_REFUSALS: Record<Exclude<ReturnResult, { ok: true }>["reason"], string> = {
	closed: gameRoomsCopy.holdem.tournamentOver,
	notSeated: gameRoomsCopy.holdem.notSeated,
	notSittingOut: gameRoomsCopy.holdem.notSittingOut,
};

// I'm back, for a seat that sits out after two timeouts in a row. A compare and swap
// on the action stamp, which returnToTable moves, so a racing action or clock fold
// on the old stamp loses instead of writing the seat back to sitting out.
export async function handleImBack(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const table = tableOf(room);
	if (!table || table.status === "finished") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.holdem.tournamentOver] });
		return;
	}

	const readAt = table.lastActionAt;
	const result = returnToTable(table, interaction.user.id);
	if (!result.ok) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [RETURN_REFUSALS[result.reason]] });
		return;
	}

	const written = await persistIfUnchanged(room, table, readAt);
	if (!written) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.holdem.tableBusy] });
		return;
	}

	await interaction.deferUpdate();
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "system",
		text: gameRoomsCopy.holdem.backAtTable(interaction.user.id),
	});
	await redraw(interaction.client, room, table);
}

// ── the host's seat controls (2026-10 item 244 Phase 4) ───────────────
/**
 * Open seats or Close seats, the host's toggle while a tournament runs. `choice` is
 * the value the press SETS ("on" or "off"), so a stale board's button does what its
 * label said. Routed hostOnly with the admin override. Closing stops new late seats
 * only: a seat already held keeps its promise and is dealt in at the next hand.
 */
export async function handleSeatsToggle(interaction: ButtonInteraction, room: IGameRoom, choice: string): Promise<void> {
	if (choice !== "on" && choice !== "off") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	const table = tableOf(room);
	if (!table || table.status !== "playing") {
		const refusal = table?.status === "joining" ? hostWords.seats.notPlaying : gameRoomsCopy.holdem.tournamentOver;
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [refusal] });
		return;
	}
	const open = choice === "on";
	if ((room.seatsOpen ?? false) === open) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [open ? hostWords.seats.alreadyOpen : hostWords.seats.alreadyClosed] });
		return;
	}

	const updated = (await gameRoomStore.update(room.guildId, room.roomId, { seatsOpen: open })) ?? room;
	await interaction.deferUpdate();
	await roomTrail.postMove(interaction.client, updated, {
		actorId: interaction.user.id,
		kind: "system",
		text: open ? hostWords.seats.openedLine(interaction.user.id) : hostWords.seats.closedLine(interaction.user.id),
	});
	await redraw(interaction.client, updated, tableOf(updated) ?? table);
}

/** How taking a removed player off the table went: done, nothing to take, or still held after every retry. */
export type TableRemoval = "removed" | "notAtTable" | "busy";

/**
 * Take a player the host removed off the table: a waiting late seat is dropped, and
 * a seat is given up exactly the way Leave table gives it up (a live hand folded, the
 * seat out in the bust order, its stack gone with it, since chips die with the
 * table). The same settle path a leave takes then pays a hand the fold ended, or ends
 * the tournament when one player is left.
 *
 * `room` must be the row AFTER the removal was written (hostControls writes kickedIds
 * first), so a removal that ends the tournament rates it without the removed player.
 * Retries a lost compare and swap up to GAME_ROOM_KICK_ATTEMPTS times; "busy" means
 * every attempt lost to a move, and the host is told to press again.
 */
export async function removeFromTable(client: Client, room: IGameRoom, userId: string, actorId: string): Promise<TableRemoval> {
	let current = room;
	for (let attempt = 0; attempt < BOT_CONSTANTS.GAME_ROOM_KICK_ATTEMPTS; attempt++) {
		const table = tableOf(current);
		if (!table || table.status === "finished") return "notAtTable";

		const readAt = table.lastActionAt;
		const seatsRead = table.seats.length;
		const before = toPublicView(table);
		const handStartChips = chipsAtHandStart(table.seats);
		const revealBefore = holdemRevealKey(table);
		const withdrewLateSeat = withdrawLateSeat(table, userId);
		const outcome = withdrewLateSeat ? null : leaveTable(table, userId, secureRandom);
		if (outcome && !outcome.ok) return "notAtTable";
		const turn = outcome ? stampHoldemTurn(table, revealBefore, holdemMoveLines(outcome, [])) : NO_NEW_LINES;

		if (await persistLeaveOrEnd(current, table, readAt, seatsRead)) {
			// At a chip table the removed player keeps their chips: a waiting seat's buy in,
			// or the stack the write above took off the table (2026-10 item 250 Phase 5).
			if (!outcome) {
				await refundBuyIn(table, userId);
				await redraw(client, current, table);
				return "removed";
			}
			if (table.chips) await cashOut(table, userId, outcome.stackLeft ?? 0);
			await settleOutcome(client, current, table, outcome, actorId, { cause: "forfeit", handStartChips }, turn);
			if (outcome.foldedHand) announceDealer({ client, roomId: current.roomId, before, after: toPublicView(table), outcome });
			return "removed";
		}
		current = (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? current;
	}
	return "busy";
}

/** Redraw a room's table from its row, for a host control that changed only the room (a request answered). */
export async function redrawTable(client: Client, room: IGameRoom): Promise<void> {
	const table = tableOf(room);
	if (table) await redraw(client, room, table);
}

// ── the private peek ──────────────────────────────────────────────────
export async function handleShowCards(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const table = tableOf(room);
	if (!table) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.holdem.tournamentOver] });
		return;
	}
	// ⚠️ ONLY EVER THE CLICKER'S OWN CARDS. There is no code path here that takes
	// another member's id. A modal only the presser sees (post-launch plan item 16),
	// with the ephemeral embed it used to be as the fallback.
	await showPrivateView(interaction, room.roomId, holeCardsView(table, interaction.user.id), async () => ({
		embeds: [holeCardsEmbed(table, interaction.user.id)],
		...PRIVATE,
	}));
}

// ── the turn clock ────────────────────────────────────────────────────
export interface HoldemClockSummary {
	forced: number;
	dealt: number;
}

/**
 * Force an action for every hold em table whose player has run out of time, and
 * deal the next hand at every table whose last hand has sat on the board for
 * HOLDEM_NEXT_HAND_DELAY_MS. Both clocks count from when the board showed the
 * state (clockStartOf), and both hold while the board draws.
 *
 * ⚠️ NEVER PAUSES FOR A PLAYER. A table that waits for an absent player hands one
 * person the power to stall five, which is the exact failure a turn clock exists to
 * prevent. Only a board that is drawing holds it, for as long as the draw takes.
 */
export async function sweepHoldemClocks(client: Client, now: Date = new Date()): Promise<HoldemClockSummary> {
	// ⚠️ ONE SWEEP AT A TIME. The interval fires every HOLDEM_CLOCK_TICK_MS whether or
	// not the previous tick finished, and a tick that stalls behind a 429 while posting
	// trail lines would otherwise re-enter on the same stale tables and force a second
	// action for a seat it already folded.
	if (sweepInFlight) return { forced: 0, dealt: 0 };
	sweepInFlight = true;

	try {
		return await runHoldemClockSweep(client, now);
	} finally {
		sweepInFlight = false;
	}
}

let sweepInFlight = false;

async function runHoldemClockSweep(client: Client, now: Date): Promise<HoldemClockSummary> {
	const rooms = await gameRoomStore.findPlayingByGame("holdem");
	let forced = 0;
	let dealt = 0;

	for (const room of rooms) {
		try {
			const table = tableOf(room);
			if (!table || table.status !== "playing") continue;
			if (handInProgress(table)) {
				if (await forceFoldIfDue(client, room, table, now)) forced++;
				continue;
			}
			if (await dealNextHandIfDue(client, room, table, now)) dealt++;
		} catch (error) {
			// Per table. This runs on an interval with nobody watching, so a throw
			// would stall every other table's clock too.
			console.error("[game-rooms] hold em clock failed for one table", {
				guildId: room.guildId,
				roomId: room.roomId,
				error,
			});
		}
	}

	return { forced, dealt };
}

// The player on the clock has used their HOLDEM_TURN_TIMEOUT_MS: check for them when
// checking is free, fold otherwise, and sit the seat out on its second timeout in a
// row. Answers whether a forced action landed.
async function forceFoldIfDue(client: Client, room: IGameRoom, table: HoldemTable, now: Date): Promise<boolean> {
	if (!whoActs(table)) return false;
	// Never while the board draws, and every held millisecond is added back (the
	// drawing pause), so a slow render never costs a player their turn.
	if (!isClockExpired(roomDrawingKey(room), clockStartOf(table), BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS, now.getTime())) return false;

	// Captured BEFORE forceFold, which stamps a new one through `act`.
	const readAt = table.lastActionAt;
	const before = toPublicView(table);
	const handStartChips = chipsAtHandStart(table.seats);
	const revealBefore = holdemRevealKey(table);
	const outcome = forceFold(table, secureRandom);
	if (!outcome.ok || !outcome.userId) return false;
	// The clock's line replaces the engine's narration as the move, and a second timeout in a row
	// says the seat now sits out: both are the street's, stamped into the fold's own write.
	const timedOutId = outcome.userId;
	const lead: RoomMoveInput[] = [
		{ actorId: timedOutId, kind: "system", text: gameRoomsCopy.holdem.timedOut(timedOutId, outcome.narration?.includes("checks") ? "checked" : "folded") },
		...(outcome.satOut ? [{ actorId: timedOutId, kind: "system" as const, text: gameRoomsCopy.holdem.satOut(timedOutId) }] : []),
	];
	const turn = stampHoldemTurn(table, revealBefore, holdemMoveLines(outcome, lead));

	// ⚠️ THE PLAYER GETS THE BENEFIT OF THE DOUBT ON A TIE. This loop is
	// sequential and each iteration awaits Discord I/O, so the Nth table is being
	// decided against a snapshot read seconds ago, and a short stack acting at
	// 59.9 seconds races the fold. If their action landed first the write below
	// finds a different lastActionAt and does nothing, so their real move stands
	// instead of being overwritten by a fold they did not make. Without this both
	// wrote, both called settleOutcome, and payPlacements paid the tournament out
	// twice.
	const written = await persistIfUnchanged(room, table, readAt);
	if (!written) return false;

	await settleOutcome(client, room, table, outcome, timedOutId, { cause: "timeout", handStartChips }, turn);
	announceDealer({ client, roomId: room.roomId, before, after: toPublicView(table), outcome });
	return true;
}

// The last hand has sat on the board for HOLDEM_NEXT_HAND_DELAY_MS: deal the next one
// as the host's Next hand button would, which stays as the way to deal sooner. The
// host is the actor on its trail lines, since it is their table. Answers whether a
// deal landed; the host's own press winning the claim first answers false.
async function dealNextHandIfDue(client: Client, room: IGameRoom, table: HoldemTable, now: Date): Promise<boolean> {
	if (!canDealItself(table)) return false;
	if (!isClockExpired(roomDrawingKey(room), clockStartOf(table), BOT_CONSTANTS.HOLDEM_NEXT_HAND_DELAY_MS, now.getTime())) return false;
	const deal = await claimDeal(room, table, room.hostId);
	if (!deal) return false;
	await announceDeal(client, room, table, deal, room.hostId);
	return true;
}

// ── the turn prompt (turnPrompt.ts, 2026-10 item 257 Phase 4a) ────────
// What:  Hold'em's side of the shared turn piece: the seat on the clock, a fingerprint that
//        moves with every action, the player's two cards, the board, the pot and their
//        stack as the modal's text, and their legal moves as a select with a typed raise.
// How:   every move plays through playHoldemMove, the function the board's buttons call, so
//        the compare and swap, the narration and the redraw are the ones a button press gets.
//        A Dero bot on the clock gets no prompt (syncTurnPrompt skips bot seats); its tick
//        plays it through applySeatMove.

const MOVE_FIELD = "move";
const AMOUNT_FIELD = "amount";
// The select value for the aggressive action, which the engine names bet or raise by street.
const RAISE_CHOICE = "raise";

export const holdemTurnAdapter: TurnAdapter = {
	game: "holdem",
	whoseTurn(room) {
		const table = tableOf(room);
		return table && table.status === "playing" && handInProgress(table) ? (whoActs(table) ?? null) : null;
	},
	fingerprintOf(room) {
		const table = tableOf(room);
		return table ? `h${table.handNumber}.${table.lastActionAt}` : null;
	},
	view(room, userId) {
		const table = tableOf(room);
		if (!table || table.status !== "playing" || whoActs(table) !== userId || actionsFor(table, userId).length === 0) return null;
		return holdemTurnView(table, userId, currentPot(table));
	},
	async apply(client, room, userId, answers, acknowledge) {
		const typed = answers[AMOUNT_FIELD];
		const amount = typed ? parseChipAmount(typed) : undefined;
		if (amount === null) return { ok: false, reason: gameRoomsCopy.turnPrompt.invalidAmount };
		const choice = answers[MOVE_FIELD] ?? "";
		// A typed total only means something for a raise; anything else plays as its own preset.
		const request: HoldemMoveRequest = choice === RAISE_CHOICE ? { preset: "min", amount } : { preset: choice };
		const refusal = await playHoldemMove(client, room, userId, request, acknowledge);
		return refusal ? { ok: false, reason: refusal } : { ok: true };
	},
};

/**
 * Hold'em's turn clock (2026-10 item 267): the seat to act, from when the board showed the turn
 * (clockStartOf) plus HOLDEM_TURN_TIMEOUT_MS and every drawing hold, the deadline the board's
 * countdown line and the clock sweep both read. Its end is forceFoldIfDue, the sweep's own.
 */
export const holdemTurnClock: TurnClockGame = {
	kind: "holdem",
	current(room, now) {
		const table = tableOf(room);
		const memberId = holdemTurnAdapter.whoseTurn(room);
		const fingerprint = holdemTurnAdapter.fingerprintOf(room);
		if (!table || !memberId || !fingerprint) return null;
		return { memberId, fingerprint, deadline: pausedDeadline(roomDrawingKey(room), clockStartOf(table), BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS, now) };
	},
	async expire(client, room, now) {
		const table = tableOf(room);
		if (!table || table.status !== "playing" || !handInProgress(table)) return false;
		return forceFoldIfDue(client, room, table, now);
	},
};

export const roomHoldemHandlers = {
	handleBuyIn,
	handleDeal,
	handleMove,
	handleShowCards,
	handleLeaveTable,
	handleEndTable,
	leaveRefusal,
	endRefusal,
	handleImBack,
	handleSeatsToggle,
	sweepHoldemClocks,
	playHoldemBotTurn,
};

// Rendering helpers the provisioner needs to post the first board.
export { tableEmbed, joiningRows, currentPot };
