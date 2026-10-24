import { MessageFlags, TextChannel, type ButtonInteraction, type Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { buildPots, potTotal, type PlayerCommitment } from "@features/games/holdemPots.js";
import {
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
	type LateSeatResult,
	type ReturnResult,
} from "@features/games/holdemTable.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { awardXp, type AwardXpInput } from "@features/leveling/awardXp.js";
import { announceDealer, toPublicView, type PublicView } from "@features/dero-brain/dealerNarration.js";
import { holdemLiveView, renderHoldemLiveCard } from "@features/dero-brain/dealerShowdownRenderer.js";
import { recordMatchRatings } from "@features/ratings/recordMatchRatings.js";
import { recordShowdownHand } from "@features/ratings/gameResultCounts.js";
import { isRatedHoldemSession } from "@features/ratings/ratingEngine.js";
import { secureRandom } from "@utils/secureRng.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isClockExpired, roomDrawingKey, withDrawingPause } from "./drawingPause.js";
import { judgeJoin } from "./joinGate.js";
import { labelEmbedForRoom, relayState } from "./satelliteRooms.js";
import { consentPrompt } from "./networkRules.js";
import { scheduleNetworkBoardRefresh } from "./networkBoard.js";
import { hostDestinationFor, resolveHoldemXpDestination } from "./networkXp.js";
import {
	tableEmbed,
	holeCardsEmbed,
	joiningRows,
	betweenHandsRows,
	bettingRows,
	aggressiveActionFor,
	resolveRaiseAmount,
	tableHostStateOf,
} from "./roomHoldem.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

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
// How:   every path ends by persisting the table and redrawing one board message,
//        with the live table card, behind the drawing pause. The three paths that
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
	return gameRoomStore.updateSecretIf(room.guildId, room.roomId, { "secret.lastActionAt": readAt }, table);
}

// Redraw the one board message behind the drawing pause: the live table card (every
// table, every action) in the table embed's image slot, or the embed alone when the
// card does not draw, while the clock holds. Cosmetic, so a failure is logged and
// swallowed: the row is the truth and the next action catches up.
async function redraw(client: Client, room: IGameRoom, table: HoldemTable): Promise<void> {
	if (!table.boardMessageId || !room.channelId) return;
	const channel = await client.channels.fetch(room.channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return;
	const message = await channel.messages.fetch(table.boardMessageId).catch(() => null);
	if (!message) return;

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
		showStatus: (status) => message.edit({ content: status }),
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
			await message.edit({
				content: null,
				embeds,
				components,
				files,
				// `attachments: []` drops the last action's card, which an edit otherwise keeps.
				attachments: [],
			});
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
	await gameRoomStore.updateSecretIf(room.guildId, room.roomId, { "secret.lastActionAt": table.lastActionAt, "secret.status": "playing" }, table);
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
const canDealItself = (table: HoldemTable): boolean => presentPlayers(table).length >= BOT_CONSTANTS.HOLDEM_MIN_SEATS;

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
		// the member gets the notice, and presses Buy in again once they accept it.
		if (verdict.reason === "noConsent") {
			await interaction.reply(consentPrompt({ kind: "again" }));
			return;
		}
		await interaction.reply({ content: joinRefusalText(room, verdict.reason), ...PRIVATE });
		return;
	}
	if (verdict.kind === "ask") {
		await askHostForSeat(interaction, room);
		return;
	}

	// ② The seat itself.
	const claim = await claimSeat(room, userId, memberDisplayName(interaction));
	if (!claim.ok) {
		await interaction.reply({ content: claim.refusal, ...PRIVATE });
		return;
	}
	if (claim.late) {
		await interaction.reply({ content: hostWords.seats.heldReply(startingStackOf(claim.table)), ...PRIVATE });
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
		await interaction.reply({ content: hostWords.approval.alreadyAsked, ...PRIVATE });
		return;
	}
	const updated = await gameRoomStore.addPendingJoin(room.guildId, room.roomId, interaction.user.id);
	if (!updated) {
		await interaction.reply({ content: hostWords.kick.refusedRejoin, ...PRIVATE });
		return;
	}
	await interaction.reply({ content: hostWords.approval.asked, ...PRIVATE });
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
	let current: IGameRoom = room;
	for (let attempt = 0; attempt < BOT_CONSTANTS.HOLDEM_SEAT_CLAIM_ATTEMPTS; attempt++) {
		const table = tableOf(current);
		if (!table || table.status === "finished") return { ok: false, refusal: gameRoomsCopy.holdem.tournamentOver };

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
	if (!result.ok) {
		const refusal =
			result.reason === "alreadySeated"
				? gameRoomsCopy.holdem.alreadySeated
				: result.reason === "tableFull"
				  ? gameRoomsCopy.holdem.tableFull
				  : gameRoomsCopy.holdem.alreadyStarted;
		return { outcome: "refused", refusal };
	}
	const written = await gameRoomStore.updateSecretIf(
		room.guildId,
		room.roomId,
		{ "secret.seats": { $size: table.seats.length - 1 }, kickedIds: { $ne: userId } },
		table,
		{ $addToSet: { playerIds: userId } }
	);
	return written ? { outcome: "landed", table } : { outcome: "lost" };
}

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
		{ "secret.lastActionAt": readAt, seatsOpen: true, kickedIds: { $ne: userId } },
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
		text: claim.late ? hostWords.seats.heldLine(userId) : gameRoomsCopy.holdem.seatTaken(userId, claim.table.seats.length),
	});
	await redraw(client, room, claim.table);
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
		await interaction.reply({ content: gameRoomsCopy.holdem.handInProgress, ...PRIVATE });
		return;
	}

	if (table.status === "joining") {
		if (table.seats.length < BOT_CONSTANTS.HOLDEM_MIN_SEATS) {
			await interaction.reply({ content: gameRoomsCopy.holdem.needMorePlayers, ...PRIVATE });
			return;
		}
		table.status = "playing";
	}
	if (table.status !== "playing") {
		await interaction.reply({ content: gameRoomsCopy.holdem.tournamentOver, ...PRIVATE });
		return;
	}

	const deal = await claimDeal(room, table);
	if (!deal) {
		await interaction.reply({ content: gameRoomsCopy.holdem.handInProgress, ...PRIVATE });
		return;
	}

	await interaction.deferUpdate();
	await announceDeal(interaction.client, room, table, deal, interaction.user.id);
}

