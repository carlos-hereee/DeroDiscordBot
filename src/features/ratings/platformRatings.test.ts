import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Client } from "discord.js";

const mocks = vi.hoisted(() => ({
	allConsenting: vi.fn(),
	ratingsOf: vi.fn(),
	boards: vi.fn(),
}));

vi.mock("@db/stores/networkConsentStore.js", () => ({ networkConsentStore: { allConsentingUserIds: mocks.allConsenting } }));
vi.mock("@db/stores/playerRatingStore.js", () => ({ playerRatingStore: { findForPlayersInAllGames: mocks.ratingsOf } }));
vi.mock("./serverRatings.js", () => ({ serverBoardsByGame: mocks.boards }));

import { buildPlatformRatings, gameSpreads, platformServerRows, ratingDistribution, readPlatformRatings } from "./platformRatings.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { RatedGame } from "./ratingEngine.js";
import type { ServerRatingRow } from "./serverRatings.js";

// ── the platform ratings block (2026-10 item 244 Phase 5c) ─────────────────
// What Dero's Castle reads beside the render analytics: each rated game's consenting
// players and how their display ratings spread in 100 point buckets, and the server
// boards with names, tags and ratings only. A failed or slow read answers null, so the
// render report it rides with always answers.

const client = {} as Client;
const rating = (userId: string, game: string, displayRating: number) => ({ userId, game, displayRating });
const server = (name: string, tag: string | null, value: number): ServerRatingRow => ({ guildId: `id-${name}`, name, tag, rating: value, members: 5 });
const emptyBoards = () => new Map<RatedGame, ServerRatingRow[]>([["holdem", []], ["battleship", []], ["monopoly", []]]);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.allConsenting.mockResolvedValue([]);
	mocks.ratingsOf.mockResolvedValue([]);
	mocks.boards.mockResolvedValue(emptyBoards());
});

describe("ratingDistribution", () => {
	it("buckets by 100 points, each bucket named by its lowest rating", () => {
		expect(BOT_CONSTANTS.RATINGS.DISTRIBUTION_BUCKET).toBe(100);
		expect(ratingDistribution([1000, 1099, 1100, 1250])).toEqual([
			{ bucket: 1000, count: 2 },
			{ bucket: 1100, count: 1 },
			{ bucket: 1200, count: 1 },
		]);
	});

	it("keeps an empty bucket between two full ones as a zero, so the gap shows", () => {
		expect(ratingDistribution([880, 1210])).toEqual([
			{ bucket: 800, count: 1 },
			{ bucket: 900, count: 0 },
			{ bucket: 1000, count: 0 },
			{ bucket: 1100, count: 0 },
			{ bucket: 1200, count: 1 },
		]);
	});

	it("floors a rating below zero into its own bucket rather than the zero bucket", () => {
		expect(ratingDistribution([-30, 40])).toEqual([
			{ bucket: -100, count: 1 },
			{ bucket: 0, count: 1 },
		]);
	});

	it("has no buckets when nobody holds a rating", () => {
		expect(ratingDistribution([])).toEqual([]);
	});
});

describe("gameSpreads", () => {
	it("answers every rated game in order, a game nobody plays with no players and no buckets", () => {
		const spreads = gameSpreads([rating("a", "holdem", 1010), rating("b", "holdem", 1190), rating("a", "monopoly", 950)]);
		expect(spreads.map((spread) => spread.game)).toEqual(["holdem", "battleship", "monopoly"]);
		expect(spreads[0]).toEqual({ game: "holdem", players: 2, distribution: [{ bucket: 1000, count: 1 }, { bucket: 1100, count: 1 }] });
		expect(spreads[1]).toEqual({ game: "battleship", players: 0, distribution: [] });
		expect(spreads[2]).toEqual({ game: "monopoly", players: 1, distribution: [{ bucket: 900, count: 1 }] });
	});

	it("leaves out a row of a game that is not rated", () => {
		expect(gameSpreads([rating("a", "coinflip", 1500)]).every((spread) => spread.players === 0)).toBe(true);
	});
});

describe("platformServerRows", () => {
	it("lists each game's board best first, game by game, with no guild id or member count", () => {
		const boards = emptyBoards();
		boards.set("holdem", [server("First", "ONE", 1300), server("Second", null, 1100)]);
		boards.set("monopoly", [server("First", "ONE", 1050)]);
		const rows = platformServerRows(boards);
		expect(rows).toEqual([
			{ guildName: "First", tag: "ONE", game: "holdem", rating: 1300 },
			{ guildName: "Second", tag: null, game: "holdem", rating: 1100 },
			{ guildName: "First", tag: "ONE", game: "monopoly", rating: 1050 },
		]);
		expect(JSON.stringify(rows)).not.toContain("id-First");
	});
});

describe("buildPlatformRatings", () => {
	it("counts consenting players only, reading their ratings in one query, beside the server boards", async () => {
		mocks.allConsenting.mockResolvedValue(["a", "b"]);
		mocks.ratingsOf.mockResolvedValue([rating("a", "holdem", 1000), rating("b", "battleship", 1320)]);
		const boards = emptyBoards();
		boards.set("battleship", [server("Fleet", "FLT", 1210)]);
		mocks.boards.mockResolvedValue(boards);

		const block = await buildPlatformRatings(client);

		expect(mocks.allConsenting).toHaveBeenCalledWith(BOT_CONSTANTS.NETWORK.CONSENT_VERSION);
		expect(mocks.ratingsOf).toHaveBeenCalledWith(["a", "b"]);
		expect(mocks.boards).toHaveBeenCalledWith(client);
		expect(block.games.map((spread) => spread.players)).toEqual([1, 1, 0]);
		expect(block.servers).toEqual([{ guildName: "Fleet", tag: "FLT", game: "battleship", rating: 1210 }]);
	});

	it("carries no user id anywhere in the block", async () => {
		mocks.allConsenting.mockResolvedValue(["user-secret-1"]);
		mocks.ratingsOf.mockResolvedValue([rating("user-secret-1", "holdem", 1000)]);
		expect(JSON.stringify(await buildPlatformRatings(client))).not.toContain("user-secret-1");
	});
});

describe("readPlatformRatings", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("answers the block when the reads succeed", async () => {
		mocks.allConsenting.mockResolvedValue(["a"]);
		mocks.ratingsOf.mockResolvedValue([rating("a", "holdem", 1000)]);
		expect((await readPlatformRatings(client))?.games[0].players).toBe(1);
	});

	it("answers null, never a rejection, when a read fails", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.boards.mockRejectedValue(new Error("discord unreachable"));
		await expect(readPlatformRatings(client)).resolves.toBeNull();
		expect(consoleError).toHaveBeenCalled();
	});

	it("answers null once the block runs past its time, so the render report is not held up", async () => {
		vi.useFakeTimers();
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.boards.mockReturnValue(new Promise(() => undefined));
		const read = readPlatformRatings(client, 1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(read).resolves.toBeNull();
		expect(consoleWarn).toHaveBeenCalled();
	});

	it("waits under the server's own 5 second timeout for the bot", () => {
		expect(BOT_CONSTANTS.RATINGS.PLATFORM_REPORT_TIMEOUT_MS).toBeLessThan(5_000);
	});
});
