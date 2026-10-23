import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepliableInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({ awardXp: vi.fn() }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: mocks.awardXp }));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { pickDeroThrow, playSoloLuck, resolveSoloLuck } from "./soloLuck.js";
import { gamesCopy } from "./gamesCopy.js";

// ── soloLuck ───────────────────────────────────────────────────────────────
// Coin flip, dice roll and rps against Dero (the 1.7.0 test fixes, item 14). The
// resolver is pinned through an rng stub, the way versusResolve's own suite pins its
// odds, and the entry point through a fake interaction, so each game's outcome and
// its XP are both under test.

// Hands out the given numbers in order, so a case can name each roll it needs.
const rngOf = (...values: number[]) => {
	let index = 0;
	return () => values[index++ % values.length];
};

interface FakeInteraction {
	interaction: RepliableInteraction;
	reply: ReturnType<typeof vi.fn>;
}

function fakeInteraction(inGuild = true): FakeInteraction {
	const reply = vi.fn(async () => undefined);
	const interaction = {
		inGuild: () => inGuild,
		guildId: inGuild ? "guild-1" : null,
		channelId: "games-1",
		client: {},
		user: { id: "member-1", username: "member", globalName: "Member" },
		reply,
	} as unknown as RepliableInteraction;
	return { interaction, reply };
}

const paidAmounts = (): number[] => mocks.awardXp.mock.calls.map((call) => (call[0] as { amount: number }).amount);

beforeEach(() => {
	mocks.awardXp.mockReset().mockResolvedValue(undefined);
});

describe("resolveSoloLuck, with Dero as the second side", () => {
	it("gives the coin's heads to the member and its tails to Dero", () => {
		expect(resolveSoloLuck({ game: "coinflip" }, () => 0.1)).toEqual({ game: "coinflip", face: "heads", outcome: "won" });
		expect(resolveSoloLuck({ game: "coinflip" }, () => 0.9)).toEqual({ game: "coinflip", face: "tails", outcome: "lost" });
	});

	it("rolls a d20 each, member first, and can tie", () => {
		// floor(0.95 * 20) + 1 = 20 and floor(0 * 20) + 1 = 1.
		expect(resolveSoloLuck({ game: "diceroll" }, rngOf(0.95, 0))).toEqual({
			game: "diceroll",
			memberRoll: 20,
			deroRoll: 1,
			outcome: "won",
		});
		expect(resolveSoloLuck({ game: "diceroll" }, rngOf(0, 0.95)).outcome).toBe("lost");
		expect(resolveSoloLuck({ game: "diceroll" }, rngOf(0.5, 0.5)).outcome).toBe("tie");
	});

	it("scores the member's throw against Dero's", () => {
		// RPS_CHOICES is rock, paper, scissors: 0 is rock, 0.5 is paper, 0.9 is scissors.
		expect(resolveSoloLuck({ game: "rps", memberThrow: "paper" }, () => 0)).toMatchObject({ deroThrow: "rock", outcome: "won" });
		expect(resolveSoloLuck({ game: "rps", memberThrow: "paper" }, () => 0.9)).toMatchObject({
			deroThrow: "scissors",
			outcome: "lost",
		});
		expect(resolveSoloLuck({ game: "rps", memberThrow: "paper" }, () => 0.5)).toMatchObject({ deroThrow: "paper", outcome: "tie" });
	});

	it("lets Dero throw anything, and only those three", () => {
		expect([0, 0.34, 0.67, 0.9999].map((value) => pickDeroThrow(() => value))).toEqual(["rock", "paper", "scissors", "scissors"]);
	});
});

describe("playSoloLuck", () => {
	const { SOLO_LUCK_WIN_XP, SOLO_LUCK_OTHER_XP } = BOT_CONSTANTS.LEVELING;

	it("pins the owner's amounts: 3 for a win, 1 for anything else", () => {
		expect(SOLO_LUCK_WIN_XP).toBe(3);
		expect(SOLO_LUCK_OTHER_XP).toBe(1);
	});

	it.each([
		["a coin flip win", { game: "coinflip" } as const, () => 0.1, SOLO_LUCK_WIN_XP],
		["a coin flip loss", { game: "coinflip" } as const, () => 0.9, SOLO_LUCK_OTHER_XP],
		["a dice win", { game: "diceroll" } as const, rngOf(0.95, 0), SOLO_LUCK_WIN_XP],
		["a dice loss", { game: "diceroll" } as const, rngOf(0, 0.95), SOLO_LUCK_OTHER_XP],
		["a dice tie", { game: "diceroll" } as const, rngOf(0.5, 0.5), SOLO_LUCK_OTHER_XP],
		["an rps win", { game: "rps", memberThrow: "rock" } as const, () => 0.9, SOLO_LUCK_WIN_XP],
		["an rps loss", { game: "rps", memberThrow: "rock" } as const, () => 0.5, SOLO_LUCK_OTHER_XP],
		["an rps tie", { game: "rps", memberThrow: "rock" } as const, () => 0, SOLO_LUCK_OTHER_XP],
	])("pays %s as soloLuck, inside the daily cap", async (_label, play, rng, xp) => {
		const { interaction } = fakeInteraction();
		await playSoloLuck(interaction, play, rng);

		expect(paidAmounts()).toEqual([xp]);
		expect(mocks.awardXp.mock.calls[0][0]).toMatchObject({ guildId: "guild-1", userId: "member-1", source: "soloLuck" });
	});

	it("records no per game result, so achievements cannot be farmed past the cap", async () => {
		const { interaction } = fakeInteraction();
		await playSoloLuck(interaction, { game: "coinflip" }, () => 0.1);

		const award = mocks.awardXp.mock.calls[0][0] as { game?: string; outcome?: string };
		expect(award.game).toBeUndefined();
		expect(award.outcome).toBeUndefined();
	});

	it("posts exactly one public message, pinging nobody", async () => {
		const { interaction, reply } = fakeInteraction();
		await playSoloLuck(interaction, { game: "diceroll" }, rngOf(0.95, 0));

		expect(reply).toHaveBeenCalledOnce();
		const sent = reply.mock.calls[0][0] as { flags?: unknown; allowedMentions: unknown; embeds: { toJSON(): { title: string; description: string } }[] };
		expect(sent.flags).toBeUndefined();
		expect(sent.allowedMentions).toEqual({ parse: [] });
		const embed = sent.embeds[0].toJSON();
		expect(embed.title).toBe(gamesCopy.soloLuck.diceTitle);
		expect(embed.description).toContain(gamesCopy.soloLuck.memberWins("member-1"));
	});

	it("refuses a DM and pays nothing", async () => {
		const { interaction, reply } = fakeInteraction(false);
		await playSoloLuck(interaction, { game: "coinflip" }, () => 0.1);

		expect(reply.mock.calls[0][0]).toMatchObject({ flags: expect.anything() });
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});
});
