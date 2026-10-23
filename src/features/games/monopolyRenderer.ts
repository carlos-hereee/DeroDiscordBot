import { AttachmentBuilder, type ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import { canvasModule, type CanvasModule, type Image, type SKRSContext2D } from "@features/renderer/canvasModule.js";
import { canvasColor, drawCardBackground, drawPanel, drawPill, drawText, renderCard, type RenderPayload } from "@features/renderer/index.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { BOARD, BOARD_SIZE, MAX_SEATS, findOwnableTile, ownableTileName, type ColorGroup, type TileId } from "./monopolyBoard.js";
import type { AuctionState, MonopolyState, TradeProposal } from "./monopolyState.js";
import { GAME_ASSET_FILES, gameAssetPath, missingGameAssets, type GameAssetKey, type ResolvedGameAsset } from "./gamesAssets.js";

// ── monopolyRenderer ─────────────────────────────────────────────────
// What:  draws the Monopoly board as one PNG: the owner's board art with every
//        seat still in the match standing on its tile, houses and hotels on
//        built lots, and the jail stamp over a jailed token.
// Who:   roomMonopoly.monopolyBoardEmbed, on the first board post and every
//        redraw; main.ts calls logMonopolyRendererStatus once at boot.
// When:  once per board redraw, which is once per landed move. The art is
//        decoded once per process and reused; only the composite is new.
// Where: a progressive enhancement over the text token map, never a
//        requirement. When the canvas library did not load, or any art the
//        composite needs is missing, renderBoard answers null and the embed
//        keeps its text board, so the game plays the same either way.
// How:   ① paint board-base.png, ② draw each built lot's houses or hotel along
//        the tile edge facing the middle of the board, ③ draw each seat's token
//        in that seat's fixed slot on its tile, then the jail stamp over it,
//        ④ encode a PNG and hand back an attachment plus the ref an embed's
//        setImage points at.
//
// The three cards (2026-10 item 243 Phase 3) are a separate drawing on the shared
// card pipeline rather than on the board art: the trade card on the private offer
// review, the auction card on a bidder's sealed bid confirmation, and the winner
// card on the room's result. See "the cards" at the end of this file.
//
// ⚠️ THE CANVAS LIBRARY COMES FROM THE SHARED LOADER, NEVER A STATIC IMPORT.
// features/renderer/canvasModule.ts loads @napi-rs/canvas with a caught dynamic
// import and answers null when the native binary is missing, so a host without
// it loses the board picture and nothing else. Its header explains the trap.

type Point = readonly [number, number];

// ── board geometry ────────────────────────────────────────────────────
// The width and height of board-base.png in its own pixels. BOARD_PIXEL_COORDS
// and every size below were measured against this, and all of them are scaled by
// the real width over this at draw time, so a re-export of the SAME layout at
// another size still lines up. New art with a different layout needs the
// coordinates measured again; nothing can infer where a tile was drawn.
const BOARD_ART_SIZE = 1254;

/**
 * The pixel centre of each of the 40 tiles on board-base.png, indexed by board
 * position. Measured from the gutters between tiles in the owner's art, which
 * are not evenly spaced (some lots are drawn wider than others), so a computed
 * grid would put tokens on the wrong square.
 */
export const BOARD_PIXEL_COORDS: readonly Point[] = [
	// Bottom row, GO (lower right) leftward to the last lot before Jail.
	[1152, 1140], [1001, 1140], [880, 1140], [757, 1140], [640, 1140],
	[550, 1140], [467, 1140], [383, 1140], [300, 1140], [219, 1140],
	// Left column, Jail (lower left) upward to the last lot before Free Parking.
	[98, 1140], [98, 1007], [98, 909], [98, 812], [98, 719],
	[98, 625], [98, 533], [98, 427], [98, 322], [98, 233],
	// Top row, Free Parking (upper left) rightward to the last lot before Go To Jail.
	[98, 104], [224, 104], [313, 104], [404, 104], [509, 104],
	[619, 104], [719, 104], [812, 104], [911, 104], [1015, 104],
	// Right column, Go To Jail (upper right) downward to the last lot before GO.
	[1152, 104], [1152, 233], [1152, 322], [1152, 427], [1152, 533],
	[1152, 625], [1152, 724], [1152, 820], [1152, 913], [1152, 1007],
];

// Ten tiles per side, so position / 10 (rounded down) names the side a tile is
// on, with each corner counted as the first tile of the side it starts.
const TILES_PER_SIDE = BOARD_SIZE / 4;

// The unit step toward the middle of the board from each side, in side order:
// the bottom row, the left column, the top row, the right column.
const INWARD_BY_SIDE: readonly Point[] = [
	[0, -1],
	[1, 0],
	[0, 1],
	[-1, 0],
];

// Sizes in the art's own pixels. A token's frame is drawn well above the 32
// pixels the asset spec asks for, because Discord shows the whole board at
// roughly a third of its size in the embed, and the token art fills only two
// thirds of its frame's width (the figure is about 32 by 45 at this size).
const TOKEN_SIZE = 48;
// Half the distance between the two token columns on a tile, and the distance
// between the three token rows. Two figures 19 either side of the centre span
// about 70 pixels, inside the narrowest lot (76 pixels wide); their transparent
// frames overlap, the figures do not.
const TOKEN_COLUMN_STEP = 19;
const TOKEN_ROW_STEP = 28;
// The stamp art is a wide band inside a square frame, so its frame is drawn
// larger than a token's for the band to read as stamped across the figure.
const JAIL_STAMP_SIZE = 56;
// Four houses at this step span 76 pixels, the narrowest lot. The house art
// fills its whole frame, so neighbours touch rather than overlap.
const HOUSE_SIZE = 22;
const HOUSE_STEP = 18;
const HOTEL_SIZE = 28;
// From a tile's centre to the centre of its building strip, toward the middle
// of the board. Lots are 152 to 170 pixels deep, so this centres the strip about
// fifteen pixels inside the inner edge, just past the innermost token row (whose
// figures reach about 50); where the two touch, the token is drawn on top.
const BUILDING_INSET = 64;

// Each seat keeps one fixed slot on whatever tile it stands on, as [column, row]
// in steps across and into the tile, so six tokens on GO at the start read as six
// tokens rather than one stack. The middle row fills first.
const TOKEN_SLOTS: readonly Point[] = [
	[-1, 0],
	[1, 0],
	[-1, -1],
	[1, -1],
	[-1, 1],
	[1, 1],
];

// ── the art ───────────────────────────────────────────────────────────
// Seat order: seat one is token-1, and so on up to the six seat cap.
const TOKEN_ART: readonly GameAssetKey[] = [
	"monopolyToken1",
	"monopolyToken2",
	"monopolyToken3",
	"monopolyToken4",
	"monopolyToken5",
	"monopolyToken6",
];

// Without any one of these the picture would be wrong rather than plain (a board
// with no tokens, or a built lot drawn bare), so the text board is used instead.
// The jail stamp is left out on purpose: a jailed token without it still stands
// on the Jail tile, and the seat line under the picture says "in jail".
const REQUIRED_ART: readonly GameAssetKey[] = ["monopolyBoardBase", ...TOKEN_ART, "monopolyHouse", "monopolyHotel"];

// Every Monopoly slot in the manifest, for the boot line. Derived rather than
// listed so a slot added to gamesAssets is reported without touching this file.
const MONOPOLY_ART = (Object.keys(GAME_ASSET_FILES) as GameAssetKey[]).filter((key) => key.startsWith("monopoly"));

// Decoded once per process. A deploy restarts the process, which is also how new
// art reaches Railway, so nothing here ever needs to notice a file changing.
const artCache = new Map<GameAssetKey, Image>();

// ── public surface ────────────────────────────────────────────────────
/** True when the canvas library loaded and every piece of art the composite needs is on disk. */
export function isRendererAvailable(): boolean {
	return canvasModule !== null && missingGameAssets(REQUIRED_ART).length === 0;
}

/**
 * The board as an image attachment plus the `attachment://` ref for the embed's
 * setImage, or null whenever the text board should be used instead. Never throws:
 * a render that fails part way costs the picture, not the move it was drawing.
 */
export async function renderBoard(state: MonopolyState, now: number = Date.now()): Promise<ResolvedGameAsset | null> {
	if (!canvasModule || !isRendererAvailable()) return null;
	try {
		return await composeBoard(canvasModule, state, now);
	} catch (error) {
		console.warn("[monopoly-renderer] the board render failed, so this redraw posts the text board", error);
		return null;
	}
}

/** Forget every decoded image, so a test can swap the art or the canvas mock between cases. */
export function clearRenderCache(): void {
	artCache.clear();
}

/** One boot line: whether boards render as images, and which Monopoly art is still owed. */
export function logMonopolyRendererStatus(): void {
	const mode = isRendererAvailable() ? "image board" : "text board";
	const missing = missingGameAssets(MONOPOLY_ART);
	const owed = missing.length === 0 ? "every Monopoly asset is on disk" : `missing from assets/games: ${missing.join(", ")}`;
	const library = canvasModule ? "" : " (@napi-rs/canvas did not load)";
	console.log(`[monopoly-renderer] ${mode}${library}; ${owed}`);
}

// ── composite ─────────────────────────────────────────────────────────
async function composeBoard(canvas: CanvasModule, state: MonopolyState, now: number): Promise<ResolvedGameAsset> {
	// ① The base, at the art's own size, so nothing is resampled but the pieces.
	const board = await loadArt(canvas, "monopolyBoardBase");
	const surface = canvas.createCanvas(board.width, board.height);
	const context = surface.getContext("2d");
	context.drawImage(board, 0, 0);
	const scale = board.width / BOARD_ART_SIZE;

	// ② then ③: buildings before tokens, so a token standing on a built lot is
	// drawn over its houses rather than under them.
	await drawBuildings(canvas, context, state, scale);
	await drawTokens(canvas, context, state, scale);

	// ④ The name carries the time so each redraw is a new upload with its own
	// ref, and an edit can never point an embed at the previous move's picture.
	const name = `monopoly-board-${now}.png`;
	return { attachment: new AttachmentBuilder(await surface.encode("png"), { name }), ref: `attachment://${name}` };
}

async function drawBuildings(canvas: CanvasModule, context: SKRSContext2D, state: MonopolyState, scale: number): Promise<void> {
	for (const [position, tile] of BOARD.entries()) {
		if (tile.kind !== "property") continue;
		const lot = state.properties[tile.id];
		if (!lot) continue;

		const strip = buildingStripCentre(position);
		if (lot.hotel) {
			// A hotel replaces the four houses it was built from (the engine hands
			// them back to the bank), so it is drawn alone.
			drawCentred(context, await loadArt(canvas, "monopolyHotel"), scalePoint(strip, scale), HOTEL_SIZE * scale);
			continue;
		}
		if (lot.houses === 0) continue;

		const house = await loadArt(canvas, "monopolyHouse");
		for (let index = 0; index < lot.houses; index++) {
			// Centred as a group along the edge: the first house sits half the row's
			// width before the strip's centre, each next one a step further on.
			const offset = (index - (lot.houses - 1) / 2) * HOUSE_STEP;
			drawCentred(context, house, scalePoint(alongEdge(position, strip, offset), scale), HOUSE_SIZE * scale);
		}
	}
}

async function drawTokens(canvas: CanvasModule, context: SKRSContext2D, state: MonopolyState, scale: number): Promise<void> {
	// Loaded only when someone is jailed, because the stamp is optional art.
	const jailStamp = state.seats.some((seat) => seat.inJail && !seat.bankrupt) ? await loadOptionalArt(canvas, "monopolyJailStamp") : null;

	for (const [seatIndex, seat] of state.seats.entries()) {
		// A bankrupt seat has left the board; the seat list still names it. The
		// engine refuses a seventh seat, so the cap only stops a corrupt row from
		// reaching past the six tokens there is art for.
		if (seat.bankrupt || seatIndex >= MAX_SEATS) continue;

		const centre = scalePoint(tokenCentre(seat.position, seatIndex), scale);
		drawCentred(context, await loadArt(canvas, TOKEN_ART[seatIndex]), centre, TOKEN_SIZE * scale);
		if (seat.inJail && jailStamp) drawCentred(context, jailStamp, centre, JAIL_STAMP_SIZE * scale);
	}
}

// ── placement ─────────────────────────────────────────────────────────
function inwardOf(position: number): Point {
	return INWARD_BY_SIDE[Math.floor(position / TILES_PER_SIDE)];
}

// A point moved `distance` along the tile's edge. "Along" is the inward step
// turned a quarter turn, which runs left to right on the bottom row and keeps the
// same handedness all the way round the board.
function alongEdge(position: number, [x, y]: Point, distance: number): Point {
	const [inwardX, inwardY] = inwardOf(position);
	return [x - inwardY * distance, y + inwardX * distance];
}

function buildingStripCentre(position: number): Point {
	const [x, y] = BOARD_PIXEL_COORDS[position];
	const [inwardX, inwardY] = inwardOf(position);
	return [x + inwardX * BUILDING_INSET, y + inwardY * BUILDING_INSET];
}

function tokenCentre(position: number, seatIndex: number): Point {
	const [column, row] = TOKEN_SLOTS[seatIndex];
	const [x, y] = alongEdge(position, BOARD_PIXEL_COORDS[position], column * TOKEN_COLUMN_STEP);
	const [inwardX, inwardY] = inwardOf(position);
	return [x + inwardX * row * TOKEN_ROW_STEP, y + inwardY * row * TOKEN_ROW_STEP];
}

const scalePoint = ([x, y]: Point, scale: number): Point => [x * scale, y * scale];

function drawCentred(context: SKRSContext2D, image: Image, [x, y]: Point, size: number): void {
	context.drawImage(image, x - size / 2, y - size / 2, size, size);
}

// ── art loading ───────────────────────────────────────────────────────
async function loadOptionalArt(canvas: CanvasModule, key: GameAssetKey): Promise<Image | null> {
	const cached = artCache.get(key);
	if (cached) return cached;
	const path = gameAssetPath(key);
	if (!path) return null;
	const image = await canvas.loadImage(path);
	artCache.set(key, image);
	return image;
}

// Required art. isRendererAvailable checked it is on disk, so a miss here means
// the file vanished mid render; the throw lands in renderBoard's catch.
async function loadArt(canvas: CanvasModule, key: GameAssetKey): Promise<Image> {
	const image = await loadOptionalArt(canvas, key);
	if (!image) throw new Error(`Monopoly art ${GAME_ASSET_FILES[key]} disappeared from assets/games during a render`);
	return image;
}

// ── the cards ─────────────────────────────────────────────────────────
// Trade, auction and winner, each through renderCard and each wrapped by its
// caller in withRenderFallback, so the text reply or the plain result card
// posts whenever one does not draw. The trade and auction cards are NEVER
// cached: a trade's terms stay private until it is accepted (risk M6) and a bid
// stays sealed until its round closes, and a cached card would hold either one
// under a content addressed S3 key that outlives the secret.

/** One lot as the cards show it: its name, and its color group (null for a railroad or a utility). */
export interface MonopolyLotView {
	name: string;
	group: ColorGroup | null;
}

/** One side of a trade: what changes hands from one player. */
export interface MonopolyTradeSideView {
	lots: MonopolyLotView[];
	chips: number;
	jailCards: number;
}

/** The trade card's view, from the side of the player looking at it. */
export interface MonopolyTradeView {
	youGet: MonopolyTradeSideView;
	youGive: MonopolyTradeSideView;
}

export interface MonopolyAuctionView {
	lot: MonopolyLotView & { price: number };
	bid: number;
}

export interface MonopolyStandingView {
	name: string;
	chips: number;
	lots: number;
	bankrupt: boolean;
	isWinner: boolean;
}

export interface MonopolyWinnerView {
	/** The winner's display name, or null for a match that ended without one. */
	winner: string | null;
	standings: MonopolyStandingView[];
}

export function monopolyLotView(tileId: TileId): MonopolyLotView {
	const tile = findOwnableTile(tileId);
	return { name: ownableTileName(tileId), group: tile?.kind === "property" ? tile.group : null };
}

const tradeSideView = (side: TradeProposal["offer"]): MonopolyTradeSideView => ({
	lots: side.properties.map(monopolyLotView),
	chips: side.chips,
	jailCards: side.gojf,
});

/** The trade card's view of an open offer, as the viewer would receive and give it. */
export function monopolyTradeView(youGet: TradeProposal["offer"], youGive: TradeProposal["offer"]): MonopolyTradeView {
	return { youGet: tradeSideView(youGet), youGive: tradeSideView(youGive) };
}

/** The auction card's view of the lot on the block and the bid just placed. */
export function monopolyAuctionView(auction: AuctionState, bid: number): MonopolyAuctionView {
	return { lot: { ...monopolyLotView(auction.tileId), price: findOwnableTile(auction.tileId)?.price ?? 0 }, bid };
}

/**
 * The winner card's view of a finished match. `names` maps a seat's user id to
 * its display name; a seat with none (a member who left) reads as its seat number.
 */
export function monopolyWinnerView(state: MonopolyState, names: ReadonlyMap<string, string>): MonopolyWinnerView {
	const nameOf = (userId: string, index: number): string => names.get(userId) ?? gameRoomsCopy.monopoly.cardSeat(index);
	const lotsHeld = (userId: string): number => Object.values(state.properties).filter((lot) => lot.ownerId === userId).length;
	const winnerIndex = state.seats.findIndex((seat) => seat.userId === state.winnerId);
	return {
		winner: winnerIndex >= 0 ? nameOf(state.seats[winnerIndex].userId, winnerIndex) : null,
		standings: state.seats.map((seat, index) => ({
			name: nameOf(seat.userId, index),
			chips: seat.chips,
			lots: lotsHeld(seat.userId),
			bankrupt: seat.bankrupt,
			isWinner: seat.userId === state.winnerId,
		})),
	};
}

// Bump whenever a card's drawing changes, or members keep seeing cached cards.
const MONOPOLY_CARD_VERSION = 1;
const CARD_WIDTH = 960;
const CARD_PADDING = 40;
const TRADE_CARD_HEIGHT = 440;
const AUCTION_CARD_HEIGHT = 340;
const STANDING_ROW_HEIGHT = 64;
const WINNER_HEADER_HEIGHT = 200;
// A side lists this many items before it says how many more there are.
const MAX_TRADE_ITEMS = 6;
const TRADE_ITEM_HEIGHT = 44;
const SWATCH_SIZE = 22;

const GROUP_COLORS: Record<ColorGroup, ColorResolvable> = {
	brown: COLORS.MONOPOLY_BROWN,
	"light-blue": COLORS.MONOPOLY_LIGHT_BLUE,
	pink: COLORS.MONOPOLY_PINK,
	orange: COLORS.MONOPOLY_ORANGE,
	red: COLORS.MONOPOLY_RED,
	yellow: COLORS.MONOPOLY_YELLOW,
	green: COLORS.MONOPOLY_GREEN,
	"dark-blue": COLORS.MONOPOLY_DARK_BLUE,
};

// A railroad or a utility belongs to no color group, so it takes the muted ink.
const lotColor = (lot: MonopolyLotView): string => canvasColor(lot.group ? GROUP_COLORS[lot.group] : COLORS.CARD_TEXT_MUTED);

/** The trade card for the private offer review, or null when the text offer should post alone. Never throws. */
export function renderTradeCard(view: MonopolyTradeView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "monopoly-trade",
		version: MONOPOLY_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: TRADE_CARD_HEIGHT,
		draw: (context, input) => {
			drawTradeCard(context, input);
			return { cacheable: false };
		},
	});
}

