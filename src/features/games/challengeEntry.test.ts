import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

vi.mock("@features/game-rooms/challengeBoard.js", () => ({ startChallengeDraft: vi.fn(async () => null) }));

import { runCoinFlip, runDiceRoll, runMonopoly, runRps } from "./challengeEntry.js";
import { startChallengeDraft } from "@features/game-rooms/challengeBoard.js";

// ── challengeEntry ───────────────────────────────────────────────────────────
// Each /mini-game doorway hands its OWN game slug to the challenge board, the same
// function the board's buttons call. A doorway passing the wrong slug would post a
// card for another game, which nothing else would catch.

const draftMock = startChallengeDraft as unknown as ReturnType<typeof vi.fn>;
const interaction = { user: { id: "member-1" } } as unknown as ChatInputCommandInteraction;

beforeEach(() => {
	draftMock.mockClear();
});

describe("the challenge doorways", () => {
	it.each([
		["coin flip", runCoinFlip, "coinflip"],
		["dice roll", runDiceRoll, "diceroll"],
		["rps", runRps, "rps"],
		["monopoly", runMonopoly, "monopoly"],
	] as const)("%s posts the challenge card for its own game", async (_name, run, slug) => {
		await run(interaction);
		expect(draftMock).toHaveBeenCalledOnce();
		expect(draftMock).toHaveBeenCalledWith(interaction, slug);
	});
});
