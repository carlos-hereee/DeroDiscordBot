import { describe, it, expect, vi } from "vitest";
import { TextChannel, type Client, type Guild } from "discord.js";

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));

import { challengeCardLink, challengeResultLine, closeChallengeCard, editOpenerCard, isChallengeChannel, refreshTableCard, resolveChallengesChannel } from "./challengeCard.js";
import type { OpenerCardState } from "./challengeBoardEmbeds.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the closed challenge card's line (post-launch plan item 21) ──────
// "**winner** won." plus a flavor line for how, with the flavor drawn from the shelf
// for the game and bucket. rng 0 picks each shelf's first line, so the cases can name
// the exact line they expect.

const FIRST = (): number => 0;
const flavor = gameRoomsCopy.postMatch.flavor;

describe("challengeResultLine", () => {
	it("names the winner and the game's own flavor for the bucket", () => {
		const line = challengeResultLine({ game: "holdem", winnerId: "p1", abandoned: false, bucket: "tactic" }, FIRST);
		expect(line).toBe(`👑 **<@p1>** won. ${flavor.byGame.holdem?.tactic?.[0]}`);
	});

	it("reads a win with no bucket as narrow, the plan's default", () => {
		const line = challengeResultLine({ game: "coinflip", winnerId: "p1", abandoned: false }, FIRST);
		expect(line).toBe(`👑 **<@p1>** won. ${flavor.byGame.luck?.narrow?.[0]}`);
	});

	it("falls back to the shared shelf for a bucket the game has none for", () => {
		const line = challengeResultLine({ game: "battleship", winnerId: "p1", abandoned: false, bucket: "forfeit" }, FIRST);
		expect(line).toBe(`👑 **<@p1>** won. ${flavor.shared.forfeit[0]}`);
	});

	it("names the room for hangman's guessers, and a draw as a draw", () => {
		expect(challengeResultLine({ game: "hangman", winnerId: null, abandoned: false, bucket: "decisive", roomWon: true }, FIRST)).toBe(
			`👑 **The room** won. ${flavor.byGame.hangman?.decisive?.[0]}`
		);
		expect(challengeResultLine({ game: "rps", winnerId: null, abandoned: false, bucket: "draw" }, FIRST)).toBe(`🤝 **A draw.** ${flavor.shared.draw[0]}`);
	});

	it("adds no flavor when nobody won, and says so for an abandoned room", () => {
		expect(challengeResultLine({ game: "hangman", winnerId: null, abandoned: false })).toBe(gameRoomsCopy.postMatch.noWinnerLine);
		expect(challengeResultLine({ game: "holdem", winnerId: "p1", abandoned: true })).toBe(gameRoomsCopy.postMatch.abandonedLine);
	});
});

