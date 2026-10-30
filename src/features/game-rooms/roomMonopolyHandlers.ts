import {
	type ButtonInteraction,
	type Client,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { secureRandom } from "@utils/secureRng.js";
import { BOARD, JAIL_BAIL, describeTile, isOwnableTile, ownableTileName } from "@features/games/monopolyBoard.js";
import {
	applyBuy,
	applyDebtDefault,
	applyEndTurn,
	closeAuction,
	applyForfeit,
	applyJailChoice,
	applyPayDebt,
	applyRoll,
	applySkip,
	waitingDebt,
	type JailChoice,
	type MonopolyResult,
	type MonopolyState,
} from "@features/games/monopolyState.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { awardMultiPlayerResult } from "@features/games/gameXp.js";
import { monopolyWinnerView, renderWinnerCard } from "@features/games/monopolyRenderer.js";
import { withRenderFallback } from "@features/renderer/index.js";
import { monopolyFinishingOrder, recordMatchRatings } from "@features/ratings/recordMatchRatings.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { monopolyOutcome, type FinishCause, type OutcomeBucket } from "./matchOutcome.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { auctionClosesAt, monopolyInventoryReply, monopolyPromptButtons } from "./roomMonopoly.js";
import { syncTurnPrompt, type TurnAdapter, type TurnView } from "./turnPrompt.js";
import { syncTurnClocks, type TurnClockGame } from "./turnClock.js";
import { isClockExpired, pausedDeadline, roomDrawingKey } from "./drawingPause.js";
import { lastActivityAt } from "./roomActivity.js";
import { monopolyStateOf, placeMonopolyBoard, splitTurnLines, withTurnLog } from "./roomMonopolyBoard.js";
import { postRefereeNotice } from "./roomMonopolyRefereeNotice.js";
import { announceReferee } from "./roomMonopolyReferee.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { RoomMoveKind } from "./roomTypes.js";
import { botSeatName, isBotSeatId, memberIdsOnly } from "./botSeat.js";
import { showNotice } from "@utils/textModal.js";

// ── roomMonopolyHandlers ─────────────────────────────────────────────
// What:  every Monopoly button: roll, buy, skip, end turn, the three ways out of
//        jail, and the private Inventory peek. Plus the shared tail (persist,
//        place the board with the trail, finish) the idle sweep in roomTurnSweep
//        reuses; where the board goes is roomMonopolyBoard's.
// Who:   routed from gameRoomHandlers after its playersOnly gate; the idle sweep
//        calls applyMonopolyOutcome directly, and the trade, auction and build
//        modules (roomMonopolyTrade, roomMonopolyAuction, roomMonopolyBuild) commit
//        their moves through commitMonopolyMove.
// When:  once per press, for a match that can run for days.
// Where: the match lives on the room row's `secret`, so a deploy between two
//        presses costs nothing. The engine (features/games/monopolyState) decides
//        every rule; this file only loads, persists and announces.
// How:   ① acknowledge, ② re-read the row, ③ refuse a seat that is not on the
//        clock, ④ apply the pure action, ⑤ persist only if nobody moved first,
//        ⑥ ⑦ place the board, which carries the trail, ⑧ finish and pay if it ended.


const JAIL_CHOICES: readonly JailChoice[] = ["bail", "card", "roll"];

// Re-exported so every caller keeps one import for the Monopoly room layer.
export { monopolyStateOf };

// ── persistence ───────────────────────────────────────────────────────
// What the persist below compares against: the turn as the caller READ it.
//
// ⚠️ A COMPARE AND SWAP, NOT A PLAIN WRITE, for the reason the hold em table
// learned: `secret` is one Mixed field, so an unconditional write lets a double
// click (or the idle sweep racing a press) land twice, the second replacing the
// first wholesale after both had posted their trail lines. Here that is two rolls
// in one turn.
//
// `revision` is the stamp that matters: the engine bumps it on every action that
// lands. The turn fields alone were enough while only the seat on the clock could
// move, but a trade, a bid or an accept comes from ANY seat and leaves them all as
// they were, so without the revision a roll computed from a read taken before an
// accepted trade would write the pre-trade lots and chips back over it. The turn
// fields stay as a second check that costs nothing.
//
// The board's message id is in it too (2026-10 item 254, Arcade 8). Moving the board
// writes only that one field and leaves the revision alone, so without it a move read
// before the board moved would write the old id back with the rest of the blob, and the
// match would point at the board that was just deleted.
export function turnFingerprint(state: MonopolyState): Record<string, unknown> {
	const index = state.activeSeatIndex;
	const seat = state.seats[index];
	return {
		"secret.revision": state.revision,
		"secret.boardMessageId": state.boardMessageId,
		"secret.phase": state.phase,
		"secret.activeSeatIndex": index,
		"secret.doublesStreak": state.doublesStreak,
		"secret.rolledThisTurn": state.rolledThisTurn,
		"secret.turnStartedAt": state.turnStartedAt,
		[`secret.seats.${index}.position`]: seat.position,
		[`secret.seats.${index}.chips`]: seat.chips,
		[`secret.seats.${index}.inJail`]: seat.inJail,
		[`secret.seats.${index}.jailTurnsRemaining`]: seat.jailTurnsRemaining,
	};
}

/**
 * Persist `next` only if the row still holds the turn `read` describes, stamped with the
 * turn log the board will carry (`lines` are the move's trail lines, as they will post).
 * Answers the state as written, which is what applyMonopolyOutcome takes, or null when
 * somebody else moved first.
 */
export async function persistIfUnchanged(room: IGameRoom, read: MonopolyState, next: MonopolyState, lines: readonly string[]): Promise<MonopolyState | null> {
	const stamped = withTurnLog(read, next, lines);
	const written = await gameRoomStore.updateSecretIf(room.guildId, room.roomId, turnFingerprint(read), stamped);
	return written ? stamped : null;
}

// ── the shared tail ───────────────────────────────────────────────────
/**
 * Everything after a move has been PERSISTED, whoever caused it: place the board (which
 * carries the turn's lines, or posts the finished turn's log above a new board), hand
 * the lines to the voice referee, then finish and pay if the match just ended. The
 * button path and the idle sweep both end here so a forfeit for inactivity reads like
 * any other move; the sweep puts its own "out for inactivity" line ahead of the
 * engine's in `lines`. `read` is the match the move was computed from and `state` what
 * persistIfUnchanged wrote.
 */
export async function applyMonopolyOutcome(
	client: Client,
	room: IGameRoom,
	read: MonopolyState,
	state: MonopolyState,
	trail: { actorId: string; kind: RoomMoveKind; lines: string[] },
	// "timeout" when the idle sweep's forfeit is what ended it (post-launch plan item 21).
	cause: FinishCause = "played"
): Promise<void> {
	const split = splitTurnLines(read, state, trail.lines);
	// The prompt line for whoever the turn passed to posts inside the placement, between the
	// finished turn's kept board and the new turn's board (item 257 Phase 4a, item 263).
	await placeMonopolyBoard(client, room, state, { split, actorId: trail.actorId, kind: trail.kind, promptSync: () => syncTurnPrompt(client, room, monopolyTurnAdapter) });
	// The seat's idle clock and an auction's round clock (2026-10 item 267), after every placed
	// move rather than inside the prompt sync: an auction opens and a seat acts inside one turn,
	// which posts no new prompt line but moves what the clocks count from.
	await syncTurnClocks(client, room, MONOPOLY_TURN_CLOCKS);
	// Voice only, for a room whose host turned the referee on. Fire and forget, so a
	// slow render never holds up the finish below or the next press. A move it cannot
	// speak posts the match's one notice saying why (2026-10 item 254, Arcade 7).
	announceReferee({ client, room, state, lines: trail.lines, onSilent: (reason) => void postRefereeNotice(client, room, reason) });
	if (state.phase === "finished") await finishMonopolyMatch(client, room, state, cause);
}

// How the match was won, for the closed challenge card (post-launch plan item 21), from
// the facts the engine kept. A match stored before the facts existed reads as no
// auctions, no forfeits and a winner never short of cash.
function monopolyEndingBucket(state: MonopolyState, cause: FinishCause): OutcomeBucket {
	const stats = state.stats;
	const winnerLowestShare = state.winnerId ? stats?.lowestCashShare[state.winnerId] : undefined;
	return monopolyOutcome({
		cause,
		turnsTaken: stats?.turnsTaken ?? 0,
		seatCount: state.seats.length,
		auctionsOpened: stats?.auctionsOpened ?? 0,
		forfeits: stats?.forfeits ?? 0,
		winnerLowestShare: winnerLowestShare ?? 1,
	});
}

// The match is over: close the room, then record one result per seat.
//
// ⚠️ PAID ONLY WHEN THIS CALL WON finish's CLAIM. finish returns false when the
// room was already finished, and the award below sits outside that claim, so
// paying regardless would pay the table twice if the sweep and a press both
// reached the end. One award per match, at its end, per the plan: the last seat
// standing wins and every other seat (bankrupt or forfeited) records a loss.
//
// The names are resolved BEFORE the claim, because the winner card on the result
// (2026-10 item 243 Phase 3) needs them and finish posts the result. A press that
// loses the claim spends one member fetch for nothing, which is cheaper than a
// second result card. No card means the result posts without art, as it did.
async function finishMonopolyMatch(client: Client, room: IGameRoom, state: MonopolyState, cause: FinishCause): Promise<boolean> {
	const participants = await resolveParticipants(client, room.guildId, state.seats.map((seat) => seat.userId));
	const names = new Map(participants.flatMap(({ userId, username }) => (username ? [[userId, username] as const] : [])));
	const winnerCard = await withRenderFallback(
		() => renderWinnerCard(monopolyWinnerView(state, names)),
		() => null
	);
	const claimed = await roomLifecycle.finish(client, room, {
		winnerId: state.winnerId,
		...(winnerCard ? { art: winnerCard } : {}),
		outcome: { bucket: monopolyEndingBucket(state, cause) },
	});
	if (!claimed) return false;

	// The winner first, then the seats in reverse elimination order; a seat forfeited
	// for a day's inactivity counts as a bankruptcy (2026-10 item 244). A seat the host
	// removed went out through the same forfeit, and is excluded so their result never
	// moves a rating (Phase 4). Fire and forget.
	void recordMatchRatings(room, monopolyFinishingOrder(state), room.kickedIds ?? []);

	awardMultiPlayerResult({
		client,
		guildId: room.guildId,
		channelId: room.channelId,
		game: "monopoly",
		participants,
		winnerId: state.winnerId,
		nonWinnerOutcome: "lost",
		resultKey: room.roomId,
	});
	return true;
}

/** True when the engine says the match is over while the room still says it is playing. */
export function isSettledMonopolyMatch(room: IGameRoom): boolean {
	return room.game === "monopoly" && room.status === "playing" && monopolyStateOf(room)?.phase === "finished";
}

/**
 * Finish a match the engine already ended but the room never did (2026-10 item 280): the move
 * that ended it was saved, then the process stopped before that move's finish ran, which left
 * the pot unpaid, nobody rated and the host's slot held, since every other path reads the
 * finished phase as nothing to do. The sweep and boot recovery call this; it is the live move's
 * own finish, and finish's claim means a live move still finishing pays nothing twice.
 * Answers whether this call finished it.
 */
export async function finishSettledMonopolyMatch(client: Client, room: IGameRoom): Promise<boolean> {
	const state = monopolyStateOf(room);
	if (!isSettledMonopolyMatch(room) || !state) return false;
	return finishMonopolyMatch(client, room, state, "played");
}

/**
 * Display names for seats, through one bulk fetch into the cache: the XP award
 * and the trade partner picker both read them. A member who left the server gets
 * no name (undefined, never the snowflake) for the reason gameXp's participants
 * type explains, and the caller supplies its own fallback.
 */
export async function resolveParticipants(client: Client, guildId: string, userIds: string[]) {
	const guild = await client.guilds.fetch(guildId).catch(() => null);
	// A Dero bot seat (2026-10 item 250 Phase 5) is named, never fetched: one id that is not
	// a member's would fail the fetch for every member in the list.
	const members = memberIdsOnly(userIds);
	if (members.length > 0) await guild?.members.fetch({ user: members }).catch(() => null);
	return userIds.map((userId) => ({ userId, username: isBotSeatId(userId) ? botSeatName(userId) : guild?.members.cache.get(userId)?.displayName }));
}

// ── committing a move ─────────────────────────────────────────────────
/** One player's move against the stored match: the engine action, already bound to its arguments. */
export type MonopolyMove = (state: MonopolyState, actorId: string) => MonopolyResult;

export type CommitOutcome = { ok: true; state: MonopolyState } | { ok: false; reason: string };

/**
 * Steps ② to ⑧ for any interaction that has ALREADY been acknowledged: re-read,
 * guard, apply, persist by compare and swap, then redraw, trail and finish. The
 * caller acknowledged in whatever way its interaction needs (a button defers an
 * update, a modal defers an ephemeral reply) and reports a refusal the same way.
 * `onTurnOnly` is for the actions that belong to the seat on the clock; a trade,
 * a bid or an answer to a trade comes from any seat still in the match.
 */
export async function commitMonopolyMove(
	client: Client,
	room: IGameRoom,
	actorId: string,
	move: MonopolyMove,
	// `kind` is the transcript kind of the move's lines: "guess" unless the caller says
	// otherwise, such as a removal's "system" or a surrender's "forfeit".
	options: { onTurnOnly: boolean; kind?: RoomMoveKind }
): Promise<CommitOutcome> {
	// ② Re-read rather than trust the row the router loaded: it is a few hundred
	// milliseconds older, and a stale read only loses the compare and swap below.
	const fresh = (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? room;
	// A room finished from outside the match (the leave watcher, a removal that ended it) leaves
	// the engine's phase as it was, so the room's own status is read too (2026-10 item 276, audit
	// P3). The compare and swap below refuses it as well, for a finish that lands after this read.
	if (fresh.status !== "playing") return { ok: false, reason: gameRoomsCopy.monopoly.matchOver };
	const state = monopolyStateOf(fresh);
	if (!state) return { ok: false, reason: gameRoomsCopy.monopoly.noBoard };
	if (state.phase === "finished") return { ok: false, reason: gameRoomsCopy.monopoly.matchOver };

	// ③ The engine's roll, end turn and jail actions take no actor (they act for
	// whoever is on the clock), so the clicker is checked here. playersOnly upstream
	// only proved they are at the table, not that it is their turn.
	if (options.onTurnOnly && state.seats[state.activeSeatIndex].userId !== actorId) {
		return { ok: false, reason: gameRoomsCopy.monopoly.notYourTurn };
	}

	// ④ The engine's own refusal text is already written for the player.
	const result = move(state, actorId);
	if (!result.ok) return { ok: false, reason: result.reason };

	// ⑤ Claim it BEFORE announcing it. The loser of a double click says nothing to
	// the channel, rather than posting a trail line for a move that never landed.
	const written = await persistIfUnchanged(fresh, state, result.state, result.trailLines);
	if (!written) return { ok: false, reason: gameRoomsCopy.monopoly.boardBusy };

	// ⑥ ⑦ ⑧ The board with the trail, then the ending. "guess" is the trail kind every
	// player made move uses (hold em's narration too); "system" is for lines no
	// player pressed for.
	await applyMonopolyOutcome(client, fresh, state, written, { actorId, kind: options.kind ?? "guess", lines: result.trailLines });
	return { ok: true, state: written };
}

/**
 * A move's result with `lines` posted ahead of the engine's own, for the room layer's
 * reason a move happened (the host removed a seat, a seat surrendered), so the reason
 * rides the board with the move instead of posting as a message of its own below it.
 */
export function withLeadLines(result: MonopolyResult, lines: readonly string[]): MonopolyResult {
	return result.ok ? { ...result, trailLines: [...lines, ...result.trailLines] } : result;
}

// ── the host removing a seat (2026-10 item 244 Phase 4) ───────────────
/** How taking a removed player out of the match went: done, nothing to take, or still seated after every retry. */
export type MatchRemoval = "removed" | "notInMatch" | "busy";

/**
 * Take a seat the host removed out of the match through the forfeit path, the same one
 * the idle sweep uses: its holdings go back to the bank, a deal it was part of is called
 * off, and the last seat standing wins. The finish that may follow excludes the seat
 * from the ratings, because the removal wrote kickedIds onto the row before this runs
 * and commitMonopolyMove re-reads that row.
 *
 * A lost compare and swap (a move landed first) is retried up to GAME_ROOM_KICK_ATTEMPTS
 * times; any other refusal means the seat is already out or was never seated. The
 * host's "removed" line leads the engine's lines on the board (`leadLine`), so it lands once,
 * in the turn's This turn block; on any refusal it is the caller's to post.
 */
export async function removeFromMonopolyMatch(client: Client, room: IGameRoom, userId: string, actorId: string, leadLine?: string): Promise<MatchRemoval> {
	const lead = leadLine ? [leadLine] : [];
	for (let attempt = 0; attempt < BOT_CONSTANTS.GAME_ROOM_KICK_ATTEMPTS; attempt++) {
		const outcome = await commitMonopolyMove(client, room, actorId, (state) => withLeadLines(applyForfeit(state, userId), lead), { onTurnOnly: false, kind: "system" });
		if (outcome.ok) return "removed";
		if (outcome.reason !== gameRoomsCopy.monopoly.boardBusy) return "notInMatch";
	}
	return "busy";
}

/**
 * Take out every seat the host removed that a busy board still holds (2026-10 item 276, audit P3):
 * removeFromMonopolyMatch gives up after its retries, but the removal already took the member out
 * of the room, so nobody can play that seat and it would hold the match up for its whole idle
 * budget. The Monopoly idle sweep calls this every tick, so the removal lands on a later look.
 * The removal's own line already posted, so the forfeit carries the engine's lines alone.
 * Answers how many seats it took out.
 */
export async function forfeitRemovedMonopolySeats(client: Client, room: IGameRoom): Promise<number> {
	const state = monopolyStateOf(room);
	const removed = new Set(room.kickedIds ?? []);
	if (room.status !== "playing" || !state || state.phase === "finished" || removed.size === 0) return 0;
	let takenOut = 0;
	for (const seat of state.seats.filter((candidate) => !candidate.bankrupt && removed.has(candidate.userId))) {
		if ((await removeFromMonopolyMatch(client, room, seat.userId, room.hostId)) === "removed") takenOut++;
	}
	return takenOut;
}

// ── the button path ───────────────────────────────────────────────────
async function refuse(interaction: ButtonInteraction, reason: string): Promise<void> {
	// Every refusal below comes after the deferUpdate, which has spent the modal, and each is a
	// state (not your turn, cannot afford, the board busy), so it is a private notice, never a
	// ping in 💬dero-commands (owner rule 1 of the Round 3 list, 2026-10 item 263).
	await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [reason] });
}

