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
import { BOARD, BOARD_SIZE, describeTile, isOwnableTile, ownableTileName, type OwnableTile } from "@features/games/monopolyBoard.js";
import {
	BANK_CREDITOR,
	listBuildOptions,
	listMortgageOptions,
	listSellOptions,
	listUnmortgageOptions,
	unmortgageCost,
	waitingDebt,
	type AuctionState,
	type MonopolySeat,
	type MonopolyState,
} from "@features/games/monopolyState.js";
import { renderBoard } from "@features/games/monopolyRenderer.js";
import type { ResolvedGameAsset } from "@features/games/gamesAssets.js";
import { GAME_ROOM_PREFIX, GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isBotSeatId, labelBotMentions } from "./botSeat.js";
import { turnBlockLines } from "./turnLog.js";

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
// How:   at most TWO rows on the board, and only what the turn line does not carry
//        (2026-10 item 263 R3-22): Build and Pay a debt, plus, while a Dero bot is on the
//        clock and so no turn line exists, Bid, Trade, Inventory and Surrender. Mortgage
//        controls live in the private Inventory peek rather than on the shared board. The board is a
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
 * picture, or the token map when there is none), the seats, and the turn so far.
 * `names` labels each token on the picture (roomMonopolyBoard.seatNamesForBoard).
 */
export async function monopolyBoardEmbed(state: MonopolyState, names: ReadonlyMap<string, string> = new Map()): Promise<MonopolyBoardMessage> {
	return monopolyBoardEmbedWith(state, await renderBoard(state, Date.now(), names));
}

/**
 * The board message's embed around a picture already drawn, or the token map when
 * `picture` is null. For a redraw that drew its picture behind the drawing pause.
 */
export function monopolyBoardEmbedWith(state: MonopolyState, picture: ResolvedGameAsset | null): MonopolyBoardMessage {
	// The picture REPLACES the token map rather than joining it, because the two
	// show the same positions. The seat lines stay either way: they name every
	// seat's tile in words, so nobody has to read the picture to play.
	const board = picture ? [] : ["", gameRoomsCopy.monopoly.boardMapLabel, tokenMap(state)];

	// The turn's lines are the bottom of the DESCRIPTION rather than the embed's
	// footer, for two reasons: a footer is plain text, so the mention every engine
	// line carries would render as raw digits, and the footer already holds the
	// Dero brand line that every embed shares.
	const description = [
		...statusLines(state),
		...board,
		"",
		state.seats.map((seat, index) => seatLine(state, seat, index)).join("\n"),
		"",
		...moveLines(state),
	];

	// Dero bot seats (2026-10 item 250 Phase 5) are named rather than mentioned.
	const embed = infoEmbed(gameRoomsCopy.monopoly.boardTitle, labelBotMentions(description.join("\n")), COLORS.ARCADE as ColorResolvable);
	if (!picture) return { embed, attachment: null };
	return { embed: embed.setImage(picture.ref), attachment: picture.attachment };
}

// The board carries the turn on the clock as it happens (2026-10 item 254, Arcade 8): its
// This turn block (turnLog.turnBlockLines, the block every game's board shares since item 263
// R3-29), and the board stays in the room once the turn passes, so its block is that turn's
// log. A state from before the turn log, or a turn with no line yet, shows the last move as
// the board always did.
function moveLines(state: MonopolyState): string[] {
	const turnLog = state.turnLog ?? [];
	if (turnLog.length > 0) return turnBlockLines(turnLog);
	const lastMove = state.log[state.log.length - 1]?.text ?? gameRoomsCopy.monopoly.noMovesYet;
	return [`**${gameRoomsCopy.monopoly.lastMoveLabel}** ${lastMove}`];
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
		case "awaiting-debt":
			return debtPrompt(state);
		default:
			return gameRoomsCopy.monopoly.waitingPrompt;
	}
}

// Who owes what to whom, and how far short they are, while the match waits on a debt.
function debtPrompt(state: MonopolyState): string {
	const debt = waitingDebt(state);
	const debtor = debt ? state.seats.find((seat) => seat.userId === debt.debtorId) : undefined;
	if (!debt || !debtor) return gameRoomsCopy.monopoly.waitingPrompt;
	return gameRoomsCopy.monopoly.debtPrompt(debt.debtorId, creditorLabel(debt.creditorId), debt.amount, debtor.chips);
}

// A debt's payee as the copy names it: a mention for a player, "the bank" otherwise.
const creditorLabel = (creditorId: string): string =>
	creditorId === BANK_CREDITOR ? gameRoomsCopy.monopoly.bankCreditor : `<@${creditorId}>`;

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

