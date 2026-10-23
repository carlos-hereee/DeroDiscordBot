import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import type { IPlayerRating } from "@db/models/PlayerRating.js";

// ── ratingBoards ───────────────────────────────────────────────────────────
// The read side every arcade board and the monthly post share (2026-10 item 244
// Phase 3b). The promises that matter: a board ranks only players who played in
// THIS server, only current members appear, a provisional rating is marked, the
// luck board adds the three games up and hides anyone under 20 decided games, and
// a hand key the pack cannot phrase is skipped, never printed.

const mocks = vi.hoisted(() => ({
	playerIdsInGuild: vi.fn(),
	findForPlayers: vi.fn(),
	findAllForPlayer: vi.fn(),
	luckForGuildMonth: vi.fn(),
	handsForGuildMonth: vi.fn(),
}));

vi.mock("@db/stores/matchResultStore.js", () => ({ matchResultStore: { playerIdsInGuild: mocks.playerIdsInGuild } }));
vi.mock("@db/stores/playerRatingStore.js", () => ({
	playerRatingStore: { findForPlayers: mocks.findForPlayers, findAllForPlayer: mocks.findAllForPlayer },
}));
vi.mock("@db/stores/luckStatStore.js", () => ({ luckStatStore: { findForGuildMonth: mocks.luckForGuildMonth } }));
vi.mock("@db/stores/gameResultCountStore.js", () => ({ gameResultCountStore: { findForGuildMonth: mocks.handsForGuildMonth } }));

import {
	formatLuckScore,
	formatRating,
	luckBoardInGuild,
	memberRatings,
	rankLuck,
	rankWinningHands,
	sumLuckByPlayer,
	topRatedInGuild,
	topWinningHands,
	type NameResolver,
} from "./ratingBoards.js";

const rating = (userId: string, displayRating: number, ratedGames: number, game = "holdem"): IPlayerRating => ({
	userId,
	game,
	mu: 25,
	sigma: 8,
	ratedGames,
	displayRating,
	lastRatedAt: new Date("2026-10-20T00:00:00Z"),
});

const luckRow = (userId: string, game: string, decided: number, wins: number) => ({ guildId: "g1", userId, game, month: "2026-10", decided, wins });

// Names every id except the ones listed as gone, the way a guild's member list would.
function resolverWithout(...gone: string[]): Mock<NameResolver> {
	return vi.fn<NameResolver>(async (userIds) => new Map(userIds.filter((id) => !gone.includes(id)).map((id) => [id, `Name ${id}`])));
}

beforeEach(() => {
	mocks.playerIdsInGuild.mockReset().mockResolvedValue([]);
	mocks.findForPlayers.mockReset().mockResolvedValue([]);
	mocks.findAllForPlayer.mockReset().mockResolvedValue([]);
	mocks.luckForGuildMonth.mockReset().mockResolvedValue([]);
	mocks.handsForGuildMonth.mockReset().mockResolvedValue([]);
});

describe("memberRatings", () => {
	it("answers every rated game in order, null where the member has no rated result yet", async () => {
		mocks.findAllForPlayer.mockResolvedValue([rating("u1", 1120, 4, "battleship")]);
		expect(await memberRatings("u1")).toEqual([
			{ game: "holdem", rating: null },
			{ game: "battleship", rating: { displayRating: 1120, ratedGames: 4, provisional: true } },
			{ game: "monopoly", rating: null },
		]);
	});

	it("answers only the asked game, settled from 10 rated games", async () => {
		mocks.findAllForPlayer.mockResolvedValue([rating("u1", 1180, 10, "holdem"), rating("u1", 990, 2, "monopoly")]);
		expect(await memberRatings("u1", ["holdem"])).toEqual([{ game: "holdem", rating: { displayRating: 1180, ratedGames: 10, provisional: false } }]);
	});
});

