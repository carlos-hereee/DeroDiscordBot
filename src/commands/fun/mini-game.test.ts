import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApplicationCommandOptionType, type ChatInputCommandInteraction } from "discord.js";

// ── mini-game subcommand routing ───────────────────────────────────────────
// The merge folded four games into ONE command, so routing is now the seam the
// whole feature hangs off: every game is reachable only through the dispatch
// table, and a builder-to-table mismatch is the obvious way a future session
// breaks this file while adding a fifth game. These tests pin both directions.

// vi.mock is hoisted above the imports, so the spies have to be created inside
// vi.hoisted or the factory below would reference an uninitialized binding.
const handlers = vi.hoisted(() => ({
	runCoinFlip: vi.fn(async () => undefined),
	runDiceRoll: vi.fn(async () => undefined),
	runRps: vi.fn(async () => undefined),
	runMonopoly: vi.fn(async () => undefined),
	runHangman: vi.fn(async () => undefined),
	runBlackjack: vi.fn(async () => undefined),
	runFortune: vi.fn(async () => undefined),
}));

// Mocked by the SAME specifier mini-game.ts imports, so the real handlers (and
// their transitive Mongo / Discord dependencies) never load in this suite.
// The three head to head games route through challengeEntry as of game rooms
// Phase 4; versusHandler.ts and rpsHandler.ts were retired with challengeFlow.
vi.mock("@features/games/challengeEntry.js", () => ({
	runCoinFlip: handlers.runCoinFlip,
	runDiceRoll: handlers.runDiceRoll,
	runRps: handlers.runRps,
	runMonopoly: handlers.runMonopoly,
}));
vi.mock("@features/games/hangmanHandler.js", () => ({ runHangman: handlers.runHangman }));
vi.mock("@features/games/blackjackHandler.js", () => ({ runBlackjack: handlers.runBlackjack }));
vi.mock("@features/games/fortuneHandler.js", () => ({ runFortune: handlers.runFortune }));

import { data, execute, MINI_GAME_HANDLERS } from "./mini-game.js";

// Declaration order, which the builder shape assertion below depends on.
const SUBCOMMANDS = ["coin-flip", "dice-roll", "rps", "monopoly", "hangman", "blackjack", "fortune"] as const;

function fakeInteraction(subcommand: string): { interaction: ChatInputCommandInteraction; reply: ReturnType<typeof vi.fn> } {
	const reply = vi.fn(async () => undefined);
	const interaction = {
		commandName: "mini-game",
		options: { getSubcommand: () => subcommand },
		reply,
	} as unknown as ChatInputCommandInteraction;
	return { interaction, reply };
}

// The builder's JSON is the wire contract Discord actually receives, so the
// shape assertions below read it rather than the builder's fluent internals.
const json = data.toJSON();
const topLevel = json.options ?? [];

describe("/mini-game builder shape", () => {
	it("registers under the mini-game name", () => {
		expect(json.name).toBe("mini-game");
	});

	it("declares exactly the expected subcommands", () => {
		const names = topLevel.map((option) => option.name);
		expect(names).toEqual([...SUBCOMMANDS]);
	});

	it("carries NO top level options, only subcommands", () => {
		// Discord forbids a command from holding both subcommands and top level
		// options, and silently makes the bare command uninvokable if you try. This
		// pins that constraint into a test rather than leaving it in a comment: a
		// stray .addStringOption() on the parent would fail here.
		for (const option of topLevel) {
			expect(option.type).toBe(ApplicationCommandOptionType.Subcommand);
		}
	});

	it("keeps the absorbed fortune option contract identical to the shipped /fortune", () => {
		// A drift here is a silent behavior change for a command members already
		// use, so both options are checked by name, type, requiredness, and cap.
		const fortune = topLevel.find((option) => option.name === "fortune");
		expect(fortune).toBeDefined();
		const options = (fortune as { options?: { name: string; type: number; required?: boolean; max_length?: number }[] }).options ?? [];

		const question = options.find((option) => option.name === "question");
		expect(question?.type).toBe(ApplicationCommandOptionType.String);
		expect(question?.required ?? false).toBe(false);
		expect(question?.max_length).toBe(200);

		const isPrivate = options.find((option) => option.name === "private");
		expect(isPrivate?.type).toBe(ApplicationCommandOptionType.Boolean);
		expect(isPrivate?.required ?? false).toBe(false);
	});

	// ⚠️ THIS TEST WAS INVERTED BY GAME ROOMS PHASE 4, and the inversion is the
	// requirement. It used to assert an opponent option was REQUIRED on all three
	// head to head games. An addUserOption is populated by DISCORD and will happily
	// return a bot, which is the only reason the bot had to carry a bot-opponent
	// rejection string at all (the phrase is not quoted here on purpose: a grep for
	// it returning nothing is this phase's completion criterion, and quoting it
	// across two lines is what made that grep pass by accident rather than by
	// absence). Those three games now open a challenge card on ⚔️challenges, where
	// the opponent arrives through a bot-populated StringSelect (a bot can never be
	// an option) or a Join button (a bot cannot click). F9 became structural, and
	// this asserts the surface that made it non-structural is gone.
	it("offers NO user option on any subcommand, so no picker can return a bot", () => {
		const userOptions = topLevel.flatMap((sub) => {
			const options = (sub as { options?: { name: string; type: number }[] }).options ?? [];
			return options.filter((option) => option.type === ApplicationCommandOptionType.User);
		});
		expect(userOptions).toEqual([]);
	});
});

describe("/mini-game dispatch table", () => {
	it("has exactly one entry per declared subcommand, both directions", () => {
		// Both directions on purpose. A missing entry means a declared game that
		// does nothing when a member picks it; an extra entry means dead code that
		// nothing can ever reach.
		expect(Object.keys(MINI_GAME_HANDLERS).sort()).toEqual([...SUBCOMMANDS].sort());
	});
});

describe("/mini-game execute routing", () => {
	beforeEach(() => {
		for (const handler of Object.values(handlers)) handler.mockClear();
	});

	it.each([
		["coin-flip", "runCoinFlip"],
		["dice-roll", "runDiceRoll"],
		["rps", "runRps"],
		["monopoly", "runMonopoly"],
		["hangman", "runHangman"],
		["fortune", "runFortune"],
	] as const)("routes %s to its own handler and no other", async (subcommand, expectedKey) => {
		const { interaction } = fakeInteraction(subcommand);
		await execute(interaction);

		for (const [key, handler] of Object.entries(handlers)) {
			if (key === expectedKey) {
				expect(handler).toHaveBeenCalledTimes(1);
				expect(handler).toHaveBeenCalledWith(interaction);
			} else {
				expect(handler).not.toHaveBeenCalled();
			}
		}
	});

	describe("unknown subcommand", () => {
		let errorSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		});
		afterEach(() => {
			errorSpy.mockRestore();
		});

		it("fails loudly rather than silently, and calls no handler", async () => {
			// Unreachable for a member (Discord will not send an undeclared
			// subcommand), so this only fires on a builder-to-table mismatch. A
			// silent return would ship that mistake as a game that does nothing.
			const { interaction, reply } = fakeInteraction("tic-tac-toe");
			await execute(interaction);

			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(String(errorSpy.mock.calls[0][0])).toContain("tic-tac-toe");
			expect(reply).toHaveBeenCalledTimes(1);
			for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
		});
	});
});
