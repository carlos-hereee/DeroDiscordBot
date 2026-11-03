import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, User } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── gameXp ─────────────────────────────────────────────────────────────────
// The games feature's only seam into leveling. What is worth pinning is the
// PAYOUT SHAPE, because it is the thing a player will notice and argue about:
// the winner earns more than the loser, a draw sits between the two, and a
// hangman round that somebody else solved credits the other guessers with an
// assist rather than a loss.

const mocks = vi.hoisted(() => ({ awardXp: vi.fn(), awardForResult: vi.fn() }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: mocks.awardXp }));
// The coin amounts are deroCoins.test.ts's; this pins what each helper hands it.
vi.mock("@features/economy/deroCoins.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/economy/deroCoins.js")>()),
	awardForResult: mocks.awardForResult,
}));

import { awardBlackjackResult, awardBlackjackTableCoins, awardMultiPlayerResult, awardSoloLuckResult, awardTwoPlayerResult } from "./gameXp.js";
import type { SeatResult } from "./blackjackState.js";

const { GAME_PLAY_XP, GAME_WIN_XP, GAME_TIE_XP, BLACKJACK_NATURAL_XP, BLACKJACK_DOUBLE_WIN_MULTIPLIER } = BOT_CONSTANTS.LEVELING;

const client = {} as Client;
const user = (id: string): User => ({ id, username: id, globalName: id }) as unknown as User;

interface Award {
	userId: string;
	username?: string;
	amount: number;
	outcome?: string;
	game?: string;
	source: string;
}

const awards = (): Award[] => mocks.awardXp.mock.calls.map((call) => call[0] as Award);
const awardFor = (userId: string): Award | undefined => awards().find((award) => award.userId === userId);

beforeEach(() => {
	mocks.awardXp.mockReset().mockResolvedValue(undefined);
	mocks.awardForResult.mockReset().mockResolvedValue(undefined);
});

describe("two player results (duel and rps share this)", () => {
	const duel = (winner: "challenger" | "opponent" | "tie") =>
		awardTwoPlayerResult({
			client,
			guildId: "g1",
			game: "diceroll",
			challenger: user("challenger"),
			opponent: user("opponent"),
			winner,
		});

	it("pays BOTH players, and the winner more", async () => {
		duel("challenger");

		expect(awards()).toHaveLength(2);
		expect(awardFor("challenger")?.amount).toBe(GAME_PLAY_XP + GAME_WIN_XP);
		expect(awardFor("opponent")?.amount).toBe(GAME_PLAY_XP);
		expect(awardFor("challenger")!.amount).toBeGreaterThan(awardFor("opponent")!.amount);
	});

	it("records the outcome on both sides so the /account record stays symmetric", async () => {
		duel("opponent");
		expect(awardFor("opponent")?.outcome).toBe("won");
		expect(awardFor("challenger")?.outcome).toBe("lost");
	});

	it("pays a tie to both as DRAWN, at an amount between losing and winning", async () => {
		duel("tie");

		expect(awardFor("challenger")?.amount).toBe(GAME_TIE_XP);
		expect(awardFor("opponent")?.amount).toBe(GAME_TIE_XP);
		expect(awards().every((award) => award.outcome === "drawn")).toBe(true);
		// The ladder members will notice: a draw beats losing and loses to winning.
		expect(GAME_TIE_XP).toBeGreaterThan(GAME_PLAY_XP);
		expect(GAME_TIE_XP).toBeLessThan(GAME_PLAY_XP + GAME_WIN_XP);
	});

	it("tags the game so /account can keep a per game row", async () => {
		duel("challenger");
		expect(awards().every((award) => award.game === "diceroll" && award.source === "game")).toBe(true);
	});

	it("awards nothing in a DM, where there is no guild to be ranked in", async () => {
		awardTwoPlayerResult({
			client,
			guildId: null,
			game: "rps",
			challenger: user("a"),
			opponent: user("b"),
			winner: "tie",
		});
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});
});

