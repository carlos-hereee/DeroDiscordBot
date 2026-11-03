import { describe, it, expect, vi, beforeEach } from "vitest";

// ── the canvas library, mocked ──
// Every drawImage lands in `drawn` with the image it drew, so a case reads the
// composite as a sequence of placements instead of comparing pixels. loadImage
// hands back a fake image that remembers which file it came from.
const canvasState = vi.hoisted(() => ({ boardWidth: 1254, drawn: [] as unknown[][], texts: [] as string[] }));

vi.mock("@napi-rs/canvas", () => ({
	loadImage: vi.fn(async (path: string) => {
		const isBoard = path.endsWith("board-base.png");
		const size = isBoard ? canvasState.boardWidth : 128;
		return { path, width: size, height: size };
	}),
	createCanvas: vi.fn((width: number, height: number) => ({
		width,
		height,
		getContext: () => ({
			drawImage: (...args: unknown[]) => canvasState.drawn.push(args),
			// The name tags draw shapes and text; each name is 14 pixels a character here.
			measureText: (text: string) => ({ width: [...text].length * 14 }),
			fillText: (text: string) => canvasState.texts.push(text),
			save: () => undefined,
			restore: () => undefined,
			beginPath: () => undefined,
			roundRect: () => undefined,
			moveTo: () => undefined,
			lineTo: () => undefined,
			closePath: () => undefined,
			fill: () => undefined,
		}),
		encode: vi.fn(async () => Buffer.from("composited-png")),
	})),
}));

// The art on disk, mocked: every slot present at a fake path unless a case says
// otherwise. The manifest itself stays real, so the slot names are the live ones.
vi.mock("./gamesAssets.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./gamesAssets.js")>();
	return {
		...actual,
		gameAssetPath: vi.fn((key: keyof typeof actual.GAME_ASSET_FILES) => `/art/${actual.GAME_ASSET_FILES[key]}`),
		missingGameAssets: vi.fn(() => []),
	};
});

// Render analytics, stubbed. The vi.resetModules case below imports the renderer
// again, which would register the RenderAnalytics model a second time and make
// Mongoose throw; nothing in this file counts lookups (2026-10 item 244).
vi.mock("@features/renderer/renderAnalytics.js", () => ({
	recordCardLookup: vi.fn(),
	recordAvatarLookup: vi.fn(),
}));

import * as canvas from "@napi-rs/canvas";
import { BOARD_PIXEL_COORDS, clearRenderCache, isRendererAvailable, layoutTokens, logMonopolyRendererStatus, overlaps, renderBoard } from "./monopolyRenderer.js";
import { GAME_ASSET_FILES, gameAssetPath, missingGameAssets, type GameAssetKey } from "./gamesAssets.js";
import { BOARD_SIZE, MAX_SEATS } from "./monopolyBoard.js";
import { createInitialState, type MonopolyState } from "./monopolyState.js";

// ── monopolyRenderer ─────────────────────────────────────────────────
// Pins where the board art says each tile is, that the renderer steps aside for
// the text board whenever it cannot draw a true picture, and the order it
// composites in: base, buildings, then each token with its jail stamp.

const A = "player-a";
const B = "player-b";
const C = "player-c";
const NOW = 1_761_220_800_000;
// How far a token may sit from its tile's centre and still be on that tile. The
// narrowest lot is 76 pixels across, so 40 is inside every tile.
const ON_TILE = 40;
// Half the depth of the shallowest lot (152 pixels): a building further than this
// from the tile's centre, toward the board's middle, would be off the tile.
const HALF_LOT_DEPTH = 76;

const missingMock = missingGameAssets as unknown as ReturnType<typeof vi.fn>;
const pathMock = gameAssetPath as unknown as ReturnType<typeof vi.fn>;
const loadImageMock = canvas.loadImage as unknown as ReturnType<typeof vi.fn>;
const createCanvasMock = canvas.createCanvas as unknown as ReturnType<typeof vi.fn>;

type Placement = { file: string; centre: [number, number]; size: number };

// Where the mocked disk keeps a slot, matching gamesAssets' own relative paths.
const fakePath = (key: GameAssetKey): string => `/art/${GAME_ASSET_FILES[key]}`;

