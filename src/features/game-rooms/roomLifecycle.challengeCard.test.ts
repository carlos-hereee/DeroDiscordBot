import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { finish: vi.fn() } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
// The card edit itself is challengeCard's business; here only WHETHER finish closes the
// card, and with which line, is under test. The line builder stays real.
vi.mock("./challengeCard.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./challengeCard.js")>()), closeChallengeCard: vi.fn() }));

import { finish } from "./roomLifecycle.js";
import { closeChallengeCard } from "./challengeCard.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── finish closes the challenge card (post-launch plan item 21) ──────

const storeMock = gameRoomStore as unknown as { finish: ReturnType<typeof vi.fn> };
const closeMock = closeChallengeCard as unknown as ReturnType<typeof vi.fn>;

const room = {
	roomId: "room-1",
	guildId: "guild-1",
	game: "battleship",
	hostId: "p1",
	playerIds: ["p1", "p2"],
	channelId: null,
	boardMessageId: "card-1",
	status: "playing",
} as unknown as IGameRoom;

// No room channel, so finish skips the lock and the result card and only the claim,
// the top up and the card close are left to observe.
const client = { user: { id: "bot-1" }, channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.finish.mockResolvedValue({ ...room, status: "finished" });
	closeMock.mockResolvedValue(undefined);
});

describe("roomLifecycle.finish and the challenge card", () => {
	it("closes the card with the winner and a flavor line from the bucket's shelf", async () => {
		await finish(client, room, { winnerId: "p2", outcome: { bucket: "comeback" } });

		expect(closeMock).toHaveBeenCalledOnce();
		const [, closedRoom, line] = closeMock.mock.calls[0] as [Client, IGameRoom, string];
		expect(closedRoom.roomId).toBe("room-1");
		const shelf = gameRoomsCopy.postMatch.flavor.byGame.battleship?.comeback ?? [];
		expect(shelf.some((flavor) => line === `👑 **<@p2>** won. ${flavor}`)).toBe(true);
	});

	it("says the room was abandoned when nobody chose the ending", async () => {
		await finish(client, room, { abandoned: true });

		expect(closeMock.mock.calls[0][2]).toBe(gameRoomsCopy.postMatch.abandonedLine);
	});

	it("leaves the card alone when another path already finished the room", async () => {
		storeMock.finish.mockResolvedValue(null);

		await finish(client, room, { winnerId: "p2", outcome: { bucket: "decisive" } });

		expect(closeMock).not.toHaveBeenCalled();
	});
});