describe("topRatedInGuild", () => {
	it("ranks only players with a result in this server, best first, current members only", async () => {
		mocks.playerIdsInGuild.mockResolvedValue(["a", "b", "c", "gone"]);
		mocks.findForPlayers.mockResolvedValue([rating("a", 1040, 12), rating("gone", 1300, 30), rating("b", 1210, 3), rating("c", 1040, 15)]);

		const players = await topRatedInGuild({ guildId: "g1", game: "holdem", limit: 10, resolveNames: resolverWithout("gone") });

		expect(mocks.playerIdsInGuild).toHaveBeenCalledWith("g1", "holdem", undefined);
		expect(mocks.findForPlayers).toHaveBeenCalledWith(["a", "b", "c", "gone"], "holdem");
		// "gone" left the server; a and c tie on rating and c's 15 games outrank a's 12.
		expect(players.map((player) => [player.userId, player.displayRating, player.provisional])).toEqual([
			["b", 1210, true],
			["c", 1040, false],
			["a", 1040, false],
		]);
		expect(players[0].displayName).toBe("Name b");
	});

	it("walks past departed players to fill the board, one slice at a time", async () => {
		mocks.playerIdsInGuild.mockResolvedValue(["x", "y", "z"]);
		mocks.findForPlayers.mockResolvedValue([rating("x", 1300, 20), rating("y", 1200, 20), rating("z", 1100, 20)]);
		const resolveNames = resolverWithout("x");

		const players = await topRatedInGuild({ guildId: "g1", game: "holdem", limit: 1, resolveNames });

		expect(players.map((player) => player.userId)).toEqual(["y"]);
		expect(resolveNames).toHaveBeenCalledTimes(2);
	});

	it("reads nothing more for a server nobody played the game in", async () => {
		expect(await topRatedInGuild({ guildId: "g1", game: "monopoly", limit: 10, resolveNames: resolverWithout() })).toEqual([]);
		expect(mocks.findForPlayers).not.toHaveBeenCalled();
	});
});

describe("the luck board", () => {
	it("adds a player's three games into one tally", () => {
		const tallies = sumLuckByPlayer([luckRow("a", "coinflip", 10, 7), luckRow("a", "rps", 12, 5), luckRow("b", "diceroll", 3, 1)]);
		expect(tallies.get("a")).toEqual({ decided: 22, wins: 12 });
		expect(tallies.get("b")).toEqual({ decided: 3, wins: 1 });
	});

	it("hides anyone under 20 decided games and ranks the rest by wins above even", () => {
		const ranked = rankLuck(
			new Map([
				["lucky", { decided: 24, wins: 18 }],
				["even", { decided: 20, wins: 10 }],
				["unlucky", { decided: 30, wins: 9 }],
				["new", { decided: 19, wins: 19 }],
			])
		);
		expect(ranked.map((row) => [row.userId, row.score])).toEqual([
			["lucky", 6],
			["even", 0],
			["unlucky", -6],
		]);
	});

	it("reads this guild's month and keeps current members only", async () => {
		mocks.luckForGuildMonth.mockResolvedValue([luckRow("a", "coinflip", 20, 15), luckRow("gone", "coinflip", 40, 40)]);
		const players = await luckBoardInGuild({ guildId: "g1", month: "2026-10", limit: 10, resolveNames: resolverWithout("gone") });
		expect(mocks.luckForGuildMonth).toHaveBeenCalledWith("g1", "2026-10");
		expect(players).toEqual([{ userId: "a", displayName: "Name a", decided: 20, wins: 15, score: 5 }]);
	});
});

describe("the winning hands", () => {
	const words = rokCommanderCopy.holdemHands;
	const row = (label: string, count: number) => ({ guildId: "g1", game: "holdem", month: "2026-09", label, count });

	it("phrases keys in members' words, most frequent first, top three", () => {
		const hands = rankWinningHands([row("pair:A", 4), row("full house:K", 9), row("straight flush:A", 1), row("two pair:Q", 4)], words, 3);
		expect(hands).toEqual([
			{ phrase: "kings full", count: 9 },
			{ phrase: "pair of aces", count: 4 },
			{ phrase: "queens up", count: 4 },
		]);
	});

	it("skips a key the pack cannot phrase rather than printing it", () => {
		const hands = rankWinningHands([row("nonsense", 50), row("pair:Z", 40), row("straight flush:A", 1)], words, 3);
		expect(hands).toEqual([{ phrase: "royal flush", count: 1 }]);
		expect(hands.every((hand) => !hand.phrase.includes(":"))).toBe(true);
	});

	it("reads Hold'em's month for this guild", async () => {
		mocks.handsForGuildMonth.mockResolvedValue([row("three of a kind:7", 2)]);
		expect(await topWinningHands({ guildId: "g1", month: "2026-09", limit: 3, words })).toEqual([{ phrase: "three sevens", count: 2 }]);
		expect(mocks.handsForGuildMonth).toHaveBeenCalledWith("g1", "holdem", "2026-09");
	});
});

describe("formatting", () => {
	it("marks a provisional rating and leaves a settled one bare", () => {
		expect(formatRating({ displayRating: 1120, provisional: true }, "?")).toBe("1120?");
		expect(formatRating({ displayRating: 1120, provisional: false }, "?")).toBe("1120");
	});

	it("signs a luck score to one decimal at most", () => {
		expect(formatLuckScore(6.5)).toBe("+6.5");
		expect(formatLuckScore(4)).toBe("+4");
		expect(formatLuckScore(0)).toBe("0");
		expect(formatLuckScore(-2)).toBe("-2");
	});
});