async function runMonopolyAction(
	interaction: ButtonInteraction,
	room: IGameRoom,
	move: MonopolyMove,
	options: { onTurnOnly: boolean } = { onTurnOnly: true }
): Promise<void> {
	// ① Acknowledge FIRST (risk M1). The read and the compare and swap are two Mongo
	// round trips, and Discord voids an interaction not acknowledged within three
	// seconds, which on a slow Atlas moment would fail a move that landed.
	await interaction.deferUpdate();
	const outcome = await commitMonopolyMove(interaction.client, room, interaction.user.id, move, options);
	if (!outcome.ok) await refuse(interaction, outcome.reason);
}

// ── the moves ─────────────────────────────────────────────────────────
// Each turn move bound to its engine action, ONCE: the board's buttons and the turn modal
// (monopolyTurnAdapter) both play these, so a move has exactly one path (item 257 Phase 4a).

/** Roll the dice. secureRandom, because the dice decide who pays whom. */
const rollMove: MonopolyMove = (state) => applyRoll(state, secureRandom);

/** Buy the lot on the button. The engine refuses a lot the seat is no longer standing on. */
const buyMove = (tileId: string): MonopolyMove => (state, actorId) => applyBuy(state, actorId, tileId);

/**
 * Pass on the lot. In a match with auctions on, the engine opens the auction
 * itself, and the trail gets one more line saying the clock is running, since the
 * engine keeps no timer and so says nothing about one.
 */