// drawImage(image, x, y) for the base; drawImage(image, x, y, w, h) for a piece.
function placements(): Placement[] {
	return canvasState.drawn.map((args) => {
		const [image, x, y, width = 0] = args as [{ path: string }, number, number, number?];
		const file = image.path.replace("/art/monopoly/", "");
		return { file, centre: [x + width / 2, y + width / 2], size: width };
	});
}

// A token's centre on its tile: within ON_TILE along the tile's edge, and within half
// the shallowest lot's depth across it, since the 72 pixel tokens (2026-10 item 254,
// Arcade 12) stack their rows a figure's height apart into the tile.
const isTokenOnTile = ([x, y]: [number, number], position: number, scale = 1): boolean => {
	const [tileX, tileY] = BOARD_PIXEL_COORDS[position];
	const dx = Math.abs(x - tileX * scale);
	const dy = Math.abs(y - tileY * scale);
	const horizontalSide = Math.floor(position / 10) % 2 === 0;
	const [along, across] = horizontalSide ? [dx, dy] : [dy, dx];
	return along <= ON_TILE * scale && across <= HALF_LOT_DEPTH * scale;
};

// Three seats: one on GO, one in jail, one on Free Parking.
function threeSeatMatch(): MonopolyState {
	const state = createInitialState([A, B, C], { auctionsEnabled: false }, 1_000, 1);
	state.seats[1].position = 10;
	state.seats[1].inJail = true;
	state.seats[2].position = 20;
	return state;
}

beforeEach(() => {
	vi.clearAllMocks();
	clearRenderCache();
	canvasState.drawn = [];
	canvasState.texts = [];
	canvasState.boardWidth = 1254;
	// clearAllMocks keeps implementations, so a case that hid a file would leak
	// into the next one without these two resets.
	missingMock.mockImplementation(() => []);
	pathMock.mockImplementation(fakePath);
});

describe("BOARD_PIXEL_COORDS", () => {
	it("has one centre for every tile on the board", () => {
		expect(BOARD_PIXEL_COORDS).toHaveLength(BOARD_SIZE);
	});

	it("pins the four corners where the board art draws them", () => {
		expect(BOARD_PIXEL_COORDS[0]).toEqual([1152, 1140]); // GO, lower right
		expect(BOARD_PIXEL_COORDS[10]).toEqual([98, 1140]); // Jail, lower left
		expect(BOARD_PIXEL_COORDS[20]).toEqual([98, 104]); // Free Parking, upper left
		expect(BOARD_PIXEL_COORDS[30]).toEqual([1152, 104]); // Go To Jail, upper right
	});

	it("walks each side in play order: left along the bottom, up the left, right along the top, down the right", () => {
		for (let position = 1; position < BOARD_SIZE; position++) {
			const [x, y] = BOARD_PIXEL_COORDS[position];
			const [previousX, previousY] = BOARD_PIXEL_COORDS[position - 1];
			if (position <= 10) expect(x).toBeLessThan(previousX);
			else if (position <= 20) expect(y).toBeLessThan(previousY);
			else if (position <= 30) expect(x).toBeGreaterThan(previousX);
			else expect(y).toBeGreaterThan(previousY);
		}
	});
});

describe("isRendererAvailable", () => {
	it("is true when the canvas library loaded and every required piece of art is on disk", () => {
		expect(isRendererAvailable()).toBe(true);
	});

	it("is false when gamesAssets reports the board base missing", () => {
		missingMock.mockReturnValue(["monopoly/board-base.png"]);
		expect(isRendererAvailable()).toBe(false);
	});

	it("asks about the board, all six tokens, the house and the hotel, and not the optional art", () => {
		isRendererAvailable();
		const asked = missingMock.mock.calls[0][0] as GameAssetKey[];
		expect(asked).toEqual([
			"monopolyBoardBase",
			"monopolyToken1",
			"monopolyToken2",
			"monopolyToken3",
			"monopolyToken4",
			"monopolyToken5",
			"monopolyToken6",
			"monopolyHouse",
			"monopolyHotel",
		]);
		expect(asked).toHaveLength(MAX_SEATS + 3);
	});
});