/** The Inventory reply: the holdings embed, plus the controls for anything there is to mortgage, lift or sell. */
export interface MonopolyInventoryReply {
	embeds: EmbedBuilder[];
	components: ActionRowBuilder<StringSelectMenuBuilder>[];
}

// One select option: what the player reads, and the tile id the handler gets.
type HoldingsOption = { label: string; value: string };

/**
 * The Inventory reply for `viewerId`: their own chips, jail cards and every lot with
 * what is on it, and up to three selects: each lot they could mortgage now, each
 * mortgage they could lift now, and each building they could sell back now. These
 * are also how a seat raises cash for a held debt, so a debtor's own peek opens with
 * what they owe and how far short they are. Ephemeral at the call site. The selects
 * list the engine's own option lists, so they never offer a move the engine would
 * refuse; a finished match and a seat that is out get the embed alone.
 */
export function monopolyInventoryReply(state: MonopolyState, viewerId: string, roomId: string): MonopolyInventoryReply {
	const embed = monopolyInventoryEmbed(state, viewerId);
	const seat = state.seats.find((candidate) => candidate.userId === viewerId && !candidate.bankrupt);
	if (state.phase === "finished" || !seat) return { embeds: [embed], components: [] };

	const mortgage = listMortgageOptions(state, viewerId).map((option) => ({
		label: gameRoomsCopy.monopoly.mortgageOptionLabel(option.name, option.amount),
		value: option.tileId,
	}));
	const lift = listUnmortgageOptions(state, viewerId).map((option) => ({
		label: gameRoomsCopy.monopoly.unmortgageOptionLabel(option.name, option.amount),
		value: option.tileId,
	}));
	const sell = listSellOptions(state, viewerId).map((option) => ({
		label: gameRoomsCopy.monopoly.sellOptionLabel(option.name, option.kind, option.amount),
		value: option.tileId,
	}));
	const components = [
		holdingsSelect(roomId, "mmortgage", gameRoomsCopy.monopoly.mortgagePlaceholder, mortgage),
		holdingsSelect(roomId, "munmortgage", gameRoomsCopy.monopoly.unmortgagePlaceholder, lift),
		holdingsSelect(roomId, "msell", gameRoomsCopy.monopoly.sellPlaceholder, sell),
	].filter((select): select is ActionRowBuilder<StringSelectMenuBuilder> => select !== null);

	const debt = waitingDebt(state);
	const owes = debt?.debtorId === viewerId ? debt : null;
	const description = [
		...(owes ? [gameRoomsCopy.monopoly.inventoryDebtLine(owes.amount, creditorLabel(owes.creditorId), Math.max(0, owes.amount - seat.chips)), ""] : []),
		embed.data.description ?? "",
		...(components.length > 0 ? ["", gameRoomsCopy.monopoly.inventoryMortgageHint] : []),
	];
	return { embeds: [embed.setDescription(description.join("\n"))], components };
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

// One of the peek's selects, or null when it would have no options: a select
// needs at least one, and an empty one would only be a control that does nothing.
function holdingsSelect(
	roomId: string,
	action: "mmortgage" | "munmortgage" | "msell",
	placeholder: string,
	options: HoldingsOption[]
): ActionRowBuilder<StringSelectMenuBuilder> | null {
	if (options.length === 0) return null;
	const select = new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:${action}:${roomId}`)
		.setPlaceholder(placeholder)
		.addOptions(options.slice(0, MAX_SELECT_OPTIONS));
	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

// ── controls ──────────────────────────────────────────────────────────
/**
 * The board message's buttons, rendered for `viewerId`, the seat on the clock (the board is ONE
 * shared message). While a member is on the clock the board carries NO buttons: the turn's moves
 * are buttons on the turn line, and Bid, Pay a debt, Build, Trade, Inventory and Surrender ride
 * the line beside them (monopolyPromptButtons), so no button is on both. A finished match gets
 * no rows. Every button is still
 * re-checked in its handler, because a rendered button is a hint, and every route a removed
 * button used stays registered, so a board posted before this change still works.
 *
 * ⚠️ A DERO BOT ON THE CLOCK GETS NO TURN LINE (turnPrompt.syncTurnPrompt skips a bot seat), and
 * that is the one time a Monopoly table runs without one: a Monopoly room is never a network
 * table. So while a bot is on the clock the board keeps what a member would otherwise have
 * nowhere to press: Bid in an auction, Trade, Inventory and Surrender (owner decision 3).
 */
export function monopolyControlsRow(state: MonopolyState, viewerId: string, roomId: string): ActionRowBuilder<ButtonBuilder>[] {
	if (state.phase === "finished") return [];

	const active = state.seats[state.activeSeatIndex];
	// A member on the clock has every one of these on the turn line (monopolyPromptButtons, owner
	// decision of 2026-10-29: the game card keeps none of the line's buttons), so the board is bare.
	if (!isBotSeatId(active.userId)) return [];
	const turn = [...bidButtons(state, roomId), ...debtButtons(state, roomId)];
	const anyTime = [...buildButtons(state, active, viewerId, roomId), ...lineButtons(state, roomId)];
	return [turn, anyTime].filter((buttons) => buttons.length > 0).map((buttons) => row(...buttons));
}

/**
 * The buttons that ride the turn prompt line beside the turn's moves (2026-10 item 257 Phase 4a,
 * item 263 R3-22): Bid while an auction is open, Pay a debt while one waits, Build for the seat on
 * the clock when a build would go through, then Trade, Inventory and Surrender. Bid and Trade open their own modal,
 * which cannot open from the turn modal's Submit (risk R6), so they stay buttons. Built with the
 * same helpers and labels as the board's bot turn rows, so a prompt and a board cannot disagree.
 */
export function monopolyPromptButtons(state: MonopolyState, roomId: string): ButtonBuilder[] {
	const active = state.seats[state.activeSeatIndex];
	const build = active ? buildButtons(state, active, active.userId, roomId) : [];
	return [...bidButtons(state, roomId), ...debtButtons(state, roomId), ...build, ...lineButtons(state, roomId)];
}

// Bid, while an auction is open: every seat still playing bids, not only the seat on the clock.
// The round's opening time rides the arg so a bid button from an earlier auction cannot open the
// modal for a later one.
function bidButtons(state: MonopolyState, roomId: string): ButtonBuilder[] {
	if (state.phase !== "in-auction" || !state.pendingAuction) return [];
	const { tileId, roundOpenedAt } = state.pendingAuction;
	return [button(roomId, "mauction", gameRoomsCopy.monopoly.bidLabel(ownableTileName(tileId)), ButtonStyle.Primary, "🔨", String(roundOpenedAt))];
}

// Pay a debt, shown to every seat while the match waits on one, because the debtor may not be
// the seat on the clock and the turn line pings only that seat. The prompt above names who owes,
// and the engine refuses anyone else. Never greyed out: a debtor who can no longer cover the
// debt settles it by pressing Pay too (the engine then declares the bankruptcy).
function debtButtons(state: MonopolyState, roomId: string): ButtonBuilder[] {
	const debt = waitingDebt(state);
	return debt ? [button(roomId, "mpaydebt", gameRoomsCopy.monopoly.payDebtLabel(debt.amount), ButtonStyle.Danger, "💸")] : [];
}

// Build, for the seat on the clock and only when the build would go through for at least one
// lot, from the same rule check the build runs (listBuildOptions), so the button and the action
// cannot disagree. Never for a Dero bot on the clock: nobody can press it for the bot.
function buildButtons(state: MonopolyState, active: MonopolySeat, viewerId: string, roomId: string): ButtonBuilder[] {
	if (active.userId !== viewerId || isBotSeatId(active.userId) || listBuildOptions(state, viewerId).length === 0) return [];
	return [button(roomId, "mbuild", gameRoomsCopy.monopoly.buildLabel, ButtonStyle.Success, "🏗️")];
}

// Trade, Inventory and Surrender, for any seat at any time. Surrender (2026-10 item 254, Arcade
// 12) only opens a private confirm, so a slip costs nothing.
function lineButtons(state: MonopolyState, roomId: string): ButtonBuilder[] {
	const tradeLabel = state.pendingTrade ? gameRoomsCopy.monopoly.tradeOpenLabel : gameRoomsCopy.monopoly.tradeLabel;
	return [
		button(roomId, "mtrade", tradeLabel, ButtonStyle.Secondary, "🤝"),
		button(roomId, "minventory", gameRoomsCopy.monopoly.inventoryLabel, ButtonStyle.Secondary, "🎒"),
		button(roomId, "msurrender", gameRoomsCopy.monopoly.surrenderLabel, ButtonStyle.Danger, "🏳️"),
	];
}

// customId shape `gameroom:<action>:<roomId>[:<arg>]`, parsed by parseGameRoomCustomId.
function button(roomId: string, action: string, label: string, style: ButtonStyle, emoji: string, arg?: string): ButtonBuilder {
	const customId = arg ? `${GAME_ROOM_PREFIX}:${action}:${roomId}:${arg}` : `${GAME_ROOM_PREFIX}:${action}:${roomId}`;
	return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setEmoji(emoji);
}

const row = (...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> =>
	new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