describe("multi player results (hangman)", () => {
	const participants = [
		{ userId: "solver", username: "Solver" },
		{ userId: "helper1", username: "Helper One" },
		{ userId: "helper2", username: "Helper Two" },
	];

	const round = (winnerId: string | null) =>
		awardMultiPlayerResult({ client, guildId: "g1", game: "hangman", participants, winnerId });

	it("gives the solver the win and EVERY other guesser an assist", async () => {
		// Hangman is the only current game with a genuine assist: a public round is
		// solved by one member on top of letters several others revealed. This is
		// also the reason the participants set had to exist at all.
		round("solver");

		expect(awardFor("solver")?.outcome).toBe("won");
		expect(awardFor("helper1")?.outcome).toBe("assist");
		expect(awardFor("helper2")?.outcome).toBe("assist");
	});

	it("pays the solver more than the assists", async () => {
		round("solver");
		expect(awardFor("solver")?.amount).toBe(GAME_PLAY_XP + GAME_WIN_XP);
		expect(awardFor("helper1")?.amount).toBe(GAME_PLAY_XP);
	});

	it("gives NOBODY a win bonus on a loss", async () => {
		// The trap this guards: actorId in the terminal branch is whoever made the
		// FINAL guess, which is the member who HANGED the round on a loss. Passing
		// it as the winner would hand the win bonus to the person who lost it.
		round(null);

		expect(awards()).toHaveLength(3);
		expect(awards().every((award) => award.outcome === "lost")).toBe(true);
		expect(awards().every((award) => award.amount === GAME_PLAY_XP)).toBe(true);
	});

	// Monopoly's shape: one winner, and everyone else went bankrupt or was forfeited,
	// which is a loss and not an assist. The xp is the same; only the record differs.
	it("records every other participant as lost when the game says they lost", async () => {
		awardMultiPlayerResult({ client, guildId: "g1", game: "monopoly", participants, winnerId: "solver", nonWinnerOutcome: "lost" });

		expect(awardFor("solver")).toMatchObject({ outcome: "won", amount: GAME_PLAY_XP + GAME_WIN_XP, game: "monopoly" });
		expect(awardFor("helper1")).toMatchObject({ outcome: "lost", amount: GAME_PLAY_XP });
		expect(awardFor("helper2")).toMatchObject({ outcome: "lost", amount: GAME_PLAY_XP });
	});

	it("still pays everyone who showed up on a loss", async () => {
		// Showing up is the behavior being rewarded, so a lost round is not a zero.
		round(null);
		expect(awards().every((award) => award.amount > 0)).toBe(true);
	});

	it("pays a solo round exactly once", async () => {
		awardMultiPlayerResult({
			client,
			guildId: "g1",
			game: "hangman",
			participants: [{ userId: "solo", username: "Solo" }],
			winnerId: "solo",
		});
		expect(awards()).toHaveLength(1);
		expect(awardFor("solo")?.outcome).toBe("won");
	});

	it("awards nothing outside a guild", async () => {
		awardMultiPlayerResult({ client, guildId: null, game: "hangman", participants, winnerId: "solver" });
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});
});

describe("no amount is inlined", () => {
	it("reads every payout from BOT_CONSTANTS.LEVELING", async () => {
		// So an operator can retune the economy in one place, and so a game added in
		// phases 6 to 8 cannot quietly pay differently from its siblings.
		awardTwoPlayerResult({
			client,
			guildId: "g1",
			game: "diceroll",
			challenger: user("a"),
			opponent: user("b"),
			winner: "challenger",
		});

		const paid = awards().map((award) => award.amount);
		expect(paid).toContain(GAME_PLAY_XP + GAME_WIN_XP);
		expect(paid).toContain(GAME_PLAY_XP);
	});
});

// ── blackjack ───────────────────────────────────────────────────────────────
// The shape worth pinning here is that a hand, not a seat, is the unit of
// payment, and that doubling is a genuine gamble rather than free upside.

