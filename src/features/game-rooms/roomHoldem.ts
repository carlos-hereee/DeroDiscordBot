import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ColorResolvable } from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { formatCard } from "@features/games/holdemHand.js";
import {
	whoActs,
	actionsFor,
	hasLateSeatFree,
	livePlayers,
	seatCapOf,
	startingStackOf,
	type HoldemTable,
} from "@features/games/holdemTable.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// The host controls' words read the same in every pack (both packs share this
// object), so the default pack is the right one here without a config read on
// every redraw of every table.
const hostWords = rokCommanderCopy.arcadeHostControls;

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
//        beside Leave table, End table and, while a seat sits out, I'm back. A
//        running tournament adds a fourth, the host's seat row (Take a seat, Open
//        or Close seats, Requests), when the redraw passes the room's host state.

// ── the public table ──────────────────────────────────────────────────
/**
 * The table as text: the header, the clock line when the redraw passes one (whose
 * turn and when it runs out, or when the next hand deals), the board, the pot and
 * every seat. The live card goes in its image slot when it draws.
 */
export function tableEmbed(table: HoldemTable, potTotal: number, clockLine: string | null = null): EmbedBuilder {
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
			const away = !seat.out && seat.sittingOut ? `, ${gameRoomsCopy.holdem.sittingOutTag}` : "";
			// Parentheses rather than a dash: house rule 1 bans em dashes in anything a
			// member reads, and this line renders on every redraw of every table.
			return `${marker} <@${seat.userId}> (${state}${away})`;
		})
		.join("\n");

	const header =
		table.status === "joining"
			? joiningHeader(table)
			: table.status === "finished"
			  ? gameRoomsCopy.holdem.finishedLine(table.winnerId)
			  : gameRoomsCopy.holdem.handLine(table.handNumber, table.smallBlind, table.bigBlind);

	// Late seats waiting for the deal are named under the seats, not among them: they
	// hold no chips and no cards yet, and listing them as seats would read as though
	// they were in this hand (2026-10 item 244 Phase 4).
	const waiting = (table.pendingSeats ?? []).map((entry) => entry.userId);
	const waitingLines = waiting.length > 0 && table.status === "playing" ? ["", hostWords.seats.waitingLine(waiting)] : [];

	const lines = [
		header,
		...(clockLine ? [clockLine] : []),
		"",
		`**${gameRoomsCopy.holdem.boardLabel}** ${board}`,
		`**${gameRoomsCopy.holdem.potLabel}** ${potTotal}`,
		"",
		seats,
		...waitingLines,
	];
	return infoEmbed(gameRoomsCopy.holdem.tableTitle, lines.join("\n"), COLORS.ARCADE as ColorResolvable);
}

// ── the host's seat controls (2026-10 item 244 Phase 4) ───────────────
/** What the table's rows show of the room's host controls, read off the room row. */
export interface TableHostState {
	seatsOpen: boolean;
	// The Requests button shows while the host approves joiners or anybody still waits.
	showRequests: boolean;
	pendingJoinCount: number;
}

/** The host control state a room row carries. An older row reads as seats closed and no approval. */
export function tableHostStateOf(room: Pick<IGameRoom, "seatsOpen" | "requireApproval" | "pendingJoinIds">): TableHostState {
	const pendingJoinCount = (room.pendingJoinIds ?? []).length;
	return { seatsOpen: room.seatsOpen ?? false, showRequests: (room.requireApproval ?? false) || pendingJoinCount > 0, pendingJoinCount };
}

function requestsButton(roomId: string, host: TableHostState): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(`${GAME_ROOM_PREFIX}:requests:${roomId}`)
		.setLabel(hostWords.approval.requestsLabel(host.pendingJoinCount))
		.setEmoji("📨")
		.setStyle(ButtonStyle.Secondary);
}