/** A deal that won its claim: the table as it stood before, and what the deal set off. */
interface ClaimedDeal {
	before: PublicView;
	blindsBefore: number;
	outcome: ActionOutcome;
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
async function claimDeal(room: IGameRoom, table: HoldemTable): Promise<ClaimedDeal | null> {
	const expected = { "secret.handNumber": table.handNumber, "secret.lastActionAt": table.lastActionAt };
	const blindsBefore = table.bigBlind;
	const before = toPublicView(table);
	dropRemovedLateSeats(table, room);
	const outcome = dealHand(table, secureRandom);
	const lateSeated = outcome.lateSeated ?? [];
	const written =
		lateSeated.length > 0
			? await gameRoomStore.updateSecretIf(room.guildId, room.roomId, expected, table, { $addToSet: { playerIds: { $each: lateSeated } } })
			: await gameRoomStore.updateSecretIf(room.guildId, room.roomId, expected, table);
	return written ? { before, blindsBefore, outcome } : null;
}

function dropRemovedLateSeats(table: HoldemTable, room: IGameRoom): void {
	const removed = new Set(room.kickedIds ?? []);
	if (removed.size === 0 || !table.pendingSeats?.length) return;
	table.pendingSeats = table.pendingSeats.filter((entry) => !removed.has(entry.userId));
}

// Everything after a deal landed, whoever dealt it: the blinds and deal lines, then
// the same settle path an action takes, which posts any sit out folds the deal set
// off, settles a hand they ended, and redraws the board.
async function announceDeal(client: Client, room: IGameRoom, table: HoldemTable, deal: ClaimedDeal, actorId: string): Promise<void> {
	// The late seats first: they sat down before the cards went round.
	for (const userId of deal.outcome.lateSeated ?? []) {
		await roomTrail.postMove(client, room, { actorId: userId, kind: "join", text: hostWords.seats.seatedLine(userId, startingStackOf(table)) });
	}
	if (table.bigBlind !== deal.blindsBefore) {
		await roomTrail.postMove(client, room, {
			actorId,
			kind: "system",
			text: gameRoomsCopy.holdem.blindsUp(table.smallBlind, table.bigBlind),
		});
	}
	await roomTrail.postMove(client, room, {
		actorId,
		kind: "system",
		text: gameRoomsCopy.holdem.handDealt(table.handNumber, table.smallBlind, table.bigBlind),
	});
	await settleOutcome(client, room, table, deal.outcome, actorId);
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
	const table = tableOf(room);
	if (!table || table.status !== "playing") {
		await interaction.reply({ content: gameRoomsCopy.holdem.tournamentOver, ...PRIVATE });
		return;
	}
	if (whoActs(table) !== interaction.user.id) {
		await interaction.reply({ content: gameRoomsCopy.holdem.notYourTurn, ...PRIVATE });
		return;
	}

	const choice = PRESET_ACTIONS[preset];
	if (!choice) {
		await interaction.reply({ content: gameRoomsCopy.errors.controlRetired, ...PRIVATE });
		return;
	}

	// ⚠️ ASK THE ENGINE WHAT THE AGGRESSIVE ACTION IS CALLED. It is "bet" when there
	// is no bet to raise and "raise" when there is, and every street after preflop
	// opens at a current bet of zero, so post-flop the legal label is "bet".
	// Dispatching a hardcoded "raise" made applyAction's `legal.find` miss on the flop,
	// turn and river, so the only aggression that ever worked after preflop was All in,
	// and the refusal came back as the not-your-turn copy to the one player whose turn
	// it actually was.
	const aggressive = choice === "aggress" ? aggressiveActionFor(table, interaction.user.id) : undefined;
	if (choice === "aggress" && !aggressive) {
		await interaction.reply({ content: gameRoomsCopy.holdem.illegalMove, ...PRIVATE });
		return;
	}
	const action = aggressive ? aggressive.action : (choice as Exclude<HoldemPreset, "aggress">);
	const amount = aggressive ? resolveRaiseAmount(table, interaction.user.id, preset, currentPot(table)) : 0;

	const readAt = table.lastActionAt;
	const before = toPublicView(table);
	const outcome = act(table, interaction.user.id, action, amount, secureRandom);
	if (!outcome.ok) {
		// Says what actually happened. Answering an illegal action with "it is not your
		// turn" is how the raise bug stayed invisible: the message blamed the player for
		// something that was not true and named nothing that could be searched for.
		await interaction.reply({ content: gameRoomsCopy.holdem.illegalMove, ...PRIVATE });
		return;
	}

	// Claim it BEFORE announcing it. Two clicks arrive as two interactions that both
	// read the same table and both clear the whoActs check, and the turn clock may be
	// mid-forceFold on this very seat. Only one write matches; the loser says nothing
	// rather than posting a trail line for a move that never landed.
	const written = await persistIfUnchanged(room, table, readAt);
	if (!written) {
		await interaction.reply({ content: gameRoomsCopy.holdem.tableBusy, ...PRIVATE });
		return;
	}

	await interaction.deferUpdate();
	await settleOutcome(interaction.client, room, table, outcome, interaction.user.id);
	announceDealer({ client: interaction.client, roomId: room.roomId, before, after: toPublicView(table), outcome });
}

// Everything that happens after any action, whoever caused it. Shared by the
// button path and the turn clock so a forced fold reads exactly like a real one.
async function settleOutcome(
	client: Client,
	room: IGameRoom,
	table: HoldemTable,
	outcome: ActionOutcome,
	actorId: string
): Promise<void> {
	if (outcome.narration) {
		await roomTrail.postMove(client, room, { actorId, kind: "guess", text: outcome.narration });
	}
	// Seats the action reached while they sit out, folded by the engine, each in the
	// room's own words rather than the engine's plain "folds".
	for (const userId of outcome.sittingOutFolds ?? []) {
		await roomTrail.postMove(client, room, { actorId: userId, kind: "system", text: gameRoomsCopy.holdem.sittingOutFolded(userId) });
	}

	if (outcome.handOver) {
		// Before the awards, because that is the order it happens at a real table: the
		// uncalled chips come back first, then what is left is won. Posting it as a
		// separate line rather than folding it into the win is the point; a hand history
		// that credits somebody with chips they were never at risk of losing is one
		// players argue about.
		if (outcome.returned) {
			await roomTrail.postMove(client, room, {
				actorId: outcome.returned.userId,
				kind: "system",
				text: gameRoomsCopy.holdem.uncalledReturned(outcome.returned.userId, outcome.returned.amount),
			});
		}

		if (outcome.showdown?.length) {
			for (const shown of outcome.showdown) {
				await roomTrail.postMove(client, room, {
					actorId: shown.userId,
					kind: "system",
					text: gameRoomsCopy.holdem.showdownLine(shown.userId, shown.hand),
				});
			}
			// The winning hand, counted for the monthly post (2026-10 item 244). Once per
			// showdown, because only the action that won the table's compare and swap gets
			// here. Fire and forget: a count never holds up the table.
			void recordShowdownHand({ guildId: room.guildId, table, shownUserIds: outcome.showdown.map((shown) => shown.userId) });
		}
		for (const award of outcome.awards ?? []) {
			if (award.amount <= 0) continue;
			await roomTrail.postMove(client, room, {
				actorId: award.userId,
				kind: "system",
				text: gameRoomsCopy.holdem.handWon(award.userId, award.amount),
			});
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
		for (const bustedId of outcome.busted ?? []) {
			await roomTrail.postMove(client, room, {
				actorId: bustedId,
				kind: "system",
				text: gameRoomsCopy.holdem.busted(bustedId),
			});
		}
	}

	if (outcome.tournamentOver) {
		await payPlacements(client, room, table);
		const claimed = await roomLifecycle.finish(client, room, { winnerId: table.winnerId });
		// One rating update per finished session, by finishing order: the winner, then the
		// reverse bust order (a seat that left counts as a bust, since leaveTable records
		// it in bustOrder). Only the call that won finish's claim rates, so a racing clock
		// fold cannot rate the session twice. A session under 10 dealt hands is recorded
		// unrated (2026-10 item 244). A player the host removed sits in that bust order
		// too (removal is a leave), and is excluded, so their result never moves a rating;
		// the removal writes kickedIds before it touches the table, so the room a removal
		// itself finishes always carries them.
		if (claimed) void recordMatchRatings(room, placements(table), room.kickedIds ?? [], { rated: isRatedHoldemSession(table.handNumber) });
		return;
	}

	await redraw(client, room, table);
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
		{ "secret.lastActionAt": readAt, "secret.seats": { $size: seatsRead } },
		table
	);
}

export async function handleLeaveTable(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const table = tableOf(room);
	if (!table || table.status === "finished") {
		await interaction.reply({ content: gameRoomsCopy.holdem.tournamentOver, ...PRIVATE });
		return;
	}

	const readAt = table.lastActionAt;
	const seatsRead = table.seats.length;
	const before = toPublicView(table);
	const outcome = leaveTable(table, interaction.user.id, secureRandom);
	if (!outcome.ok) {
		await interaction.reply({ content: gameRoomsCopy.holdem.notSeated, ...PRIVATE });
		return;
	}

	const written = await persistLeaveOrEnd(room, table, readAt, seatsRead);
	if (!written) {
		await interaction.reply({ content: gameRoomsCopy.holdem.tableBusy, ...PRIVATE });
		return;
	}

	await interaction.deferUpdate();
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "system",
		text: gameRoomsCopy.holdem.leftTable(interaction.user.id, outcome.foldedHand ?? false),
	});
	// The same settle path a fold takes, so a leave that ends the hand pays the pot and
	// one that leaves a single seat ends the tournament exactly the way a bust does.
	await settleOutcome(interaction.client, room, table, outcome, interaction.user.id);
	if (outcome.foldedHand) {
		announceDealer({ client: interaction.client, roomId: room.roomId, before, after: toPublicView(table), outcome });
	}
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
export async function handleEndTable(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const table = tableOf(room);
	if (!table || table.status === "finished") {
		await interaction.reply({ content: gameRoomsCopy.holdem.tournamentOver, ...PRIVATE });
		return;
	}

	const readAt = table.lastActionAt;
	const seatsRead = table.seats.length;
	const order = endTable(table);
	const written = await persistLeaveOrEnd(room, table, readAt, seatsRead);
	if (!written) {
		await interaction.reply({ content: gameRoomsCopy.holdem.tableBusy, ...PRIVATE });
		return;
	}

	await interaction.deferUpdate();
	const standings = order.map((userId) => {
		const seat = table.seats.find((entry) => entry.userId === userId);
		return { userId, stack: seat && !seat.out ? seat.stack : null };
	});
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "system",
		text: gameRoomsCopy.holdem.tableEnded(interaction.user.id, standings, table.handNumber > 0),
	});
	// Redrawn before the finish so the board loses its controls; the result card that
	// finish posts is the room's last word.
	await redraw(interaction.client, room, table);
	const claimed = await roomLifecycle.finish(interaction.client, room, { winnerId: table.winnerId });
	// Ranked by the standings endTable answered: chips first, then the reverse bust
	// order. Only the press that won finish's claim records it, and a table ended before
	// its first deal records nothing, because no match was played. Fire and forget.
	if (claimed && table.handNumber > 0) void recordMatchRatings(room, order, room.kickedIds ?? [], { rated: isRatedHoldemSession(table.handNumber) });
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
		await interaction.reply({ content: gameRoomsCopy.holdem.tournamentOver, ...PRIVATE });
		return;
	}

	const readAt = table.lastActionAt;
	const result = returnToTable(table, interaction.user.id);
	if (!result.ok) {
		await interaction.reply({ content: RETURN_REFUSALS[result.reason], ...PRIVATE });
		return;
	}

	const written = await persistIfUnchanged(room, table, readAt);
	if (!written) {
		await interaction.reply({ content: gameRoomsCopy.holdem.tableBusy, ...PRIVATE });
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
		await interaction.reply({ content: gameRoomsCopy.errors.controlRetired, ...PRIVATE });
		return;
	}
	const table = tableOf(room);
	if (!table || table.status !== "playing") {
		const refusal = table?.status === "joining" ? hostWords.seats.notPlaying : gameRoomsCopy.holdem.tournamentOver;
		await interaction.reply({ content: refusal, ...PRIVATE });
		return;
	}
	const open = choice === "on";
	if ((room.seatsOpen ?? false) === open) {
		await interaction.reply({ content: open ? hostWords.seats.alreadyOpen : hostWords.seats.alreadyClosed, ...PRIVATE });
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
		const withdrewLateSeat = withdrawLateSeat(table, userId);
		const outcome = withdrewLateSeat ? null : leaveTable(table, userId, secureRandom);
		if (outcome && !outcome.ok) return "notAtTable";

		if (await persistLeaveOrEnd(current, table, readAt, seatsRead)) {
			if (!outcome) {
				await redraw(client, current, table);
				return "removed";
			}
			await settleOutcome(client, current, table, outcome, actorId);
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
		await interaction.reply({ content: gameRoomsCopy.holdem.tournamentOver, ...PRIVATE });
		return;
	}
	// ⚠️ EPHEMERAL AND ONLY EVER THE CLICKER'S OWN CARDS. There is no code path
	// here that takes another member's id.
	await interaction.reply({ embeds: [holeCardsEmbed(table, interaction.user.id)], ...PRIVATE });
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
	const outcome = forceFold(table, secureRandom);
	if (!outcome.ok || !outcome.userId) return false;

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

	await roomTrail.postMove(client, room, {
		actorId: outcome.userId,
		kind: "system",
		text: gameRoomsCopy.holdem.timedOut(outcome.userId, outcome.narration?.includes("checks") ? "checked" : "folded"),
	});
	if (outcome.satOut) {
		await roomTrail.postMove(client, room, { actorId: outcome.userId, kind: "system", text: gameRoomsCopy.holdem.satOut(outcome.userId) });
	}
	await settleOutcome(client, room, table, outcome, outcome.userId);
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
	const deal = await claimDeal(room, table);
	if (!deal) return false;
	await announceDeal(client, room, table, deal, room.hostId);
	return true;
}

export const roomHoldemHandlers = {
	handleBuyIn,
	handleDeal,
	handleMove,
	handleShowCards,
	handleLeaveTable,
	handleEndTable,
	handleImBack,
	handleSeatsToggle,
	sweepHoldemClocks,
};

// Rendering helpers the provisioner needs to post the first board.
export { tableEmbed, joiningRows, currentPot };
