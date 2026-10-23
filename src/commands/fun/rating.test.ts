import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import type { IPlayerRating } from "@db/models/PlayerRating.js";

// ── /rating ────────────────────────────────────────────────────────────────
// One describe per subcommand, each pinning what a member actually reads: their
// own rating per rated game with the provisional mark under 10 games, this
// server's board of one game from current members only, and this month's luck
// board with its 20 decided game floor. The real ratingBoards runs under the
// command; only the stores and the member list are faked.

const mocks = vi.hoisted(() => ({
	guildConfig: vi.fn(),
	findAllForPlayer: vi.fn(),
	findForPlayers: vi.fn(),
	playerIdsInGuild: vi.fn(),
	luckForGuildMonth: vi.fn(),
	gone: new Set<string>(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.guildConfig } }));
vi.mock("@db/stores/playerRatingStore.js", () => ({
	playerRatingStore: { findAllForPlayer: mocks.findAllForPlayer, findForPlayers: mocks.findForPlayers },
}));
vi.mock("@db/stores/matchResultStore.js", () => ({ matchResultStore: { playerIdsInGuild: mocks.playerIdsInGuild } }));
vi.mock("@db/stores/luckStatStore.js", () => ({ luckStatStore: { findForGuildMonth: mocks.luckForGuildMonth } }));
vi.mock("@db/stores/gameResultCountStore.js", () => ({ gameResultCountStore: { findForGuildMonth: vi.fn() } }));
vi.mock("@features/ratings/memberNames.js", () => ({
	memberNameResolver: () => async (userIds: readonly string[]) =>
		new Map(userIds.filter((id) => !mocks.gone.has(id)).map((id) => [id, `Name_${id}`])),
}));

import { data, execute } from "./rating.js";

const rating = (userId: string, game: string, displayRating: number, ratedGames: number): IPlayerRating => ({
	userId,
	game,
	mu: 25,
	sigma: 8,
	ratedGames,
	displayRating,
	lastRatedAt: new Date("2026-10-20T00:00:00Z"),
});

type Options = { sub: string; game?: string; inGuild?: boolean };

function run({ sub, game, inGuild = true }: Options) {
	const reply = vi.fn(async () => undefined);
	const deferReply = vi.fn(async () => undefined);
	const editReply = vi.fn(async () => undefined);
	const interaction = {
		guild: inGuild ? { id: "g1", name: "Kingdom 1234" } : null,
		user: { id: "u1", displayName: "account name" },
		member: { displayName: "Silent Warrior" },
		inCachedGuild: () => inGuild,
		reply,
		deferReply,
		editReply,
		options: { getSubcommand: () => sub, getString: () => game ?? null },
	} as unknown as ChatInputCommandInteraction;
	return { interaction, reply, deferReply, editReply };
}

async function answer(options: Options): Promise<{ title: string; description: string }> {
	const { interaction, editReply } = run(options);
	await execute(interaction);
	const embed = (editReply.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[] }])[0].embeds[0];
	return { title: embed.data.title ?? "", description: embed.data.description ?? "" };
}

beforeEach(() => {
	mocks.guildConfig.mockReset().mockResolvedValue({ guildId: "g1", pluginId: "rok-commander" });
	mocks.findAllForPlayer.mockReset().mockResolvedValue([]);
	mocks.findForPlayers.mockReset().mockResolvedValue([]);
	mocks.playerIdsInGuild.mockReset().mockResolvedValue([]);
	mocks.luckForGuildMonth.mockReset().mockResolvedValue([]);
	mocks.gone.clear();
});

describe("the builder", () => {
	it("is a public command with me, board and luck, offering only the rated games", () => {
		const json = data.toJSON();
		expect(json.name).toBe("rating");
		// Members read their own ratings, so no default permission hides it from them.
		expect(json.default_member_permissions).toBeUndefined();
		const subs = json.options ?? [];
		expect(subs.map((sub) => sub.name)).toEqual(["me", "board", "luck"]);
		const boardOptions = (subs[1] as { options?: Array<{ required?: boolean; choices?: Array<{ value: string }> }> }).options ?? [];
		expect(boardOptions[0].required).toBe(true);
		expect(boardOptions[0].choices?.map((choice) => choice.value)).toEqual(["holdem", "battleship", "monopoly"]);
	});

	it("never calls it Elo", () => {
		expect(JSON.stringify(data.toJSON())).not.toMatch(/\belo\b/i);
	});
});

