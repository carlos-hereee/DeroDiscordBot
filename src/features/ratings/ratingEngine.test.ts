import { describe, it, expect } from "vitest";
import {
	displayRating,
	fitsBand,
	houseTablePlaces,
	isRankedMatch,
	isLuckGame,
	isProvisional,
	isRatedGame,
	isRatedHoldemSession,
	newRating,
	rateAgainstHouse,
	rateFinishingOrder,
	rateRanks,
	UNRATED_STANDING,
	type RatingStanding,
} from "./ratingEngine.js";

// ── ratingEngine ─────────────────────────────────────────────────────────
// The pure rating math of 2026-10 item 244: the direction an OpenSkill update moves
// each finisher, the display formula, the provisional boundary and every branch of
// the band check. No store, no Discord.

const settled = (displayRatingValue: number): RatingStanding => ({ displayRating: displayRatingValue, ratedGames: 25 });
const provisional = (displayRatingValue: number): RatingStanding => ({ displayRating: displayRatingValue, ratedGames: 3 });

describe("rateFinishingOrder", () => {
	it("moves a fresh 4 player table in finishing order: the winner up most, last place down", () => {
		const fresh = newRating();
		const after = rateFinishingOrder([fresh, fresh, fresh, fresh]);

		expect(after).toHaveLength(4);
		expect(after[0].mu).toBeGreaterThan(fresh.mu);
		expect(after[3].mu).toBeLessThan(fresh.mu);
		// Strictly ordered: each place ends above the one below it.
		expect(after[0].mu).toBeGreaterThan(after[1].mu);
		expect(after[1].mu).toBeGreaterThan(after[2].mu);
		expect(after[2].mu).toBeGreaterThan(after[3].mu);
		// Every player played, so every estimate got more certain.
		for (const rating of after) expect(rating.sigma).toBeLessThan(fresh.sigma);
	});

	it("moves a heads up winner up and the loser down by the same mean shift", () => {
		const fresh = newRating();
		const [winner, loser] = rateFinishingOrder([fresh, fresh]);

		expect(winner.mu - fresh.mu).toBeCloseTo(fresh.mu - loser.mu, 6);
		expect(displayRating(winner)).toBeGreaterThan(displayRating(loser));
	});

	it("answers a lone player unchanged, since one player is not a match", () => {
		const fresh = newRating();
		expect(rateFinishingOrder([fresh])).toEqual([fresh]);
		expect(rateFinishingOrder([])).toEqual([]);
	});
});

describe("displayRating", () => {
	it("reads 1000 for a fresh rating, whose mu minus 3 sigma is 0", () => {
		expect(displayRating(newRating())).toBe(1000);
		expect(UNRATED_STANDING).toEqual({ displayRating: 1000, ratedGames: 0 });
	});

	it("is round(1000 + 40 x (mu minus 3 sigma))", () => {
		expect(displayRating({ mu: 30, sigma: 2 })).toBe(1000 + 40 * (30 - 6));
		expect(displayRating({ mu: 20, sigma: 5 })).toBe(1000 + 40 * (20 - 15));
		// An ordinal of 0.3125 is 12.5 display points, and 1012.5 rounds up.
		expect(displayRating({ mu: 3.3125, sigma: 1 })).toBe(1013);
	});

	it("goes below 1000 for a player whose skill is still near the uncertain floor", () => {
		expect(displayRating({ mu: 10, sigma: 5 })).toBe(1000 + 40 * (10 - 15));
	});
});

describe("isProvisional", () => {
	it("marks 9 rated games provisional and 10 settled", () => {
		expect(isProvisional(0)).toBe(true);
		expect(isProvisional(9)).toBe(true);
		expect(isProvisional(10)).toBe(false);
	});
});

describe("isRatedHoldemSession", () => {
	it("rates a session from 10 dealt hands, never under", () => {
		expect(isRatedHoldemSession(3)).toBe(false);
		expect(isRatedHoldemSession(9)).toBe(false);
		expect(isRatedHoldemSession(10)).toBe(true);
	});
});

describe("rated and luck games", () => {
	it("rates exactly Hold'em, Battleship, Monopoly and Blackjack", () => {
		expect(["holdem", "battleship", "monopoly", "blackjack"].every(isRatedGame)).toBe(true);
		for (const game of ["coinflip", "diceroll", "rps", "hangman", "solo-blackjack", "solo-hangman"]) {
			expect(isRatedGame(game)).toBe(false);
		}
	});

	it("keeps luck stats for exactly coin flip, dice roll and rock paper scissors", () => {
		expect(["coinflip", "diceroll", "rps"].every(isLuckGame)).toBe(true);
		expect(isLuckGame("holdem")).toBe(false);
		expect(isLuckGame("hangman")).toBe(false);
	});
});

