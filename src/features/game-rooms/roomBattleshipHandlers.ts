import { MessageFlags, TextChannel, type ButtonInteraction, type StringSelectMenuInteraction } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { placeFleet } from "@features/games/battleshipState.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import {
	fire,
	deserializeMatch,
	serializeMatch,
	publicBoardEmbed,
	privateBoardEmbed,
	battleshipRows,
	PRIVATE,
	type StoredBattleship,
} from "./roomBattleship.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomBattleshipHandlers ───────────────────────────────────────────
// What:  the interaction half of battleship: aiming, firing, looking at your own
//        board, and re-laying your fleet.
// Who:   routed from gameRoomHandlers, which has already proven the clicker is one
//        of the room's players.
// When:  many times per match, unlike every other game in this feature.
// Where: the public board is ONE message, EDITED every turn. That deliberately
//        differs from hangman's append-only trail: a 10x10 grid reposted per shot
//        would be thirty unreadable walls, so the board carries the STATE and the
//        trail carries the NARRATION. Both exist; neither is redundant.
// How:   every write goes back through the room row, so a deploy mid-match costs
//        nothing.

const storedMatch = (room: IGameRoom): StoredBattleship | null => (room.secret as StoredBattleship | null) ?? null;

async function persist(room: IGameRoom, stored: StoredBattleship) {
	return gameRoomStore.update(room.guildId, room.roomId, { secret: stored as never });
}

// Redraw the one public board message. Cosmetic, so a failure is logged and
// swallowed: the row is the truth and the next turn will catch up.
async function refreshBoard(interaction: ButtonInteraction, room: IGameRoom, stored: StoredBattleship): Promise<void> {
	if (!stored.boardMessageId || !room.channelId) return;
	const channel = await interaction.client.channels.fetch(room.channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return;
	const message = await channel.messages.fetch(stored.boardMessageId).catch(() => null);
	if (!message) return;

	const state = deserializeMatch(stored);
	await message
		.edit({ embeds: [publicBoardEmbed(state)], components: battleshipRows(room.roomId, state) })
		.catch((error) => console.warn("[game-rooms] failed to redraw the battleship board", error));
}

// ── aiming ────────────────────────────────────────────────────────────
// The two selects each store HALF a coordinate on the row. Keeping it on the row
// rather than in a Map means a deploy mid-aim costs a re-click at worst, and two
// players aiming at once cannot collide on one shared slot.
export async function handleAimSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const [, action, roomId] = interaction.customId.split(":");
	const guildId = interaction.guildId;
	if (!guildId || !roomId) return;

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room || room.status !== "playing") {
		await interaction.reply({ content: gameRoomsCopy.battleship.matchOver, ...PRIVATE });
		return;
	}
	// Re-gated: a select's customId is user input and this is reachable directly.
	if (!room.playerIds.includes(interaction.user.id)) {
		await interaction.reply({ content: gameRoomsCopy.errors.notYours, ...PRIVATE });
		return;
	}

	const stored = storedMatch(room);
	if (!stored) {
		await interaction.reply({ content: gameRoomsCopy.battleship.matchOver, ...PRIVATE });
		return;
	}

	const value = Number.parseInt(interaction.values[0] ?? "", 10);
	if (!Number.isInteger(value)) return;

	const pending = { ...(stored.pending ?? {}) };
	const mine = { ...(pending[interaction.user.id] ?? {}) };
	if (action === "bscol") mine.x = value;
	else mine.y = value;
	pending[interaction.user.id] = mine;

	await persist(room, { ...stored, pending });

	// Ephemeral, always: announcing an aim publicly would tell the opponent where
	// the next shot is going before it is fired.
	const ready = mine.x !== undefined && mine.y !== undefined;
	await interaction.reply({
		content: ready
			? gameRoomsCopy.battleship.aimed(`${["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"][mine.x!]}${mine.y! + 1}`)
			: gameRoomsCopy.battleship.aimedPartial,
		...PRIVATE,
	});
}

