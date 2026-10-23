import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ColorResolvable } from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { BOARD, BOARD_SIZE, JAIL_BAIL, describeTile, isOwnableTile, ownableTileName } from "@features/games/monopolyBoard.js";
import type { MonopolySeat, MonopolyState } from "@features/games/monopolyState.js";
import { GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── roomMonopoly ─────────────────────────────────────────────────────
// What:  how a Monopoly match looks in Discord, and what its controls are: the
//        public board embed, the one context sensitive row of buttons, and the
//        private holdings peek.
// Who:   RoomProvisioner (the first board), roomMonopolyHandlers (every redraw and
//        the Inventory reply) and the idle sweep in roomTurnSweep.
// When:  redrawn after every move that lands.
// Where: pure rendering over the engine's MonopolyState. Nothing here reads the
//        row or calls the engine's actions; it does not decide what is legal, it
//        only declines to offer what plainly is not (the engine still refuses).
// How:   ONE row, because the active seat never has more than four things it can
//        do in Phase 4 (the jail row is the widest), well inside Discord's five per
//        row. Build, trade, mortgage and auction controls are Phase 5 and are
//        deliberately absent, rather than rendered disabled.

// Tiles per line of the token map. Ten is one side of the board, so each line of
// the map is one side and the line labels (0, 10, 20, 30) are the four corners.
const MAP_TILES_PER_LINE = 10;

// ── the public board ──────────────────────────────────────────────────
/** The board message's embed: whose turn, what they can do, the token map, the seats, and the last move. */
export function monopolyBoardEmbed(state: MonopolyState): EmbedBuilder {
	const lastMove = state.log[state.log.length - 1]?.text ?? gameRoomsCopy.monopoly.noMovesYet;

	// The last move is the bottom line of the DESCRIPTION rather than the embed's
	// footer, for two reasons: a footer is plain text, so the mention every engine
	// line carries would render as raw digits, and the footer already holds the
	// Dero brand line that every embed shares.
	const description = [
		...statusLines(state),
		"",
		gameRoomsCopy.monopoly.boardMapLabel,
		tokenMap(state),
		"",
		state.seats.map((seat, index) => seatLine(state, seat, index)).join("\n"),
		"",
		`**${gameRoomsCopy.monopoly.lastMoveLabel}** ${lastMove}`,
	];

	return infoEmbed(gameRoomsCopy.monopoly.boardTitle, description.join("\n"), COLORS.ARCADE as ColorResolvable);
}

// Who is on the clock and what they can do, or who won.
function statusLines(state: MonopolyState): string[] {
	if (state.phase === "finished") return [gameRoomsCopy.monopoly.finishedLine(state.winnerId)];
	const active = state.seats[state.activeSeatIndex];
	return [gameRoomsCopy.monopoly.onTheClock(active.userId), turnPrompt(state, active)];
}

function turnPrompt(state: MonopolyState, active: MonopolySeat): string {
	switch (state.phase) {
		case "pre-roll":
			return active.inJail ? gameRoomsCopy.monopoly.jailPrompt : gameRoomsCopy.monopoly.rollPrompt;
		case "awaiting-buy-or-skip": {
			const tile = BOARD[active.position];
			// The awaiting phase is only ever set on an ownable lot; the guard narrows
			// the type for the price rather than handling a real case.
			if (!isOwnableTile(tile)) return gameRoomsCopy.monopoly.waitingPrompt;
			return gameRoomsCopy.monopoly.buyPrompt(tile.name, tile.price);
		}
		case "post-roll":
			return gameRoomsCopy.monopoly.endTurnPrompt;
		default:
			return gameRoomsCopy.monopoly.waitingPrompt;
	}
}

// A monospaced map of the 40 tiles, one board side per line. Seat numbers rather
// than emoji tokens, because an emoji renders wider than a monospaced cell in a
// code block and shears every column after it out of line.
function tokenMap(state: MonopolyState): string {
	const lines: string[] = [];
	for (let start = 0; start < BOARD_SIZE; start += MAP_TILES_PER_LINE) {
		const cells: string[] = [];
		for (let tile = start; tile < start + MAP_TILES_PER_LINE; tile++) cells.push(tokenCell(state, tile));
		lines.push(`${String(start).padStart(2, " ")}  ${cells.join(" ")}`);
	}
	return ["```", ...lines, "```"].join("\n");
}

// One cell: "·" for an empty tile, the seat number when one token stands there,
// "+" when two or more do (the seat list says exactly who).
function tokenCell(state: MonopolyState, tile: number): string {
	const here = state.seats
		.map((seat, index) => ({ seat, number: index + 1 }))
		.filter(({ seat }) => !seat.bankrupt && seat.position === tile);
	if (here.length === 0) return "·";
	if (here.length > 1) return "+";
	return String(here[0].number);
}

function seatLine(state: MonopolyState, seat: MonopolySeat, index: number): string {
	const marker = seatMarker(state, seat, index);
	const line = gameRoomsCopy.monopoly.seatLine(
		index + 1,
		seat.userId,
		seat.chips,
		lotsOwnedBy(state, seat.userId).length,
		describeTile(BOARD[seat.position])
	);
	if (seat.bankrupt) return `${marker} ${line} (${gameRoomsCopy.monopoly.outTag})`;
	if (seat.inJail) return `${marker} ${line} (${gameRoomsCopy.monopoly.inJailTag})`;
	return `${marker} ${line}`;
}

function seatMarker(state: MonopolyState, seat: MonopolySeat, index: number): string {
	if (seat.bankrupt) return "💀";
	if (state.phase !== "finished" && index === state.activeSeatIndex) return "▶️";
	return "•";
}

// The ids of every lot a seat owns, in board order, because that is the order
// the board itself reads in.
function lotsOwnedBy(state: MonopolyState, userId: string): string[] {
	return BOARD.filter(isOwnableTile)
		.filter((tile) => state.properties[tile.id]?.ownerId === userId)
		.map((tile) => tile.id);
}

// ── the private peek ──────────────────────────────────────────────────
/**
 * The Inventory reply: the viewer's OWN chips, lots and jail cards. Ephemeral at
 * the call site. Nothing here is secret (the board shows every balance), so this
 * is a convenience for reading your own lots by name, not a privacy surface.
 */
export function monopolyInventoryEmbed(state: MonopolyState, viewerId: string): EmbedBuilder {
	const seat = state.seats.find((candidate) => candidate.userId === viewerId);
	const color = COLORS.ARCADE as ColorResolvable;
	if (!seat) return infoEmbed(gameRoomsCopy.monopoly.inventoryTitle, gameRoomsCopy.monopoly.notSeated, color);
	if (seat.bankrupt) return infoEmbed(gameRoomsCopy.monopoly.inventoryTitle, gameRoomsCopy.monopoly.inventoryOut, color);

	const lotNames = lotsOwnedBy(state, viewerId).map(ownableTileName);
	return infoEmbed(
		gameRoomsCopy.monopoly.inventoryTitle,
		[
			gameRoomsCopy.monopoly.inventoryChips(seat.chips),
			gameRoomsCopy.monopoly.inventoryJailCards(seat.gojfCards),
			gameRoomsCopy.monopoly.inventoryLots(lotNames),
		].join("\n"),
		color
	);
}

// ── controls ──────────────────────────────────────────────────────────
/**
 * The board message's buttons for `viewerId`. The board is ONE shared message, so
 * the room renders it for the seat on the clock; a viewer who is not that seat
 * gets Inventory only, and a finished match gets no row at all. Every button is
 * still re-checked in its handler, because a rendered button is a hint.
 */
export function monopolyControlsRow(state: MonopolyState, viewerId: string, roomId: string): ActionRowBuilder<ButtonBuilder>[] {
	if (state.phase === "finished") return [];

	const inventory = button(roomId, "minventory", gameRoomsCopy.monopoly.inventoryLabel, ButtonStyle.Secondary, "🎒");
	const active = state.seats[state.activeSeatIndex];
	if (active.userId !== viewerId) return [row(inventory)];

	switch (state.phase) {
		case "pre-roll":
			return active.inJail ? [row(...jailButtons(active, roomId), inventory)] : [row(rollButton(roomId), inventory)];
		case "awaiting-buy-or-skip":
			return [row(...buyOrSkipButtons(active, roomId), inventory)];
		case "post-roll":
			return [row(button(roomId, "mend", gameRoomsCopy.monopoly.endTurnLabel, ButtonStyle.Primary, "✅"), inventory)];
		default:
			// "in-auction" and "in-trade" have no Phase 4 control. Neither is
			// reachable yet (every Phase 4 match opens with auctions off and nothing
			// opens a trade), so Inventory alone is the honest row if one ever is.
			return [row(inventory)];
	}
}

const rollButton = (roomId: string): ButtonBuilder =>
	button(roomId, "mroll", gameRoomsCopy.monopoly.rollLabel, ButtonStyle.Primary, "🎲");

// Disabled rather than hidden where the seat plainly cannot afford it or holds
// no card: the engine would refuse either press, and a greyed button says why
// nothing would happen before the player tries.
function jailButtons(active: MonopolySeat, roomId: string): ButtonBuilder[] {
	return [
		button(roomId, "mjail", gameRoomsCopy.monopoly.bailLabel(JAIL_BAIL), ButtonStyle.Primary, "💵", "bail").setDisabled(
			active.chips < JAIL_BAIL
		),
		button(roomId, "mjail", gameRoomsCopy.monopoly.useCardLabel, ButtonStyle.Secondary, "🎟️", "card").setDisabled(
			active.gojfCards < 1
		),
		button(roomId, "mjail", gameRoomsCopy.monopoly.jailRollLabel, ButtonStyle.Secondary, "🎲", "roll"),
	];
}

function buyOrSkipButtons(active: MonopolySeat, roomId: string): ButtonBuilder[] {
	const tile = BOARD[active.position];
	const skip = button(roomId, "mskip", gameRoomsCopy.monopoly.skipLabel, ButtonStyle.Secondary, "⏭️");
	// Same narrowing as turnPrompt: the phase is only set on an ownable lot.
	if (!isOwnableTile(tile)) return [skip];
	const buy = button(roomId, "mbuy", gameRoomsCopy.monopoly.buyLabel(tile.name, tile.price), ButtonStyle.Success, "🏠", tile.id);
	return [buy.setDisabled(active.chips < tile.price), skip];
}

// customId shape `gameroom:<action>:<roomId>[:<arg>]`, parsed by parseGameRoomCustomId.
function button(roomId: string, action: string, label: string, style: ButtonStyle, emoji: string, arg?: string): ButtonBuilder {
	const customId = arg ? `${GAME_ROOM_PREFIX}:${action}:${roomId}:${arg}` : `${GAME_ROOM_PREFIX}:${action}:${roomId}`;
	return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setEmoji(emoji);
}

const row = (...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> =>
	new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
