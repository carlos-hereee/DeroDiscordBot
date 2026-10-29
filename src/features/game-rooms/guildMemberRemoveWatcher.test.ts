import { describe, it, expect, vi, beforeEach } from "vitest";
import { Events, type Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findOpenByPlayer: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("./roomDeparture.js", () => ({ departMatch: vi.fn() }));

import { handleGuildMemberRemove, registerGameRoomMemberRemoveWatcher } from "./guildMemberRemoveWatcher.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { departMatch } from "./roomDeparture.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as { findOpenByPlayer: ReturnType<typeof vi.fn> };
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };
const lifecycleMock = roomLifecycle as unknown as { finish: ReturnType<typeof vi.fn> };
const departMock = departMatch as unknown as ReturnType<typeof vi.fn>;

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
	departMock.mockResolvedValue(undefined);
});

describe("handleGuildMemberRemove", () => {
	// ⚠️ 2026-10 item 276, audit P1-4: a match in play goes through the game's own departure, the
	// one its Leave or Surrender plays, never a finish naming the one other human the winner. One
	// leave used to end a four seat Monopoly match, or a Hold'em table, for everyone.
	it.each(["monopoly", "holdem", "blackjack", "battleship", "hangman", "rps"])("takes the leaver out of a %s match through the game's own departure", async (game) => {
		const room = makeRoom({ game: game as IGameRoom["game"], playerIds: ["host-1", "leaver-1", "p3", "p4"] });
		storeMock.findOpenByPlayer.mockResolvedValue([room]);

		await handleGuildMemberRemove(client, departed);

		expect(departMock).toHaveBeenCalledOnce();
		expect(departMock).toHaveBeenCalledWith(client, room, "leaver-1", "leftServer");
		// The departure decides whether the match ends; the watcher never finishes it itself.
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
		// The departure posts the line itself (Monopoly carries it on the turn's board).
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});

	it("still takes the leaver out of their other rooms when one departure fails", async () => {
		storeMock.findOpenByPlayer.mockResolvedValue([makeRoom({ roomId: "room-1" }), makeRoom({ roomId: "room-2" })]);
		departMock.mockRejectedValueOnce(new Error("board busy"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		await handleGuildMemberRemove(client, departed);

		expect(departMock).toHaveBeenCalledTimes(2);
		expect(departMock.mock.calls[1][1]).toMatchObject({ roomId: "room-2" });
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
		// The store answer drives the fan-out: one departure per match in play, one line and
		// one abandoned finish per draft.
		storeMock.findOpenByPlayer.mockResolvedValue([
			makeRoom({ roomId: "room-1" }),
			makeRoom({ roomId: "room-2", playerIds: ["leaver-1", "p9"], hostId: "p9" }),
			makeRoom({ roomId: "room-3", status: "draft" }),
		]);

		await handleGuildMemberRemove(client, departed);

		expect(departMock).toHaveBeenCalledTimes(2);
		expect(trailMock.postMove).toHaveBeenCalledOnce();
		expect(lifecycleMock.finish).toHaveBeenCalledOnce();
	});

	it("costs a non-participant departure zero writes", async () => {
		storeMock.findOpenByPlayer.mockResolvedValue([]);

		await handleGuildMemberRemove(client, departed);

		// One indexed read, nothing else: this fires on EVERY departure in the guild.
		expect(storeMock.findOpenByPlayer).toHaveBeenCalledWith("guild-1", "leaver-1");
		expect(trailMock.postMove).not.toHaveBeenCalled();
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
		expect(departMock).not.toHaveBeenCalled();
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
