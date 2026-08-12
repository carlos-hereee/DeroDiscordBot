import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findNonTerminal: vi.fn() },
}));
vi.mock("./roomLifecycle.js", () => ({ finish: vi.fn() }));
vi.mock("./roomArchiveSweep.js", () => ({ sweepExpiredRooms: vi.fn() }));

import { recoverGameRoomsOnBoot } from "./roomBootRecovery.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { finish } from "./roomLifecycle.js";
import { sweepExpiredRooms } from "./roomArchiveSweep.js";

const storeMock = gameRoomStore as unknown as { findNonTerminal: ReturnType<typeof vi.fn> };
const finishMock = finish as unknown as ReturnType<typeof vi.fn>;
const sweepMock = sweepExpiredRooms as unknown as ReturnType<typeof vi.fn>;

const makeRoom = (roomId: string, channelId: string | null) => ({
	roomId,
	guildId: "guild-1",
	channelId,
	status: "playing",
});

function makeClient(liveChannelIds: string[]): Client {
	return {
		user: { id: "bot-1" },
		channels: {
			fetch: vi.fn(async (id: string) => (liveChannelIds.includes(id) ? { id } : null)),
		},
	} as unknown as Client;
}

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.findNonTerminal.mockResolvedValue([]);
	finishMock.mockResolvedValue(undefined);
	sweepMock.mockResolvedValue({ archived: 0, failed: 0 });
});

describe("recoverGameRoomsOnBoot", () => {
	// ⚠️ THE CASE THIS EXISTS FOR. While the process was down, an admin deleted a room
	// channel and nothing was listening. The row still says "playing", and because the
	// partial unique index counts non-terminal statuses it holds that host's ONE room
	// slot forever: that member can never start another game, everyone else is fine,
	// and no error is ever raised.
	it("closes a room whose channel no longer exists, as abandoned", async () => {
		storeMock.findNonTerminal.mockResolvedValue([makeRoom("ghost", "ch-gone")]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		const summary = await recoverGameRoomsOnBoot(makeClient([]));

		expect(summary.abandoned).toBe(1);
		expect(finishMock).toHaveBeenCalledOnce();
		expect(finishMock.mock.calls[0][2]).toEqual({ abandoned: true });
		logSpy.mockRestore();
	});

	it("leaves a room whose channel is still there completely alone", async () => {
		// The overwhelmingly common case: a deploy restarted the bot mid match. The
		// room must come back fully playable, which means nothing touches it.
		storeMock.findNonTerminal.mockResolvedValue([makeRoom("live", "ch-live")]);

		const summary = await recoverGameRoomsOnBoot(makeClient(["ch-live"]));

		expect(summary.abandoned).toBe(0);
		expect(finishMock).not.toHaveBeenCalled();
	});

	// ⚠️ A DRAFT HAS NO CHANNEL BY DEFINITION, so "no channel" says nothing about it.
	// Reaping drafts here would finish every room a host was still configuring at the
	// moment of a deploy. They expire on their own GAME_ROOM_DRAFT_TIMEOUT_MS clock.
	it("never reaps a draft, which legitimately has no channel yet", async () => {
		storeMock.findNonTerminal.mockResolvedValue([makeRoom("draft", null)]);

		const summary = await recoverGameRoomsOnBoot(makeClient([]));

		expect(summary.abandoned).toBe(0);
		expect(finishMock).not.toHaveBeenCalled();
	});

	it("keeps going when one room fails to close", async () => {
		storeMock.findNonTerminal.mockResolvedValue([makeRoom("a", "gone-a"), makeRoom("b", "gone-b")]);
		finishMock.mockRejectedValueOnce(new Error("unknown guild"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		const summary = await recoverGameRoomsOnBoot(makeClient([]));

		expect(finishMock).toHaveBeenCalledTimes(2);
		expect(summary.abandoned).toBe(1);
		errorSpy.mockRestore();
		logSpy.mockRestore();
	});

	// A bot that was down for six hours has rooms that passed archiveAt while nothing
	// was sweeping. Waiting for the first cron tick would leave them visible for five
	// more minutes for no reason.
	it("runs the expiry sweep immediately rather than waiting for the first cron tick", async () => {
		sweepMock.mockResolvedValue({ archived: 3, failed: 0 });
		const summary = await recoverGameRoomsOnBoot(makeClient([]));

		expect(sweepMock).toHaveBeenCalledOnce();
		expect(summary.archived).toBe(3);
	});

	it("still sweeps when the recovery scan itself fails", async () => {
		// The two halves are independent. A Mongo blip on the scan must not skip the
		// archiving, which is the half that deletes channels members can see.
		storeMock.findNonTerminal.mockRejectedValue(new Error("mongo down"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const summary = await recoverGameRoomsOnBoot(makeClient([]));

		expect(sweepMock).toHaveBeenCalledOnce();
		expect(summary.abandoned).toBe(0);
		errorSpy.mockRestore();
	});

	it("never throws into the boot sequence when the sweep fails", async () => {
		// This runs inside main.ts's ready handler. A rejection here would surface as a
		// startup failure in a feature that is not on the critical path.
		sweepMock.mockRejectedValue(new Error("discord down"));
		await expect(recoverGameRoomsOnBoot(makeClient([]))).resolves.toEqual({ abandoned: 0, archived: 0 });
	});
});
