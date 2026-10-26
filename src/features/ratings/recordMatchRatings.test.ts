import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@db/stores/playerRatingStore.js", () => ({
	playerRatingStore: { findForPlayers: vi.fn(), applyRating: vi.fn() },
}));
vi.mock("@db/stores/matchResultStore.js", () => ({ matchResultStore: { insertOnce: vi.fn() } }));

import {
	monopolyFinishingOrder,
	onRatedWin,
	ratedOrder,
	recordMatchRatings,
	twoPlayerFinishingOrder,
	type RatingRoom,
} from "./recordMatchRatings.js";
import { displayRating, isRatedHoldemSession, newRating } from "./ratingEngine.js";
import { playerRatingStore } from "@db/stores/playerRatingStore.js";
import { matchResultStore } from "@db/stores/matchResultStore.js";
import { createTable, dealHand, handInProgress, joinTable, act, whoActs, leaveTable, placements, type HoldemTable } from "@features/games/holdemTable.js";
import { applyForfeit, createInitialState } from "@features/games/monopolyState.js";
import type { IMatchResult } from "@db/models/MatchResult.js";

// ── recordMatchRatings ───────────────────────────────────────────────────
// What:  the finish site recorder of 2026-10 item 244, against mocked stores. The
//        finishing orders come from the REAL engines (a Hold'em table played and
//        left seat by seat, a Monopoly match forfeited seat by seat), so a change to
//        how either engine records who went out first fails here.
// Pins:  rank order and rating direction, the 10 hand Hold'em minimum, the Battleship
//        forfeit, the Monopoly elimination order, that an abandoned room writes
//        nothing, and that an excluded player is recorded but never rated.

const ratingStore = playerRatingStore as unknown as {
	findForPlayers: ReturnType<typeof vi.fn>;
	applyRating: ReturnType<typeof vi.fn>;
};
const resultStore = matchResultStore as unknown as { insertOnce: ReturnType<typeof vi.fn> };

const NOW = new Date("2026-10-23T20:00:00.000Z");
const FRESH_DISPLAY = displayRating(newRating());

const room = (game: string, roomId = "room-1"): RatingRoom => ({ roomId, guildId: "guild-1", game }) as RatingRoom;

function seededRng(seed = 7): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

/**
 * A 4 seat table that dealt `hands` hands (each folded round to one player, so
 * nobody busts on chips), then lost seats to Leave table in `leaveOrder`, which the
 * engine records in bustOrder exactly as it records a bust. The last leave leaves
 * one seat, which ends the tournament.
 */
function holdemSession(hands: number, leaveOrder: string[]): HoldemTable {
	const table = createTable(NOW.getTime());
	for (const userId of ["a", "b", "c", "d"]) joinTable(table, userId, userId.toUpperCase());
	table.status = "playing";
	const rng = seededRng();
	for (let hand = 0; hand < hands; hand++) {
		dealHand(table, rng);
		while (handInProgress(table)) act(table, whoActs(table)!, "fold", 0, rng);
	}
	for (const userId of leaveOrder) leaveTable(table, userId, rng);
	return table;
}

const insertedResult = (): IMatchResult => resultStore.insertOnce.mock.calls[0][0] as IMatchResult;
const appliedFor = (userId: string) =>
	ratingStore.applyRating.mock.calls.find((call) => call[0] === userId)?.[2] as { mu: number; displayRating: number } | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	ratingStore.findForPlayers.mockResolvedValue([]);
	ratingStore.applyRating.mockResolvedValue(undefined);
	resultStore.insertOnce.mockResolvedValue(true);
});

