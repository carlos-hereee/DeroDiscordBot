import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: vi.fn(), findBySatelliteChannel: vi.fn() },
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: vi.fn() }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { archiveNow: vi.fn(), finish: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomHoldemHandlers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./roomHoldemHandlers.js")>()),
	roomHoldemHandlers: {
		handleBuyIn: vi.fn(),
		handleDeal: vi.fn(),
		handleMove: vi.fn(),
		handleShowCards: vi.fn(),
		handleLeaveTable: vi.fn(),
		handleEndTable: vi.fn(),
		handleImBack: vi.fn(),
		handleSeatsToggle: vi.fn(),
	},
}));

import { _handleGameRoomButton } from "./gameRoomHandlers.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { roomHoldemHandlers } from "./roomHoldemHandlers.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── a press in a satellite (2026-10 item 244 Phase 5a) ───────────────
// What:  the router resolves a press in a network table's satellite channel to the HOST
//        row, by the guild and channel it came from, and lets only that satellite's
//        seated players press only their own seat's controls there.

type Mock = ReturnType<typeof vi.fn>;
const storeMock = gameRoomStore as unknown as Record<"findByRoomId" | "findBySatelliteChannel", Mock>;
const gateMock = gateOwnerOrAdmin as unknown as Mock;
const holdemMock = roomHoldemHandlers as unknown as Record<string, Mock>;
const words = rokCommanderCopy.arcadeSatellites;

const hostRoom = (overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: "host-guild",
		game: "holdem",
		hostId: "host-1",
		status: "playing",
		playerIds: ["host-1", "remote-1"],
		network: true,
		satellites: [{ guildId: "remote-guild", channelId: "sat-ch", userIds: ["remote-1", "remote-2"], tableMessageId: "sat-msg" }],
		...overrides,
	}) as unknown as IGameRoom;

function pressInSatellite(customId: string, userId: string, channelId = "sat-ch"): ButtonInteraction {
	return {
		customId,
		guildId: "remote-guild",
		guild: { id: "remote-guild" },
		channelId,
		user: { id: userId },
		client: { user: { id: "bot-1" } },
		reply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

const replyText = (interaction: ButtonInteraction): string =>
	(((interaction.reply as unknown as Mock).mock.calls[0]?.[0] ?? {}) as { content?: string }).content ?? "";

beforeEach(() => {
	vi.clearAllMocks();
	// The clicking guild holds no room by this id: the room lives in the host guild.
	storeMock.findByRoomId.mockResolvedValue(null);
	storeMock.findBySatelliteChannel.mockResolvedValue(hostRoom());
	// An admin of the REMOTE server would pass the host room's admin override.
	gateMock.mockResolvedValue(true);
});

describe("a press in a satellite channel", () => {
	it("resolves the host row through the satellite lookup, scoped to the guild and channel it came from", async () => {
		await _handleGameRoomButton(pressInSatellite("gameroom:hmove:room-1:call", "remote-1"));

		expect(storeMock.findByRoomId).toHaveBeenCalledWith("remote-guild", "room-1");
		expect(storeMock.findBySatelliteChannel).toHaveBeenCalledWith("remote-guild", "sat-ch");
		expect(holdemMock.handleMove).toHaveBeenCalledOnce();
		const [, room, preset] = holdemMock.handleMove.mock.calls[0] as [unknown, IGameRoom, string];
		expect(room.guildId).toBe("host-guild");
		expect(room.roomId).toBe("room-1");
		expect(preset).toBe("call");
	});

	it("lets a seated remote member buy in from their satellite", async () => {
		await _handleGameRoomButton(pressInSatellite("gameroom:hjoin:room-1", "remote-2"));
		expect(holdemMock.handleBuyIn).toHaveBeenCalledOnce();
	});

	it("refuses a member the satellite does not seat, even an admin of that server reading along", async () => {
		const interaction = pressInSatellite("gameroom:hcards:room-1", "remote-admin");

		await _handleGameRoomButton(interaction);

		expect(replyText(interaction)).toBe(words.notSeatedHere);
		expect(holdemMock.handleShowCards).not.toHaveBeenCalled();
	});

	// ⚠️ The host's controls, with the admin override, belong to the host room. In a
	// satellite the clicker is a member of another server, so the override never runs.
	it.each([
		["deal", "gameroom:hstart:room-1", "handleDeal"],
		["end the table", "gameroom:hend:room-1", "handleEndTable"],
		["open seats", "gameroom:hseats:room-1:on", "handleSeatsToggle"],
	])("refuses a host only action (%s) from a satellite, without consulting the admin override", async (_label, customId, handler) => {
		const interaction = pressInSatellite(customId, "remote-1");

		await _handleGameRoomButton(interaction);

		expect(replyText(interaction)).toBe(words.hostRoomOnly);
		expect(holdemMock[handler]).not.toHaveBeenCalled();
		expect(gateMock).not.toHaveBeenCalled();
	});

	it("refuses Archive now and Rematch from a satellite", async () => {
		for (const customId of ["gameroom:archive:room-1", "gameroom:rematch:room-1"]) {
			const interaction = pressInSatellite(customId, "remote-1");
			await _handleGameRoomButton(interaction);
			expect(replyText(interaction)).toBe(words.hostRoomOnly);
		}
		expect((roomLifecycle as unknown as Record<string, Mock>).archiveNow).not.toHaveBeenCalled();
	});

	it("reads a control naming another table as not found, even inside a satellite", async () => {
		const interaction = pressInSatellite("gameroom:hmove:room-OTHER:call", "remote-1");

		await _handleGameRoomButton(interaction);

		expect(replyText(interaction)).toBe("That room no longer exists.");
		expect(holdemMock.handleMove).not.toHaveBeenCalled();
	});

	it("reads a press from a channel that is no satellite as not found", async () => {
		storeMock.findBySatelliteChannel.mockResolvedValue(null);
		const interaction = pressInSatellite("gameroom:hmove:room-1:call", "remote-1", "some-other-channel");

		await _handleGameRoomButton(interaction);

		expect(replyText(interaction)).toBe("That room no longer exists.");
		expect(holdemMock.handleMove).not.toHaveBeenCalled();
	});

	it("never asks the satellite lookup about a press the clicking guild's own room answers", async () => {
		storeMock.findByRoomId.mockResolvedValue(hostRoom({ guildId: "remote-guild", satellites: [] }));

		await _handleGameRoomButton(pressInSatellite("gameroom:hmove:room-1:call", "remote-1"));

		expect(storeMock.findBySatelliteChannel).not.toHaveBeenCalled();
		expect(holdemMock.handleMove).toHaveBeenCalledOnce();
	});
});
