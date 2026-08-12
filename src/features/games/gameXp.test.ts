import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, User } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── gameXp ─────────────────────────────────────────────────────────────────
// The games feature's only seam into leveling. What is worth pinning is the
// PAYOUT SHAPE, because it is the thing a player will notice and argue about:
// the winner earns more than the loser, a draw sits between the two, and a
// hangman round that somebody else solved credits the other guessers with an
// assist rather than a loss.

const mocks = vi.hoisted(() => ({ awardXp: vi.fn() }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: mocks.awardXp }));

import { awardMultiPlayerResult, awardTwoPlayerResult } from "./gameXp.js";

const { GAME_PLAY_XP, GAME_WIN_XP, GAME_TIE_XP } = BOT_CONSTANTS.LEVELING;

const client = {} as Client;
const user = (id: string): User => ({ id, username: id, globalName: id }) as unknown as User;

interface Award {
	userId: string;
	amount: number;
	outcome?: string;
	game?: string;
	source: string;
}

const awards = (): Award[] => mocks.awardXp.mock.calls.map((call) => call[0] as Award);
const awardFor = (userId: string): Award | undefined => awards().find((award) => award.userId === userId);

beforeEach(() => {
	mocks.awardXp.mockReset().mockResolvedValue(undefined);
});

describe("two player results (duel and rps share this)", () => {
	const duel = (winner: "challenger" | "opponent" | "tie") =>
		awardTwoPlayerResult({
			client,
			guildId: "g1",
			game: "duel",
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
		expect(awards().every((award) => award.game === "duel" && award.source === "game")).toBe(true);
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
			game: "duel",
			challenger: user("a"),
			opponent: user("b"),
			winner: "challenger",
		});

		const paid = awards().map((award) => award.amount);
		expect(paid).toContain(GAME_PLAY_XP + GAME_WIN_XP);
		expect(paid).toContain(GAME_PLAY_XP);
	});
});