const skipMove: MonopolyMove = (state, actorId) => withAuctionNotice(applySkip(state, actorId));

const endTurnMove: MonopolyMove = (state) => applyEndTurn(state);

const payDebtMove: MonopolyMove = (state, actorId) => applyPayDebt(state, actorId);

const jailMove = (choice: JailChoice): MonopolyMove => (state) => applyJailChoice(state, choice, secureRandom);

export const handleMroll = (interaction: ButtonInteraction, room: IGameRoom): Promise<void> => runMonopolyAction(interaction, room, rollMove);

export const handleMbuy = (interaction: ButtonInteraction, room: IGameRoom, tileId: string): Promise<void> => runMonopolyAction(interaction, room, buyMove(tileId));

export const handleMskip = (interaction: ButtonInteraction, room: IGameRoom): Promise<void> => runMonopolyAction(interaction, room, skipMove);

/** A skip's result with the auction notice added when the skip opened an auction. Shared with a Dero bot's skip (botTurns). */
export function withAuctionNotice(result: MonopolyResult): MonopolyResult {
	const auction = result.ok ? result.state.pendingAuction : null;
	if (!result.ok || !auction) return result;
	const notice = gameRoomsCopy.monopoly.auctionOpened(ownableTileName(auction.tileId), auctionClosesAt(auction));
	return { ...result, trailLines: [...result.trailLines, notice] };
}

