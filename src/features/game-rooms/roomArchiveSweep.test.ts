import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findExpiredArchives: vi.fn(), markArchived: vi.fn() },
}));
vi.mock("./roomLifecycle.js", () => ({ archiveRoom: vi.fn() }));

import { sweepExpiredRooms } from "./roomArchiveSweep.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { archiveRoom } from "./roomLifecycle.js";

const storeMock = gameRoomStore as unknown as { findExpiredArchives: ReturnType<typeof vi.fn> };
const archiveMock = archiveRoom as unknown as ReturnType<typeof vi.fn>;

const client = { user: { id: "bot-1" } } as unknown as Client;
const makeRoom = (roomId: string, guildId = "guild-1") => ({ roomId, guildId, channelId: `ch-${roomId}` });

beforeEach(() => {
	vi.clearAllMocks();
	archiveMock.mockResolvedValue("archived");
});

describe("sweepExpiredRooms", () => {
	it("does nothing and touches no channel on an empty tick", async () => {
		storeMock.findExpiredArchives.mockResolvedValue([]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		expect(await sweepExpiredRooms(client)).toEqual({ archived: 0, failed: 0 });
		expect(archiveMock).not.toHaveBeenCalled();
		// An empty tick is the normal state, every five minutes, forever. Logging it
		// would drown the Railway log in noise.
		expect(logSpy).not.toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it("archives every expired room", async () => {
		storeMock.findExpiredArchives.mockResolvedValue([makeRoom("a"), makeRoom("b"), makeRoom("c")]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		expect(await sweepExpiredRooms(client)).toEqual({ archived: 3, failed: 0 });
		expect(archiveMock).toHaveBeenCalledTimes(3);
		logSpy.mockRestore();
	});

	// ⚠️ ISOLATION IS PER ROOM, NOT PER GUILD, AND NOT ABSENT. This runs on a cron with
	// nobody watching: one room whose guild the bot was kicked from must not stop the
	// other nineteen, and an unisolated throw would be swallowed by the cron wrapper
	// while the backlog grew silently.
	it("keeps going when one room fails, and counts it", async () => {
		storeMock.findExpiredArchives.mockResolvedValue([makeRoom("a"), makeRoom("bad"), makeRoom("c")]);
		archiveMock.mockImplementation(async (_client: unknown, room: { roomId: string }) => {
			if (room.roomId === "bad") throw new Error("unknown guild");
			return "archived";
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		expect(await sweepExpiredRooms(client)).toEqual({ archived: 2, failed: 1 });
		expect(archiveMock).toHaveBeenCalledTimes(3);
		errorSpy.mockRestore();
		logSpy.mockRestore();
	});

	// 2026-10 item 276, audit P3: a refused delete or a channel a rematch took over is not archived.
	it("counts a room left for the next tick, or left to its rematch, as not archived", async () => {
		storeMock.findExpiredArchives.mockResolvedValue([makeRoom("a"), makeRoom("refused"), makeRoom("rematched")]);
		archiveMock.mockImplementation(async (_client: unknown, room: { roomId: string }) => ({ a: "archived", refused: "retry", rematched: "kept" })[room.roomId]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		expect(await sweepExpiredRooms(client)).toEqual({ archived: 1, failed: 2 });
		logSpy.mockRestore();
	});

	it("passes the caller's clock straight through to the query", async () => {
		// The safety property lives in that query (status finished AND a non-null
		// archiveAt in the past), not in this loop, so what it is asked is the thing
		// worth pinning.
		storeMock.findExpiredArchives.mockResolvedValue([]);
		const now = new Date("2026-08-12T10:00:00.000Z");
		await sweepExpiredRooms(client, now);
		expect(storeMock.findExpiredArchives).toHaveBeenCalledWith(now);
	});

	it("never fans out more than the concurrency limit at once", async () => {
		// A guild that let a backlog expire while the bot was down would otherwise fire
		// every delete simultaneously into one rate limit bucket and get the whole
		// connection 429ed, not just this sweep.
		let inFlight = 0;
		let peak = 0;
		storeMock.findExpiredArchives.mockResolvedValue(Array.from({ length: 60 }, (_, i) => makeRoom(`r${i}`)));
		archiveMock.mockImplementation(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight--;
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await sweepExpiredRooms(client);

		expect(peak).toBeLessThanOrEqual(20);
		logSpy.mockRestore();
	});
});