/** The auction card for a bidder's sealed bid confirmation, or null when the text line should post alone. Never throws. */
export function renderAuctionCard(view: MonopolyAuctionView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "monopoly-auction",
		version: MONOPOLY_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: AUCTION_CARD_HEIGHT,
		draw: (context, input) => {
			drawAuctionCard(context, input);
			return { cacheable: false };
		},
	});
}

/** The winner card for a finished match's result, or null when the result card should post without it. Never throws. */
export function renderWinnerCard(view: MonopolyWinnerView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "monopoly-winner",
		version: MONOPOLY_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: WINNER_HEADER_HEIGHT + view.standings.length * STANDING_ROW_HEIGHT + CARD_PADDING,
		draw: drawWinnerCard,
	});
}

// ── trade ──
function drawTradeCard(context: SKRSContext2D, view: MonopolyTradeView): void {
	drawCardBackground(context, COLORS.ARCADE, CARD_WIDTH / 2, 0, CARD_WIDTH * 0.6);
	const columnWidth = (CARD_WIDTH - CARD_PADDING * 3) / 2;
	drawTradeSide(context, gameRoomsCopy.monopoly.cardYouGet, view.youGet, CARD_PADDING, columnWidth);
	drawTradeSide(context, gameRoomsCopy.monopoly.cardYouGive, view.youGive, CARD_PADDING * 2 + columnWidth, columnWidth);
}