describe("the guild gate", () => {
	it("refuses a DM before reading anything", async () => {
		const { interaction, reply, deferReply } = run({ sub: "me", inGuild: false });
		await execute(interaction);
		const embed = (reply.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[]; flags: number }])[0];
		expect(embed.embeds[0].data.description).toContain("not a DM");
		expect(embed.flags).toBeDefined();
		expect(deferReply).not.toHaveBeenCalled();
		expect(mocks.findAllForPlayer).not.toHaveBeenCalled();
	});
});

describe("/rating me", () => {
	it("shows every rated game, marking a rating under 10 games and naming the unrated ones", async () => {
		mocks.findAllForPlayer.mockResolvedValue([rating("u1", "holdem", 1120, 4), rating("u1", "monopoly", 1210, 12)]);

		const { title, description } = await answer({ sub: "me" });

		expect(mocks.findAllForPlayer).toHaveBeenCalledWith("u1");
		expect(title).toBe("⚔️ Silent Warrior's arcade ratings");
		expect(description).toContain("**Texas hold em**: 1120?, from 4 rated matches");
		expect(description).toContain("**Battleship**: no rated match yet");
		expect(description).toContain("**Monopoly**: 1210, from 12 rated matches");
		expect(description).toContain("A ? marks a rating still settling");
	});

	it("shows one game when asked, with no note when nothing on screen is provisional", async () => {
		mocks.findAllForPlayer.mockResolvedValue([rating("u1", "monopoly", 1210, 12), rating("u1", "holdem", 1120, 4)]);

		const { description } = await answer({ sub: "me", game: "monopoly" });

		expect(description).toContain("**Monopoly**: 1210, from 12 rated matches");
		expect(description).not.toContain("Texas hold em");
		expect(description).not.toContain("still settling");
	});

	it("says a single rated match in the singular", async () => {
		mocks.findAllForPlayer.mockResolvedValue([rating("u1", "battleship", 1031, 1)]);
		expect((await answer({ sub: "me", game: "battleship" })).description).toContain("from 1 rated match");
	});
});

describe("/rating board", () => {
	it("ranks this server's players of the game, current members only, escaping names", async () => {
		mocks.playerIdsInGuild.mockResolvedValue(["a", "b", "gone"]);
		mocks.findForPlayers.mockResolvedValue([rating("a", "holdem", 1100, 22), rating("b", "holdem", 1210, 3), rating("gone", "holdem", 1400, 40)]);
		mocks.gone.add("gone");

		const { title, description } = await answer({ sub: "board", game: "holdem" });

		expect(mocks.playerIdsInGuild).toHaveBeenCalledWith("g1", "holdem", undefined);
		expect(title).toBe("🏆 Texas hold em ratings in this realm");
		expect(description.split("\n").slice(0, 2)).toEqual(["1. **Name\\_b**: 1210?", "2. **Name\\_a**: 1100"]);
		expect(description).not.toContain("gone");
		expect(description).toContain("still settling");
	});

	it("invites the first match when nobody here holds a rating in the game", async () => {
		const { description } = await answer({ sub: "board", game: "battleship" });
		expect(description).toContain("No warrior of this realm holds a rating in this game yet");
		expect(mocks.findForPlayers).not.toHaveBeenCalled();
	});
});

describe("/rating luck", () => {
	it("ranks this month's players past 20 decided games by wins above even", async () => {
		mocks.luckForGuildMonth.mockResolvedValue([
			{ guildId: "g1", userId: "a", game: "coinflip", month: "2026-10", decided: 12, wins: 9 },
			{ guildId: "g1", userId: "a", game: "rps", month: "2026-10", decided: 10, wins: 6 },
			{ guildId: "g1", userId: "b", game: "diceroll", month: "2026-10", decided: 20, wins: 8 },
			{ guildId: "g1", userId: "c", game: "coinflip", month: "2026-10", decided: 19, wins: 19 },
		]);

		const { title, description } = await answer({ sub: "luck" });

		expect(mocks.luckForGuildMonth).toHaveBeenCalledWith("g1", expect.stringMatching(/^\d{4}-\d{2}$/));
		expect(title).toBe("🍀 The luckiest warriors this month");
		expect(description).toContain("1. **Name\\_a**: +4 (15 of 22 won)");
		expect(description).toContain("2. **Name\\_b**: -2 (8 of 20 won)");
		// 19 decided games is under the floor, however lucky.
		expect(description).not.toContain("Name\\_c");
	});

	it("says nobody has reached the floor yet", async () => {
		expect((await answer({ sub: "luck" })).description).toContain("No warrior has 20 decided games of chance this month yet");
	});
});

describe("a failed read", () => {
	it("answers plainly instead of throwing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.findAllForPlayer.mockRejectedValue(new Error("connection lost"));
		expect((await answer({ sub: "me" })).description).toContain("would not open just now");
		error.mockRestore();
	});
});