// ── shared by the select and modal paths ──────────────────────────────
/**
 * The room a Monopoly select or modal submit belongs to, loaded inside the
 * clicker's guild and gated to its players, or null once the refusal has been
 * replied. Re-gated here because a select's customId and a modal submit are both
 * reachable without the button that led to them.
 */
export async function loadSeatedRoom(
	interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
	roomId: string | undefined
): Promise<IGameRoom | null> {
	const guildId = interaction.guildId;
	const room = guildId && roomId ? await gameRoomStore.findByRoomId(guildId, roomId) : null;
	if (!room || room.status !== "playing") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.monopoly.matchOver] });
		return null;
	}
	if (!room.playerIds.includes(interaction.user.id)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.errors.notYours] });
		return null;
	}
	return room;
}

// Digits only, at most nine of them: a chip count, a bid or a jail card count. A
// cap rather than a parse of anything Number accepts, because "1e3", "0x10" and
// " 12.0" are all numbers to JavaScript and none is what a player typed a count as.
const WHOLE_COUNT = /^\d{1,9}$/;

/** A typed count of chips or cards: blank reads as 0, anything but plain digits as null. */
export function parseWholeCount(text: string): number | null {
	const trimmed = text.trim();
	if (trimmed === "") return 0;
	return WHOLE_COUNT.test(trimmed) ? Number(trimmed) : null;
}

