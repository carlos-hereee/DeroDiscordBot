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
	creditClaim: vi.fn(),
	settleClaim: vi.fn(),
	findClaim: vi.fn(),
	findOpenClaims: vi.fn(),
}));

vi.mock("@db/stores/deroCoinStore.js", () => ({ deroCoinStore: mocks }));

import { awardForClaim, awardForResult, awardReleaseGift, settleOpenCoinClaims, claimKeyFor, coinAmountFor, coinTierOf, readCoinBalance } from "./deroCoins.js";

const NOW = new Date("2026-10-27T15:00:00Z");
const BOT = "dero-bot-red";

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.insertAward.mockResolvedValue(true);
	mocks.sumGameCoinsSince.mockResolvedValue(0);
	mocks.creditClaim.mockResolvedValue(true);
	mocks.settleClaim.mockResolvedValue(undefined);
	mocks.findClaim.mockResolvedValue(null);
	mocks.findOpenClaims.mockResolvedValue([]);
});

// The owner's "drip" amounts of 2026-10-28 (2026-10 item 267, decision 4).
describe("the coin table", () => {
	it.each([
		["holdem", 5, 2, 1],
		["monopoly", 5, 2, 1],
		["battleship", 5, 2, 1],
		["hangman", 2, 1, 1],
		["blackjack", 2, 1, 1],
		["coinflip", 2, 1, 1],
		["diceroll", 2, 1, 1],
		["rps", 2, 1, 1],
	] as const)("%s pays %i for a win, %i for a draw, %i for playing", (game, win, draw, play) => {
		expect(coinAmountFor(game, "won", false)).toBe(win);
		expect(coinAmountFor(game, "drawn", false)).toBe(draw);
		expect(coinAmountFor(game, "played", false)).toBe(play);
	});

	it.each(["solo-coinflip", "solo-diceroll", "solo-rps", "solo-hangman", "solo-blackjack"] as const)("%s, a round against Dero, pays no coins", (game) => {
		expect(coinTierOf(game)).toBe("solo");
		expect(coinAmountFor(game, "won", false)).toBe(0);
		expect(coinAmountFor(game, "drawn", false)).toBe(0);
		expect(coinAmountFor(game, "played", false)).toBe(0);
	});

	it("pays the play amount only for a match with a Dero bot seat, even a win", () => {
		expect(coinAmountFor("holdem", "won", true)).toBe(1);
		expect(coinAmountFor("battleship", "won", true)).toBe(1);
		expect(coinAmountFor("monopoly", "drawn", true)).toBe(1);
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

		expect(mocks.insertAward).toHaveBeenCalledWith({ userId: "u1", guildId: "g1", amount: 5, source: "game", game: "battleship", outcome: "won", roomId: "room1", at: NOW });
		expect(mocks.credit).toHaveBeenCalledWith("u1", 5);
		expect(mocks.credit).toHaveBeenCalledWith("u2", 1);
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
		expect(mocks.credit).toHaveBeenCalledWith("u1", 2);
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
		expect(mocks.credit).toHaveBeenCalledWith("u1", 1);
		expect(mocks.credit).not.toHaveBeenCalledWith(BOT, expect.anything());
	});

	it("pays a solo round nothing, but still writes its row at zero so a retry stays a duplicate", async () => {
		await awardForResult({ guildId: "g1", game: "solo-coinflip", resultKey: "i1", players: [{ userId: "u1", outcome: "won" }], now: NOW });

		expect(mocks.sumGameCoinsSince).toHaveBeenCalledWith("u1", expect.arrayContaining(["solo-coinflip", "solo-diceroll", "solo-rps", "solo-hangman", "solo-blackjack"]), new Date("2026-10-27T00:00:00Z"));
		expect(mocks.insertAward).toHaveBeenCalledWith(expect.objectContaining({ amount: 0, roomId: "i1" }));
		expect(mocks.credit).not.toHaveBeenCalled();
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

describe("awardReleaseGift", () => {
	const gift = { guildId: "g1", userId: "u1", giftKey: "age-limit-apology", now: NOW };

	it("pays the listed coins, on a claim row of its own that no UTC day key can equal", async () => {
		await expect(awardReleaseGift(gift)).resolves.toEqual({ status: "paid", amount: 5 });
		expect(mocks.insertAward).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", amount: 5, source: "claim", claimKey: "release:age-limit-apology", settled: false }));
		expect(mocks.creditClaim).toHaveBeenCalledWith("u1", 5, "release:age-limit-apology");
		expect(mocks.settleClaim).toHaveBeenCalledWith("release:age-limit-apology", "u1");
	});

	it("pays nothing on a second press, in this server or another", async () => {
		mocks.insertAward.mockResolvedValue(false);
		mocks.findClaim.mockResolvedValue({ amount: 5, settled: true });
		await expect(awardReleaseGift({ ...gift, guildId: "g2" })).resolves.toEqual({ status: "already" });
		expect(mocks.creditClaim).not.toHaveBeenCalled();
	});

	it("loses nothing when the credit fails: the log row stays open and the next press pays", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.creditClaim.mockRejectedValueOnce(new Error("the network dropped"));
		await expect(awardReleaseGift(gift)).resolves.toEqual({ status: "failed" });
		expect(mocks.settleClaim).not.toHaveBeenCalled();
		logged.mockRestore();

		mocks.insertAward.mockResolvedValue(false);
		mocks.findClaim.mockResolvedValue({ amount: 5, settled: false });
		await expect(awardReleaseGift(gift)).resolves.toEqual({ status: "paid", amount: 5 });
		expect(mocks.settleClaim).toHaveBeenCalledOnce();
	});

	it("doubles nothing when the wallet paid but the row never closed: the receipt refuses the retry", async () => {
		mocks.insertAward.mockResolvedValue(false);
		mocks.findClaim.mockResolvedValue({ amount: 5, settled: false });
		mocks.creditClaim.mockResolvedValue(false);
		await expect(awardReleaseGift(gift)).resolves.toEqual({ status: "already" });
		expect(mocks.settleClaim).toHaveBeenCalledOnce();
	});

	it("still says paid when closing the row fails after the coins landed", async () => {
		const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.settleClaim.mockRejectedValue(new Error("the network dropped"));
		await expect(awardReleaseGift(gift)).resolves.toEqual({ status: "paid", amount: 5 });
		warned.mockRestore();
	});

	it("pays nothing for a gift the table does not list", async () => {
		await expect(awardReleaseGift({ ...gift, giftKey: "made-up" })).resolves.toEqual({ status: "unknown" });
		expect(mocks.insertAward).not.toHaveBeenCalled();
	});

	it("never throws to the button", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.insertAward.mockRejectedValue(new Error("the network dropped"));
		await expect(awardReleaseGift(gift)).resolves.toEqual({ status: "failed" });
		logged.mockRestore();
	});
});

describe("settleOpenCoinClaims", () => {
	it("finishes a claim a crash left open, paying only what the wallet has no receipt for", async () => {
		mocks.findOpenClaims.mockResolvedValue([
			{ userId: "u1", amount: 5, claimKey: "release:age-limit-apology" },
			{ userId: "u2", amount: 3, claimKey: "2026-11-06" },
		]);
		mocks.creditClaim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

		await expect(settleOpenCoinClaims()).resolves.toBe(1);
		expect(mocks.settleClaim).toHaveBeenCalledTimes(2);
	});

	it("never stops a boot", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.findOpenClaims.mockRejectedValue(new Error("the network dropped"));
		await expect(settleOpenCoinClaims()).resolves.toBe(0);
		logged.mockRestore();
	});
});

describe("awardForClaim", () => {
	// One coin claim a day across every server (2026-10 item 267 Session 1a).
	it("keys the claim by the UTC day alone, so every server shares it", () => {
		expect(claimKeyFor(NOW)).toBe("2026-10-27");
	});

	it.each([
		["won", 3],
		["tie", 2],
		["lost", 1],
	] as const)("pays a %s round %i coins from the claim table", async (outcome, coins) => {
		await expect(awardForClaim({ guildId: "g1", userId: "u1", outcome, now: NOW })).resolves.toBe(coins);
		expect(mocks.insertAward).toHaveBeenCalledWith({ userId: "u1", guildId: "g1", amount: coins, source: "claim", claimKey: "2026-10-27", settled: false, at: NOW });
		expect(mocks.creditClaim).toHaveBeenCalledWith("u1", coins, "2026-10-27");
	});

	it("pays a claim in server A, then in server B the same day, once", async () => {
		await awardForClaim({ guildId: "gA", userId: "u1", outcome: "won", now: NOW });
		mocks.insertAward.mockResolvedValue(false);
		await expect(awardForClaim({ guildId: "gB", userId: "u1", outcome: "won", now: NOW })).resolves.toBe(0);
		// Both rows carry the same day key, so the unique claim index refuses the second.
		expect(mocks.insertAward.mock.calls.map((call) => (call[0] as { claimKey: string }).claimKey)).toEqual(["2026-10-27", "2026-10-27"]);
		expect(mocks.creditClaim).toHaveBeenCalledTimes(1);
	});
});

describe("readCoinBalance", () => {
	it("reads 0 before the first award", async () => {
		mocks.findWallet.mockResolvedValue(null);
		await expect(readCoinBalance("u1")).resolves.toBe(0);
	});
});
