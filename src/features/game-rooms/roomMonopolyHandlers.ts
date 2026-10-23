import {
	MessageFlags,
	TextChannel,
	type ButtonInteraction,
	type Client,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { secureRandom } from "@utils/secureRng.js";
import { ownableTileName } from "@features/games/monopolyBoard.js";
import {
	applyBuy,
	applyEndTurn,
	applyJailChoice,
	applyPayDebt,
	applyRoll,
	applySkip,
	type JailChoice,
	type MonopolyResult,
	type MonopolyState,
} from "@features/games/monopolyState.js";
import { awardMultiPlayerResult } from "@features/games/gameXp.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { auctionClosesAt, monopolyBoardEmbed, monopolyControlsRow, monopolyInventoryReply } from "./roomMonopoly.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { RoomMoveKind } from "./roomTypes.js";

// ── roomMonopolyHandlers ─────────────────────────────────────────────
// What:  every Monopoly button: roll, buy, skip, end turn, the three ways out of
//        jail, and the private Inventory peek. Plus the shared tail (persist,
//        redraw, trail, finish) the idle sweep in roomTurnSweep reuses.
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
//        ⑥ redraw the board, ⑦ post the trail, ⑧ finish and pay if it ended.

const PRIVATE = { flags: MessageFlags.Ephemeral } as const;

const JAIL_CHOICES: readonly JailChoice[] = ["bail", "card", "roll"];

/**
 * The match stored on a room row, or null for a row with no board yet. Through
 * `unknown` because IGameRoom types `secret` as hangman's RoomSecret, the shape the
 * Mixed field was first written for; the `seats` check is what tells a Monopoly
 * state apart from a row whose secret was never seeded.
 */
export function monopolyStateOf(room: IGameRoom | null): MonopolyState | null {
	const stored = room?.secret as unknown as Partial<MonopolyState> | null | undefined;
	return Array.isArray(stored?.seats) ? (stored as MonopolyState) : null;
}

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
export function turnFingerprint(state: MonopolyState): Record<string, unknown> {
	const index = state.activeSeatIndex;
	const seat = state.seats[index];
	return {
		"secret.revision": state.revision,
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

/** Persist `next` only if the row still holds the turn `read` describes. Null means somebody else moved first. */
export async function persistIfUnchanged(room: IGameRoom, read: MonopolyState, next: MonopolyState) {
	return gameRoomStore.updateSecretIf(room.guildId, room.roomId, turnFingerprint(read), next);
}

// ── the shared tail ───────────────────────────────────────────────────
// Redraw the one board message. Cosmetic, so a failure is logged and swallowed:
// the row is the truth and the next press redraws from it.
export async function redrawMonopolyBoard(client: Client, room: IGameRoom, state: MonopolyState): Promise<void> {
	if (!state.boardMessageId || !room.channelId) return;
	const channel = await client.channels.fetch(room.channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return;
	const message = await channel.messages.fetch(state.boardMessageId).catch(() => null);
	if (!message) return;

	// Rendered for the seat on the clock, because the board is one shared message
	// and that seat is the only one whose buttons do anything.
	const activeId = state.seats[state.activeSeatIndex].userId;
	const { embed, attachment } = await monopolyBoardEmbed(state);
	await message
		.edit({
			embeds: [embed],
			components: monopolyControlsRow(state, activeId, room.roomId),
			// ⚠️ `attachments: []` IS LOAD BEARING. An edit keeps the message's existing
			// files unless told otherwise, so without it every move would stack one more
			// board picture on the message, and a redraw that fell back to text would
			// leave the last picture hanging under the embed. It must be a fresh array
			// per call: discord.js pushes the new upload into the one it is given.
			attachments: [],
			files: attachment ? [attachment] : [],
		})
		.catch((error) => console.warn("[game-rooms] failed to redraw the monopoly board", error));
}

/**
 * Everything after a move has been PERSISTED, whoever caused it: redraw, post each
 * trail line, then finish and pay if the match just ended. The button path and the
 * idle sweep both end here so a forfeit for inactivity reads like any other move;
 * the sweep puts its own "out for inactivity" line ahead of the engine's in `lines`.
 */
export async function applyMonopolyOutcome(
	client: Client,
	room: IGameRoom,
	state: MonopolyState,
	trail: { actorId: string; kind: RoomMoveKind; lines: string[] }
): Promise<void> {
	await redrawMonopolyBoard(client, room, state);
	for (const text of trail.lines) {
		await roomTrail.postMove(client, room, { actorId: trail.actorId, kind: trail.kind, text });
	}
	if (state.phase === "finished") await finishMonopolyMatch(client, room, state);
}

// The match is over: close the room, then record one result per seat.
//
// ⚠️ PAID ONLY WHEN THIS CALL WON finish's CLAIM. finish returns false when the
// room was already finished, and the award below sits outside that claim, so
// paying regardless would pay the table twice if the sweep and a press both
// reached the end. One award per match, at its end, per the plan: the last seat
// standing wins and every other seat (bankrupt or forfeited) records a loss.
async function finishMonopolyMatch(client: Client, room: IGameRoom, state: MonopolyState): Promise<void> {
	const claimed = await roomLifecycle.finish(client, room, { winnerId: state.winnerId });
	if (!claimed) return;

	awardMultiPlayerResult({
		client,
		guildId: room.guildId,
		channelId: room.channelId,
		game: "monopoly",
		participants: await resolveParticipants(client, room.guildId, state.seats.map((seat) => seat.userId)),
		winnerId: state.winnerId,
		nonWinnerOutcome: "lost",
	});
}

/**
 * Display names for seats, through one bulk fetch into the cache: the XP award
 * and the trade partner picker both read them. A member who left the server gets
 * no name (undefined, never the snowflake) for the reason gameXp's participants
 * type explains, and the caller supplies its own fallback.
 */
export async function resolveParticipants(client: Client, guildId: string, userIds: string[]) {
	const guild = await client.guilds.fetch(guildId).catch(() => null);
	await guild?.members.fetch({ user: userIds }).catch(() => null);
	return userIds.map((userId) => ({ userId, username: guild?.members.cache.get(userId)?.displayName }));
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
	options: { onTurnOnly: boolean }
): Promise<CommitOutcome> {
	// ② Re-read rather than trust the row the router loaded: it is a few hundred
	// milliseconds older, and a stale read only loses the compare and swap below.
	const fresh = (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? room;
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
	const written = await persistIfUnchanged(fresh, state, result.state);
	if (!written) return { ok: false, reason: gameRoomsCopy.monopoly.boardBusy };

	// ⑥ ⑦ ⑧ Redraw, then the trail, then the ending. "guess" is the trail kind every
	// player made move uses (hold em's narration too); "system" is for lines no
	// player pressed for.
	await applyMonopolyOutcome(client, fresh, result.state, { actorId, kind: "guess", lines: result.trailLines });
	return { ok: true, state: result.state };
}

// ── the button path ───────────────────────────────────────────────────
async function refuse(interaction: ButtonInteraction, reason: string): Promise<void> {
	// followUp, not reply: every refusal below comes after the deferUpdate, and a
	// deferred interaction has spent its one reply.
	await interaction.followUp({ embeds: [errorEmbed(reason)], ...PRIVATE });
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

/** Roll the dice. secureRandom, because the dice decide who pays whom. */
export const handleMroll = (interaction: ButtonInteraction, room: IGameRoom): Promise<void> =>
	runMonopolyAction(interaction, room, (state) => applyRoll(state, secureRandom));

/** Buy the lot on the button. The engine refuses a lot the seat is no longer standing on. */
export const handleMbuy = (interaction: ButtonInteraction, room: IGameRoom, tileId: string): Promise<void> =>
	runMonopolyAction(interaction, room, (state, actorId) => applyBuy(state, actorId, tileId));

/**
 * Pass on the lot. In a match with auctions on, the engine opens the auction
 * itself, and the trail gets one more line saying the clock is running, since the
 * engine keeps no timer and so says nothing about one.
 */
export const handleMskip = (interaction: ButtonInteraction, room: IGameRoom): Promise<void> =>
	runMonopolyAction(interaction, room, (state, actorId) => withAuctionNotice(applySkip(state, actorId)));

function withAuctionNotice(result: MonopolyResult): MonopolyResult {
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
		await interaction.reply({ content: gameRoomsCopy.monopoly.matchOver, ...PRIVATE });
		return null;
	}
	if (!room.playerIds.includes(interaction.user.id)) {
		await interaction.reply({ content: gameRoomsCopy.errors.notYours, ...PRIVATE });
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

export const handleMend = (interaction: ButtonInteraction, room: IGameRoom): Promise<void> =>
	runMonopolyAction(interaction, room, (state) => applyEndTurn(state));

/**
 * Pay the debt the match is waiting on. Not turn bound: the debtor may be a rival
 * a card charged. The engine refuses anyone but the debtor, and refuses the debtor
 * while mortgaging or selling could still raise the rest.
 */
export const handleMpaydebt = (interaction: ButtonInteraction, room: IGameRoom): Promise<void> =>
	runMonopolyAction(interaction, room, (state, actorId) => applyPayDebt(state, actorId), { onTurnOnly: false });

/** The three jail buttons share this handler; the choice rides the customId's arg. */
export async function handleMjail(interaction: ButtonInteraction, room: IGameRoom, choice: string): Promise<void> {
	// The arg is user controlled (a customId anyone can replay), so it is matched
	// against the closed list before it reaches the engine. Refused BEFORE the defer
	// because nothing has been spent yet, so a plain reply still works.
	const jailChoice = JAIL_CHOICES.find((candidate) => candidate === choice);
	if (!jailChoice) {
		await interaction.reply({ content: gameRoomsCopy.errors.controlRetired, ...PRIVATE });
		return;
	}
	await runMonopolyAction(interaction, room, (state) => applyJailChoice(state, jailChoice, secureRandom));
}

// ── the private peek ──────────────────────────────────────────────────
// No defer and no write: it reads the row the router loaded and answers at once.
// Its mortgage selects are answered in roomMonopolyMortgage.
export async function handleMinventory(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const state = monopolyStateOf(room);
	if (!state) {
		await interaction.reply({ content: gameRoomsCopy.monopoly.noBoard, ...PRIVATE });
		return;
	}
	await interaction.reply({ ...monopolyInventoryReply(state, interaction.user.id, room.roomId), ...PRIVATE });
}

export const roomMonopolyHandlers = {
	handleMroll,
	handleMbuy,
	handleMskip,
	handleMend,
	handleMjail,
	handleMinventory,
	handleMpaydebt,
};