describe("renderBoard", () => {
	it("returns null, without throwing or loading anything, when the board base is missing", async () => {
		missingMock.mockReturnValue(["monopoly/board-base.png"]);
		await expect(renderBoard(threeSeatMatch(), NOW)).resolves.toBeNull();
		expect(loadImageMock).not.toHaveBeenCalled();
		expect(createCanvasMock).not.toHaveBeenCalled();
	});

	it("composites the base, then each seat's token in seat order, with the jail stamp over the jailed one", async () => {
		await renderBoard(threeSeatMatch(), NOW);

		const drawn = placements();
		expect(drawn.map((placement) => placement.file)).toEqual([
			"board-base.png",
			"token-1.png",
			"token-2.png",
			"jail-stamp.png",
			"token-3.png",
		]);
		expect(drawn[0].centre).toEqual([0, 0]);
		expect(isTokenOnTile(drawn[1].centre, 0)).toBe(true);
		expect(isTokenOnTile(drawn[2].centre, 10)).toBe(true);
		// The stamp sits on the jailed token itself, slightly larger so it covers it.
		expect(drawn[3].centre).toEqual(drawn[2].centre);
		expect(drawn[3].size).toBeGreaterThan(drawn[2].size);
		expect(isTokenOnTile(drawn[4].centre, 20)).toBe(true);
	});

	it("gives every seat its own slot, so six tokens on one tile are six visible tokens", async () => {
		const state = createInitialState(["s1", "s2", "s3", "s4", "s5", "s6"], { auctionsEnabled: false }, 1_000, 1);
		await renderBoard(state, NOW);

		const tokens = placements().filter((placement) => placement.file.startsWith("token-"));
		expect(tokens).toHaveLength(MAX_SEATS);
		expect(new Set(tokens.map((token) => token.centre.join(","))).size).toBe(MAX_SEATS);
		for (const token of tokens) expect(isTokenOnTile(token.centre, 0)).toBe(true);
	});

	it("leaves a bankrupt seat off the board", async () => {
		const state = threeSeatMatch();
		state.seats[2].bankrupt = true;
		await renderBoard(state, NOW);
		expect(placements().map((placement) => placement.file)).not.toContain("token-3.png");
	});

	it("draws each built lot's houses on its tile, under the tokens, and a hotel alone", async () => {
		const state = threeSeatMatch();
		// Position 1 is the first brown lot, 39 the last dark blue one.
		state.properties["vermillion-alley"] = { ownerId: A, houses: 3, hotel: false, mortgaged: false };
		state.properties["postern-lane"] = { ownerId: B, houses: 0, hotel: true, mortgaged: false };
		await renderBoard(state, NOW);

		const drawn = placements();
		const houses = drawn.filter((placement) => placement.file === "house.png");
		const hotels = drawn.filter((placement) => placement.file === "hotel.png");

		// Position 1 is on the bottom row, so the board's middle is UP (smaller y):
		// three houses side by side across the lot, between its centre and its inner edge.
		const [lotX, lotY] = BOARD_PIXEL_COORDS[1];
		expect(houses).toHaveLength(3);
		expect(new Set(houses.map((house) => house.centre[0])).size).toBe(3);
		for (const house of houses) {
			expect(Math.abs(house.centre[0] - lotX)).toBeLessThanOrEqual(ON_TILE);
			expect(lotY - house.centre[1]).toBeGreaterThan(0);
			expect(lotY - house.centre[1]).toBeLessThan(HALF_LOT_DEPTH);
		}

		// Position 39 is on the right column, so the board's middle is LEFT.
		const [keepX, keepY] = BOARD_PIXEL_COORDS[39];
		expect(hotels).toHaveLength(1);
		expect(Math.abs(hotels[0].centre[1] - keepY)).toBeLessThanOrEqual(ON_TILE);
		expect(keepX - hotels[0].centre[0]).toBeGreaterThan(0);
		expect(keepX - hotels[0].centre[0]).toBeLessThan(HALF_LOT_DEPTH);

		// Buildings first, so a token on a built lot is drawn over them.
		const files = drawn.map((placement) => placement.file);
		const firstToken = files.findIndex((file) => file.startsWith("token-"));
		expect(Math.max(files.lastIndexOf("house.png"), files.lastIndexOf("hotel.png"))).toBeLessThan(firstToken);
	});

	it("returns a PNG attachment named for the moment it was drawn, and the ref that points at it", async () => {
		const rendered = await renderBoard(threeSeatMatch(), NOW);
		expect(rendered?.ref).toBe(`attachment://monopoly-board-${NOW}.png`);
		expect(rendered?.attachment.name).toBe(`monopoly-board-${NOW}.png`);
		expect(rendered?.attachment.attachment).toEqual(Buffer.from("composited-png"));
	});

	it("scales every placement when the art is exported at another size", async () => {
		canvasState.boardWidth = 627;
		await renderBoard(threeSeatMatch(), NOW);

		const drawn = placements();
		expect(createCanvasMock).toHaveBeenCalledWith(627, 627);
		expect(isTokenOnTile(drawn[1].centre, 0, 0.5)).toBe(true);
		expect(isTokenOnTile(drawn[4].centre, 20, 0.5)).toBe(true);
	});

	it("decodes the board once per process, and again only after the cache is cleared", async () => {
		await renderBoard(threeSeatMatch(), NOW);
		await renderBoard(threeSeatMatch(), NOW + 1);
		const boardLoads = () => loadImageMock.mock.calls.filter(([path]) => String(path).endsWith("board-base.png")).length;
		expect(boardLoads()).toBe(1);

		clearRenderCache();
		await renderBoard(threeSeatMatch(), NOW + 2);
		expect(boardLoads()).toBe(2);
	});

	it("still draws the jailed token when the optional jail stamp is missing", async () => {
		pathMock.mockImplementation((key: GameAssetKey) => (key === "monopolyJailStamp" ? null : fakePath(key)));
		const rendered = await renderBoard(threeSeatMatch(), NOW);
		expect(rendered).not.toBeNull();
		expect(placements().map((placement) => placement.file)).toEqual(["board-base.png", "token-1.png", "token-2.png", "token-3.png"]);
	});

	it("answers null instead of throwing when the encode fails, so the move still posts the text board", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		createCanvasMock.mockImplementationOnce((width: number, height: number) => ({
			width,
			height,
			getContext: () => ({ drawImage: vi.fn() }),
			encode: vi.fn(async () => {
				throw new Error("encoder out of memory");
			}),
		}));

		await expect(renderBoard(threeSeatMatch(), NOW)).resolves.toBeNull();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("answers null when a required file vanishes between the check and the load", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		pathMock.mockImplementation((key: GameAssetKey) => (key === "monopolyToken2" ? null : fakePath(key)));
		await expect(renderBoard(threeSeatMatch(), NOW)).resolves.toBeNull();
		warn.mockRestore();
	});
});

