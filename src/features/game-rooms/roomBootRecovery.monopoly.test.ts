import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findNonTerminal: vi.fn() },
}));
vi.mock("./roomLifecycle.js", () => ({ finish: vi.fn() }));
vi.mock("./roomArchiveSweep.js", () => ({ sweepExpiredRooms: vi.fn() }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("@features/games/blackjackHandler.js", () => ({
	hasLiveBlackjackTable: vi.fn(),
	disarmStaleBlackjackBoard: vi.fn(),
}));

import { recoverGameRoomsOnBoot } from "./roomBootRecovery.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { finish } from "./roomLifecycle.js";
import { sweepExpiredRooms } from "./roomArchiveSweep.js";
import { roomTrail } from "./roomTrail.js";
import { createInitialState } from "@features/games/monopolyState.js";

// ── boot recovery for a Monopoly room ────────────────────────────────
// ⚠️ PINS THAT A DEPLOY MID MATCH IS A NO-OP (the plan's Definition of Done 2).
// The whole match lives on the row's `secret`, so a room whose channel survived
// the restart must come back exactly as it was: not finished, not posted to, not
// written. The recovery code needs no Monopoly branch for that, and this fixture
// is what stops a future branch from adding one by accident.

const storeMock = gameRoomStore as unknown as { findNonTerminal: ReturnType<typeof vi.fn> };
const finishMock = finish as unknown as ReturnType<typeof vi.fn>;
const postMoveMock = roomTrail.postMove as unknown as ReturnType<typeof vi.fn>;

const monopolyRoom = (channelId: string) => ({
	roomId: "room-1",
	guildId: "guild-1",
	hostId: "player-a",
	channelId,
	game: "monopoly",
	status: "playing",
	secret: { ...createInitialState(["player-a", "player-b"], { auctionsEnabled: false }, 0, 1), boardMessageId: "board-1" },
});

const makeClient = (liveChannelIds: string[]): Client =>
	({
		user: { id: "bot-1" },
		channels: { fetch: vi.fn(async (id: string) => (liveChannelIds.includes(id) ? { id } : null)) },
	}) as unknown as Client;

beforeEach(() => {
	vi.clearAllMocks();
	(sweepExpiredRooms as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ archived: 0, failed: 0 });
	finishMock.mockResolvedValue(undefined);
	postMoveMock.mockResolvedValue(true);
});

describe("recoverGameRoomsOnBoot with a Monopoly room", () => {
	it("leaves a playing match with a live channel completely alone", async () => {
		storeMock.findNonTerminal.mockResolvedValue([monopolyRoom("ch-live")]);

		const summary = await recoverGameRoomsOnBoot(makeClient(["ch-live"]));

		expect(summary).toMatchObject({ abandoned: 0, lostTables: 0 });
		expect(finishMock).not.toHaveBeenCalled();
		expect(postMoveMock).not.toHaveBeenCalled();
	});

	it("still closes a match whose channel was deleted while the bot was down, as abandoned", async () => {
		storeMock.findNonTerminal.mockResolvedValue([monopolyRoom("ch-gone")]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		const summary = await recoverGameRoomsOnBoot(makeClient([]));

		expect(summary.abandoned).toBe(1);
		expect(finishMock.mock.calls[0][2]).toEqual({ abandoned: true });
		logSpy.mockRestore();
	});
});
