import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: vi.fn() },
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: { findByGuildId: vi.fn() },
}));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: vi.fn() }));
vi.mock("./roomLifecycle.js", () => ({
	roomLifecycle: { archiveNow: vi.fn(), finish: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));

import { _handleGameRoomButton } from "./gameRoomHandlers.js";
import { parseGameRoomCustomId } from "./gameRoomActions.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { roomTrail } from "./roomTrail.js";

const storeMock = gameRoomStore as unknown as { findByRoomId: ReturnType<typeof vi.fn> };
const gateMock = gateOwnerOrAdmin as unknown as ReturnType<typeof vi.fn>;
const lifecycleMock = roomLifecycle as unknown as {
	archiveNow: ReturnType<typeof vi.fn>;
	finish: ReturnType<typeof vi.fn>;
};
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };

const makeRoom = (overrides: Record<string, unknown> = {}) => ({
	roomId: "room-1",
	guildId: "guild-1",
	hostId: "host-1",
	playerIds: ["host-1", "player-2"],
	channelId: "ch-room",
	...overrides,
});

function makeInteraction(customId: string, userId = "host-1"): ButtonInteraction {
	return {
		customId,
		guildId: "guild-1",
		guild: { id: "guild-1" },
		user: { id: userId },
		client: { user: { id: "bot-1" } },
		reply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

const replyText = (interaction: ButtonInteraction): string =>
	((interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content?: string }).content ?? "";

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.findByRoomId.mockResolvedValue(makeRoom());
	gateMock.mockResolvedValue(false);
	lifecycleMock.archiveNow.mockResolvedValue({ ok: true });
	lifecycleMock.finish.mockResolvedValue(undefined);
	trailMock.postMove.mockResolvedValue(true);
});

describe("parseGameRoomCustomId", () => {
	it("parses a known control", () => {
		expect(parseGameRoomCustomId("gameroom:archive:room-1")).toEqual({ action: "archive", roomId: "room-1" });
	});

	// customIds live as long as the messages carrying them, so a control retired two
	// deploys ago is still clickable by anyone scrolling back. That is the ordinary
	// case here, not an attack.
	it.each([
		["a foreign prefix", "powerup:archive:room-1"],
		["an unknown action", "gameroom:selfdestruct:room-1"],
		["a missing roomId", "gameroom:archive"],
		["garbage", "nonsense"],
		// Phase 4's reserved controls are deliberately NOT in the table yet, so they
		// must read as unknown rather than routing into a branch that does not exist.
		["a Phase 4 control that is not built", "gameroom:join:room-1"],
	])("returns null for %s", (_label, customId) => {
		expect(parseGameRoomCustomId(customId)).toBeNull();
	});
});

describe("gameRoomHandlers routing", () => {
	it("answers an unknown control honestly instead of crashing", async () => {
		const interaction = makeInteraction("gameroom:join:room-1");
		await _handleGameRoomButton(interaction);
		expect(replyText(interaction)).toContain("no longer available");
	});

	// ⚠️ GUILD SCOPING IS A SECURITY BOUNDARY (invariant 2). The roomId rides a
	// customId anyone can read and replay, so a room in another guild must read as NOT
	// FOUND rather than forbidden; "forbidden" would confirm it exists.
	it("scopes the room lookup to the clicking guild", async () => {
		const interaction = makeInteraction("gameroom:archive:room-1");
		await _handleGameRoomButton(interaction);
		expect(storeMock.findByRoomId).toHaveBeenCalledWith("guild-1", "room-1");
	});

	it("reports a missing room as not found", async () => {
		storeMock.findByRoomId.mockResolvedValue(null);
		const interaction = makeInteraction("gameroom:archive:room-1");

		await _handleGameRoomButton(interaction);

		expect(replyText(interaction)).toContain("no longer exists");
		expect(lifecycleMock.archiveNow).not.toHaveBeenCalled();
	});
});

describe("gameRoomHandlers gates", () => {
	it("lets the host archive", async () => {
		await _handleGameRoomButton(makeInteraction("gameroom:archive:room-1", "host-1"));
		expect(lifecycleMock.archiveNow).toHaveBeenCalledOnce();
	});

	it("lets an admin archive somebody else's room", async () => {
		gateMock.mockResolvedValue(true);
		await _handleGameRoomButton(makeInteraction("gameroom:archive:room-1", "moderator-9"));

		// Clearing an abandoned room is moderation, which is why hostOnly is not a bare
		// equality check against hostId.
		expect(lifecycleMock.archiveNow).toHaveBeenCalledOnce();
		expect(lifecycleMock.archiveNow.mock.calls[0][3]).toBe(true);
	});

	it("refuses a player who is neither host nor admin", async () => {
		const interaction = makeInteraction("gameroom:archive:room-1", "player-2");
		await _handleGameRoomButton(interaction);

		expect(lifecycleMock.archiveNow).not.toHaveBeenCalled();
		expect(replyText(interaction)).toContain("host or an admin");
	});

	// ⚠️ main.ts DOES NOT GATE BUTTONS. Its permission checks live inside
	// `if (interaction.isChatInputCommand())`, so this handler is the only gate a
	// clicker passes. A spectator forfeiting somebody else's match is the obvious
	// griefing shape.
	it("refuses a forfeit from someone who is not a player", async () => {
		const interaction = makeInteraction("gameroom:forfeit:room-1", "spectator-3");
		await _handleGameRoomButton(interaction);

		expect(lifecycleMock.finish).not.toHaveBeenCalled();
		expect(trailMock.postMove).not.toHaveBeenCalled();
		expect(replyText(interaction)).toContain("host or an admin");
	});
});

describe("gameRoomHandlers forfeit", () => {
	it("records the forfeit as a MOVE before finishing the room", async () => {
		const order: string[] = [];
		trailMock.postMove.mockImplementation(async () => {
			order.push("move");
			return true;
		});
		lifecycleMock.finish.mockImplementation(async () => void order.push("finish"));

		await _handleGameRoomButton(makeInteraction("gameroom:forfeit:room-1", "player-2"));

		// The transcript is the product. A forfeit that only appeared on the result
		// card would be missing from the history the dashboard reads back.
		expect(order).toEqual(["move", "finish"]);
	});

	it("hands the win to the one remaining player", async () => {
		await _handleGameRoomButton(makeInteraction("gameroom:forfeit:room-1", "player-2"));
		expect(lifecycleMock.finish.mock.calls[0][2]).toEqual({ winnerId: "host-1" });
	});

	// A three seat room losing one player has no winner yet. Picking an arbitrary
	// survivor would write a false result into a permanent transcript.
	it("declares no winner when more than one player remains", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ playerIds: ["host-1", "player-2", "player-3"] }));
		await _handleGameRoomButton(makeInteraction("gameroom:forfeit:room-1", "player-2"));
		expect(lifecycleMock.finish.mock.calls[0][2]).toEqual({ winnerId: null });
	});

	it("acknowledges before the room is torn down", async () => {
		// The channel this button lives in is about to stop existing. Replying after
		// the delete would throw against a channel that is no longer there.
		const interaction = makeInteraction("gameroom:archive:room-1", "host-1");
		const order: string[] = [];
		(interaction.reply as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => void order.push("ack"));
		lifecycleMock.archiveNow.mockImplementation(async () => {
			order.push("archive");
			return { ok: true };
		});

		await _handleGameRoomButton(interaction);

		expect(order).toEqual(["ack", "archive"]);
	});
});