interface TradeItem {
	label: string;
	swatch: string | null;
}

function tradeItems(side: MonopolyTradeSideView): TradeItem[] {
	const copy = gameRoomsCopy.monopoly;
	const items: TradeItem[] = side.lots.map((lot) => ({ label: lot.name, swatch: lotColor(lot) }));
	if (side.chips > 0) items.push({ label: copy.cardChips(side.chips), swatch: null });
	if (side.jailCards > 0) items.push({ label: copy.cardJailCards(side.jailCards), swatch: null });
	if (items.length === 0) items.push({ label: copy.cardNothing, swatch: null });
	return items;
}

function drawTradeSide(context: SKRSContext2D, heading: string, side: MonopolyTradeSideView, left: number, width: number): void {
	const top = CARD_PADDING;
	drawPanel(context, { x: left, y: top, width, height: TRADE_CARD_HEIGHT - CARD_PADDING * 2, radius: 20, fill: canvasColor(COLORS.CARD_PANEL) });
	drawText(context, heading, { x: left + 24, y: top + 44, size: 22, weight: "bold", color: canvasColor(COLORS.CARD_TEXT_SECONDARY) });

	const items = tradeItems(side);
	// One slot is given up to the "and N more" line when the list overflows.
	const shown = items.length > MAX_TRADE_ITEMS ? items.slice(0, MAX_TRADE_ITEMS - 1) : items;
	shown.forEach((item, index) => {
		const middle = top + 96 + index * TRADE_ITEM_HEIGHT;
		const textLeft = item.swatch ? left + 24 + SWATCH_SIZE + 14 : left + 24;
		if (item.swatch) drawPanel(context, { x: left + 24, y: middle - SWATCH_SIZE / 2, width: SWATCH_SIZE, height: SWATCH_SIZE, radius: 5, fill: item.swatch });
		drawText(context, item.label, { x: textLeft, y: middle, size: 22, color: canvasColor(COLORS.CARD_TEXT), baseline: "middle", maxWidth: left + width - 24 - textLeft });
	});
	const hidden = items.length - shown.length;
	if (hidden <= 0) return;
	drawText(context, gameRoomsCopy.monopoly.cardMoreLots(hidden), {
		x: left + 24,
		y: top + 96 + shown.length * TRADE_ITEM_HEIGHT,
		size: 20,
		color: canvasColor(COLORS.CARD_TEXT_MUTED),
		baseline: "middle",
	});
}