// ── a dealing table's open card (2026-10 item 276, D14) ──────────────
// A ranked Blackjack table's card stays open while it deals and redraws its seats, so a redraw
// still rendering when finish closes the card must never draw it open again.
describe("an open table's card", () => {
	const guild = { members: { cache: { get: () => undefined }, fetch: async () => null } } as unknown as Guild;
	const open: OpenerCardState = { game: "blackjack", hostId: "host-1", visibility: "public", pool: [], startedChannelId: "room-ch", tableSeats: { taken: 2, max: 5 } };

	it("never draws an open table over a card that closed", async () => {
		const message = { edit: vi.fn(async () => undefined) };
		await editOpenerCard(guild, "room-open-1", message, open);
		await editOpenerCard(guild, "room-open-1", message, { ...open, resultLine: "over" });
		await editOpenerCard(guild, "room-open-1", message, open);
		expect(message.edit).toHaveBeenCalledTimes(2);
	});

	it("redraws no card for a room that is no longer playing", async () => {
		const fetch = vi.fn();
		const client = { guilds: { cache: { get: vi.fn() }, fetch } } as unknown as Client;
		const room = { roomId: "room-1", guildId: "guild-1", boardMessageId: "card-1", status: "finished", channelId: "room-ch" } as unknown as IGameRoom;
		await refreshTableCard(client, room, { userIds: ["host-1"], max: 5 });
		expect((client.guilds.cache.get as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
	});
});

describe("closeChallengeCard", () => {
	it("skips a room that never had a challenge card", async () => {
		const fetch = vi.fn();
		const client = { guilds: { cache: { get: vi.fn() }, fetch } } as unknown as Client;

		await closeChallengeCard(client, { roomId: "room-1", guildId: "guild-1", boardMessageId: null } as unknown as IGameRoom, "line");

		expect((client.guilds.cache.get as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});

// ── which channel a challenge lives in (2026-10 item 254, Arcade 5) ──────
describe("resolveChallengesChannel", () => {
	const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
	const textChannel = (id: string): TextChannel => Object.assign(Object.create(TextChannel.prototype), { id }) as TextChannel;

	function guildWith(channels: Record<string, TextChannel>): Guild {
		return { id: "guild-1", channels: { fetch: vi.fn(async (id: string) => channels[id] ?? null) } } as unknown as Guild;
	}

	const BOTH = { arcadeChallengesChannelId: "challenges-1", arcadeRatedChallengesChannelId: "rated-1" };

	it.each(["holdem", "battleship", "monopoly", "blackjack"] as const)("posts a rated game's card (%s) in 🏆rated-challenges", async (game) => {
		configMock.findByGuildId.mockResolvedValue(BOTH);
		const channel = await resolveChallengesChannel(guildWith({ "challenges-1": textChannel("challenges-1"), "rated-1": textChannel("rated-1") }), game);
		expect(channel?.id).toBe("rated-1");
	});

	it.each(["coinflip", "diceroll", "rps", "hangman"] as const)("keeps %s, which is not rated, in ⚔️challenges", async (game) => {
		configMock.findByGuildId.mockResolvedValue(BOTH);
		const channel = await resolveChallengesChannel(guildWith({ "challenges-1": textChannel("challenges-1"), "rated-1": textChannel("rated-1") }), game);
		expect(channel?.id).toBe("challenges-1");
	});

	// Owner decision 8 (2026-10 item 263 R3-5): the channel is the game's AND the match's.
	it.each(["holdem", "battleship", "monopoly", "blackjack"] as const)("posts a casual %s card in ⚔️challenges", async (game) => {
		configMock.findByGuildId.mockResolvedValue(BOTH);
		const channel = await resolveChallengesChannel(guildWith({ "challenges-1": textChannel("challenges-1"), "rated-1": textChannel("rated-1") }), game, true);
		expect(channel?.id).toBe("challenges-1");
	});

	// A guild whose boot repair has not built 🏆rated-challenges yet still takes rated challenges.
	it("falls back to ⚔️challenges for a rated game while the guild has no 🏆rated-challenges", async () => {
		configMock.findByGuildId.mockResolvedValue({ arcadeChallengesChannelId: "challenges-1", arcadeRatedChallengesChannelId: null });
		const channel = await resolveChallengesChannel(guildWith({ "challenges-1": textChannel("challenges-1") }), "holdem");
		expect(channel?.id).toBe("challenges-1");
	});
});

describe("isChallengeChannel", () => {
	const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };

	it("knows both challenge channels, and nothing else", async () => {
		configMock.findByGuildId.mockResolvedValue({ arcadeChallengesChannelId: "challenges-1", arcadeRatedChallengesChannelId: "rated-1" });
		await expect(isChallengeChannel("guild-1", "challenges-1")).resolves.toBe(true);
		await expect(isChallengeChannel("guild-1", "rated-1")).resolves.toBe(true);
		await expect(isChallengeChannel("guild-1", "games-1")).resolves.toBe(false);
		await expect(isChallengeChannel("guild-1", null)).resolves.toBe(false);
	});
});

// ── the held card's link (2026-10 item 263 R3-9) ──
describe("challengeCardLink", () => {
	const ids = { arcadeChallengesChannelId: "challenges-1", arcadeRatedChallengesChannelId: "rated-1" };

	it("links a card in the channel its game and match post in", () => {
		expect(challengeCardLink(ids, { guildId: "guild-1", game: "holdem", casual: false, boardMessageId: "card-1" })).toBe("https://discord.com/channels/guild-1/rated-1/card-1");
		expect(challengeCardLink(ids, { guildId: "guild-1", game: "holdem", casual: true, boardMessageId: "card-1" })).toBe("https://discord.com/channels/guild-1/challenges-1/card-1");
		expect(challengeCardLink(ids, { guildId: "guild-1", game: "rps", casual: false, boardMessageId: "card-1" })).toBe("https://discord.com/channels/guild-1/challenges-1/card-1");
	});

	it("links nothing for a draft with no card", () => {
		expect(challengeCardLink(ids, { guildId: "guild-1", game: "holdem", casual: false, boardMessageId: null })).toBeNull();
	});
});