describe("Hold'em", () => {
	it("rates a 12 hand, 4 player session by bust order: the winner, then the last seat out", async () => {
		// d went out first, then b, then c, which leaves a the winner.
		const table = holdemSession(12, ["d", "b", "c"]);
		expect(table.status).toBe("finished");
		expect(placements(table)).toEqual(["a", "c", "b", "d"]);

		await recordMatchRatings(room("holdem"), placements(table), [], { rated: isRatedHoldemSession(table.handNumber), now: NOW });

		const result = insertedResult();
		expect(result).toMatchObject({ roomId: "room-1", guildId: "guild-1", game: "holdem", rated: true, finishedAt: NOW });
		expect(result.entries.map((entry) => [entry.userId, entry.rank])).toEqual([
			["a", 1],
			["c", 2],
			["b", 3],
			["d", 4],
		]);
		// Fresh players, so every before reads the fresh display, and the order of the
		// afters follows the finishing order.
		expect(result.entries.every((entry) => entry.displayBefore === FRESH_DISPLAY)).toBe(true);
		const afters = result.entries.map((entry) => entry.displayAfter!);
		expect(afters[0]).toBeGreaterThan(FRESH_DISPLAY);
		expect(afters[0]).toBeGreaterThan(afters[1]);
		expect(afters[1]).toBeGreaterThan(afters[2]);
		expect(afters[2]).toBeGreaterThan(afters[3]);

		expect(ratingStore.findForPlayers).toHaveBeenCalledWith(["a", "c", "b", "d"], "holdem");
		expect(ratingStore.applyRating).toHaveBeenCalledTimes(4);
		expect(appliedFor("a")!.mu).toBeGreaterThan(appliedFor("d")!.mu);
		expect(appliedFor("a")!.displayRating).toBe(afters[0]);
	});

	it("records a 3 hand session unrated and moves no rating", async () => {
		const table = holdemSession(3, ["d", "b", "c"]);
		expect(table.handNumber).toBe(3);

		await recordMatchRatings(room("holdem"), placements(table), [], { rated: isRatedHoldemSession(table.handNumber), now: NOW });

		const result = insertedResult();
		expect(result.rated).toBe(false);
		expect(result.entries.map((entry) => entry.rank)).toEqual([1, 2, 3, 4]);
		expect(result.entries.every((entry) => entry.displayBefore === null && entry.displayAfter === null)).toBe(true);
		expect(ratingStore.findForPlayers).not.toHaveBeenCalled();
		expect(ratingStore.applyRating).not.toHaveBeenCalled();
	});

	it("starts a returning player from their stored rating, not a fresh one", async () => {
		ratingStore.findForPlayers.mockResolvedValue([{ userId: "a", mu: 32, sigma: 3 }]);

		await recordMatchRatings(room("holdem"), ["a", "b"], [], { now: NOW });

		const entryA = insertedResult().entries.find((entry) => entry.userId === "a")!;
		expect(entryA.displayBefore).toBe(displayRating({ mu: 32, sigma: 3 }));
		expect(insertedResult().entries.find((entry) => entry.userId === "b")!.displayBefore).toBe(FRESH_DISPLAY);
	});
});

describe("Battleship", () => {
	it("rates a turn timeout forfeit: the player who kept playing wins", async () => {
		await recordMatchRatings(room("battleship"), twoPlayerFinishingOrder(["host", "guest"], "guest"), [], { now: NOW });

		const result = insertedResult();
		expect(result.rated).toBe(true);
		expect(result.entries.map((entry) => [entry.userId, entry.rank])).toEqual([
			["guest", 1],
			["host", 2],
		]);
		expect(appliedFor("guest")!.mu).toBeGreaterThan(appliedFor("host")!.mu);
	});
});

describe("Monopoly", () => {
	it("rates the winner first, then the seats in reverse elimination order, forfeits counting as bankruptcies", async () => {
		let state = createInitialState(["a", "b", "c", "d"], { auctionsEnabled: false }, NOW.getTime(), 1);
		// b goes out first, then d, then a, which leaves c.
		for (const seatId of ["b", "d", "a"]) {
			const result = applyForfeit(state, seatId, NOW.getTime());
			expect(result.ok).toBe(true);
			if (result.ok) state = result.state;
		}
		expect(state.phase).toBe("finished");
		expect(monopolyFinishingOrder(state)).toEqual(["c", "a", "d", "b"]);

		await recordMatchRatings(room("monopoly"), monopolyFinishingOrder(state), [], { now: NOW });

		expect(insertedResult().entries.map((entry) => [entry.userId, entry.rank])).toEqual([
			["c", 1],
			["a", 2],
			["d", 3],
			["b", 4],
		]);
		expect(ratingStore.applyRating).toHaveBeenCalledTimes(4);
	});

	it("leaves out a non winning seat with no elimination stamp rather than guessing its place", () => {
		const order = monopolyFinishingOrder({
			winnerId: "a",
			seats: [
				{ userId: "a", bankruptedAt: null },
				{ userId: "b", bankruptedAt: 1 },
				{ userId: "c", bankruptedAt: null },
			],
		});
		expect(order).toEqual(["a", "b"]);
	});
});

