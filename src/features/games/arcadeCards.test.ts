import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RenderPayload } from "@features/renderer/index.js";

// ── the arcade cards (2026-10 item 243 Phase 3) ────────────────────────────
// One describe per surface: hangman, blackjack, battleship, the three Monopoly
// cards and the hold em showdown. Each seeds a fixed game state, builds the
// card's view from it the way the handler does, and checks the card comes back
// as a real PNG drawn by the real canvas library. One file rather than five so
// the byte readers are written once without a helper module in src/, which
// tsconfig would compile into the deploy; the leveling cards made the same call.
//
// Beside the pixels, each secret the games keep gets a case: the hangman card
// never sees the word, the public battleship card never sees an unfired ship,
// and the private fleet, the trade and the sealed bid never enter the cache.
// S3 is switched off, so nothing reaches the network.

// The real config with S3 forced off: the dealer's module pulls in the voice
// config as well, so a mock holding only the S3 switch would not load.
vi.mock("@utils/config.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("@utils/config.js")>()), discordBotS3Enabled: false }));
vi.mock("@utils/aws/index.js", () => ({ putObject: vi.fn(), getObjectBytes: vi.fn(async () => null) }));

// The battleship renderer stays real; `fail` stands in for a host where its cards
// do not draw, so the room's message helpers can be read on both paths.
const battleshipSwitch = vi.hoisted(() => ({ fail: false }));
vi.mock("./battleshipRenderer.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./battleshipRenderer.js")>();
	return {
		...real,
		renderBattleshipBoardCard: (view: Parameters<typeof real.renderBattleshipBoardCard>[0]) =>
			battleshipSwitch.fail ? Promise.resolve(null) : real.renderBattleshipBoardCard(view),
		renderBattleshipFleetCard: (view: Parameters<typeof real.renderBattleshipFleetCard>[0]) =>
			battleshipSwitch.fail ? Promise.resolve(null) : real.renderBattleshipFleetCard(view),
	};
});

// The games' art loader stays real; `missing` stands in for a host where none of
// the art is on disk, so each card's drawn stand ins can be read (Phase 3b).
const artSwitch = vi.hoisted(() => ({ missing: false }));
vi.mock("./gamesArt.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./gamesArt.js")>();
	return {
		...real,
		loadGameArt: (key: Parameters<typeof real.loadGameArt>[0]) => (artSwitch.missing ? Promise.resolve(null) : real.loadGameArt(key)),
		loadDeckFaces: (cards: Parameters<typeof real.loadDeckFaces>[0]) =>
			artSwitch.missing ? Promise.resolve({ faceFor: () => null, allPresent: false }) : real.loadDeckFaces(cards),
	};
});

import { cachedCardCount, clearCardCache } from "@features/renderer/cardCache.js";
import { roomOpenerLogo } from "@features/game-rooms/gameRoomsEmbeds.js";
import { renderChallengeCard } from "@features/game-rooms/challengeCardRenderer.js";
import { createHangmanState, applyGuess } from "./hangmanState.js";
import { hangmanCardView, renderHangmanCard } from "./hangmanRenderer.js";
import { settle, type BlackjackTable, type Card as BlackjackCard, type Hand } from "./blackjackState.js";
import { blackjackResultView, blackjackTableView, renderBlackjackResultCard, renderBlackjackTableCard } from "./blackjackRenderer.js";
import { blackjackHandXp } from "./gameXp.js";
import { applyShot, createMatch, startBattle, formatCoord, type BattleshipState } from "./battleshipState.js";
import { renderBattleshipBoardCard } from "./battleshipRenderer.js";
import { battleshipBoardMessage, battleshipBoardView, privateBoardReply } from "@features/game-rooms/roomBattleship.js";
import { OWNABLE_TILES } from "./monopolyBoard.js";
import { createInitialState } from "./monopolyState.js";
import {
	monopolyAuctionView,
	monopolyTradeView,
	monopolyWinnerView,
	renderAuctionCard,
	renderTradeCard,
	renderWinnerCard,
} from "./monopolyRenderer.js";
import { act, actionsFor, createTable, dealHand, handInProgress, joinTable, whoActs } from "./holdemTable.js";
import { toPublicResult, toPublicView } from "@features/dero-brain/dealerNarration.js";
import { dealerShowdownView, holdemLiveView, renderDealerShowdownCard, renderHoldemLiveCard } from "@features/dero-brain/dealerShowdownRenderer.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";