export const handleMend = (interaction: ButtonInteraction, room: IGameRoom): Promise<void> => runMonopolyAction(interaction, room, endTurnMove);

/**
 * Pay the debt the match is waiting on. Not turn bound: the debtor may be a rival
 * a card charged. The engine refuses anyone but the debtor, and refuses the debtor
 * while mortgaging or selling could still raise the rest.
 */
export const handleMpaydebt = (interaction: ButtonInteraction, room: IGameRoom): Promise<void> => runMonopolyAction(interaction, room, payDebtMove, { onTurnOnly: false });

/** The three jail buttons share this handler; the choice rides the customId's arg. */
export async function handleMjail(interaction: ButtonInteraction, room: IGameRoom, choice: string): Promise<void> {
	// The arg is user controlled (a customId anyone can replay), so it is matched
	// against the closed list before it reaches the engine. Refused BEFORE the defer
	// because nothing has been spent yet, so a plain reply still works.
	const jailChoice = JAIL_CHOICES.find((candidate) => candidate === choice);
	if (!jailChoice) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	await runMonopolyAction(interaction, room, jailMove(jailChoice));
}

// ── the peek ──────────────────────────────────────────────────────────
// No defer and no write: it reads the row the router loaded and answers at once. A
// Monopoly seat's holdings are on the board for every player already, and the peek
// carries selects, so it posts where it was pressed (2026-10 item 257 Phase 5). Its
// mortgage selects are answered in roomMonopolyMortgage, each for its presser's own seat.
export async function handleMinventory(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const state = monopolyStateOf(room);
	if (!state) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.monopoly.noBoard] });
		return;
	}
	await answerInChannel(interaction, "here", monopolyInventoryReply(state, interaction.user.id, room.roomId));
}