describe("what is never rated", () => {
	it("writes nothing at all for an abandoned room", async () => {
		await recordMatchRatings(room("holdem"), ["a", "b", "c"], [], { abandoned: true, now: NOW });

		expect(resultStore.insertOnce).not.toHaveBeenCalled();
		expect(ratingStore.findForPlayers).not.toHaveBeenCalled();
		expect(ratingStore.applyRating).not.toHaveBeenCalled();
	});

	it("writes nothing for a game outside the rated three", async () => {
		for (const game of ["coinflip", "diceroll", "rps", "hangman", "solo-blackjack"]) {
			await recordMatchRatings(room(game), ["a", "b"], [], { now: NOW });
		}
		expect(resultStore.insertOnce).not.toHaveBeenCalled();
		expect(ratingStore.applyRating).not.toHaveBeenCalled();
	});

	it("records an excluded player as excluded and leaves them out of the rate call", async () => {
		// k was kicked; the finish site still lists them in the order (a kicked Hold'em
		// seat sits in bustOrder), and the exclusion must win.
		await recordMatchRatings(room("holdem"), ["a", "k", "b"], ["k"], { now: NOW });

		expect(ratingStore.findForPlayers).toHaveBeenCalledWith(["a", "b"], "holdem");
		expect(ratingStore.applyRating.mock.calls.map((call) => call[0]).sort()).toEqual(["a", "b"]);
		const result = insertedResult();
		expect(result.rated).toBe(true);
		expect(result.entries).toContainEqual({ userId: "k", rank: null, excluded: true, displayBefore: null, displayAfter: null });
		expect(result.entries.filter((entry) => !entry.excluded).map((entry) => [entry.userId, entry.rank])).toEqual([
			["a", 1],
			["b", 2],
		]);
	});

	// 2026-10 item 250 Phase 5: a bot is beatable on purpose, so nothing earned off one rates.
	it("records a match with a Dero bot unrated, with the bot left out of the result", async () => {
		await recordMatchRatings(room("holdem"), ["a", "dero-bot-red", "b"], [], { now: NOW });

		const result = insertedResult();
		expect(result.rated).toBe(false);
		expect(result.entries.map((entry) => entry.userId)).toEqual(["a", "b"]);
		expect(ratingStore.applyRating).not.toHaveBeenCalled();
	});

	// 2026-10 item 254, Arcade 6: the host chose Casual, and people taking every bot's seat
	// before the start leaves an all member table that still does not rate.
	it("records a Casual match unrated even with no Dero bot left at the table", async () => {
		await recordMatchRatings({ ...room("monopoly"), casual: true }, ["a", "b", "c"], [], { now: NOW });

		const result = insertedResult();
		expect(result.rated).toBe(false);
		expect(result.entries.map((entry) => entry.userId)).toEqual(["a", "b", "c"]);
		expect(ratingStore.applyRating).not.toHaveBeenCalled();
	});

	it("still rates the same table when the host kept it Rated", async () => {
		await recordMatchRatings({ ...room("monopoly"), casual: false }, ["a", "b", "c"], [], { now: NOW });

		expect(insertedResult().rated).toBe(true);
		expect(ratingStore.applyRating).toHaveBeenCalledTimes(3);
	});

	it("records a match left with one rated player unrated", async () => {
		await recordMatchRatings(room("battleship"), ["a", "b"], ["b"], { now: NOW });

		expect(insertedResult().rated).toBe(false);
		expect(ratingStore.applyRating).not.toHaveBeenCalled();
	});
});

describe("the claim and the failure path", () => {
	it("moves no rating when the match result was already recorded", async () => {
		resultStore.insertOnce.mockResolvedValue(false);

		await recordMatchRatings(room("battleship"), ["a", "b"], [], { now: NOW });

		expect(ratingStore.applyRating).not.toHaveBeenCalled();
	});

	it("never rejects when a store write fails, and the next match still records", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		resultStore.insertOnce.mockRejectedValueOnce(new Error("atlas down"));

		await expect(recordMatchRatings(room("battleship", "room-a"), ["a", "b"], [], { now: NOW })).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledOnce();

		await recordMatchRatings(room("battleship", "room-b"), ["a", "b"], [], { now: NOW });
		expect(ratingStore.applyRating).toHaveBeenCalledTimes(2);
		errorSpy.mockRestore();
	});
});

describe("ratedOrder", () => {
	it("keeps each player once, at their first place", () => {
		expect(ratedOrder(["a", "b", "a", "c"], [])).toEqual(["a", "b", "c"]);
	});
});

// ── a rated win is announced (2026-10 item 244 Phase 5b) ───────────────────
// The tag notice listens for these, so exactly a RATED win must announce, once.
describe("onRatedWin", () => {
	it("announces the winner of a rated match once, after the ratings moved", async () => {
		const heard: Array<{ winnerId: string; roomId: string }> = [];
		const stop = onRatedWin((win) => heard.push({ winnerId: win.winnerId, roomId: win.room.roomId }));
		try {
			await recordMatchRatings(room("battleship"), twoPlayerFinishingOrder(["host", "guest"], "guest"), [], { now: NOW });
			expect(heard).toEqual([{ winnerId: "guest", roomId: "room-1" }]);
			expect(ratingStore.applyRating).toHaveBeenCalled();
		} finally {
			stop();
		}
	});

	it("announces nothing for an unrated match, an abandoned room, or a match already recorded", async () => {
		const heard: string[] = [];
		const stop = onRatedWin((win) => heard.push(win.winnerId));
		try {
			await recordMatchRatings(room("holdem"), ["a", "b"], [], { rated: false, now: NOW });
			await recordMatchRatings(room("holdem"), ["a", "b"], [], { abandoned: true, now: NOW });
			resultStore.insertOnce.mockResolvedValue(false);
			await recordMatchRatings(room("battleship"), ["a", "b"], [], { now: NOW });
			expect(heard).toEqual([]);
		} finally {
			stop();
		}
	});

	it("keeps rating when a listener throws, and stops calling a listener that stopped listening", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const stopThrowing = onRatedWin(() => {
			throw new Error("listener broke");
		});
		const heard: string[] = [];
		const stop = onRatedWin((win) => heard.push(win.winnerId));
		stop();
		try {
			await expect(recordMatchRatings(room("battleship"), ["a", "b"], [], { now: NOW })).resolves.toBeUndefined();
			expect(ratingStore.applyRating).toHaveBeenCalledTimes(2);
			expect(heard).toEqual([]);
		} finally {
			stopThrowing();
			error.mockRestore();
		}
	});
});
