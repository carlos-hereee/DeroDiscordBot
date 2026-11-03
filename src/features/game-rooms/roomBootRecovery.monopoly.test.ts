import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findNonTerminal: vi.fn() },
}));
// Recovery calls the bare `finish`, and a saved ending finishes through the Monopoly handlers'
// `roomLifecycle.finish` (2026-10 item 280); one mock serves both, so a test sees every finish.
const lifecycle = vi.hoisted(() => ({ finish: vi.fn() }));
vi.mock("./roomLifecycle.js", () => ({ finish: lifecycle.finish, roomLifecycle: lifecycle }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn(), awardTwoPlayerResult: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", () => ({ recordMatchRatings: vi.fn(), monopolyFinishingOrder: vi.fn(() => []) }));
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
import { awardMultiPlayerResult } from "@features/games/gameXp.js";

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
		guilds: { fetch: vi.fn(async () => null) },
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

// ── a final move saved with no finish after it (2026-10 item 280) ─────
// A restart between the final move's save and its finish left the engine finished and the room
// playing, which nothing ever finished. Boot recovery finishes it at once as played, even when
// its channel is gone too, so the pot is paid and the seats rated rather than abandoned.
describe("recoverGameRoomsOnBoot with a Monopoly match the engine ended", () => {
	const settledRoom = (channelId: string) => {
		const room = monopolyRoom(channelId);
		return { ...room, secret: { ...room.secret, phase: "finished", winnerId: "player-b" } };
	};

	it.each([["ch-live"], ["ch-gone"]])("finishes it as played with its winner (channel %s)", async (channelId) => {
		finishMock.mockResolvedValue(true);
		storeMock.findNonTerminal.mockResolvedValue([settledRoom(channelId)]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		const summary = await recoverGameRoomsOnBoot(makeClient(["ch-live"]));

		expect(summary).toMatchObject({ abandoned: 0, settled: 1 });
		expect(finishMock).toHaveBeenCalledOnce();
		expect(finishMock.mock.calls[0][2]).toMatchObject({ winnerId: "player-b" });
		expect(finishMock.mock.calls[0][2]).not.toHaveProperty("abandoned");
		expect(awardMultiPlayerResult).toHaveBeenCalledWith(expect.objectContaining({ game: "monopoly", winnerId: "player-b" }));
		logSpy.mockRestore();
	});
});
