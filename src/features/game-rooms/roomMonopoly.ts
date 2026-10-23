import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	StringSelectMenuBuilder,
	type ColorResolvable,
} from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOARD, BOARD_SIZE, JAIL_BAIL, describeTile, isOwnableTile, ownableTileName, type OwnableTile } from "@features/games/monopolyBoard.js";
import {
	listBuildOptions,
	listMortgageOptions,
	listUnmortgageOptions,
	unmortgageCost,
	type AuctionState,
	type MonopolySeat,
	type MonopolyState,
	type MortgageOption,
} from "@features/games/monopolyState.js";
import { renderBoard } from "@features/games/monopolyRenderer.js";
import { GAME_ROOM_PREFIX, GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
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
// How:   at most TWO rows: the turn row (whose widest form is jail's three) and the
//        any time row (Build, Trade, Inventory), well inside Discord's five per row
//        and the plan's four rows (risk M10). Mortgage controls live in the
//        private Inventory peek rather than on the shared board. The board is a
//        picture from monopolyRenderer when its art is on disk and the monospaced
//        token map when it is not; everything else in the embed is the same text.

// Tiles per line of the token map. Ten is one side of the board, so each line of
// the map is one side and the line labels (0, 10, 20, 30) are the four corners.
const MAP_TILES_PER_LINE = 10;

// ── the public board ──────────────────────────────────────────────────
/** The board message's embed plus the picture it shows, which the caller attaches to the SAME message. */
export interface MonopolyBoardMessage {
	embed: EmbedBuilder;
	// Null when the board is the text map: no art, no canvas library, or a render
	// that failed. Attach it to the message that carries `embed`, or the embed's
	// image ref has nothing to resolve against and Discord shows an empty slot.
	attachment: AttachmentBuilder | null;
}

/**
 * The board message's embed: whose turn, what they can do, the board (a rendered
 * picture, or the token map when there is none), the seats, and the last move.
 */
export async function monopolyBoardEmbed(state: MonopolyState): Promise<MonopolyBoardMessage> {
	const lastMove = state.log[state.log.length - 1]?.text ?? gameRoomsCopy.monopoly.noMovesYet;
	const picture = await renderBoard(state);

	// The picture REPLACES the token map rather than joining it, because the two
	// show the same positions. The seat lines stay either way: they name every
	// seat's tile in words, so nobody has to read the picture to play.
	const board = picture ? [] : ["", gameRoomsCopy.monopoly.boardMapLabel, tokenMap(state)];

	// The last move is the bottom line of the DESCRIPTION rather than the embed's
	// footer, for two reasons: a footer is plain text, so the mention every engine
	// line carries would render as raw digits, and the footer already holds the
	// Dero brand line that every embed shares.
	const description = [
		...statusLines(state),
		...board,
		"",
		state.seats.map((seat, index) => seatLine(state, seat, index)).join("\n"),
		"",
		`**${gameRoomsCopy.monopoly.lastMoveLabel}** ${lastMove}`,
	];

	const embed = infoEmbed(gameRoomsCopy.monopoly.boardTitle, description.join("\n"), COLORS.ARCADE as ColorResolvable);
	if (!picture) return { embed, attachment: null };
	return { embed: embed.setImage(picture.ref), attachment: picture.attachment };
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
		case "in-auction":
			return state.pendingAuction
				? gameRoomsCopy.monopoly.auctionPrompt(ownableTileName(state.pendingAuction.tileId), auctionClosesAt(state.pendingAuction))
				: gameRoomsCopy.monopoly.waitingPrompt;
		default:
			return gameRoomsCopy.monopoly.waitingPrompt;
	}
}

/**
 * When an auction round stops taking bids, in epoch milliseconds. One helper for
 * the board prompt, the opening notice, the bid modal and the closing sweep, so no
 * two of them can disagree about when a round ends (rule 17).
 */
export const auctionClosesAt = (auction: AuctionState): number => auction.roundOpenedAt + BOT_CONSTANTS.MONOPOLY_AUCTION_ROUND_MS;

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

