import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ColorResolvable } from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { formatCard } from "@features/games/holdemHand.js";
import {
	whoActs,
	actionsFor,
	livePlayers,
	seatCapOf,
	startingStackOf,
	type HoldemTable,
} from "@features/games/holdemTable.js";
import { GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── roomHoldem ───────────────────────────────────────────────────────
// What:  how a hold em table looks in Discord, and what its controls are.
// Who:   the room's board message and the `gameroom:h*` handlers.
// When:  redrawn on every action.
// Where: ⚠️ HOLE CARDS ARE NEVER IN ANYTHING THIS FILE RENDERS PUBLICLY. The table
//        embed shows the board, the pot and the stacks; a player's own two cards
//        come back only as an ephemeral reply to their own Show cards click (T16),
//        never pushed and never a DM. Grep this file for `holeCards` and there is
//        exactly one hit, in the private builder.
// How:   three rows, because Discord caps a message at five and a betting table
//        needs room to breathe: the actions, the raise presets, and the card peek
//        beside Leave table and End table.

// ── the public table ──────────────────────────────────────────────────
export function tableEmbed(table: HoldemTable, potTotal: number): EmbedBuilder {
	const board = table.board.length ? table.board.map(formatCard).join("  ") : gameRoomsCopy.holdem.noBoardYet;
	const acting = whoActs(table);

	const seats = table.seats
		.map((seat) => {
			const marker = seat.out ? "💀" : seat.userId === acting ? "▶️" : seat.folded ? "🚪" : "•";
			const state = seat.out
				? gameRoomsCopy.holdem.bustedTag
				: seat.allIn
				  ? gameRoomsCopy.holdem.allInTag
				  : seat.folded
				    ? gameRoomsCopy.holdem.foldedTag
				    : `${seat.stack}`;
			// Parentheses rather than a dash: house rule 1 bans em dashes in anything a
			// member reads, and this line renders on every redraw of every table.
			return `${marker} <@${seat.userId}> (${state})`;
		})
		.join("\n");

	const header =
		table.status === "joining"
			? joiningHeader(table)
			: table.status === "finished"
			  ? gameRoomsCopy.holdem.finishedLine(table.winnerId)
			  : gameRoomsCopy.holdem.handLine(table.handNumber, table.smallBlind, table.bigBlind);

	return infoEmbed(
		gameRoomsCopy.holdem.tableTitle,
		[header, "", `**${gameRoomsCopy.holdem.boardLabel}** ${board}`, `**${gameRoomsCopy.holdem.potLabel}** ${potTotal}`, "", seats].join(
			"\n"
		),
		COLORS.ARCADE as ColorResolvable
	);
}

// A table opened with terms says them while it waits for players, so nobody buys
// in to a 5000 chip table thinking it is the standard 1000. A table without terms
// keeps the line it always had.
function joiningHeader(table: HoldemTable): string {
	if (table.startingStack === undefined) return gameRoomsCopy.holdem.joiningLine(table.seats.length);
	return gameRoomsCopy.holdem.joiningTermsLine({
		seated: table.seats.length,
		seatCap: seatCapOf(table),
		stack: startingStackOf(table),
		smallBlind: table.smallBlind,
		bigBlind: table.bigBlind,
	});
}

// ── the private peek (T16) ────────────────────────────────────────────
// ⚠️ EPHEMERAL, PULL BASED, AND NEVER A DM. Same rule as battleship's own board:
// pushing cards costs a message per player per hand and a DM cannot be revoked or
// audited. A player clicks and sees their own two cards, and nothing else in the
// bot can reach this function with somebody else's id.
export function holeCardsEmbed(table: HoldemTable, viewerId: string): EmbedBuilder {
	const cards = table.holeCards[viewerId];
	const seat = table.seats.find((entry) => entry.userId === viewerId);

	if (!cards?.length) {
		return infoEmbed(gameRoomsCopy.holdem.yourCardsTitle, gameRoomsCopy.holdem.noCardsYet, COLORS.ARCADE as ColorResolvable);
	}

	return infoEmbed(
		gameRoomsCopy.holdem.yourCardsTitle,
		[cards.map(formatCard).join("  "), "", gameRoomsCopy.holdem.yourStack(seat?.stack ?? 0)].join("\n"),
		COLORS.ARCADE as ColorResolvable
	);
}

// ── controls ──────────────────────────────────────────────────────────
// Leave table and End table ride every live state's last row, so no state of the
// table can hold a seated player, or the host's one room slot, with no way out.
// Leave is any seated player's and End is the host's; gameRoomActions gates both.
function tableExitButtons(roomId: string): ButtonBuilder[] {
	return [
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:hleave:${roomId}`)
			.setLabel(gameRoomsCopy.holdem.leaveLabel)
			.setEmoji("🚪")
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:hend:${roomId}`)
			.setLabel(gameRoomsCopy.holdem.endLabel)
			.setEmoji("🏁")
			.setStyle(ButtonStyle.Danger),
	];
}

// `table` carries the buy in and the seat cap; without it (or for a table without
// terms) both are the standard ones, which is what every caller got before terms.
export function joiningRows(roomId: string, seatCount: number, table?: HoldemTable): ActionRowBuilder<ButtonBuilder>[] {
	const stack = table ? startingStackOf(table) : BOT_CONSTANTS.HOLDEM_STARTING_STACK;
	const seatCap = table ? seatCapOf(table) : BOT_CONSTANTS.HOLDEM_MAX_SEATS;
	return [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`${GAME_ROOM_PREFIX}:hjoin:${roomId}`)
				.setLabel(gameRoomsCopy.holdem.buyInLabel(stack))
				.setEmoji("🪙")
				.setStyle(ButtonStyle.Success)
				.setDisabled(seatCount >= seatCap),
			new ButtonBuilder()
				.setCustomId(`${GAME_ROOM_PREFIX}:hstart:${roomId}`)
				.setLabel(gameRoomsCopy.holdem.startLabel)
				.setEmoji("🃏")
				.setStyle(ButtonStyle.Primary)
				.setDisabled(seatCount < BOT_CONSTANTS.HOLDEM_MIN_SEATS),
			...tableExitButtons(roomId)
		),
	];
}