// ── auction ──
function drawAuctionCard(context: SKRSContext2D, view: MonopolyAuctionView): void {
	drawCardBackground(context, COLORS.ARCADE, CARD_WIDTH * 0.75, AUCTION_CARD_HEIGHT / 2, CARD_WIDTH * 0.5);
	const deed = { x: CARD_PADDING, y: CARD_PADDING, width: 380, height: AUCTION_CARD_HEIGHT - CARD_PADDING * 2 };
	drawPanel(context, { ...deed, radius: 20, fill: canvasColor(COLORS.CARD_PANEL) });
	// The deed's color band, as a printed title deed has across its top.
	drawPanel(context, { x: deed.x, y: deed.y, width: deed.width, height: 72, radius: 20, fill: lotColor(view.lot) });
	drawText(context, view.lot.name, {
		x: deed.x + deed.width / 2,
		y: deed.y + 140,
		size: 30,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		align: "center",
		baseline: "middle",
		maxWidth: deed.width - 40,
	});
	drawText(context, gameRoomsCopy.monopoly.cardListPrice(view.lot.price), {
		x: deed.x + deed.width / 2,
		y: deed.y + 196,
		size: 22,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		align: "center",
		baseline: "middle",
	});

	const right = deed.x + deed.width + 48;
	drawPill(context, { x: right, y: 90, width: 220, height: 48, fill: canvasColor(COLORS.ARCADE), label: gameRoomsCopy.monopoly.cardAuction });
	drawText(context, gameRoomsCopy.monopoly.cardYourBid(view.bid), {
		x: right,
		y: 210,
		size: 36,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: CARD_WIDTH - right - CARD_PADDING,
	});
}