// Every lot a seat owns, in board order, because that is the order the board
// itself reads in.
function lotsOwnedBy(state: MonopolyState, userId: string): OwnableTile[] {
	return BOARD.filter(isOwnableTile).filter((tile) => state.properties[tile.id]?.ownerId === userId);
}

// ── the private peek ──────────────────────────────────────────────────
// Discord's ceiling on options in one select. A seat can own 28 lots, so in that
// corner the last few wait for a second pick; the slice keeps the select from throwing.
const MAX_SELECT_OPTIONS = 25;

/** The Inventory reply: the holdings embed, plus the mortgage controls when there is anything to mortgage or lift. */
export interface MonopolyInventoryReply {
	embeds: EmbedBuilder[];
	components: ActionRowBuilder<StringSelectMenuBuilder>[];
}

/**
 * The Inventory reply for `viewerId`: their own chips, jail cards and every lot with
 * what is on it, and two selects, one for each lot they could mortgage now and one
 * for each mortgage they could lift now. Ephemeral at the call site. The selects
 * list the engine's own option lists, so they never offer a move the engine would
 * refuse; a finished match and a seat that is out get the embed alone.
 */
export function monopolyInventoryReply(state: MonopolyState, viewerId: string, roomId: string): MonopolyInventoryReply {
	const embed = monopolyInventoryEmbed(state, viewerId);
	const playing = state.phase !== "finished" && state.seats.some((seat) => seat.userId === viewerId && !seat.bankrupt);
	if (!playing) return { embeds: [embed], components: [] };

	const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
	const toMortgage = listMortgageOptions(state, viewerId);
	if (toMortgage.length > 0) {
		components.push(
			mortgageSelect(roomId, "mmortgage", gameRoomsCopy.monopoly.mortgagePlaceholder, toMortgage, gameRoomsCopy.monopoly.mortgageOptionLabel)
		);
	}
	const toLift = listUnmortgageOptions(state, viewerId);
	if (toLift.length > 0) {
		components.push(
			mortgageSelect(roomId, "munmortgage", gameRoomsCopy.monopoly.unmortgagePlaceholder, toLift, gameRoomsCopy.monopoly.unmortgageOptionLabel)
		);
	}
	if (components.length > 0) embed.setDescription(`${embed.data.description ?? ""}\n\n${gameRoomsCopy.monopoly.inventoryMortgageHint}`);
	return { embeds: [embed], components };
}

/**
 * The holdings embed alone: chips, jail cards, and each lot with its houses, hotel
 * or mortgage (and what lifting it costs). Nothing here is secret (the board shows
 * every balance), so this is a convenience for reading your own lots, not a
 * privacy surface.
 */
export function monopolyInventoryEmbed(state: MonopolyState, viewerId: string): EmbedBuilder {
	const seat = state.seats.find((candidate) => candidate.userId === viewerId);
	const color = COLORS.ARCADE as ColorResolvable;
	if (!seat) return infoEmbed(gameRoomsCopy.monopoly.inventoryTitle, gameRoomsCopy.monopoly.notSeated, color);
	if (seat.bankrupt) return infoEmbed(gameRoomsCopy.monopoly.inventoryTitle, gameRoomsCopy.monopoly.inventoryOut, color);

	const lots = lotsOwnedBy(state, viewerId);
	const lotLines = lots.length > 0 ? [gameRoomsCopy.monopoly.inventoryLotsHeader, ...lots.map((tile) => lotLine(state, tile))] : [gameRoomsCopy.monopoly.inventoryNoLots];
	return infoEmbed(
		gameRoomsCopy.monopoly.inventoryTitle,
		[gameRoomsCopy.monopoly.inventoryChips(seat.chips), gameRoomsCopy.monopoly.inventoryJailCards(seat.gojfCards), "", ...lotLines].join("\n"),
		color
	);
}

// One lot and what is on it. A lot with buildings cannot be mortgaged and a
// mortgaged one cannot be built on, so at most one of these applies at a time.
function lotLine(state: MonopolyState, tile: OwnableTile): string {
	const lot = state.properties[tile.id];
	const details: string[] = [];
	if (lot.hotel) details.push(gameRoomsCopy.monopoly.lotHotel);
	else if (lot.houses > 0) details.push(gameRoomsCopy.monopoly.lotHouses(lot.houses));
	if (lot.mortgaged) details.push(gameRoomsCopy.monopoly.lotMortgaged(unmortgageCost(tile)));
	return gameRoomsCopy.monopoly.inventoryLotLine(tile.name, details);
}