describe("blackjack results", () => {
	const seat = (userId: string, hands: SeatResult["hands"], doubled: boolean[] = hands.map(() => false)): SeatResult => ({
		userId,
		username: userId,
		hands,
		doubled,
	});

	const play = (seats: SeatResult[]) => awardBlackjackResult({ client, guildId: "g1", seats });

	it("pays each hand independently, so a split seat gets two awards", () => {
		play([seat("a", ["win", "lose"])]);
		expect(awards()).toHaveLength(2);
		expect(awards().map((award) => award.amount)).toEqual([GAME_PLAY_XP + GAME_WIN_XP, GAME_PLAY_XP]);
		expect(awards().map((award) => award.outcome)).toEqual(["won", "lost"]);
	});

	it("pays a natural more than an ordinary win", () => {
		play([seat("a", ["blackjack"])]);
		expect(awardFor("a")?.amount).toBe(GAME_PLAY_XP + GAME_WIN_XP + BLACKJACK_NATURAL_XP);
		expect(awardFor("a")?.outcome).toBe("won");
	});

	it("records a push as a draw and pays the tie amount", () => {
		play([seat("a", ["push"])]);
		expect(awardFor("a")?.amount).toBe(GAME_TIE_XP);
		expect(awardFor("a")?.outcome).toBe("drawn");
	});

	it("doubles the WIN BONUS on a doubled win, not the whole award", () => {
		play([seat("a", ["win"], [true])]);
		expect(awardFor("a")?.amount).toBe(GAME_PLAY_XP + GAME_WIN_XP * BLACKJACK_DOUBLE_WIN_MULTIPLIER);
	});

	it("pays NOTHING on a doubled loss, which is what makes doubling a decision", () => {
		// The asymmetry that stops "always double" from being correct: an ordinary
		// loss still pays the play xp, a doubled one forfeits it.
		play([seat("a", ["lose"], [true]), seat("b", ["lose"])]);
		expect(awardFor("a")?.amount).toBe(0);
		expect(awardFor("b")?.amount).toBe(GAME_PLAY_XP);
	});

	it("still records the hand when a doubled loss pays zero", () => {
		// awardXp only short circuits a zero amount when no game is attached, so the
		// win/loss record must still move. Losing the xp is the cost; losing the row
		// would make /account disagree with what the member watched happen.
		play([seat("a", ["lose"], [true])]);
		expect(awardFor("a")).toMatchObject({ game: "blackjack", outcome: "lost", source: "game" });
	});

	it("pays every seat at a table, because the dealer is not a member", () => {
		play([seat("a", ["win"]), seat("b", ["win"]), seat("c", ["lose"])]);
		expect(awards()).toHaveLength(3);
		expect(awardFor("a")?.amount).toBe(GAME_PLAY_XP + GAME_WIN_XP);
		expect(awardFor("b")?.amount).toBe(GAME_PLAY_XP + GAME_WIN_XP);
		expect(awardFor("c")?.amount).toBe(GAME_PLAY_XP);
	});

	it("awards nothing outside a guild", () => {
		awardBlackjackResult({ client, guildId: null, seats: [seat("a", ["win"])] });
		expect(awards()).toHaveLength(0);
	});
});

