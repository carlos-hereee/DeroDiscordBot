import { describe, it, expect, vi, beforeEach } from "vitest";

// ── deroCoins ───────────────────────────────────────────────────────────────
// The coin table by game and result, the bot seat rule, the solo daily cap, and the
// money invariant: the award row is inserted first and the wallet moves only when that
// insert succeeded, so a result reported twice pays once (risk R3). The store is mocked;
// the unique indexes themselves are Mongo's.

const mocks = vi.hoisted(() => ({
	insertAward: vi.fn(),
	credit: vi.fn(),
	sumGameCoinsSince: vi.fn(),
	hasClaim: vi.fn(),
	findWallet: vi.fn(),
}));

vi.mock("@db/stores/deroCoinStore.js", () => ({ deroCoinStore: mocks }));

import { awardForClaim, awardForResult, claimKeyFor, coinAmountFor, coinTierOf, readCoinBalance } from "./deroCoins.js";

const NOW = new Date("2026-10-27T15:00:00Z");
const BOT = "dero-bot-red";

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.insertAward.mockResolvedValue(true);
	mocks.sumGameCoinsSince.mockResolvedValue(0);
});

describe("the coin table", () => {
	it.each([
		["holdem", 30, 15, 10],
		["monopoly", 30, 15, 10],
		["battleship", 30, 15, 10],
		["hangman", 12, 6, 4],
		["blackjack", 12, 6, 4],
		["coinflip", 12, 6, 4],
		["diceroll", 12, 6, 4],
		["rps", 12, 6, 4],
	] as const)("%s pays %i for a win, %i for a draw, %i for playing", (game, win, draw, play) => {
		expect(coinAmountFor(game, "won", false)).toBe(win);
		expect(coinAmountFor(game, "drawn", false)).toBe(draw);
		expect(coinAmountFor(game, "played", false)).toBe(play);
	});

	it.each(["solo-coinflip", "solo-diceroll", "solo-rps", "solo-hangman", "solo-blackjack"] as const)("%s, a round against Dero, pays 3 for a win and 1 otherwise", (game) => {
		expect(coinTierOf(game)).toBe("solo");
		expect(coinAmountFor(game, "won", false)).toBe(3);
		expect(coinAmountFor(game, "drawn", false)).toBe(1);
		expect(coinAmountFor(game, "played", false)).toBe(1);
	});

	it("pays the play amount only for a match with a Dero bot seat, even a win", () => {
		expect(coinAmountFor("holdem", "won", true)).toBe(10);
		expect(coinAmountFor("battleship", "won", true)).toBe(10);
		expect(coinAmountFor("monopoly", "drawn", true)).toBe(10);
	});
});