function mortgageSelect(
	roomId: string,
	action: "mmortgage" | "munmortgage",
	placeholder: string,
	options: MortgageOption[],
	label: (tileName: string, amount: number) => string
): ActionRowBuilder<StringSelectMenuBuilder> {
	const select = new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:${action}:${roomId}`)
		.setPlaceholder(placeholder)
		.addOptions(options.slice(0, MAX_SELECT_OPTIONS).map((option) => ({ label: label(option.name, option.amount), value: option.tileId })));
	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

// ── controls ──────────────────────────────────────────────────────────
/**
 * The board message's buttons for `viewerId`, in at most two rows: the turn row
 * (what the seat on the clock does next, or the bid button every seat shares
 * during an auction), then the any time row (Build for the seat on the clock when
 * it can build, Trade and Inventory for everyone). The board is ONE shared
 * message, so the room renders it for the seat on the clock. A finished match
 * gets no rows at all. Every button is still re-checked in its handler, because a
 * rendered button is a hint.
 */
export function monopolyControlsRow(state: MonopolyState, viewerId: string, roomId: string): ActionRowBuilder<ButtonBuilder>[] {
	if (state.phase === "finished") return [];

	const active = state.seats[state.activeSeatIndex];
	const turn = turnButtons(state, active, viewerId, roomId);
	const anyTime = anyTimeButtons(state, active, viewerId, roomId);
	return turn.length > 0 ? [row(...turn), row(...anyTime)] : [row(...anyTime)];
}

function turnButtons(state: MonopolyState, active: MonopolySeat, viewerId: string, roomId: string): ButtonBuilder[] {
	// The one turn control that is not the active seat's: every seat still playing
	// bids. The round's opening time rides the arg so a bid button from an earlier
	// auction cannot open the modal for a later one.
	if (state.phase === "in-auction" && state.pendingAuction) {
		const { tileId, roundOpenedAt } = state.pendingAuction;
		return [button(roomId, "mauction", gameRoomsCopy.monopoly.bidLabel(ownableTileName(tileId)), ButtonStyle.Primary, "🔨", String(roundOpenedAt))];
	}
	if (active.userId !== viewerId) return [];

	switch (state.phase) {
		case "pre-roll":
			return active.inJail ? jailButtons(active, roomId) : [rollButton(roomId)];
		case "awaiting-buy-or-skip":
			return buyOrSkipButtons(active, roomId);
		case "post-roll":
			return [button(roomId, "mend", gameRoomsCopy.monopoly.endTurnLabel, ButtonStyle.Primary, "✅")];
		default:
			// "in-trade" is never entered (a trade does not move the phase), so no
			// turn control is the honest row if it ever were.
			return [];
	}
}

// Build is offered only when the build would go through for at least one lot, from
// the same rule check the build runs (listBuildOptions), so the button and the
// action cannot disagree. Trade and Inventory are for any seat at any time.
function anyTimeButtons(state: MonopolyState, active: MonopolySeat, viewerId: string, roomId: string): ButtonBuilder[] {
	const buttons: ButtonBuilder[] = [];
	if (active.userId === viewerId && listBuildOptions(state, viewerId).length > 0) {
		buttons.push(button(roomId, "mbuild", gameRoomsCopy.monopoly.buildLabel, ButtonStyle.Success, "🏗️"));
	}
	const tradeLabel = state.pendingTrade ? gameRoomsCopy.monopoly.tradeOpenLabel : gameRoomsCopy.monopoly.tradeLabel;
	buttons.push(button(roomId, "mtrade", tradeLabel, ButtonStyle.Secondary, "🤝"));
	buttons.push(button(roomId, "minventory", gameRoomsCopy.monopoly.inventoryLabel, ButtonStyle.Secondary, "🎒"));
	return buttons;
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