// ── Dero coins ride the same seam (2026-10 item 257, Phase 3a) ──
describe("the coins each helper hands deroCoins", () => {
	const coinCall = () => mocks.awardForResult.mock.calls[0][0] as { game: string; resultKey: string; players: Array<{ userId: string; outcome: string }> };

	it("pays a two player result by its room: the winner won, the loser played, a tie drawn", () => {
		awardTwoPlayerResult({ client, guildId: "g1", game: "battleship", challenger: user("a"), opponent: user("b"), winner: "challenger", resultKey: "room1" });
		expect(coinCall()).toEqual({ guildId: "g1", game: "battleship", resultKey: "room1", players: [{ userId: "a", outcome: "won" }, { userId: "b", outcome: "played" }] });

		mocks.awardForResult.mockClear();
		awardTwoPlayerResult({ client, guildId: "g1", game: "rps", challenger: user("a"), opponent: user("b"), winner: "tie", resultKey: "room2" });
		expect(coinCall().players).toEqual([{ userId: "a", outcome: "drawn" }, { userId: "b", outcome: "drawn" }]);
	});

	it("hands a bot seat over with the humans, so deroCoins can tell a bot match", () => {
		awardTwoPlayerResult({ client, guildId: "g1", game: "battleship", challenger: user("a"), opponent: user("dero-bot-red"), winner: "challenger", resultKey: "room1" });
		expect(coinCall().players).toContainEqual({ userId: "dero-bot-red", outcome: "played" });
	});

	it("reads a hangman assist as played", () => {
		const participants = [{ userId: "solver" }, { userId: "helper" }];
		awardMultiPlayerResult({ client, guildId: "g1", game: "hangman", participants, winnerId: "solver", resultKey: "room1" });
		expect(coinCall()).toEqual({ guildId: "g1", game: "hangman", resultKey: "room1", players: [{ userId: "solver", outcome: "won" }, { userId: "helper", outcome: "played" }] });
	});

	it("pays an inline blackjack table per seat by its best hand, and a one seat table as solo blackjack", () => {
		awardBlackjackResult({
			client,
			guildId: "g1",
			resultKey: "chan1:1",
			coinsPerHand: true,
			seats: [
				{ userId: "a", username: "a", hands: ["lose", "win"], doubled: [false, false], bets: [0, 0], payouts: [0, 0] },
				{ userId: "b", username: "b", hands: ["push"], doubled: [false], bets: [0], payouts: [0] },
			],
		});
		expect(coinCall()).toEqual({ guildId: "g1", game: "blackjack", resultKey: "chan1:1", players: [{ userId: "a", outcome: "won" }, { userId: "b", outcome: "drawn" }] });

		mocks.awardForResult.mockClear();
		awardBlackjackResult({ client, guildId: "g1", resultKey: "chan2:1", coinsPerHand: true, seats: [{ userId: "a", username: "a", hands: ["lose"], doubled: [false], bets: [0], payouts: [0] }] });
		expect(coinCall()).toEqual({ guildId: "g1", game: "solo-blackjack", resultKey: "chan2:1", players: [{ userId: "a", outcome: "played" }] });
	});

	// 2026-10 item 267, owner decision 7: a room table pays coins once, at its finish, never per hand.
	it("pays a room table's hand no coins, and the room's coins once by each member's final stack against the buy in", () => {
		awardBlackjackResult({ client, guildId: "g1", resultKey: "room1", coinsPerHand: false, seats: [{ userId: "a", username: "a", hands: ["win"], doubled: [false], bets: [100], payouts: [200] }] });
		expect(mocks.awardForResult).not.toHaveBeenCalled();

		awardBlackjackTableCoins({
			guildId: "g1",
			game: "blackjack",
			roomId: "room1",
			stacks: [
				{ userId: "a", buyIn: 1000, stack: 1500 },
				{ userId: "b", buyIn: 1000, stack: 1000 },
				{ userId: "c", buyIn: 1000, stack: 0 },
			],
		});
		expect(coinCall()).toEqual({
			guildId: "g1",
			game: "blackjack",
			resultKey: "room1",
			players: [
				{ userId: "a", outcome: "won" },
				{ userId: "b", outcome: "drawn" },
				{ userId: "c", outcome: "played" },
			],
		});
	});

	it("pays a solo luck round under its solo slug and key", () => {
		awardSoloLuckResult({ client, guildId: "g1", user: user("a"), won: true, game: "solo-rps", resultKey: "interaction1" });
		expect(coinCall()).toEqual({ guildId: "g1", game: "solo-rps", resultKey: "interaction1", players: [{ userId: "a", outcome: "won" }] });
	});

	it("pays a solo hangman round as a capped solo round, with no per game record (2026-10 item 280)", () => {
		awardSoloLuckResult({ client, guildId: "g1", user: { id: "a" }, won: true, game: "solo-hangman", resultKey: "room1" });
		expect(awards()).toEqual([expect.objectContaining({ userId: "a", source: "soloLuck", amount: BOT_CONSTANTS.LEVELING.SOLO_LUCK_WIN_XP })]);
		expect(awards()[0]).not.toHaveProperty("game");
		expect(awards()[0].username).toBeUndefined();
		expect(coinCall()).toEqual({ guildId: "g1", game: "solo-hangman", resultKey: "room1", players: [{ userId: "a", outcome: "won" }] });
	});

	it("pays no coins outside a guild", () => {
		awardTwoPlayerResult({ client, guildId: null, game: "rps", challenger: user("a"), opponent: user("b"), winner: "challenger", resultKey: "room1" });
		expect(mocks.awardForResult).not.toHaveBeenCalled();
	});
});