// The row a running tournament adds under its controls: Take a seat while the host
// has seats open, the host's own Open seats or Close seats, and the Requests button.
// A row of its own because the between hands row is already at Discord's five, and
// Take a seat has to sit on the board a late joiner is looking at.
//
// The toggle's arg is the value the press SETS, like the Monopoly draft toggles, so a
// press on a stale board does what its label said rather than flipping the other way.
// Take a seat reuses `hjoin`, the Buy in action: both are a member asking for a seat,
// and one handler deciding both keeps the host's gate on one path.
function seatRow(roomId: string, table: HoldemTable, host: TableHostState): ActionRowBuilder<ButtonBuilder> {
	const buttons: ButtonBuilder[] = [];
	if (host.seatsOpen) {
		buttons.push(
			new ButtonBuilder()
				.setCustomId(`${GAME_ROOM_PREFIX}:hjoin:${roomId}`)
				.setLabel(hostWords.seats.takeLabel)
				.setEmoji("🪑")
				.setStyle(ButtonStyle.Success)
				.setDisabled(!hasLateSeatFree(table))
		);
	}
	buttons.push(
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:hseats:${roomId}:${host.seatsOpen ? "off" : "on"}`)
			.setLabel(host.seatsOpen ? hostWords.seats.closeLabel : hostWords.seats.openLabel)
			.setStyle(ButtonStyle.Secondary)
	);
	if (host.showRequests) buttons.push(requestsButton(roomId, host));
	return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
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
//
// I'm back joins them once the game starts while any seat sits out. Discord cannot
// show a button to one member only, so it is on the shared board for everybody, and
// the handler refuses anybody who is not sitting out.
function tableExitButtons(roomId: string, table?: HoldemTable): ButtonBuilder[] {
	const anySittingOut = table?.seats.some((seat) => seat.sittingOut && !seat.out) ?? false;
	const imBack = anySittingOut
		? [
				new ButtonBuilder()
					.setCustomId(`${GAME_ROOM_PREFIX}:hback:${roomId}`)
					.setLabel(gameRoomsCopy.holdem.imBackLabel)
					.setEmoji("👋")
					.setStyle(ButtonStyle.Success),
		  ]
		: [];
	return [
		...imBack,
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
// `host` is the room's host controls (tableHostStateOf); while the host approves
// joiners the Requests button joins the row, its fifth and last slot.
export function joiningRows(roomId: string, seatCount: number, table?: HoldemTable, host?: TableHostState): ActionRowBuilder<ButtonBuilder>[] {
	const stack = table ? startingStackOf(table) : BOT_CONSTANTS.HOLDEM_STARTING_STACK;
	const seatCap = table ? seatCapOf(table) : BOT_CONSTANTS.HOLDEM_MAX_SEATS;
	const requests = host?.showRequests ? [requestsButton(roomId, host)] : [];
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
			...tableExitButtons(roomId),
			...requests
		),
	];
}

// The controls BETWEEN hands: the tournament is still running, the last hand has
// settled, and the next one deals itself after HOLDEM_NEXT_HAND_DELAY_MS unless the
// host deals it sooner.
//
// ⚠️ THE DEAL CONTROL HAS TO COME BACK, and rendering it only in `joiningRows` is
// exactly why a tournament used to dead end after hand one. `redraw` edits ONE board
// message, so the joining row that carried `hstart` was replaced the instant the
// first hand was dealt, leaving no surface anywhere that could start hand two: the
// table sat on disabled buttons, the clock skipped it because nobody was to act, and
// the row held its host's one-room slot until somebody archived it by hand.
export function betweenHandsRows(roomId: string, table?: HoldemTable, host?: TableHostState): ActionRowBuilder<ButtonBuilder>[] {
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
			...tableExitButtons(roomId, table)
		),
		...(table && host ? [seatRow(roomId, table, host)] : []),
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
// clock is 60 seconds. The presets below are why a modal is not needed: they cover
// the sizes players actually use, and all in covers the rest.
export function bettingRows(table: HoldemTable, roomId: string, potTotal: number, host?: TableHostState): ActionRowBuilder<ButtonBuilder>[] {
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
		// near-identical numbers is harder to read under a 60 second clock than two.
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
			...tableExitButtons(roomId, table)
		)
	);
	// Four rows at most with the presets showing, inside Discord's five.
	if (host) rows.push(seatRow(roomId, table, host));

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
