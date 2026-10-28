import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

vi.mock("@features/game-rooms/challengeBoard.js", () => ({ offerChallengeDraft: vi.fn(async () => null) }));
vi.mock("./soloLuck.js", () => ({ playSoloLuck: vi.fn(async () => undefined) }));

import { runCoinFlip, runDiceRoll, runMonopoly, runRps } from "./challengeEntry.js";
import { offerChallengeDraft } from "@features/game-rooms/challengeBoard.js";
import { playSoloLuck } from "./soloLuck.js";
import { gamesCopy } from "./gamesCopy.js";

// ── challengeEntry ───────────────────────────────────────────────────────────
// Each /mini-game doorway hands its OWN game slug to the challenge board, the same
// function the board's buttons call. A doorway passing the wrong slug would post a
// card for another game, which nothing else would catch.

const draftMock = offerChallengeDraft as unknown as ReturnType<typeof vi.fn>;
const soloMock = playSoloLuck as unknown as ReturnType<typeof vi.fn>;

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
	soloMock.mockClear();
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
// The luck games keep their challenge path as the default and hand a round against
// Dero to soloLuck. Both directions are pinned: a regression that sent every round
// to Dero would pass a test that only checked the Dero branch.
describe("against Dero", () => {
	it.each([
		["coin flip", runCoinFlip, { game: "coinflip" }],
		["dice roll", runDiceRoll, { game: "diceroll" }],
	] as const)("%s plays Dero inline and posts no challenge card", async (_name, run, play) => {
		const dero = slash({ against: "dero" });
		await run(dero);
		expect(soloMock).toHaveBeenCalledWith(dero, play);
		expect(draftMock).not.toHaveBeenCalled();
	});

	it("rps plays Dero with the throw the member chose", async () => {
		const dero = slash({ against: "dero", throw: "paper" });
		await runRps(dero);
		expect(soloMock).toHaveBeenCalledWith(dero, { game: "rps", memberThrow: "paper" });
		expect(draftMock).not.toHaveBeenCalled();
	});

	it("rps against Dero with no throw asks for one and plays nothing", async () => {
		const dero = slash({ against: "dero" });
		await runRps(dero);
		expect(soloMock).not.toHaveBeenCalled();
		expect(draftMock).not.toHaveBeenCalled();
		expect((dero.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
			content: gamesCopy.soloLuck.throwNeeded,
		});
	});

	it.each([
		["coin flip", runCoinFlip, "coinflip"],
		["dice roll", runDiceRoll, "diceroll"],
		["rps", runRps, "rps"],
	] as const)("%s against a member still opens the challenge card's creation modal", async (_name, run, slug) => {
		const member = slash({ against: "member" });
		await run(member);
		expect(draftMock).toHaveBeenCalledWith(member, slug);
		expect(soloMock).not.toHaveBeenCalled();
	});
});
