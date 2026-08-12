import { MessageFlags, TextChannel, type ButtonInteraction, type Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { buildPots, potTotal, type PlayerCommitment } from "@features/games/holdemPots.js";
import {
	joinTable,
	dealHand,
	act,
	forceFold,
	placements,
	whoActs,
	type ActionOutcome,
	type HoldemTable,
} from "@features/games/holdemTable.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { tableEmbed, holeCardsEmbed, joiningRows, bettingRows, resolveRaiseAmount } from "./roomHoldem.js";
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

async function persist(room: IGameRoom, table: HoldemTable) {
	return gameRoomStore.update(room.guildId, room.roomId, { secret: table as never });
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
	const components =
		table.status === "joining"
			? joiningRows(room.roomId, table.seats.length)
			: table.status === "finished"
			  ? []
			  : bettingRows(table, room.roomId, pot);

	await message
		.edit({ embeds: [tableEmbed(table, pot)], components })
		.catch((error) => console.warn("[game-rooms] failed to redraw the hold em table", error));
}

// ── buying in ─────────────────────────────────────────────────────────
export async function handleBuyIn(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const table = tableOf(room);
	if (!table) {
		await interaction.reply({ content: gameRoomsCopy.holdem.tournamentOver, ...PRIVATE });
		return;
	}

	const username =
		interaction.guild?.members.cache.get(interaction.user.id)?.displayName ??
		interaction.user.globalName ??
		interaction.user.username;
	const result = joinTable(table, interaction.user.id, username);

	if (!result.ok) {
		const message =
			result.reason === "alreadySeated"
				? gameRoomsCopy.holdem.alreadySeated
				: result.reason === "tableFull"
				  ? gameRoomsCopy.holdem.tableFull
				  : gameRoomsCopy.holdem.alreadyStarted;
		await interaction.reply({ content: message, ...PRIVATE });
		return;
	}

	// The room's player list follows the seats, so the playersOnly gate on every
	// other hold em control admits exactly the people who bought in.
	await gameRoomStore.update(room.guildId, room.roomId, {
		secret: table as never,
		playerIds: Array.from(new Set([...room.playerIds, interaction.user.id])),
	});

	await interaction.deferUpdate();
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "join",
		text: gameRoomsCopy.holdem.seatTaken(interaction.user.id, table.seats.length),
	});
	await redraw(interaction.client, room, table);
}

// ── dealing ───────────────────────────────────────────────────────────
export async function handleDeal(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const table = tableOf(room);
	if (!table) return;

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

	const blindsBefore = table.bigBlind;
	dealHand(table);
	await persist(room, table);
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
const PRESET_ACTIONS: Record<string, "fold" | "check" | "call" | "allIn" | "raise"> = {
	fold: "fold",
	check: "check",
	call: "call",
	allin: "allIn",
	min: "raise",
	half: "raise",
	pot: "raise",
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

	const action = PRESET_ACTIONS[preset];
	if (!action) {
		await interaction.reply({ content: "This control is no longer available.", ...PRIVATE });
		return;
	}

	const amount = action === "raise" ? resolveRaiseAmount(table, interaction.user.id, preset, currentPot(table)) : 0;
	const outcome = act(table, interaction.user.id, action, amount);
	if (!outcome.ok) {
		await interaction.reply({ content: gameRoomsCopy.holdem.notYourTurn, ...PRIVATE });
		return;
	}

	await persist(room, table);
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
	const rooms = await gameRoomStore.findPlayingByGame("holdem");
	let forced = 0;

	for (const room of rooms) {
		try {
			const table = tableOf(room);
			if (!table || table.status !== "playing" || !whoActs(table)) continue;
			if (now.getTime() - table.lastActionAt < BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS) continue;

			const outcome = forceFold(table);
			if (!outcome.ok || !outcome.userId) continue;

			forced++;
			await persist(room, table);
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
