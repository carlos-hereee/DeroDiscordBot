import { MessageFlags, TextChannel, type ButtonInteraction, type Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { buildPots, potTotal, type PlayerCommitment } from "@features/games/holdemPots.js";
import {
	joinTable,
	dealHand,
	act,
	forceFold,
	handInProgress,
	placements,
	whoActs,
	type ActionOutcome,
	type HoldemTable,
} from "@features/games/holdemTable.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import {
	tableEmbed,
	holeCardsEmbed,
	joiningRows,
	betweenHandsRows,
	bettingRows,
	aggressiveActionFor,
	resolveRaiseAmount,
} from "./roomHoldem.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomHoldemHandlers ───────────────────────────────────────────────
// What:  every hold em interaction: buying in, dealing, acting, peeking at your
//        own cards, and the clock that folds for a player who vanished.
// Who:   routed from gameRoomHandlers.
// When:  many times per tournament.
// Where: the table lives on the room row, so a deploy mid-hand costs nothing. Its
//        chips live NOWHERE ELSE, which is the whole of A9/R22.
// How:   every path ends by persisting the table and redrawing one board message.

const PRIVATE = { flags: MessageFlags.Ephemeral } as const;

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

// Redraw the one board message. Cosmetic, so a failure is logged and swallowed:
// the row is the truth and the next action catches up.
async function redraw(client: Client, room: IGameRoom, table: HoldemTable): Promise<void> {
	if (!table.boardMessageId || !room.channelId) return;
	const channel = await client.channels.fetch(room.channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return;
	const message = await channel.messages.fetch(table.boardMessageId).catch(() => null);
	if (!message) return;

	const pot = currentPot(table);
	// Four states, not three. The one that was missing is BETWEEN hands: the
	// tournament is still "playing" but the last hand has settled, so there is nothing
	// to act on and the host needs the deal control back. Falling through to
	// bettingRows there rendered five disabled buttons and no way forward, which is
	// what dead ended every tournament after hand one.
	const components =
		table.status === "finished"
			? []
			: table.status === "joining"
			  ? joiningRows(room.roomId, table.seats.length)
			  : handInProgress(table)
			    ? bettingRows(table, room.roomId, pot)
			    : betweenHandsRows(room.roomId);

	await message
		.edit({ embeds: [tableEmbed(table, pot)], components })
		.catch((error) => console.warn("[game-rooms] failed to redraw the hold em table", error));
}

// ── buying in ─────────────────────────────────────────────────────────
export async function handleBuyIn(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const username =
		interaction.guild?.members.cache.get(interaction.user.id)?.displayName ??
		interaction.user.globalName ??
		interaction.user.username;

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
	// follows it can never disagree.
	let current: IGameRoom = room;
	let seated: { table: HoldemTable; count: number } | null = null;
	let refusal: string | null = null;

	for (let attempt = 0; attempt < BOT_CONSTANTS.HOLDEM_SEAT_CLAIM_ATTEMPTS && !seated && !refusal; attempt++) {
		const table = tableOf(current);
		if (!table) {
			refusal = gameRoomsCopy.holdem.tournamentOver;
			break;
		}

		const result = joinTable(table, interaction.user.id, username);
		if (!result.ok) {
			refusal =
				result.reason === "alreadySeated"
					? gameRoomsCopy.holdem.alreadySeated
					: result.reason === "tableFull"
					  ? gameRoomsCopy.holdem.tableFull
					  : gameRoomsCopy.holdem.alreadyStarted;
			break;
		}

		const written = await gameRoomStore.updateSecretIf(
			current.guildId,
			current.roomId,
			{ "secret.seats": { $size: table.seats.length - 1 } },
			table,
			{ $addToSet: { playerIds: interaction.user.id } }
		);
		if (written) {
			seated = { table, count: table.seats.length };
			break;
		}

		current = (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? current;
	}

	if (!seated) {
		await interaction.reply({ content: refusal ?? gameRoomsCopy.holdem.tableBusy, ...PRIVATE });
		return;
	}

	await interaction.deferUpdate();
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "join",
		text: gameRoomsCopy.holdem.seatTaken(interaction.user.id, seated.count),
	});
	await redraw(interaction.client, room, seated.table);
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

	const handNumberBefore = table.handNumber;
	const blindsBefore = table.bigBlind;
	dealHand(table);

	// The claim. Discord delivers both halves of a double click as two independent
	// interactions and each one re-reads the room, so both saw the same hand number
	// and both would otherwise deal. Exactly one write can match it.
	const written = await gameRoomStore.updateSecretIf(
		room.guildId,
		room.roomId,
		{ "secret.handNumber": handNumberBefore },
		table
	);
	if (!written) {
		await interaction.reply({ content: gameRoomsCopy.holdem.handInProgress, ...PRIVATE });
		return;
	}

	await interaction.deferUpdate();

	if (table.bigBlind !== blindsBefore) {
		await roomTrail.postMove(interaction.client, room, {
			actorId: interaction.user.id,
			kind: "system",
			text: gameRoomsCopy.holdem.blindsUp(table.smallBlind, table.bigBlind),
		});
	}
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "system",
		text: gameRoomsCopy.holdem.handDealt(table.handNumber, table.smallBlind, table.bigBlind),
	});
	await redraw(interaction.client, room, table);
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
	const outcome = act(table, interaction.user.id, action, amount);
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
			void awardXp({
				client,
				guildId: room.guildId,
				userId: award.userId,
				username: table.seats.find((seat) => seat.userId === award.userId)?.username ?? award.userId,
				amount: BOT_CONSTANTS.LEVELING.HOLDEM_HAND_WIN_XP,
				source: "game",
				channelId: room.channelId,
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
		await roomLifecycle.finish(client, room, { winnerId: table.winnerId });
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
		void awardXp({
			client,
			guildId: room.guildId,
			userId,
			username: table.seats.find((seat) => seat.userId === userId)?.username ?? userId,
			amount,
			source: "game",
			// The ONE call that records the match, so /account shows a hold em played
			// once per tournament rather than once per hand.
			game: "holdem",
			outcome: index === 0 ? "won" : "lost",
			channelId: room.channelId,
		});
	}
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
}

