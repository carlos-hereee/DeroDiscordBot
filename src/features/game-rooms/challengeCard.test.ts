import { describe, it, expect, vi } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));

import { challengeResultLine, closeChallengeCard } from "./challengeCard.js";
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

describe("closeChallengeCard", () => {
	it("skips a room that never had a challenge card", async () => {
		const fetch = vi.fn();
		const client = { guilds: { cache: { get: vi.fn() }, fetch } } as unknown as Client;

		await closeChallengeCard(client, { roomId: "room-1", guildId: "guild-1", boardMessageId: null } as unknown as IGameRoom, "line");

		expect((client.guilds.cache.get as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});