// ── the clocks' ends (the sweeps' and the turn clock's) ───────────────
// The later of the turn's start and the last trail line. The turn start alone
// would forfeit a seat that has been ACTING all along inside one long turn (a roll
// near the budget's end and a buy just after it still leave turnStartedAt that old),
// and the trail alone would misread a match whose last line was the previous
// seat's, posted long before this seat was handed the clock.
function monopolyLastActivityAt(room: IGameRoom, turnStartedAt: number): number {
	return Math.max(lastActivityAt(room), turnStartedAt);
}

// The seat holding the match up: the debtor while it waits on a debt (who may not be the seat
// on the clock, since a card can charge a rival), otherwise the seat on the clock.
function idleSeatOf(state: MonopolyState): string {
	return waitingDebt(state)?.debtorId ?? activeSeatOf(state).userId;
}

/**
 * Forfeit the seat holding the match up once it has sat past GAME_ROOM_MONOPOLY_IDLE_MS, and
 * finish the match when that leaves one seat. THE one idle timeout function: the 5 minute sweep
 * (roomTurnSweep.sweepMonopolyIdle) calls it for every match and the turn clock at the deadline
 * (2026-10 item 267). Answers the state it wrote, or null when nothing was due or a move won.
 */
export async function forfeitIdleMonopolySeatIfDue(client: Client, room: IGameRoom, now: Date): Promise<MonopolyState | null> {
	const state = monopolyStateOf(room);
	if (!state || state.phase === "finished") return null;

	const lastActive = monopolyLastActivityAt(room, state.turnStartedAt);
	if (!isClockExpired(roomDrawingKey(room), lastActive, BOT_CONSTANTS.GAME_ROOM_MONOPOLY_IDLE_MS, now.getTime())) return null;

	// Captured BEFORE the move, which hands the clock on.
	//
	// A debtor who never pays is bankrupt to whoever they owed (applyDebtDefault),
	// not forfeited to the bank: the creditor is owed that money, and the rules
	// give a player creditor everything a debtor who cannot pay holds.
	const debt = waitingDebt(state);
	const idleId = idleSeatOf(state);
	const result = debt ? applyDebtDefault(state, now.getTime()) : applyForfeit(state, idleId, now.getTime());
	if (!result.ok) return null;
	const reason = debt ? gameRoomsCopy.monopoly.idleDebtDefault(idleId) : gameRoomsCopy.monopoly.idleForfeit(idleId);

	// ⚠️ THE PLAYER WINS A TIE. A move that landed after this read changes the turn, so the
	// compare and swap finds nothing and the seat that just woke up keeps playing instead of
	// being forfeited on a stale read; the same claim stops a sweep and a clock from both forfeiting.
	const lines = [reason, ...result.trailLines];
	const written = await persistIfUnchanged(room, state, result.state, lines);
	if (!written) return null;
	await applyMonopolyOutcome(client, room, state, written, { actorId: idleId, kind: "system", lines }, "timeout");
	return written;
}

/**
 * Close an auction whose round has run out: the highest bid its bidder can still pay buys the
 * lot, or the bank keeps it, and the seller's turn carries on. THE one close: the 10 second
 * sweep (roomMonopolyAuction.sweepMonopolyAuctions) and the turn clock (2026-10 item 267) both
 * call it. True when this call closed it.
 */