describe("awardForResult", () => {
	it("inserts the award row first, then credits the wallet, for every player", async () => {
		await awardForResult({
			guildId: "g1",
			game: "battleship",
			resultKey: "room1",
			players: [
				{ userId: "u1", outcome: "won" },
				{ userId: "u2", outcome: "played" },
			],
			now: NOW,
		});

		expect(mocks.insertAward).toHaveBeenCalledWith({ userId: "u1", guildId: "g1", amount: 30, source: "game", game: "battleship", outcome: "won", roomId: "room1", at: NOW });
		expect(mocks.credit).toHaveBeenCalledWith("u1", 30);
		expect(mocks.credit).toHaveBeenCalledWith("u2", 10);
		expect(mocks.insertAward.mock.invocationCallOrder[0]).toBeLessThan(mocks.credit.mock.invocationCallOrder[0]);
	});

	// Risk R3: a retry, a rematch press or a sweep finishing a finished room.
	it("pays a result awarded twice for the same room and member once", async () => {
		const result = { guildId: "g1", game: "rps" as const, resultKey: "room1", players: [{ userId: "u1", outcome: "won" as const }], now: NOW };
		await awardForResult(result);
		mocks.insertAward.mockResolvedValue(false);
		await awardForResult(result);

		expect(mocks.insertAward).toHaveBeenCalledTimes(2);
		expect(mocks.credit).toHaveBeenCalledTimes(1);
		expect(mocks.credit).toHaveBeenCalledWith("u1", 12);
	});

	it("never pays a bot seat, and pays the humans at a bot table the play amount", async () => {
		await awardForResult({
			guildId: "g1",
			game: "holdem",
			resultKey: "room1",
			players: [
				{ userId: "u1", outcome: "won" },
				{ userId: BOT, outcome: "played" },
			],
			now: NOW,
		});

		expect(mocks.insertAward).toHaveBeenCalledTimes(1);
		expect(mocks.credit).toHaveBeenCalledWith("u1", 10);
		expect(mocks.credit).not.toHaveBeenCalledWith(BOT, expect.anything());
	});

	it("stops solo rounds at the daily cap: a win past 28 coins pays the 2 left, and nothing at 30", async () => {
		mocks.sumGameCoinsSince.mockResolvedValueOnce(28).mockResolvedValueOnce(30);
		const solo = (resultKey: string) => ({ guildId: "g1", game: "solo-coinflip" as const, resultKey, players: [{ userId: "u1", outcome: "won" as const }], now: NOW });

		await awardForResult(solo("i1"));
		await awardForResult(solo("i2"));

		expect(mocks.sumGameCoinsSince).toHaveBeenCalledWith("u1", expect.arrayContaining(["solo-coinflip", "solo-diceroll", "solo-rps", "solo-hangman", "solo-blackjack"]), new Date("2026-10-27T00:00:00Z"));
		expect(mocks.credit).toHaveBeenCalledTimes(1);
		expect(mocks.credit).toHaveBeenCalledWith("u1", 2);
		// The capped round still writes its row, at zero, so a retry of it stays a duplicate.
		expect(mocks.insertAward).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 0, roomId: "i2" }));
	});

	it("never reads the cap for a match between members", async () => {
		await awardForResult({ guildId: "g1", game: "hangman", resultKey: "room1", players: [{ userId: "u1", outcome: "won" }], now: NOW });
		expect(mocks.sumGameCoinsSince).not.toHaveBeenCalled();
	});

	it("logs a failed write and never throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.insertAward.mockRejectedValue(new Error("db down"));
		await expect(awardForResult({ guildId: "g1", game: "rps", resultKey: "room1", players: [{ userId: "u1", outcome: "won" }], now: NOW })).resolves.toBeUndefined();
		expect(mocks.credit).not.toHaveBeenCalled();
	});
});

describe("awardForClaim", () => {
	it("keys the claim by the UTC day and the guild", () => {
		expect(claimKeyFor("g1", NOW)).toBe("2026-10-27:g1");
	});

	it.each([
		[2, 20],
		[1.5, 15],
		[1, 10],
	])("pays the base 10 coins times %d: %i", async (multiplier, coins) => {
		await expect(awardForClaim({ guildId: "g1", userId: "u1", multiplier, now: NOW })).resolves.toBe(coins);
		expect(mocks.insertAward).toHaveBeenCalledWith({ userId: "u1", guildId: "g1", amount: coins, source: "claim", claimKey: "2026-10-27:g1", at: NOW });
		expect(mocks.credit).toHaveBeenCalledWith("u1", coins);
	});

	it("pays a claim submitted twice in a day once", async () => {
		await awardForClaim({ guildId: "g1", userId: "u1", multiplier: 2, now: NOW });
		mocks.insertAward.mockResolvedValue(false);
		await expect(awardForClaim({ guildId: "g1", userId: "u1", multiplier: 2, now: NOW })).resolves.toBe(0);
		expect(mocks.credit).toHaveBeenCalledTimes(1);
	});
});

describe("readCoinBalance", () => {
	it("reads 0 before the first award", async () => {
		mocks.findWallet.mockResolvedValue(null);
		await expect(readCoinBalance("u1")).resolves.toBe(0);
	});
});