// ── firing ────────────────────────────────────────────────────────────
export async function handleFire(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const stored = storedMatch(room);
	if (!stored) {
		await interaction.reply({ content: gameRoomsCopy.battleship.matchOver, ...PRIVATE });
		return;
	}

	const outcome = fire(stored, interaction.user.id);
	if (!outcome.ok || !outcome.state) {
		await interaction.reply({ content: outcome.message, ...PRIVATE });
		return;
	}

	// Clear this player's aim so the next turn starts from nothing rather than
	// re-firing the previous coordinate on a stray press.
	const pending = { ...(stored.pending ?? {}) };
	delete pending[interaction.user.id];
	const next = serializeMatch(outcome.state, { pending, boardMessageId: stored.boardMessageId });
	await persist(room, next);

	await interaction.reply({ content: outcome.message, ...PRIVATE });

	// The narration is a MOVE: it belongs in the transcript that is the product, and
	// it names only a coordinate that has now been fired on, never an unfired one.
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "guess",
		text: outcome.message,
		meta: { sunk: outcome.sunk ?? null },
	});

	await refreshBoard(interaction, room, next);

	// ── the per sink bonus ──
	// ⚠️ AWARDED WITHOUT `game`, DELIBERATELY. awardXp increments
	// `games.<slug>.played` for ANY call that names a game, so passing
	// game: "battleship" here would record a fifth and sixth "played" for a match
	// the member played once, and /account renders that line. The match record is
	// written exactly once, by awardTwoPlayerResult on the winning shot; this call
	// is xp only.
	//
	// Fire and forget after the primary action (house rule 7): the shot has already
	// landed and been narrated, and awardXp never throws by contract.
	if (outcome.sunk) {
		void awardXp({
			client: interaction.client,
			guildId: room.guildId,
			userId: interaction.user.id,
			username:
				interaction.guild?.members.cache.get(interaction.user.id)?.displayName ??
				interaction.user.globalName ??
				interaction.user.username,
			amount: BOT_CONSTANTS.LEVELING.GAME_SINK_XP,
			source: "game",
			channelId: room.channelId,
		});
	}

	if (!outcome.won) return;

	await roomLifecycle.finish(interaction.client, room, { winnerId: interaction.user.id });

	const [a, b] = room.playerIds;
	awardTwoPlayerResult({
		client: interaction.client,
		guildId: room.guildId,
		channelId: room.channelId,
		game: "battleship",
		challenger: { id: a } as never,
		opponent: { id: b } as never,
		winner: interaction.user.id === a ? "challenger" : "opponent",
	});
}

// ── the private board (Q8: pull based, never pushed) ──────────────────
// ⚠️ EPHEMERAL, ALWAYS. This is the one surface that renders a player's own
// unfired ships, so it must never reach the channel. No private channels and no
// DMs either: a channel per player costs two channels per match against a 500
// channel server cap, on top of the room's own.
export async function handleViewBoard(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const stored = storedMatch(room);
	if (!stored) {
		await interaction.reply({ content: gameRoomsCopy.battleship.matchOver, ...PRIVATE });
		return;
	}
	await interaction.reply({
		embeds: [privateBoardEmbed(deserializeMatch(stored), interaction.user.id)],
		...PRIVATE,
	});
}

// ── reroll ────────────────────────────────────────────────────────────
export async function handleReroll(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const stored = storedMatch(room);
	if (!stored) {
		await interaction.reply({ content: gameRoomsCopy.battleship.matchOver, ...PRIVATE });
		return;
	}

	// Only before the first shot lands anywhere. Re-laying a fleet mid-match would
	// move ships out from under hits the opponent has already earned.
	const anyShotFired = stored.players.some((player) => player.shots.length > 0);
	if (anyShotFired) {
		await interaction.reply({ content: gameRoomsCopy.battleship.rerollTooLate, ...PRIVATE });
		return;
	}

	const index = stored.players.findIndex((player) => player.userId === interaction.user.id);
	if (index === -1) {
		await interaction.reply({ content: gameRoomsCopy.errors.notYours, ...PRIVATE });
		return;
	}

	const players = [...stored.players] as StoredBattleship["players"];
	players[index] = {
		...players[index],
		ships: placeFleet().map((ship) => ({ name: ship.name, cells: ship.cells, hits: [] })),
	};
	await persist(room, { ...stored, players });

	// Ephemeral: the whole point is that nobody else learns the new layout.
	await interaction.reply({ content: gameRoomsCopy.battleship.rerolled, ...PRIVATE });
}

export const roomBattleshipHandlers = { handleAimSelect, handleFire, handleViewBoard, handleReroll };

// Re-exported so the router's flag reads identically to every other ephemeral
// surface in the feature.
export const BATTLESHIP_PRIVATE_FLAGS = MessageFlags.Ephemeral;