// The controls BETWEEN hands: the tournament is still running, the last hand has
// settled, and the host decides when the next one starts.
//
// ⚠️ THE DEAL CONTROL HAS TO COME BACK, and rendering it only in `joiningRows` is
// exactly why a tournament used to dead end after hand one. `redraw` edits ONE board
// message, so the joining row that carried `hstart` was replaced the instant the
// first hand was dealt, leaving no surface anywhere that could start hand two: the
// table sat on disabled buttons, the clock skipped it because nobody was to act, and
// the row held its host's one-room slot until somebody archived it by hand.
export function betweenHandsRows(roomId: string): ActionRowBuilder<ButtonBuilder>[] {
	return [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`${GAME_ROOM_PREFIX}:hstart:${roomId}`)
				.setLabel(gameRoomsCopy.holdem.nextHandLabel)
				.setEmoji("🃏")
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId(`${GAME_ROOM_PREFIX}:hcards:${roomId}`)
				.setLabel(gameRoomsCopy.holdem.showCardsLabel)
				.setEmoji("🂠")
				.setStyle(ButtonStyle.Secondary),
			...tableExitButtons(roomId)
		),
	];
}

// The one aggressive action currently open to a player, whatever the engine calls
// it.
//
// ⚠️ THE ENGINE NAMES IT "bet" WHEN THERE IS NOTHING TO RAISE AND "raise" OTHERWISE,
// and every street after preflop opens at a current bet of zero, so post-flop the
// legal label is "bet". Three call sites used to hardcode or re-derive that pairing;
// deriving it once is what stops the buttons and the dispatcher disagreeing, which
// is the shape the raise bug took.
export const aggressiveActionFor = (table: HoldemTable, userId: string) =>
	actionsFor(table, userId).find((entry) => entry.action === "raise" || entry.action === "bet");

// ⚠️ FIVE BUTTONS IN ONE ROW AND NO MODAL. A modal for a raise size costs a round
// trip and a focus change on every aggressive action, in a game where the turn
// clock is 30 seconds. The presets below are why a modal is not needed: they cover
// the sizes players actually use, and all in covers the rest.
export function bettingRows(table: HoldemTable, roomId: string, potTotal: number): ActionRowBuilder<ButtonBuilder>[] {
	const acting = whoActs(table);
	const legal = acting ? actionsFor(table, acting).map((entry) => entry.action) : [];
	const raise = acting ? aggressiveActionFor(table, acting) : undefined;

	const action = (key: string, label: string, style: ButtonStyle, enabled: boolean, emoji?: string) => {
		const button = new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:hmove:${roomId}:${key}`)
			.setLabel(label)
			.setStyle(style)
			.setDisabled(!enabled);
		if (emoji) button.setEmoji(emoji);
		return button;
	};

	const rows: ActionRowBuilder<ButtonBuilder>[] = [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			action("fold", gameRoomsCopy.holdem.foldLabel, ButtonStyle.Secondary, legal.includes("fold")),
			action("check", gameRoomsCopy.holdem.checkLabel, ButtonStyle.Secondary, legal.includes("check")),
			action("call", gameRoomsCopy.holdem.callLabel, ButtonStyle.Primary, legal.includes("call")),
			action("min", gameRoomsCopy.holdem.raiseLabel, ButtonStyle.Danger, Boolean(raise)),
			action("allin", gameRoomsCopy.holdem.allInLabel, ButtonStyle.Danger, legal.includes("allIn"))
		),
	];

	// Preset sizes, only while a raise is actually legal. Offering a disabled row of
	// four sizes on every fold-or-call spot is noise.
	if (raise) {
		// Two presets, not four. Half pot and pot are the sizes players actually
		// reach for; anything larger is what All in is for, and a row of five
		// near-identical numbers is harder to read under a 30 second clock than two.
		rows.push(
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				action("half", gameRoomsCopy.holdem.halfPotLabel(Math.floor(potTotal / 2)), ButtonStyle.Secondary, true),
				action("pot", gameRoomsCopy.holdem.potLabelButton(potTotal), ButtonStyle.Secondary, true)
			)
		);
	}

	rows.push(
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`${GAME_ROOM_PREFIX}:hcards:${roomId}`)
				.setLabel(gameRoomsCopy.holdem.showCardsLabel)
				.setEmoji("🂠")
				.setStyle(ButtonStyle.Secondary),
			...tableExitButtons(roomId)
		)
	);

	return rows;
}

/**
 * Turn a preset key into the TOTAL commitment a raise means.
 *
 * Clamped into the legal band rather than refused: a "pot" press when the pot is
 * larger than the stack should be an all in, not an error message about a number
 * the player never typed.
 */
export function resolveRaiseAmount(table: HoldemTable, userId: string, preset: string, potTotal: number): number {
	const raise = aggressiveActionFor(table, userId);
	if (!raise) return 0;
	const min = raise.min ?? 0;
	const max = raise.max ?? 0;

	const wanted =
		preset === "half" ? Math.floor(potTotal / 2) : preset === "pot" ? potTotal : min;
	return Math.max(min, Math.min(max, wanted));
}

export const seatedCount = (table: HoldemTable): number => livePlayers(table).length;
