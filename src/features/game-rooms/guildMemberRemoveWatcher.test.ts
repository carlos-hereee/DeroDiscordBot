import { describe, it, expect, vi, beforeEach } from "vitest";
import { Events, type Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findOpenByPlayer: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));

import { handleGuildMemberRemove, registerGameRoomMemberRemoveWatcher } from "./guildMemberRemoveWatcher.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as { findOpenByPlayer: ReturnType<typeof vi.fn> };
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };
const lifecycleMock = roomLifecycle as unknown as { finish: ReturnType<typeof vi.fn> };

const client = { user: { id: "bot-1" } } as unknown as Client;
const departed = { id: "leaver-1", guild: { id: "guild-1" } };

function makeRoom(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "rps",
		hostId: "host-1",
		playerIds: ["host-1", "leaver-1"],
		spectatorIds: [],
		visibility: "public",
		status: "playing",
		channelId: "chan-1",
		...overrides,
	} as unknown as IGameRoom;
}

beforeEach(() => {
	vi.clearAllMocks();
	trailMock.postMove.mockResolvedValue(true);
	lifecycleMock.finish.mockResolvedValue(true);
});

describe("handleGuildMemberRemove", () => {
	it("posts one system line per affected room and finishes each once, survivor wins", async () => {
		storeMock.findOpenByPlayer.mockResolvedValue([makeRoom()]);

		await handleGuildMemberRemove(client, departed);

		expect(trailMock.postMove).toHaveBeenCalledOnce();
		expect(trailMock.postMove).toHaveBeenCalledWith(
			client,
			expect.objectContaining({ roomId: "room-1" }),
			expect.objectContaining({ actorId: "leaver-1", kind: "system", text: expect.stringContaining("left the server") })
		);
		// Forfeit semantics, NOT abandonment: the survivors keep their result and the
		// room-rate top up pays, exactly as if the leaver had pressed Forfeit.
		expect(lifecycleMock.finish).toHaveBeenCalledOnce();
		expect(lifecycleMock.finish).toHaveBeenCalledWith(client, expect.objectContaining({ roomId: "room-1" }), {
			winnerId: "host-1",
			outcome: { bucket: "forfeit" },
		});
	});

	it("resolves no winner when more than one player remains", async () => {
		storeMock.findOpenByPlayer.mockResolvedValue([
			makeRoom({ game: "holdem", playerIds: ["host-1", "leaver-1", "p3"] }),
		]);

		await handleGuildMemberRemove(client, departed);

		expect(lifecycleMock.finish).toHaveBeenCalledWith(client, expect.anything(), { winnerId: null, outcome: { bucket: "forfeit" } });
	});

	it("closes a solo room as abandoned: no winner, no top up to pay", async () => {
		storeMock.findOpenByPlayer.mockResolvedValue([
			makeRoom({ game: "solo-hangman", visibility: "solo", playerIds: ["leaver-1"], hostId: "leaver-1" }),
		]);

		await handleGuildMemberRemove(client, departed);

		expect(trailMock.postMove).toHaveBeenCalledOnce();
		expect(lifecycleMock.finish).toHaveBeenCalledWith(client, expect.anything(), { abandoned: true });
	});

	it("closes a never-started draft as abandoned rather than paying for a match never played", async () => {
		storeMock.findOpenByPlayer.mockResolvedValue([
			makeRoom({ status: "draft", channelId: null, playerIds: ["leaver-1"], hostId: "leaver-1" }),
		]);

		await handleGuildMemberRemove(client, departed);

		expect(lifecycleMock.finish).toHaveBeenCalledWith(client, expect.anything(), { abandoned: true });
	});

	it("sweeps every affected room when the leaver was in more than one", async () => {
		// Player in one, host of another guild member's... the store answer is what
		// drives the fan-out, one trail line and one finish per row.
		storeMock.findOpenByPlayer.mockResolvedValue([
			makeRoom({ roomId: "room-1" }),
			makeRoom({ roomId: "room-2", playerIds: ["leaver-1", "p9"], hostId: "p9" }),
		]);

		await handleGuildMemberRemove(client, departed);

		expect(trailMock.postMove).toHaveBeenCalledTimes(2);
		expect(lifecycleMock.finish).toHaveBeenCalledTimes(2);
	});

	it("costs a non-participant departure zero writes", async () => {
		storeMock.findOpenByPlayer.mockResolvedValue([]);

		await handleGuildMemberRemove(client, departed);

		// One indexed read, nothing else: this fires on EVERY departure in the guild.
		expect(storeMock.findOpenByPlayer).toHaveBeenCalledWith("guild-1", "leaver-1");
		expect(trailMock.postMove).not.toHaveBeenCalled();
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
	});
});

describe("registerGameRoomMemberRemoveWatcher", () => {
	it("binds GuildMemberRemove and routes the payload through the handler", async () => {
		let captured: ((member: typeof departed) => void) | null = null;
		const fakeClient = {
			user: { id: "bot-1" },
			on: vi.fn((event: string, handler: (member: typeof departed) => void) => {
				if (event === Events.GuildMemberRemove) captured = handler;
			}),
		} as unknown as Client;
		storeMock.findOpenByPlayer.mockResolvedValue([]);

		registerGameRoomMemberRemoveWatcher(fakeClient);
		expect(captured).not.toBeNull();

		captured!(departed);
		// The listener is fire and forget; give its promise a tick to run.
		await new Promise((resolve) => setImmediate(resolve));
		expect(storeMock.findOpenByPlayer).toHaveBeenCalledWith("guild-1", "leaver-1");
	});
});