export async function closeExpiredAuction(client: Client, room: IGameRoom, now: number): Promise<boolean> {
	const state = monopolyStateOf(room);
	const auction = state?.pendingAuction;
	if (!state || state.phase !== "in-auction" || !auction || now < auctionClosesAt(auction)) return false;

	const result = closeAuction(state);
	if (!result.ok) return false;
	// A bid that landed after this read wins the compare and swap, and the next look closes
	// the round with that bid counted.
	const written = await persistIfUnchanged(room, state, result.state, result.trailLines);
	if (!written) return false;

	// "system": no player pressed anything; the close happens because the clock ran out.
	const sellerId = written.seats[written.activeSeatIndex].userId;
	await applyMonopolyOutcome(client, room, state, written, { actorId: sellerId, kind: "system", lines: result.trailLines });
	return true;
}

/**
 * Monopoly's idle clock (2026-10 item 267): the seat holding the match up, from the later of its
 * turn's start and the last trail line plus GAME_ROOM_MONOPOLY_IDLE_MS and every drawing hold,
 * the stamp the idle sweep reads. A debt makes the debtor the one on the clock, so the turn's
 * identity names the debtor too.
 */
export const monopolyIdleTurnClock: TurnClockGame = {
	kind: "monopoly-idle",
	current(room, now) {
		const state = monopolyStateOf(room);
		if (!state || state.phase === "finished") return null;
		const fingerprint = turnIdentityOf(state);
		const debtorId = waitingDebt(state)?.debtorId;
		return {
			memberId: idleSeatOf(state),
			fingerprint: debtorId ? `${fingerprint}.d${debtorId}` : fingerprint,
			deadline: pausedDeadline(roomDrawingKey(room), monopolyLastActivityAt(room, state.turnStartedAt), BOT_CONSTANTS.GAME_ROOM_MONOPOLY_IDLE_MS, now),
		};
	},
	async expire(client, room, now) {
		return (await forfeitIdleMonopolySeatIfDue(client, room, now)) !== null;
	},
};

/**
 * An auction round's clock (2026-10 item 267). A sealed bid is open to every seat, but the clock
 * belongs to the turn the auction interrupts, so the seat on the clock (the seller) is the one
 * warned, as the owner's rule pings only the member on the clock. Its close is the round's
 * nominal end (auctionClosesAt), never held by a draw, because the bid gates read it too.
 */
export const monopolyAuctionTurnClock: TurnClockGame = {
	kind: "monopoly-auction",
	current(room) {
		const state = monopolyStateOf(room);
		const auction = state?.pendingAuction;
		if (!state || state.phase !== "in-auction" || !auction) return null;
		return { memberId: activeSeatOf(state).userId, fingerprint: `a${auction.roundOpenedAt}`, deadline: auctionClosesAt(auction) };
	},
	expire(client, room, now) {
		return closeExpiredAuction(client, room, now.getTime());
	},
};

/** Both of a Monopoly match's clocks, which every placed move syncs. */
export const MONOPOLY_TURN_CLOCKS: readonly TurnClockGame[] = [monopolyIdleTurnClock, monopolyAuctionTurnClock];

// ── the turn prompt (turnPrompt.ts, 2026-10 item 257 Phase 4a) ────────
// What:  Monopoly's side of the shared turn piece: whose turn it is, a fingerprint that holds
//        for the whole turn (it moves when the engine counts one more turn taken), the seat's
//        position and cash as the modal's text, and the moves the seat could press on the
//        board right now as a select.
// Who:   syncTurnPrompt after every placed board; handleTurnPress and handleTurnSubmit.
// How:   the select's values map back to the moves above, played through commitMonopolyMove
//        like the board's own buttons. Trade and Bid are buttons on the prompt line, since a
//        modal cannot open from this one's Submit (risk R6).

const BUY_PREFIX = "buy:";
const MOVE_FIELD = "move";

// The moves the seat on the clock could press on the board now: the same phase table as the
// board's turnButtons, so the modal never offers a move the board would not.
function turnMoveOptions(state: MonopolyState, seat: MonopolyState["seats"][number]): { label: string; value: string }[] {
	const copy = gameRoomsCopy.monopoly;
	const debt = waitingDebt(state);
	if (debt) return debt.debtorId === seat.userId ? [{ label: copy.payDebtLabel(debt.amount), value: "paydebt" }] : [];
	switch (state.phase) {
		case "pre-roll": {
			if (!seat.inJail) return [{ label: copy.rollLabel, value: "roll" }];
			const options: { label: string; value: string }[] = [{ label: copy.jailRollLabel, value: "jailroll" }];
			if (seat.chips >= JAIL_BAIL) options.unshift({ label: copy.bailLabel(JAIL_BAIL), value: "bail" });
			if (seat.gojfCards > 0) options.unshift({ label: copy.useCardLabel, value: "card" });
			return options;
		}
		case "awaiting-buy-or-skip": {
			const tile = BOARD[seat.position];
			const skip = { label: copy.skipLabel, value: "skip" };
			if (!isOwnableTile(tile)) return [skip];
			return seat.chips >= tile.price ? [{ label: copy.buyLabel(tile.name, tile.price), value: `${BUY_PREFIX}${tile.id}` }, skip] : [skip];
		}
		case "post-roll":
			return [{ label: copy.endTurnLabel, value: "end" }];
		default:
			return [];
	}
}