// ── reading the bytes ──
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function attachmentBytes(payload: RenderPayload | null): Buffer {
	if (!payload) throw new Error("expected a rendered card, got null");
	const bytes = payload.attachment.attachment;
	if (!Buffer.isBuffer(bytes)) throw new Error("expected the rendered card to be attached as a Buffer");
	return bytes;
}

// A PNG's IHDR holds width and height big endian at bytes 16 and 20.
function pngSize(payload: RenderPayload | null): { width: number; height: number } {
	const bytes = attachmentBytes(payload);
	expect(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function seededRng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

beforeEach(() => {
	clearCardCache();
	battleshipSwitch.fail = false;
	artSwitch.missing = false;
});

// ── hangman ──
describe("hangmanRenderer", () => {
	it("draws every gallows stage from the empty frame to the full figure", async () => {
		const state = createHangmanState("castle");
		for (let wrong = 0; wrong <= 6; wrong += 1) {
			const card = await renderHangmanCard({ ...hangmanCardView(state), wrong });
			expect(pngSize(card)).toEqual({ width: 960, height: 460 });
		}
	});

	it("draws all three endings", async () => {
		const state = createHangmanState("castle");
		for (const ending of ["solved", "lost", "expired"] as const) {
			expect(pngSize(await renderHangmanCard(hangmanCardView(state, ending))).width).toBe(960);
		}
	});

	it("hands the card only the guessed letters, never the word", () => {
		const state = createHangmanState("castle");
		applyGuess(state, "c");
		applyGuess(state, "z");
		const view = hangmanCardView(state);
		expect(view.revealed).toEqual(["c", null, null, null, null, null]);
		expect(view.misses).toEqual(["z"]);
		expect(JSON.stringify(view)).not.toContain("castle");
	});
});

// ── blackjack ──
const card = (rank: BlackjackCard["rank"], suit: BlackjackCard["suit"]): BlackjackCard => ({ rank, suit });
const hand = (cards: BlackjackCard[], overrides: Partial<Hand> = {}): Hand => ({ cards, status: "stood", doubled: false, fromSplit: false, ...overrides });

function settledTable(): BlackjackTable {
	return {
		seats: [
			{ userId: "u1", username: "Silent Warrior", hands: [hand([card("10", "H"), card("9", "S")])], activeHand: 0 },
			{
				userId: "u2",
				username: "Iron Duke",
				hands: [hand([card("A", "D"), card("K", "C")], { status: "blackjack" }), hand([card("8", "H"), card("8", "C"), card("9", "D")], { status: "bust", doubled: true, fromSplit: true })],
				activeHand: 1,
			},
		],
		dealer: hand([card("10", "S"), card("8", "D")]),
		shoe: [],
		phase: "settled",
		turn: 2,
		hitsSoft17: false,
	};
}

describe("blackjackRenderer", () => {
	it("builds one row per hand with the embed's totals and the XP each hand paid", () => {
		const table = settledTable();
		const results = settle(table);
		const view = blackjackResultView(table, results);
		expect(view.dealer.total).toBe("18");
		expect(view.hands.map((row) => [row.name, row.outcome, row.total])).toEqual([
			["Silent Warrior", "win", "19"],
			["Iron Duke", "blackjack", "soft 21"],
			["Iron Duke", "lose", "25"],
		]);
		expect(view.hands.map((row) => row.xp)).toEqual([blackjackHandXp("win", false), blackjackHandXp("blackjack", false), blackjackHandXp("lose", true)]);
		expect(view.hands[1].label).not.toBeNull();
		expect(view.hands[0].label).toBeNull();
	});

	it("draws the result card, taller for each hand at the table", async () => {
		const table = settledTable();
		const view = blackjackResultView(table, settle(table));
		const three = pngSize(await renderBlackjackResultCard(view));
		const one = pngSize(await renderBlackjackResultCard({ ...view, hands: view.hands.slice(0, 1) }));
		expect(three.width).toBe(960);
		expect(three.height).toBeGreaterThan(one.height);
	});
});

// The same two seats with the hand still in play: seat two has split, is on its
// second hand, and the dealer's 8 of diamonds is the hole card nobody may see.
function tableInPlay(): BlackjackTable {
	return {
		...settledTable(),
		seats: [
			{ userId: "u1", username: "Silent Warrior", hands: [hand([card("10", "H"), card("9", "S")])], activeHand: 1 },
			{
				userId: "u2",
				username: "Iron Duke",
				hands: [hand([card("A", "D"), card("K", "C")], { fromSplit: true }), hand([card("8", "H"), card("3", "C")], { status: "playing", fromSplit: true })],
				activeHand: 1,
			},
		],
		phase: "playing",
		turn: 1,
	};
}

describe("the blackjack table card, drawn every turn (Dero 1.7.0 test fixes, Phase 3a)", () => {
	it("shows the dealer's up card and lays the hole card face down, out of the view entirely", () => {
		const view = blackjackTableView(tableInPlay());
		expect(view.dealer).toEqual({ upCards: [{ rank: "10", suit: "spade" }], faceDown: 1 });
		// The hole card is the 8 of diamonds; the only 8 a player holds is a heart.
		expect(JSON.stringify(view)).not.toContain(`{"rank":"8","suit":"diamond"}`);
	});

	it("marks the hand on the clock and says where every other hand stands", () => {
		const view = blackjackTableView(tableInPlay());
		expect(view.hands.map((row) => [row.name, row.label, row.standing])).toEqual([
			["Silent Warrior", null, "stood"],
			["Iron Duke", "Hand 1 of 2", "stood"],
			["Iron Duke", "Hand 2 of 2", "acting"],
		]);
	});

	it("draws a PNG the size of the result card, and caches it, since it carries nothing private", async () => {
		const view = blackjackTableView(tableInPlay());
		const table = pngSize(await renderBlackjackTableCard(view));
		const result = pngSize(await renderBlackjackResultCard(blackjackResultView(settledTable(), settle(settledTable()))));
		expect(table).toEqual(result);
		expect(cachedCardCount()).toBe(2);
	});

	it("still draws when no art is on disk, the back included, and caches the stand in nowhere", async () => {
		artSwitch.missing = true;
		expect(pngSize(await renderBlackjackTableCard(blackjackTableView(tableInPlay()))).width).toBe(960);
		expect(cachedCardCount()).toBe(0);
	});
});

// ── battleship ──
// Fires every cell of player two's destroyer from player one, with player two
// missing in between, so the match has a miss, two hits and one sunk ship.
function matchWithASinking(): BattleshipState {
	const state = createMatch(
		[
			{ userId: "a", username: "Admiral A" },
			{ userId: "b", username: "Admiral B" },
		],
		seededRng(3)
	);
	// Past setup (post-launch plan item 17): this card is about a battle under way.
	startBattle(state);
	const destroyer = state.players[1].ships.find((ship) => ship.name === "destroyer")!;
	const occupied = new Set(state.players[0].ships.flatMap((ship) => ship.cells.map((cell) => `${cell.x},${cell.y}`)));
	const misses = [];
	for (let y = 0; y < 10 && misses.length < destroyer.cells.length; y += 1) {
		for (let x = 0; x < 10 && misses.length < destroyer.cells.length; x += 1) if (!occupied.has(`${x},${y}`)) misses.push({ x, y });
	}
	destroyer.cells.forEach((cell, index) => {
		applyShot(state, "a", cell);
		applyShot(state, "b", misses[index]);
	});
	return state;
}

describe("battleshipRenderer", () => {
	it("draws the public board with the sinking called out", async () => {
		const state = matchWithASinking();
		const view = battleshipBoardView(state, { shooterId: "a", ship: "destroyer" });
		expect(view.sinking).toMatchObject({ sectionIndex: 0, ship: "destroyer" });
		expect(view.sections[0].sunk.map((ship) => ship.name)).toEqual(["destroyer"]);
		expect(pngSize(await renderBattleshipBoardCard(view))).toEqual({ width: 1000, height: 666 });
	});

	it("never puts an unfired ship cell into the public view", () => {
		const state = matchWithASinking();
		const view = battleshipBoardView(state);
		view.sections.forEach((section, index) => {
			const target = state.players[1 - index];
			for (const ship of target.ships) {
				for (const cell of ship.cells) {
					const fired = target.shots.has(`${cell.x},${cell.y}`);
					if (!fired) expect(section.grid[cell.y][cell.x], `unfired ${formatCoord(cell)}`).toBe("unknown");
				}
			}
			for (const ship of section.sunk) for (const cell of ship.cells) expect(target.shots.has(`${cell.x},${cell.y}`)).toBe(true);
		});
	});

	it("posts the board message with the card, or the emoji grids when it does not draw", async () => {
		const state = matchWithASinking();
		const drawn = await battleshipBoardMessage(state, "room-1");
		expect(drawn.files).toHaveLength(1);
		expect(drawn.embeds[0].data.image?.url).toBe(`attachment://${drawn.files[0].name}`);
		expect(drawn.embeds[0].data.description).not.toContain("🌊");

		battleshipSwitch.fail = true;
		const fallback = await battleshipBoardMessage(state, "room-1");
		expect(fallback.files).toEqual([]);
		expect(fallback.embeds[0].data.image).toBeUndefined();
		expect(fallback.embeds[0].data.description).toContain("🌊");
	});

	it("sends the private fleet as a card that is never cached, or the emoji grid when it does not draw", async () => {
		const state = matchWithASinking();
		const drawn = await privateBoardReply(state, "b");
		expect(drawn.files).toHaveLength(1);
		// The board spans the card, with no admiral beside it (2026-10 item 245 Phase 3b).
		expect(pngSize({ attachment: drawn.files[0], ref: "" })).toEqual({ width: 640, height: 744 });
		expect(cachedCardCount()).toBe(0);

		battleshipSwitch.fail = true;
		const fallback = await privateBoardReply(state, "b");
		expect(fallback.files).toEqual([]);
		expect(fallback.embeds[0].data.description).toContain("🚢");
	});
});

// ── monopoly ──
describe("monopoly cards", () => {
	const [first, second, third] = OWNABLE_TILES;

	it("draws the trade card and never caches it, since the terms are private until accepted", async () => {
		const view = monopolyTradeView({ properties: [first.id, second.id], chips: 100, gojf: 1 }, { properties: [third.id], chips: 0, gojf: 0 });
		expect(view.youGet.lots.map((lot) => lot.name)).toEqual([first.name, second.name]);
		expect(pngSize(await renderTradeCard(view))).toEqual({ width: 960, height: 440 });
		expect(cachedCardCount()).toBe(0);
	});

	it("draws an empty side as nothing, and a long side with the overflow line", async () => {
		const many = OWNABLE_TILES.slice(0, 9).map((tile) => tile.id);
		const view = monopolyTradeView({ properties: many, chips: 50, gojf: 0 }, { properties: [], chips: 0, gojf: 0 });
		expect(pngSize(await renderTradeCard(view)).width).toBe(960);
	});

	it("draws the auction card and never caches it, since the bid is sealed", async () => {
		const view = monopolyAuctionView({ tileId: first.id, bids: {}, roundOpenedAt: 1, skippedBy: "a" }, 120);
		expect(view.lot).toMatchObject({ name: first.name, price: first.price });
		expect(pngSize(await renderAuctionCard(view))).toEqual({ width: 960, height: 340 });
		expect(cachedCardCount()).toBe(0);
	});

	it("draws the winner card with every seat's standing, and caches it", async () => {
		const state = createInitialState(["a", "b", "c"], { auctionsEnabled: false }, 1_000, 1);
		state.properties[first.id] = { ...state.properties[first.id], ownerId: "a" };
		state.seats[2].bankrupt = true;
		state.winnerId = "a";
		const view = monopolyWinnerView(state, new Map([["a", "Lady Ledger"], ["b", "Baron Bricks"]]));
		expect(view.winner).toBe("Lady Ledger");
		expect(view.standings.map((standing) => [standing.name, standing.lots, standing.bankrupt])).toEqual([
			["Lady Ledger", 1, false],
			["Baron Bricks", 0, false],
			["Seat 3", 0, true],
		]);
		expect(pngSize(await renderWinnerCard(view)).width).toBe(960);
		expect(cachedCardCount()).toBe(1);
	});
});

// ── hold em ──
describe("dealerShowdownRenderer", () => {
	function playedToShowdown() {
		const table = createTable(5, { maxSeats: 6, startingStack: 5000, smallBlind: 100, bigBlind: 200 });
		for (let index = 0; index < 3; index += 1) joinTable(table, `p${index}`, `Player ${index}`);
		table.status = "playing";
		const rng = seededRng(11);
		dealHand(table, rng);
		let outcome: ReturnType<typeof act> | undefined;
		for (let guard = 0; handInProgress(table) && guard < 100; guard += 1) {
			const actor = whoActs(table)!;
			const legal = actionsFor(table, actor).map((entry) => entry.action);
			outcome = act(table, actor, legal.includes("check") ? "check" : "call", 0, rng);
		}
		return { view: toPublicView(table), result: toPublicResult(outcome)! };
	}

	it("builds the showdown from the public view: the board, the pot paid and every seat", () => {
		const { view, result } = playedToShowdown();
		const showdown = dealerShowdownView(view, result);
		expect(showdown.board).toHaveLength(5);
		expect(showdown.pot).toBe(result.winners.reduce((total, winner) => total + winner.amount, 0));
		expect(showdown.winnerLines).toHaveLength(result.winners.length);
		expect(showdown.seats.map((seat) => seat.name)).toEqual(["Player 0", "Player 1", "Player 2"]);
	});

	it("draws the showdown card, one strip row per seat", async () => {
		const { view, result } = playedToShowdown();
		expect(pngSize(await renderDealerShowdownCard(dealerShowdownView(view, result)))).toEqual({ width: 960, height: 260 + 3 * 56 + 40 });
	});
});

describe("the hold em live table card, every action at every table (Dero 1.7.0 test fixes, Phase 3a)", () => {
	// The private card field's name, built from halves the way the dealer tripwire does.
	const PRIVATE_CARDS_FIELD = "hole" + "Cards";

	function tableOnTheFlop() {
		const table = createTable(5);
		for (let index = 0; index < 3; index += 1) joinTable(table, `p${index}`, `Player ${index}`);
		table.status = "playing";
		const rng = seededRng(11);
		dealHand(table, rng);
		for (let guard = 0; table.board.length === 0 && guard < 10; guard += 1) {
			const actor = whoActs(table)!;
			const legal = actionsFor(table, actor).map((entry) => entry.action);
			act(table, actor, legal.includes("check") ? "check" : "call", 0, rng);
		}
		table.seats[2].sittingOut = true;
		return table;
	}

	it("builds from the public view: the board, the pot, whose turn, and each seat's stack and last action", () => {
		const table = tableOnTheFlop();
		const live = holdemLiveView(toPublicView(table), 60);
		expect(live.board).toHaveLength(3);
		expect(live.pot).toBe(60);
		const actingName = table.seats.find((seat) => seat.userId === whoActs(table))!.username;
		expect(live.headline).toBe(gameRoomsCopy.holdem.cardToAct(actingName));
		expect(live.seats.map((seat) => seat.lastAction)).toEqual(expect.arrayContaining([gameRoomsCopy.holdem.cardCall, gameRoomsCopy.holdem.cardCheck]));
		expect(live.seats[2].standing).toBe("sittingOut");
		expect(live.seats.filter((seat) => seat.isActing)).toHaveLength(1);
	});

	it("carries no player's private cards at any depth", () => {
		const table = tableOnTheFlop();
		const live = JSON.stringify(holdemLiveView(toPublicView(table), 60));
		expect(live).not.toContain(PRIVATE_CARDS_FIELD);
		// The only cards in the view are the board's three.
		expect(live.match(/"suit"/g)).toHaveLength(3);
	});

	it("draws a PNG with one strip row per seat, and caches it, since it is public", async () => {
		const live = holdemLiveView(toPublicView(tableOnTheFlop()), 60);
		expect(pngSize(await renderHoldemLiveCard(live))).toEqual({ width: 960, height: 260 + 3 * 56 + 40 });
		expect(cachedCardCount()).toBe(1);
	});

	it("draws a table still waiting for buy ins, with nothing dealt", async () => {
		const table = createTable(5);
		joinTable(table, "p0", "Player 0");
		const live = holdemLiveView(toPublicView(table), 0);
		expect(live.headline).toBe(gameRoomsCopy.holdem.cardJoining);
		expect(pngSize(await renderHoldemLiveCard(live))).toEqual({ width: 960, height: 260 + 56 + 40 });
	});

	it("still draws when no art is on disk, and caches the stand in nowhere", async () => {
		artSwitch.missing = true;
		expect(pngSize(await renderHoldemLiveCard(holdemLiveView(toPublicView(tableOnTheFlop()), 60))).width).toBe(960);
		expect(cachedCardCount()).toBe(0);
	});
});

// ── the owner's art (2026-10 item 243 Phase 3b) ──
describe("the arcade art", () => {
	function settledBlackjack() {
		const table = settledTable();
		return blackjackResultView(table, settle(table));
	}

	function finishedMonopoly() {
		const state = createInitialState(["a", "b", "c"], { auctionsEnabled: false }, 1_000, 1);
		state.seats[2].bankrupt = true;
		state.winnerId = "a";
		return monopolyWinnerView(state, new Map([["a", "Lady Ledger"]]));
	}

	it("caches a card drawn entirely from its art", async () => {
		await renderHangmanCard(hangmanCardView(createHangmanState("castle")));
		await renderBlackjackResultCard(settledBlackjack());
		await renderWinnerCard(finishedMonopoly());
		expect(cachedCardCount()).toBe(3);
	});

	it("still draws every card when no art is on disk, and caches none of them", async () => {
		artSwitch.missing = true;
		const state = matchWithASinking();
		expect(pngSize(await renderHangmanCard(hangmanCardView(createHangmanState("castle"), "lost"))).width).toBe(960);
		expect(pngSize(await renderBattleshipBoardCard(battleshipBoardView(state, { shooterId: "a", ship: "destroyer" }))).width).toBe(1000);
		expect(pngSize(await renderBlackjackResultCard(settledBlackjack())).width).toBe(960);
		expect(pngSize(await renderWinnerCard(finishedMonopoly())).width).toBe(960);
		// The logo file is on disk but nothing decodes, so the band is drawn empty.
		const challenge = { game: "battleship" as const, status: "open" as const, host: { name: "Host", avatar: null }, challengers: [], hiddenCount: 0 };
		expect(pngSize(await renderChallengeCard(challenge))).toEqual({ width: 960, height: 620 });
		expect(cachedCardCount()).toBe(0);
	});

	it("puts the game's logo on a hangman or battleship room opener, and nothing on a game without one", () => {
		expect(roomOpenerLogo("hangman")?.ref).toBe("attachment://opener-logo-stacked.png");
		expect(roomOpenerLogo("battleship")?.ref).toBe("attachment://opener-logo.png");
		expect(roomOpenerLogo("monopoly")).toBeNull();
	});
});