describe("fitsBand", () => {
	it("admits everyone under Any, however far apart", () => {
		expect(fitsBand(settled(1000), settled(2500), "any")).toBe(true);
	});

	it("treats a provisional host as Any, whatever the preset", () => {
		expect(fitsBand(provisional(1000), settled(2500), "tight")).toBe(true);
		expect(fitsBand(provisional(1000), settled(2500), "close")).toBe(true);
	});

	it("fits a provisional joiner into every band", () => {
		expect(fitsBand(settled(1000), provisional(2500), "tight")).toBe(true);
		expect(fitsBand(settled(1000), provisional(2500), "close")).toBe(true);
	});

	it("admits a settled joiner within 150 for Close, inclusive, and refuses 151", () => {
		expect(fitsBand(settled(1200), settled(1350), "close")).toBe(true);
		expect(fitsBand(settled(1200), settled(1050), "close")).toBe(true);
		expect(fitsBand(settled(1200), settled(1351), "close")).toBe(false);
		expect(fitsBand(settled(1200), settled(1049), "close")).toBe(false);
	});

	it("admits a settled joiner within 75 for Tight, inclusive, and refuses 76", () => {
		expect(fitsBand(settled(1200), settled(1275), "tight")).toBe(true);
		expect(fitsBand(settled(1200), settled(1125), "tight")).toBe(true);
		expect(fitsBand(settled(1200), settled(1276), "tight")).toBe(false);
		expect(fitsBand(settled(1200), settled(1124), "tight")).toBe(false);
	});
});

// ── ties and the house (2026-10 item 276, owner decision D8) ──────────────
describe("rateRanks", () => {
	it("moves two fresh players who tie by nothing in mu", () => {
		const [first, second] = rateRanks([
			{ ...newRating(), rank: 1 },
			{ ...newRating(), rank: 1 },
		]);
		expect(first.mu).toBeCloseTo(newRating().mu, 6);
		expect(second.mu).toBeCloseTo(newRating().mu, 6);
		expect(first.sigma).toBeLessThan(newRating().sigma);
	});

	it("answers a lone entrant unchanged", () => {
		expect(rateRanks([{ mu: 30, sigma: 4, rank: 1 }])).toEqual([{ mu: 30, sigma: 4 }]);
	});
});

describe("houseTablePlaces", () => {
	it("places seats by their result against their buy in, the house standing at zero", () => {
		expect(
			houseTablePlaces([
				{ userId: "loser", net: -50 },
				{ userId: "winner", net: 200 },
				{ userId: "level", net: 0 },
			])
		).toEqual({
			seats: [
				{ userId: "winner", rank: 1 },
				{ userId: "level", rank: 2 },
				{ userId: "loser", rank: 3 },
			],
			houseRank: 2,
		});
	});

	it("gives equal results one place, so two seats on top share first and the house sits second", () => {
		const places = houseTablePlaces([
			{ userId: "a", net: 100 },
			{ userId: "b", net: 100 },
			{ userId: "c", net: -100 },
		]);
		expect(places.seats.map((seat) => seat.rank)).toEqual([1, 1, 3]);
		expect(places.houseRank).toBe(2);
	});
});

describe("rateAgainstHouse", () => {
	it("lifts a seat that beat the house, lowers one that lost, and answers only the seats", () => {
		const after = rateAgainstHouse(
			[
				{ ...newRating(), rank: 1 },
				{ ...newRating(), rank: 3 },
			],
			2
		);
		expect(after).toHaveLength(2);
		expect(after[0].mu).toBeGreaterThan(newRating().mu);
		expect(after[1].mu).toBeLessThan(newRating().mu);
	});

	// A draw still shrinks sigma, so it lifts the shown number: why a table must settle a hand to rate.
	it("rates a lone seat that broke even as a draw with the house, which still lifts the shown number", () => {
		const [after] = rateAgainstHouse([{ ...newRating(), rank: 1 }], 1);
		expect(after.mu).toBeCloseTo(newRating().mu, 6);
		expect(after.sigma).toBeLessThan(newRating().sigma);
		expect(displayRating(after)).toBeGreaterThan(displayRating(newRating()));
	});
});

describe("isRankedMatch", () => {
	it("is a rated game with no Dero bot whose host did not choose Casual", () => {
		expect(isRankedMatch("blackjack", 0, false)).toBe(true);
		expect(isRankedMatch("holdem", 0, false)).toBe(true);
		expect(isRankedMatch("holdem", 1, false)).toBe(false);
		expect(isRankedMatch("holdem", 0, true)).toBe(false);
		expect(isRankedMatch("solo-blackjack", 0, false)).toBe(false);
		expect(isRankedMatch("hangman", 0, false)).toBe(false);
	});
});