function moveForChoice(choice: string): MonopolyMove | null {
	if (choice.startsWith(BUY_PREFIX)) return buyMove(choice.slice(BUY_PREFIX.length));
	switch (choice) {
		case "roll":
			return rollMove;
		case "skip":
			return skipMove;
		case "end":
			return endTurnMove;
		case "paydebt":
			return payDebtMove;
		case "bail":
		case "card":
			return jailMove(choice);
		case "jailroll":
			return jailMove("roll");
		default:
			return null;
	}
}

const activeSeatOf = (state: MonopolyState) => state.seats[state.activeSeatIndex];

// The turn's identity: the count of turns taken and the seat on the clock, the same for the whole turn.
const turnIdentityOf = (state: MonopolyState): string => `m${state.stats?.turnsTaken ?? 0}.${state.activeSeatIndex}`;

// The seat the turn line belongs to: the debtor while the match waits on a rival's debt, since
// only their Pay moves the match on (2026-10 item 276, audit P2-3), otherwise the seat on the clock.
const promptedSeatOf = (state: MonopolyState) => {
	const debtorId = waitingDebt(state)?.debtorId;
	return state.seats.find((seat) => seat.userId === debtorId) ?? activeSeatOf(state);
};

export const monopolyTurnAdapter: TurnAdapter = {
	game: "monopoly",
	// ⚠️ THE DEBTOR, NOT THE SEAT ON THE CLOCK, while a rival's debt is waited on (audit P2-3): a
	// card or a rent can charge a seat whose turn it is not, and the line used to ping the active
	// seat with a Take your turn that could do nothing while the debtor, unpinged, held the match
	// for up to its whole idle budget. The idle clock's warning follows the line, so it now moves the
	// line's Pay button down to the debtor with it (turnPrompt.postTurnWarning).
	whoseTurn(room) {
		const state = monopolyStateOf(room);
		return state && state.phase !== "finished" ? promptedSeatOf(state).userId : null;
	},
	// A rival's debt is a turn line of its own, so it pings the debtor, and paying it posts a fresh
	// line that pings the seat on the clock again; a debt on the active seat's own landing keeps the
	// turn's line, whose buttons change in place.
	fingerprintOf(room) {
		const state = monopolyStateOf(room);
		if (!state) return null;
		const prompted = promptedSeatOf(state);
		const turn = turnIdentityOf(state);
		return prompted === activeSeatOf(state) ? turn : `${turn}.d${prompted.userId}`;
	},
	view(room, userId): TurnView | null {
		const state = monopolyStateOf(room);
		if (!state || state.phase === "finished") return null;
		const seat = promptedSeatOf(state);
		const options = turnMoveOptions(state, seat);
		if (seat.userId !== userId || options.length === 0) return null;
		const copy = gameRoomsCopy.monopoly;
		return {
			title: copy.turnModalTitle,
			text: [copy.turnHandText(describeTile(BOARD[seat.position]), seat.chips, seat.gojfCards, seat.inJail)],
			fields: [{ kind: "select", id: MOVE_FIELD, label: gameRoomsCopy.turnPrompt.moveLabel, options }],
		};
	},
	async apply(client, room, userId, answers, acknowledge) {
		const choice = answers[MOVE_FIELD] ?? "";
		const move = moveForChoice(choice);
		if (!move) return { ok: false, reason: gameRoomsCopy.errors.controlRetired };
		// Acknowledged FIRST, like the board's buttons (risk M1): the read and the compare and swap
		// are two Mongo round trips, and a refusal after it arrives as a private follow up.
		await acknowledge();
		const outcome = await commitMonopolyMove(client, room, userId, move, { onTurnOnly: choice !== "paydebt" });
		return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
	},
	extraButtons(room) {
		const state = monopolyStateOf(room);
		return state ? monopolyPromptButtons(state, room.roomId) : [];
	},
};

export const roomMonopolyHandlers = {
	handleMroll,
	handleMbuy,
	handleMskip,
	handleMend,
	handleMjail,
	handleMinventory,
	handleMpaydebt,
};
