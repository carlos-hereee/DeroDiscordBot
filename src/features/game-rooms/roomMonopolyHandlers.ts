import { MessageFlags, TextChannel, type ButtonInteraction, type Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { secureRandom } from "@utils/secureRng.js";
import {
	applyBuy,
	applyEndTurn,
	applyJailChoice,
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
import { monopolyBoardEmbed, monopolyControlsRow, monopolyInventoryEmbed } from "./roomMonopoly.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { RoomMoveKind } from "./roomTypes.js";

// ── roomMonopolyHandlers ─────────────────────────────────────────────
// What:  every Monopoly button: roll, buy, skip, end turn, the three ways out of
//        jail, and the private Inventory peek. Plus the shared tail (persist,
//        redraw, trail, finish) the idle sweep in roomTurnSweep reuses.
// Who:   routed from gameRoomHandlers after its playersOnly gate; the sweep calls
//        applyMonopolyOutcome directly.
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
// in one turn. Every Phase 4 action moves at least one of these fields (a roll
// moves the phase, the doubles streak or the jail flag; buy and skip the phase; end
// turn the phase or the active seat; bail and card the jail flag; a forfeit the
// active seat or the phase), so matching all of them is a version stamp over the
// whole match without adding a field to the engine's state.
export function turnFingerprint(state: MonopolyState): Record<string, unknown> {
	const index = state.activeSeatIndex;
	const seat = state.seats[index];
	return {
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
	await message
		.edit({ embeds: [monopolyBoardEmbed(state)], components: monopolyControlsRow(state, activeId, room.roomId) })
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

// Display names for the award, through one bulk fetch into the cache. A member who
// left the server gets no name (undefined, never the snowflake) for the reason
// gameXp's participants type explains.
async function resolveParticipants(client: Client, guildId: string, userIds: string[]) {
	const guild = await client.guilds.fetch(guildId).catch(() => null);
	await guild?.members.fetch({ user: userIds }).catch(() => null);
	return userIds.map((userId) => ({ userId, username: guild?.members.cache.get(userId)?.displayName }));
}

// ── the button path ───────────────────────────────────────────────────
type MonopolyAction = (state: MonopolyState, actorId: string) => MonopolyResult;

async function refuse(interaction: ButtonInteraction, reason: string): Promise<void> {
	// followUp, not reply: every refusal below comes after the deferUpdate, and a
	// deferred interaction has spent its one reply.
	await interaction.followUp({ embeds: [errorEmbed(reason)], ...PRIVATE });
}

async function runMonopolyAction(interaction: ButtonInteraction, room: IGameRoom, action: MonopolyAction): Promise<void> {
	// ① Acknowledge FIRST (risk M1). The read and the compare and swap below are two
	// Mongo round trips, and Discord voids an interaction not acknowledged within
	// three seconds, which on a slow Atlas moment would fail a move that landed.
	await interaction.deferUpdate();

	// ② Re-read rather than trust the row the router loaded: it is a few hundred
	// milliseconds older, and a stale read only loses the compare and swap below.
	const fresh = (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? room;
	const state = monopolyStateOf(fresh);
	if (!state) return refuse(interaction, gameRoomsCopy.monopoly.noBoard);
	if (state.phase === "finished") return refuse(interaction, gameRoomsCopy.monopoly.matchOver);

	// ③ The engine's roll, end turn and jail actions take no actor (they act for
	// whoever is on the clock), so the clicker is checked here. playersOnly upstream
	// only proved they are at the table, not that it is their turn.
	const actorId = interaction.user.id;
	if (state.seats[state.activeSeatIndex].userId !== actorId) {
		return refuse(interaction, gameRoomsCopy.monopoly.notYourTurn);
	}

	// ④ The engine's own refusal text is already written for the player.
	const result = action(state, actorId);
	if (!result.ok) return refuse(interaction, result.reason);

	// ⑤ Claim it BEFORE announcing it. The loser of a double click says nothing to
	// the channel, rather than posting a trail line for a move that never landed.
	const written = await persistIfUnchanged(fresh, state, result.state);
	if (!written) return refuse(interaction, gameRoomsCopy.monopoly.boardBusy);

	// ⑥ ⑦ ⑧ Redraw, then the trail, then the ending. "guess" is the trail kind every
	// player made move uses (hold em's narration too); "system" is for lines no
	// player pressed for.
	await applyMonopolyOutcome(interaction.client, fresh, result.state, {
		actorId,
		kind: "guess",
		lines: result.trailLines,
	});
}

/** Roll the dice. secureRandom, because the dice decide who pays whom. */
export const handleMroll = (interaction: ButtonInteraction, room: IGameRoom): Promise<void> =>
	runMonopolyAction(interaction, room, (state) => applyRoll(state, secureRandom));

/** Buy the lot on the button. The engine refuses a lot the seat is no longer standing on. */
export const handleMbuy = (interaction: ButtonInteraction, room: IGameRoom, tileId: string): Promise<void> =>
	runMonopolyAction(interaction, room, (state, actorId) => applyBuy(state, actorId, tileId));

export const handleMskip = (interaction: ButtonInteraction, room: IGameRoom): Promise<void> =>
	runMonopolyAction(interaction, room, (state, actorId) => applySkip(state, actorId));

export const handleMend = (interaction: ButtonInteraction, room: IGameRoom): Promise<void> =>
	runMonopolyAction(interaction, room, (state) => applyEndTurn(state));

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
// No defer and no write: it reads the row the router loaded and answers at once,
// and an ephemeral reply is the whole of it.
export async function handleMinventory(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const state = monopolyStateOf(room);
	if (!state) {
		await interaction.reply({ content: gameRoomsCopy.monopoly.noBoard, ...PRIVATE });
		return;
	}
	await interaction.reply({ embeds: [monopolyInventoryEmbed(state, interaction.user.id)], ...PRIVATE });
}

export const roomMonopolyHandlers = {
	handleMroll,
	handleMbuy,
	handleMskip,
	handleMend,
	handleMjail,
	handleMinventory,
};
