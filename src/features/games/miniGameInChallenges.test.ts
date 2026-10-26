import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

// ── /mini-game typed in a challenge channel (2026-10 item 254, Arcade 1) ────
// The owner's rule is that nothing is played in ⚔️challenges. What is pinned here is the
// router's contract: typed in a challenge channel, every game opens its room or solo room
// (or posts its challenge card, the one thing the channel holds), a fortune is answered
// privately, and the channel itself is never sent anything; typed anywhere else, the
// router answers nothing and the subcommand's own handler runs as before.
vi.mock("@features/game-rooms/challengeCard.js", () => ({ isChallengeChannel: vi.fn() }));
vi.mock("@features/game-rooms/challengeBoard.js", () => ({ startChallengeDraft: vi.fn() }));
vi.mock("@features/game-rooms/soloRooms.js", () => ({ soloLuckSlugFor: (play: { game: string }) => `solo-${play.game}` }));
vi.mock("./arcadeHost.js", () => ({ openSoloRoomForMember: vi.fn() }));
vi.mock("./fortuneHandler.js", () => ({ runFortune: vi.fn() }));

import { routeMiniGameInChallenges } from "./miniGameInChallenges.js";
import { isChallengeChannel } from "@features/game-rooms/challengeCard.js";
import { startChallengeDraft } from "@features/game-rooms/challengeBoard.js";
import { openSoloRoomForMember } from "./arcadeHost.js";
import { runFortune } from "./fortuneHandler.js";
import { gamesCopy } from "./gamesCopy.js";

const channelMock = isChallengeChannel as unknown as ReturnType<typeof vi.fn>;
const draftMock = startChallengeDraft as unknown as ReturnType<typeof vi.fn>;
const soloMock = openSoloRoomForMember as unknown as ReturnType<typeof vi.fn>;
const fortuneMock = runFortune as unknown as ReturnType<typeof vi.fn>;

// A slash command typed in ⚔️challenges. `channelSend` is the channel the command was typed
// in: every case asserts it received nothing.
function typedInChallenges(options: Record<string, string | null> = {}) {
	const channelSend = vi.fn();
	const interaction = {
		inGuild: () => true,
		guild: { id: "guild-1" },
		guildId: "guild-1",
		channelId: "challenges-1",
		channel: { id: "challenges-1", send: channelSend },
		options: { getString: (name: string) => options[name] ?? null },
		reply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
	};
	return { interaction: interaction as unknown as ChatInputCommandInteraction, raw: interaction, channelSend };
}

beforeEach(() => {
	vi.clearAllMocks();
	channelMock.mockResolvedValue(true);
});

describe("routeMiniGameInChallenges, typed in a challenge channel", () => {
	it("opens a solo hangman room and answers privately", async () => {
		const { interaction, raw, channelSend } = typedInChallenges();

		await expect(routeMiniGameInChallenges(interaction, "hangman")).resolves.toBe(true);

		expect(raw.deferReply).toHaveBeenCalledWith(expect.objectContaining({ flags: expect.any(Number) }));
		expect(soloMock).toHaveBeenCalledWith(interaction, "solo-hangman");
		expect(channelSend).not.toHaveBeenCalled();
	});

	it("opens a solo blackjack room for a hand alone against the dealer", async () => {
		const { interaction, channelSend } = typedInChallenges({ mode: "solo" });

		await routeMiniGameInChallenges(interaction, "blackjack");

		expect(soloMock).toHaveBeenCalledWith(interaction, "solo-blackjack");
		expect(draftMock).not.toHaveBeenCalled();
		expect(channelSend).not.toHaveBeenCalled();
	});

	it("posts a table others may join as a challenge card, never as a table", async () => {
		const { interaction, channelSend } = typedInChallenges({ mode: "table" });

		await routeMiniGameInChallenges(interaction, "blackjack");

		expect(draftMock).toHaveBeenCalledWith(interaction, "blackjack");
		expect(soloMock).not.toHaveBeenCalled();
		expect(channelSend).not.toHaveBeenCalled();
	});

	it.each([
		["coin-flip", {}, { game: "coinflip" }],
		["dice-roll", {}, { game: "diceroll" }],
		["rps", { throw: "scissors" }, { game: "rps", memberThrow: "scissors" }],
	] as const)("opens a solo room for %s against Dero, carrying the round", async (subcommand, extra, play) => {
		const { interaction, channelSend } = typedInChallenges({ against: "dero", ...extra });

		await expect(routeMiniGameInChallenges(interaction, subcommand)).resolves.toBe(true);

		expect(soloMock).toHaveBeenCalledWith(interaction, `solo-${play.game}`, { luckPlay: play });
		expect(channelSend).not.toHaveBeenCalled();
	});

	it("asks for the throw, privately, when rps against Dero names none", async () => {
		const { interaction, raw } = typedInChallenges({ against: "dero" });

		await routeMiniGameInChallenges(interaction, "rps");

		expect(raw.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gamesCopy.soloLuck.throwNeeded, flags: expect.any(Number) }));
		expect(soloMock).not.toHaveBeenCalled();
	});

	it("answers a fortune privately whatever the member chose, since a reading has no room", async () => {
		const { interaction } = typedInChallenges({ private: null });

		await expect(routeMiniGameInChallenges(interaction, "fortune")).resolves.toBe(true);

		expect(fortuneMock).toHaveBeenCalledWith(interaction, { forcePrivate: true });
	});

	// These only ever post a challenge card, which is what the channel holds, so their own
	// handlers run unchanged.
	it.each([
		["monopoly", {}],
		["coin-flip", { against: "member" }],
		["rps", {}],
	] as const)("leaves %s against a member to its own handler", async (subcommand, options) => {
		const { interaction } = typedInChallenges(options);

		await expect(routeMiniGameInChallenges(interaction, subcommand)).resolves.toBe(false);

		expect(soloMock).not.toHaveBeenCalled();
		expect(draftMock).not.toHaveBeenCalled();
	});
});

describe("routeMiniGameInChallenges, typed anywhere else", () => {
	it.each(["hangman", "blackjack", "coin-flip", "fortune"])("answers nothing for %s, so the game behaves as today", async (subcommand) => {
		channelMock.mockResolvedValue(false);
		const { interaction } = typedInChallenges({ against: "dero" });

		await expect(routeMiniGameInChallenges(interaction, subcommand)).resolves.toBe(false);

		expect(soloMock).not.toHaveBeenCalled();
		expect(draftMock).not.toHaveBeenCalled();
		expect(fortuneMock).not.toHaveBeenCalled();
	});
});