// ── winner ──
function drawWinnerCard(context: SKRSContext2D, view: MonopolyWinnerView): void {
	drawCardBackground(context, COLORS.MONOPOLY_YELLOW, CARD_WIDTH / 2, 0, CARD_WIDTH * 0.6);
	const copy = gameRoomsCopy.monopoly;
	drawPill(context, {
		x: CARD_PADDING,
		y: CARD_PADDING,
		width: 180,
		height: 44,
		fill: canvasColor(COLORS.MONOPOLY_YELLOW),
		label: copy.cardWinner,
		labelColor: canvasColor(COLORS.CARD_BACKGROUND),
	});
	drawText(context, view.winner ?? copy.cardNoWinner, {
		x: CARD_PADDING,
		y: 140,
		size: 44,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: CARD_WIDTH - CARD_PADDING * 2,
	});
	view.standings.forEach((standing, index) => drawStanding(context, standing, WINNER_HEADER_HEIGHT + index * STANDING_ROW_HEIGHT));
}

function drawStanding(context: SKRSContext2D, standing: MonopolyStandingView, top: number): void {
	const copy = gameRoomsCopy.monopoly;
	const height = STANDING_ROW_HEIGHT - 10;
	drawPanel(context, {
		x: CARD_PADDING,
		y: top,
		width: CARD_WIDTH - CARD_PADDING * 2,
		height,
		radius: 14,
		fill: canvasColor(standing.isWinner ? COLORS.CARD_NESTED : COLORS.CARD_PANEL),
	});
	const middle = top + height / 2;
	const ink = canvasColor(standing.bankrupt ? COLORS.CARD_TEXT_MUTED : COLORS.CARD_TEXT);
	drawText(context, standing.name, { x: CARD_PADDING + 24, y: middle, size: 24, weight: "bold", color: ink, baseline: "middle", maxWidth: 420 });
	const holdings = standing.bankrupt ? copy.cardBankrupt : `${copy.cardChips(standing.chips)}   ${copy.cardLots(standing.lots)}`;
	drawText(context, holdings, { x: CARD_WIDTH - CARD_PADDING - 24, y: middle, size: 22, color: ink, align: "right", baseline: "middle" });
}
