import { AttachmentBuilder, type ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import { canvasModule, type CanvasModule, type Image, type SKRSContext2D } from "@features/renderer/canvasModule.js";
import { canvasColor, drawCardBackground, drawPanel, drawPill, drawText, renderCard, type DrawOutcome, type Rect, type RenderPayload } from "@features/renderer/index.js";
import { rendererFont } from "@features/renderer/fonts.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { BOARD, BOARD_SIZE, MAX_SEATS, findOwnableTile, ownableTileName, type ColorGroup, type TileId } from "./monopolyBoard.js";
import type { AuctionState, MonopolyState, TradeProposal } from "./monopolyState.js";
import { GAME_ASSET_FILES, gameAssetPath, missingGameAssets, type GameAssetKey, type ResolvedGameAsset } from "./gamesAssets.js";
import { clearGameArtCache, loadGameArt } from "./gamesArt.js";

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
//        then each token's name tag over everything (2026-10 item 254, Arcade 12),
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
// roughly a third of its size in the embed, and players read it on a phone: the
// owner's decision 20 (2026-10 item 254, Arcade 12) set it at 1.5 times the old 48.
const TOKEN_SIZE = 72;
// The figure inside a token's frame: two thirds of its width and about fifteen
// sixteenths of its height (32 by 45 in the old 48 pixel frame). The slot steps
// below are measured from the figure, not the frame, whose corners are transparent.
const TOKEN_FIGURE_WIDTH = (TOKEN_SIZE * 2) / 3;
const TOKEN_FIGURE_HEIGHT = (TOKEN_SIZE * 15) / 16;
// Half the distance between the two token columns on a tile, and the distance
// between the three token rows. Tokens are drawn upright on every side, so on the
// left and right columns the "columns" stack vertically and the rows run across:
// each step therefore clears the figure's TALLER side, so no two tokens on one tile
// cover each other on any side of the board. The price is that a full tile of six
// spills onto its neighbours (the narrowest lot is 76 pixels wide), which the old
// 48 pixel layout only just avoided by letting figures overlap.
const TOKEN_COLUMN_STEP = Math.ceil(TOKEN_FIGURE_HEIGHT / 2) + 1;
const TOKEN_ROW_STEP = Math.ceil(TOKEN_FIGURE_HEIGHT) + 2;
// The stamp art is a wide band inside a square frame, so its frame is drawn
// larger than a token's for the band to read as stamped across the figure.
const JAIL_STAMP_SIZE = 84;

// ── the name tags (Arcade 12) ──
// A dark rounded tag with an arrow under it, pointing down at the figure's head, so
// a player finds their own token by name on a phone. Sized for Discord's third scale
// view: a 26 pixel name reads at about 9 pixels in the embed and full size when tapped.
const TAG_FONT_SIZE = 26;
const TAG_HEIGHT = 36;
const TAG_PADDING_X = 10;
// The widest a tag may grow before its name is cut short with an ellipsis: about
// two lot widths, so a long name cannot reach across half a side of the board.
const TAG_MAX_WIDTH = 168;
const TAG_ARROW_HEIGHT = 10;
const TAG_ARROW_HALF_WIDTH = 9;
// The gap between the arrow's tip and the figure's head, and between stacked tags.
const TAG_GAP = 4;
const TAG_FILL = "rgba(16, 18, 28, 0.88)";
const TAG_INK = "#ffffff";
const ELLIPSIS = "…";
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
// tokens rather than one stack. The middle row fills first, then the row toward the
// middle of the board, so the outer row, whose tags have least room before the
// edge of the art, is only ever a fifth and sixth seat's.
const TOKEN_SLOTS: readonly Point[] = [
	[-1, 0],
	[1, 0],
	[-1, 1],
	[1, 1],
	[-1, -1],
	[1, -1],
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
export async function renderBoard(
	state: MonopolyState,
	now: number = Date.now(),
	// Each seat's name for its tag, by user id, already as the room shows it (a Dero bot
	// through labelForRoom). A seat with no entry is drawn with no tag.
	names: ReadonlyMap<string, string> = new Map()
): Promise<ResolvedGameAsset | null> {
	if (!canvasModule || !isRendererAvailable()) return null;
	try {
		return await composeBoard(canvasModule, state, now, names);
	} catch (error) {
		console.warn("[monopoly-renderer] the board render failed, so this redraw posts the text board", error);
		return null;
	}
}

/** Forget every decoded image, so a test can swap the art or the canvas mock between cases. */
export function clearRenderCache(): void {
	clearGameArtCache();
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
async function composeBoard(canvas: CanvasModule, state: MonopolyState, now: number, names: ReadonlyMap<string, string>): Promise<ResolvedGameAsset> {
	// ① The base, at the art's own size, so nothing is resampled but the pieces.
	const board = await loadArt("monopolyBoardBase");
	const surface = canvas.createCanvas(board.width, board.height);
	const context = surface.getContext("2d");
	context.drawImage(board, 0, 0);
	const scale = board.width / BOARD_ART_SIZE;

	// ② then ③: buildings before tokens, so a token standing on a built lot is
	// drawn over its houses rather than under them.
	await drawBuildings(context, state, scale);
	const placements = layoutTokens(state, names, (text) => measureTagText(context, text));
	await drawTokens(context, state, placements, scale);
	// The tags last, over every token and building, so no figure ever hides a name.
	for (const placement of placements) if (placement.tag) drawTag(context, placement.tag, scale);

	// ④ The name carries the time so each redraw is a new upload with its own
	// ref, and an edit can never point an embed at the previous move's picture.
	const name = `monopoly-board-${now}.png`;
	return { attachment: new AttachmentBuilder(await surface.encode("png"), { name }), ref: `attachment://${name}` };
}

async function drawBuildings(context: SKRSContext2D, state: MonopolyState, scale: number): Promise<void> {
	for (const [position, tile] of BOARD.entries()) {
		if (tile.kind !== "property") continue;
		const lot = state.properties[tile.id];
		if (!lot) continue;

		const strip = buildingStripCentre(position);
		if (lot.hotel) {
			// A hotel replaces the four houses it was built from (the engine hands
			// them back to the bank), so it is drawn alone.
			drawCentred(context, await loadArt("monopolyHotel"), scalePoint(strip, scale), HOTEL_SIZE * scale);
			continue;
		}
		if (lot.houses === 0) continue;

		const house = await loadArt("monopolyHouse");
		for (let index = 0; index < lot.houses; index++) {
			// Centred as a group along the edge: the first house sits half the row's
			// width before the strip's centre, each next one a step further on.
			const offset = (index - (lot.houses - 1) / 2) * HOUSE_STEP;
			drawCentred(context, house, scalePoint(alongEdge(position, strip, offset), scale), HOUSE_SIZE * scale);
		}
	}
}

async function drawTokens(context: SKRSContext2D, state: MonopolyState, placements: readonly TokenPlacement[], scale: number): Promise<void> {
	// Loaded only when someone is jailed, because the stamp is optional art.
	const jailStamp = state.seats.some((seat) => seat.inJail && !seat.bankrupt) ? await loadOptionalArt("monopolyJailStamp") : null;

	for (const { seatIndex, centre: artCentre } of placements) {
		const centre = scalePoint(artCentre, scale);
		drawCentred(context, await loadArt(TOKEN_ART[seatIndex]), centre, TOKEN_SIZE * scale);
		if (state.seats[seatIndex].inJail && jailStamp) drawCentred(context, jailStamp, centre, JAIL_STAMP_SIZE * scale);
	}
}

// ── token and tag layout ──────────────────────────────────────────────
/** One name tag, in the art's own pixels: its box, the name as drawn, and where its arrow points. */
export interface TagPlacement {
	box: Rect;
	text: string;
	// The arrow's tip, at the figure's head (or its feet, for a tag that had no room above).
	arrowTip: Point;
	pointsDown: boolean;
}

/** Where one seat still in the match is drawn, in the art's own pixels. */
export interface TokenPlacement {
	seatIndex: number;
	centre: Point;
	// The figure inside the token's frame, which is what must never cover another's.
	figure: Rect;
	tag: TagPlacement | null;
}

/**
 * Every token still on the board and its name tag, in seat order, laid out in the
 * art's own pixels (the composite scales them). `measure` is the width of a name at
 * the tag's font; the composite passes the canvas's own measure, and a test passes a
 * fixed width per character. Exported so the tests can check the layout itself:
 * figures on one tile never overlap, and no tag overlaps another tag or a figure.
 */
export function layoutTokens(state: MonopolyState, names: ReadonlyMap<string, string>, measure: (text: string) => number): TokenPlacement[] {
	const tokens: TokenPlacement[] = [];
	for (const [seatIndex, seat] of state.seats.entries()) {
		// A bankrupt seat has left the board; the seat list still names it. The
		// engine refuses a seventh seat, so the cap only stops a corrupt row from
		// reaching past the six tokens there is art for.
		if (seat.bankrupt || seatIndex >= MAX_SEATS) continue;
		const centre = tokenCentre(seat.position, seatIndex);
		tokens.push({ seatIndex, centre, figure: figureOf(centre), tag: null });
	}

	// Placed after every figure is known, because a tag must clear the figures of the
	// tokens beside its own, and in seat order, so a layout never depends on timing.
	const placedTags: Rect[] = [];
	for (const token of tokens) {
		const name = names.get(state.seats[token.seatIndex].userId);
		if (!name) continue;
		const obstacles = [...placedTags, ...tokens.filter((other) => other !== token).map((other) => other.figure)];
		token.tag = placeTag(token, fitWithEllipsis(name, TAG_MAX_WIDTH - TAG_PADDING_X * 2, measure), measure, obstacles);
		placedTags.push(token.tag.box);
	}
	return tokens;
}

const figureOf = ([x, y]: Point): Rect => ({
	x: x - TOKEN_FIGURE_WIDTH / 2,
	y: y - TOKEN_FIGURE_HEIGHT / 2,
	width: TOKEN_FIGURE_WIDTH,
	height: TOKEN_FIGURE_HEIGHT,
});

// The name cut down, one character at a time, until it and the ellipsis fit.
function fitWithEllipsis(name: string, maxWidth: number, measure: (text: string) => number): string {
	if (measure(name) <= maxWidth) return name;
	const characters = [...name];
	while (characters.length > 1 && measure(`${characters.join("").trimEnd()}${ELLIPSIS}`) > maxWidth) characters.pop();
	return `${characters.join("").trimEnd()}${ELLIPSIS}`;
}

// Above the head first, stepped further up past anything it would cover; when the art
// runs out above (the top row), below the feet, stepped further down the same way. Each
// step moves strictly away from the figure past one obstacle, so both searches end. A
// tag with no clear spot either way keeps the first spot inside the art rather than
// leaving the board.
function placeTag(token: TokenPlacement, text: string, measure: (text: string) => number, obstacles: readonly Rect[]): TagPlacement {
	const width = Math.min(TAG_MAX_WIDTH, Math.ceil(measure(text)) + TAG_PADDING_X * 2);
	const x = clamp(token.centre[0] - width / 2, 0, BOARD_ART_SIZE - width);
	const headTip: Point = [token.centre[0], token.figure.y - TAG_GAP];
	const feetTip: Point = [token.centre[0], token.figure.y + token.figure.height + TAG_GAP];
	const above = searchClearSpot({ x, y: headTip[1] - TAG_ARROW_HEIGHT - TAG_HEIGHT, width, height: TAG_HEIGHT }, "up", obstacles);
	if (above.clear) return { box: above.box, text, arrowTip: headTip, pointsDown: true };
	const below = searchClearSpot({ x, y: feetTip[1] + TAG_ARROW_HEIGHT, width, height: TAG_HEIGHT }, "down", obstacles);
	if (below.clear || !above.inside) return { box: below.box, text, arrowTip: feetTip, pointsDown: false };
	return { box: above.box, text, arrowTip: headTip, pointsDown: true };
}

// Step a tag box one way past each obstacle it covers until it covers none, or until the
// next step would leave the art. `inside` says whether the starting spot fit at all.
function searchClearSpot(start: Rect, direction: "up" | "down", obstacles: readonly Rect[]): { box: Rect; clear: boolean; inside: boolean } {
	const fits = (box: Rect): boolean => box.y >= 0 && box.y + box.height <= BOARD_ART_SIZE;
	let box = start;
	if (!fits(box)) return { box, clear: false, inside: false };
	for (let step = 0; step <= obstacles.length; step++) {
		const blocking = obstacles.find((obstacle) => overlaps(box, obstacle));
		if (!blocking) return { box, clear: true, inside: true };
		const next = { ...box, y: direction === "up" ? blocking.y - TAG_GAP - box.height : blocking.y + blocking.height + TAG_GAP };
		if (!fits(next)) break;
		box = next;
	}
	return { box, clear: false, inside: true };
}

/** True when two boxes share any area. Touching edges do not count. */
export function overlaps(first: Rect, second: Rect): boolean {
	return first.x < second.x + second.width && second.x < first.x + first.width && first.y < second.y + second.height && second.y < first.y + first.height;
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

function measureTagText(context: SKRSContext2D, text: string): number {
	context.font = rendererFont(TAG_FONT_SIZE, "bold");
	return context.measureText(text).width;
}

// The tag's box, its arrow from the box's near edge to the tip, then the name. The
// arrow's base stays inside the box even when the box was clamped at the art's edge.
function drawTag(context: SKRSContext2D, tag: TagPlacement, scale: number): void {
	const { box, arrowTip, pointsDown } = tag;
	const baseY = pointsDown ? box.y + box.height : box.y;
	const baseX = clamp(arrowTip[0], box.x + TAG_ARROW_HALF_WIDTH, box.x + box.width - TAG_ARROW_HALF_WIDTH);
	context.save();
	context.fillStyle = TAG_FILL;
	context.beginPath();
	context.roundRect(box.x * scale, box.y * scale, box.width * scale, box.height * scale, (box.height / 2) * scale);
	context.fill();
	context.beginPath();
	context.moveTo((baseX - TAG_ARROW_HALF_WIDTH) * scale, baseY * scale);
	context.lineTo((baseX + TAG_ARROW_HALF_WIDTH) * scale, baseY * scale);
	context.lineTo(arrowTip[0] * scale, arrowTip[1] * scale);
	context.closePath();
	context.fill();
	context.restore();
	drawText(context, tag.text, {
		x: (box.x + box.width / 2) * scale,
		y: (box.y + box.height / 2) * scale,
		size: TAG_FONT_SIZE * scale,
		weight: "bold",
		color: TAG_INK,
		align: "center",
		baseline: "middle",
	});
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
// Decoded once per process by gamesArt, the loader every game card shares.
const loadOptionalArt = (key: GameAssetKey): Promise<Image | null> => loadGameArt(key);

// Required art. isRendererAvailable checked it is on disk, so a miss here means
// the file vanished mid render; the throw lands in renderBoard's catch.
async function loadArt(key: GameAssetKey): Promise<Image> {
	const image = await loadOptionalArt(key);
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
const MONOPOLY_CARD_VERSION = 2;
const CARD_WIDTH = 960;
const CARD_PADDING = 40;
const TRADE_CARD_HEIGHT = 440;
const AUCTION_CARD_HEIGHT = 340;
const STANDING_ROW_HEIGHT = 64;
const WINNER_HEADER_HEIGHT = 200;
// With the owner's winner.png on disk the header is the banner, then the name.
const BANNER_BOX: Rect = { x: CARD_PADDING, y: 24, width: CARD_WIDTH - CARD_PADDING * 2, height: 300 };
const WINNER_HEADER_WITH_BANNER = 404;
// winner.png and bankrupt.png were exported with a white strip along the top and a
// purple line down the left edge (about six and two pixels); this many pixels are
// cropped from every side of both so neither strip shows on the card.
const BANNER_EDGE_CROP = 8;
const BANKRUPT_BADGE = 44;
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
	// The layout is chosen before the draw, because the banner makes the card
	// taller and the height is fixed when the canvas is made.
	const withBanner = gameAssetPath("monopolyWinner") !== null;
	const header = withBanner ? WINNER_HEADER_WITH_BANNER : WINNER_HEADER_HEIGHT;
	return renderCard({
		kind: "monopoly-winner",
		version: MONOPOLY_CARD_VERSION,
		input: { ...view, withBanner },
		width: CARD_WIDTH,
		height: header + view.standings.length * STANDING_ROW_HEIGHT + CARD_PADDING,
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
async function drawWinnerCard(context: SKRSContext2D, view: MonopolyWinnerView & { withBanner: boolean }): Promise<DrawOutcome> {
	drawCardBackground(context, COLORS.MONOPOLY_YELLOW, CARD_WIDTH / 2, 0, CARD_WIDTH * 0.6);
	const banner = view.withBanner ? await loadGameArt("monopolyWinner") : null;
	const bankrupt = view.standings.some((standing) => standing.bankrupt) ? await loadGameArt("monopolyBankrupt") : null;
	if (banner) drawBannerArt(context, banner, BANNER_BOX);
	else drawWinnerPill(context);
	const nameY = banner ? BANNER_BOX.y + BANNER_BOX.height + 40 : 140;
	drawText(context, view.winner ?? gameRoomsCopy.monopoly.cardNoWinner, {
		x: CARD_PADDING,
		y: nameY,
		size: 44,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: CARD_WIDTH - CARD_PADDING * 2,
	});
	const top = banner ? WINNER_HEADER_WITH_BANNER : WINNER_HEADER_HEIGHT;
	view.standings.forEach((standing, index) => drawStanding(context, standing, top + index * STANDING_ROW_HEIGHT, bankrupt));
	// Art the layout expected but could not load, or a bankrupt seat drawn without
	// its badge, is a stand in, so the card is not cached.
	const bankruptBadgeMissing = view.standings.some((standing) => standing.bankrupt) && !bankrupt;
	return (view.withBanner && !banner) || bankruptBadgeMissing ? { cacheable: false } : undefined;
}

// The owner's art inside `box` with its edge strips cropped, kept to its shape and
// centred, with rounded corners.
function drawBannerArt(context: SKRSContext2D, art: Image, box: Rect): void {
	const sourceWidth = art.width - BANNER_EDGE_CROP * 2;
	const sourceHeight = art.height - BANNER_EDGE_CROP * 2;
	const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight);
	const width = sourceWidth * scale;
	const height = sourceHeight * scale;
	const x = box.x + (box.width - width) / 2;
	const y = box.y + (box.height - height) / 2;
	context.save();
	context.beginPath();
	context.roundRect(x, y, width, height, 18);
	context.clip();
	context.drawImage(art, BANNER_EDGE_CROP, BANNER_EDGE_CROP, sourceWidth, sourceHeight, x, y, width, height);
	context.restore();
}

function drawWinnerPill(context: SKRSContext2D): void {
	drawPill(context, {
		x: CARD_PADDING,
		y: CARD_PADDING,
		width: 180,
		height: 44,
		fill: canvasColor(COLORS.MONOPOLY_YELLOW),
		label: gameRoomsCopy.monopoly.cardWinner,
		labelColor: canvasColor(COLORS.CARD_BACKGROUND),
	});
}

// A bankrupt seat wears the owner's sympathetic bankrupt Dero beside its name.
function drawStanding(context: SKRSContext2D, standing: MonopolyStandingView, top: number, bankruptBadge: Image | null): void {
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
	const badge = standing.bankrupt ? bankruptBadge : null;
	if (badge) {
		drawBannerArt(context, badge, { x: CARD_PADDING + 12, y: middle - BANKRUPT_BADGE / 2, width: BANKRUPT_BADGE, height: BANKRUPT_BADGE });
	}
	const nameX = CARD_PADDING + (badge ? 24 + BANKRUPT_BADGE : 24);
	drawText(context, standing.name, { x: nameX, y: middle, size: 24, weight: "bold", color: ink, baseline: "middle", maxWidth: 420 });
	const holdings = standing.bankrupt ? copy.cardBankrupt : `${copy.cardChips(standing.chips)}   ${copy.cardLots(standing.lots)}`;
	drawText(context, holdings, { x: CARD_WIDTH - CARD_PADDING - 24, y: middle, size: 22, color: ink, align: "right", baseline: "middle" });
}