/**
 * Force an action for every hold em table whose player has run out of time.
 *
 * ⚠️ NEVER PAUSES. A table that waits for an absent player hands one person the
 * power to stall five, which is the exact failure a turn clock exists to prevent.
 */
export async function sweepHoldemClocks(client: Client, now: Date = new Date()): Promise<HoldemClockSummary> {
	// ⚠️ ONE SWEEP AT A TIME. The interval fires every HOLDEM_CLOCK_TICK_MS whether or
	// not the previous tick finished, and a tick that stalls behind a 429 while posting
	// trail lines would otherwise re-enter on the same stale tables and force a second
	// action for a seat it already folded.
	if (sweepInFlight) return { forced: 0 };
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

	for (const room of rooms) {
		try {
			const table = tableOf(room);
			if (!table || table.status !== "playing" || !whoActs(table)) continue;
			if (now.getTime() - table.lastActionAt < BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS) continue;

			// Captured BEFORE forceFold, which stamps a new one through `act`.
			const readAt = table.lastActionAt;
			const outcome = forceFold(table);
			if (!outcome.ok || !outcome.userId) continue;

			// ⚠️ THE PLAYER GETS THE BENEFIT OF THE DOUBT ON A TIE. This loop is
			// sequential and each iteration awaits Discord I/O, so the Nth table is being
			// decided against a snapshot read seconds ago, and a short stack acting at
			// 29.9 seconds races the fold. If their action landed first the write below
			// finds a different lastActionAt and does nothing, so their real move stands
			// instead of being overwritten by a fold they did not make. Without this both
			// wrote, both called settleOutcome, and payPlacements paid the tournament out
			// twice.
			const written = await persistIfUnchanged(room, table, readAt);
			if (!written) continue;

			forced++;
			await roomTrail.postMove(client, room, {
				actorId: outcome.userId,
				kind: "system",
				text: gameRoomsCopy.holdem.timedOut(outcome.userId, outcome.narration?.includes("checks") ? "checked" : "folded"),
			});
			await settleOutcome(client, room, table, outcome, outcome.userId);
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

	return { forced };
}

export const roomHoldemHandlers = { handleBuyIn, handleDeal, handleMove, handleShowCards, sweepHoldemClocks };

// Rendering helpers the provisioner needs to post the first board.
export { tableEmbed, joiningRows, currentPot };
