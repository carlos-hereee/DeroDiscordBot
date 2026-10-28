import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

vi.mock("@features/game-rooms/challengeBoard.js", () => ({ offerChallengeDraft: vi.fn(async () => null) }));

import { runCoinFlip, runDiceRoll, runMonopoly, runRps } from "./challengeEntry.js";
import { offerChallengeDraft } from "@features/game-rooms/challengeBoard.js";

// ── challengeEntry ───────────────────────────────────────────────────────────
// Each /mini-game doorway hands its OWN game slug to the challenge board, the same
// function the board's buttons call. A doorway passing the wrong slug would post a
// card for another game, which nothing else would catch.

const draftMock = offerChallengeDraft as unknown as ReturnType<typeof vi.fn>;

// The options a member typed, read by name the way challengeEntry reads them.
function slash(options: Record<string, string> = {}): ChatInputCommandInteraction {
	return {
		user: { id: "member-1" },
		options: { getString: (name: string) => options[name] ?? null },
		reply: vi.fn(async () => undefined),
	} as unknown as ChatInputCommandInteraction;
}
const interaction = slash();

beforeEach(() => {
	draftMock.mockClear();
});

describe("the challenge doorways", () => {
	it.each([
		["coin flip", runCoinFlip, "coinflip"],
		["dice roll", runDiceRoll, "diceroll"],
		["rps", runRps, "rps"],
		["monopoly", runMonopoly, "monopoly"],
	] as const)("%s opens the creation modal for its own game", async (_name, run, slug) => {
		await run(interaction);
		expect(draftMock).toHaveBeenCalledOnce();
		expect(draftMock).toHaveBeenCalledWith(interaction, slug);
	});
});

// ── against Dero (the 1.7.0 test fixes, item 14) ─────────────────────────────
// A round against Dero opens its solo room in miniGameInChallenges before this module runs
// (2026-10 item 263 R3-8), so every luck doorway here is the challenge path.
describe("against a member", () => {
	it.each([
		["coin flip", runCoinFlip, "coinflip"],
		["dice roll", runDiceRoll, "diceroll"],
		["rps", runRps, "rps"],
	] as const)("%s against a member still opens the challenge card's creation modal", async (_name, run, slug) => {
		const member = slash({ against: "member" });
		await run(member);
		expect(draftMock).toHaveBeenCalledWith(member, slug);
	});
});