describe("logMonopolyRendererStatus", () => {
	it("says the image board is on and lists the Monopoly art still owed", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		missingMock.mockImplementation((keys?: GameAssetKey[]) => (keys?.includes("monopolyWinner") ? ["monopoly/winner.png"] : []));

		logMonopolyRendererStatus();

		const line = String(log.mock.calls[0][0]);
		expect(line).toContain("image board");
		expect(line).toContain("monopoly/winner.png");
		// Every one of the fourteen Monopoly slots is asked about, and nothing else.
		const asked = missingMock.mock.calls.find(([keys]) => (keys as GameAssetKey[]).includes("monopolyWinner"))?.[0] as GameAssetKey[];
		expect(asked).toHaveLength(14);
		expect(asked.every((key) => key.startsWith("monopoly"))).toBe(true);
		log.mockRestore();
	});

	it("says the board stays text when required art is missing", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		missingMock.mockReturnValue(["monopoly/board-base.png"]);

		logMonopolyRendererStatus();

		expect(String(log.mock.calls[0][0])).toContain("text board");
		expect(String(log.mock.calls[0][0])).toContain("monopoly/board-base.png");
		log.mockRestore();
	});
});

describe("when the canvas library does not load", () => {
	it("reports itself unavailable and answers null rather than taking the bot down", async () => {
		vi.resetModules();
		vi.doMock("@napi-rs/canvas", () => {
			throw new Error("Cannot find native binding");
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const isolated = await import("./monopolyRenderer.js");

		expect(isolated.isRendererAvailable()).toBe(false);
		await expect(isolated.renderBoard(threeSeatMatch(), NOW)).resolves.toBeNull();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
		vi.doUnmock("@napi-rs/canvas");
	});
});

// ── the tokens and their name tags (2026-10 item 254, Arcade 12) ──
// Laid out in the art's own pixels, so these read the layout itself rather than pixels.
describe("layoutTokens", () => {
	// Fourteen pixels a character, the same width the canvas mock above measures.
	const measure = (text: string): number => [...text].length * 14;
	const SIX = ["s1", "s2", "s3", "s4", "s5", "s6"];
	const named = (ids: readonly string[]): Map<string, string> => new Map(ids.map((id, index) => [id, `Player ${index + 1}`]));
	const onOneTile = (ids: readonly string[], position: number): MonopolyState => {
		const state = createInitialState([...ids], { auctionsEnabled: false }, 1_000, 1);
		for (const seat of state.seats) seat.position = position;
		return state;
	};
	const pairs = <T>(items: readonly T[]): [T, T][] => items.flatMap((first, index) => items.slice(index + 1).map((second): [T, T] => [first, second]));

	// GO (a corner), a narrow lot on each side, and the top row, whose outer slot has no
	// room above it for a tag.
	for (const position of [0, 3, 13, 23, 33]) {
		it(`keeps six tokens on tile ${position} from covering each other, and every tag clear of the others and of every figure`, () => {
			const laidOut = layoutTokens(onOneTile(SIX, position), named(SIX), measure);
			expect(laidOut).toHaveLength(MAX_SEATS);
			for (const [first, second] of pairs(laidOut)) expect(overlaps(first.figure, second.figure)).toBe(false);

			const tags = laidOut.map((placement) => placement.tag).filter((tag) => tag !== null);
			expect(tags).toHaveLength(MAX_SEATS);
			for (const [first, second] of pairs(tags)) expect(overlaps(first.box, second.box)).toBe(false);
			for (const placement of laidOut) {
				for (const other of laidOut) if (other !== placement) expect(overlaps(placement.tag!.box, other.figure)).toBe(false);
				const { box } = placement.tag!;
				expect(box.x).toBeGreaterThanOrEqual(0);
				expect(box.y).toBeGreaterThanOrEqual(0);
				expect(box.x + box.width).toBeLessThanOrEqual(1254);
				expect(box.y + box.height).toBeLessThanOrEqual(1254);
			}
		});
	}

	it("points each tag's arrow at its own token's head, from above it when there is room", () => {
		const laidOut = layoutTokens(onOneTile(["a", "b"], 3), named(["a", "b"]), measure);
		for (const { figure, tag } of laidOut) {
			expect(tag?.pointsDown).toBe(true);
			expect(tag!.arrowTip[0]).toBeCloseTo(figure.x + figure.width / 2);
			expect(tag!.arrowTip[1]).toBeLessThan(figure.y);
			expect(tag!.box.y + tag!.box.height).toBeLessThan(tag!.arrowTip[1]);
		}
	});

	it("names a token by its display name, cut short with an ellipsis when it would not fit", () => {
		const state = onOneTile(["a", "b"], 3);
		const names = new Map([["a", "Short"], ["b", "A display name far too long for any tag on the board"]]);
		const [short, long] = layoutTokens(state, names, measure);
		expect(short.tag?.text).toBe("Short");
		expect(long.tag?.text.endsWith("…")).toBe(true);
		expect(measure(long.tag!.text)).toBeLessThanOrEqual(168);
		expect("A display name far too long for any tag on the board".startsWith(long.tag!.text.slice(0, -1))).toBe(true);
	});

	it("draws no tag for a seat with no name and leaves a bankrupt seat off entirely", () => {
		const state = onOneTile(["a", "b", "c"], 3);
		state.seats[2].bankrupt = true;
		const laidOut = layoutTokens(state, new Map([["a", "Alpha"]]), measure);
		expect(laidOut.map((placement) => placement.seatIndex)).toEqual([0, 1]);
		expect(laidOut[0].tag?.text).toBe("Alpha");
		expect(laidOut[1].tag).toBeNull();
	});

	it("draws each tag's name on the board picture, over the tokens", async () => {
		const state = onOneTile(["a", "b"], 3);
		await renderBoard(state, NOW, new Map([["a", "Alpha"], ["b", "Dero Red"]]));
		expect(canvasState.texts).toEqual(["Alpha", "Dero Red"]);
	});
});
