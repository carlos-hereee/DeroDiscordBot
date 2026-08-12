import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { finish: vi.fn(), markArchived: vi.fn(), appendMove: vi.fn() },
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: { findByGuildId: vi.fn() },
}));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn() } }));

import { finish, archiveRoom, archiveNow } from "./roomLifecycle.js";
import { postMove } from "./roomTrail.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as {
	finish: ReturnType<typeof vi.fn>;
	markArchived: ReturnType<typeof vi.fn>;
	appendMove: ReturnType<typeof vi.fn>;
};
const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const logMock = botLogStore as unknown as { log: ReturnType<typeof vi.fn> };

function makeRoom(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "hangman",
		hostId: "host-1",
		playerIds: ["host-1", "player-2"],
		spectatorIds: ["spectator-3"],
		visibility: "invite",
		channelId: "room-channel-1",
		openerMessageId: "opener-1",
		boardMessageId: null,
		status: "playing",
		secret: null,
		moves: [],
		winnerId: null,
		startedAt: new Date(),
		endedAt: null,
		archiveAt: null,
		...overrides,
	} as IGameRoom;
}

function makeChannel() {
	return {
		id: "room-channel-1",
		guild: { roles: { everyone: { id: "everyone" } } },
		isTextBased: () => true,
		isDMBased: () => false,
		send: vi.fn().mockResolvedValue({ id: "result-1" }),
		delete: vi.fn().mockResolvedValue(undefined),
		permissionOverwrites: { set: vi.fn().mockResolvedValue(undefined) },
	};
}

function makeClient(channel: unknown): Client {
	return {
		user: { id: "bot-1" },
		channels: { fetch: vi.fn().mockResolvedValue(channel) },
	} as unknown as Client;
}

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.finish.mockResolvedValue(undefined);
	storeMock.markArchived.mockResolvedValue(undefined);
	storeMock.appendMove.mockResolvedValue(undefined);
	configMock.findByGuildId.mockResolvedValue({ adminRoleId: "admin-role" });
	logMock.log.mockResolvedValue(undefined);
});

describe("roomLifecycle.finish", () => {
	it("stamps endedAt and an archiveAt exactly one archive window out", async () => {
		const now = new Date("2026-08-12T10:00:00.000Z");
		const channel = makeChannel();
		await finish(makeClient(channel), makeRoom(), { winnerId: "host-1", now });

		expect(storeMock.finish).toHaveBeenCalledWith("guild-1", "room-1", {
			winnerId: "host-1",
			endedAt: now,
			archiveAt: new Date(now.getTime() + BOT_CONSTANTS.GAME_ROOM_ARCHIVE_DELAY_MS),
		});
	});

	// ⚠️ THE ORDER IS LOAD BEARING IN ONE DIRECTION. Persist-then-lock leaves, on a
	// crash between them, a finished row with a real archiveAt and a still-writable
	// channel: untidy for hours, and the sweep still cleans it. Lock-then-persist would
	// leave a LOCKED channel on a row still marked "playing", which the finished-only
	// sweep never touches and no recovery path finds, so it sits locked forever.
	it("persists the row BEFORE it touches the channel", async () => {
		const order: string[] = [];
		const channel = makeChannel();
		storeMock.finish.mockImplementation(async () => void order.push("persist"));
		channel.permissionOverwrites.set.mockImplementation(async () => void order.push("lock"));

		await finish(makeClient(channel), makeRoom());

		expect(order).toEqual(["persist", "lock"]);
	});

	it("locks the channel so nobody but the bot can write", async () => {
		const channel = makeChannel();
		await finish(makeClient(channel), makeRoom());

		const overwrites = channel.permissionOverwrites.set.mock.calls[0][0] as {
			id: string;
			allow?: bigint[];
			deny?: bigint[];
		}[];
		expect(overwrites.find((entry) => entry.id === "everyone")?.deny).toContain(PermissionFlagsBits.SendMessages);
		const writers = overwrites.filter((entry) => entry.allow?.includes(PermissionFlagsBits.SendMessages));
		expect(writers.map((entry) => entry.id)).toEqual(["bot-1"]);
	});

	// `set` replaces the entire array. A merge-style per-entry edit would leave behind
	// whichever playing-phase allows this code forgot to mention, which is the exact
	// shape of a lock that looks applied and is not.
	it("REPLACES the overwrite array rather than editing entries", async () => {
		const channel = makeChannel();
		await finish(makeClient(channel), makeRoom());
		expect(channel.permissionOverwrites.set).toHaveBeenCalledOnce();
	});

	it("posts the result card with the Archive now button", async () => {
		const channel = makeChannel();
		await finish(makeClient(channel), makeRoom(), { winnerId: "player-2" });

		const payload = channel.send.mock.calls[0][0] as { components: { components: unknown[] }[] };
		expect(payload.components).toHaveLength(1);
		expect(channel.send).toHaveBeenCalledOnce();
	});

	it("still stamps the row when the channel is already gone", async () => {
		// The ordinary abandonment case: an admin deleted the room channel. The row is
		// what the sweep reads, so stamping it is what lets the room close out at all.
		await finish(makeClient(null), makeRoom());
		expect(storeMock.finish).toHaveBeenCalledOnce();
	});

	it("survives a guild config read failure rather than leaving the room unlocked", async () => {
		configMock.findByGuildId.mockRejectedValue(new Error("mongo blip"));
		const channel = makeChannel();

		await finish(makeClient(channel), makeRoom());

		// The admin role is a nice-to-have on the overwrite array; the LOCK is not.
		expect(channel.permissionOverwrites.set).toHaveBeenCalledOnce();
	});
});

describe("roomLifecycle.archiveRoom", () => {
	it("deletes the channel, closes the row and logs it", async () => {
		const channel = makeChannel();
		await archiveRoom(makeClient(channel), makeRoom());

		expect(channel.delete).toHaveBeenCalled();
		expect(storeMock.markArchived).toHaveBeenCalledWith("guild-1", "room-1");
		expect(logMock.log).toHaveBeenCalled();
	});

	// ⚠️ AN ALREADY-DELETED CHANNEL IS A SUCCESS, NOT AN ERROR. Treating it as a failure
	// would leave the row un-archived, and the sweep would retry it every five minutes
	// forever.
	it("closes the row anyway when the channel is already gone", async () => {
		await archiveRoom(makeClient(null), makeRoom({ channelId: null }));
		expect(storeMock.markArchived).toHaveBeenCalledWith("guild-1", "room-1");
	});

	it("closes the row even when the delete itself fails", async () => {
		const channel = makeChannel();
		channel.delete.mockRejectedValue(new Error("50013"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await archiveRoom(makeClient(channel), makeRoom());

		expect(storeMock.markArchived).toHaveBeenCalledOnce();
		errorSpy.mockRestore();
	});
});

describe("roomLifecycle.archiveNow", () => {
	it("lets the host archive their own room", async () => {
		const channel = makeChannel();
		const result = await archiveNow(makeClient(channel), makeRoom(), "host-1", false);

		expect(result).toEqual({ ok: true });
		expect(channel.delete).toHaveBeenCalled();
	});

	it("lets an admin archive somebody else's room", async () => {
		const channel = makeChannel();
		const result = await archiveNow(makeClient(channel), makeRoom(), "moderator-9", true);
		expect(result).toEqual({ ok: true });
	});

	it("refuses a player who is neither host nor admin, and deletes NOTHING", async () => {
		const channel = makeChannel();
		const result = await archiveNow(makeClient(channel), makeRoom(), "player-2", false);

		expect(result).toEqual({ ok: false, reason: "notYours" });
		expect(channel.delete).not.toHaveBeenCalled();
		expect(storeMock.markArchived).not.toHaveBeenCalled();
	});
});

describe("roomTrail.postMove", () => {
	it("sends the move, then records it", async () => {
		const order: string[] = [];
		const channel = makeChannel();
		channel.send.mockImplementation(async () => {
			order.push("send");
			return { id: "m1" };
		});
		storeMock.appendMove.mockImplementation(async () => void order.push("append"));

		const posted = await postMove(makeClient(channel), makeRoom(), { actorId: "host-1", kind: "guess", text: "played E" });

		expect(posted).toBe(true);
		expect(order).toEqual(["send", "append"]);
	});

	// ⚠️ A TRANSCRIPT ROW FOR A MOVE NOBODY SAW IS UNRECOVERABLE. The dashboard would
	// show a move absent from the channel and nothing could say which one lied. A
	// missing row after a successful send is merely a gap, which is the tolerable
	// direction, so the send failing must abort the write entirely.
	it("records NOTHING when the send fails", async () => {
		const channel = makeChannel();
		channel.send.mockRejectedValue(new Error("50013"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const posted = await postMove(makeClient(channel), makeRoom(), { actorId: "host-1", kind: "guess", text: "played E" });

		expect(posted).toBe(false);
		expect(storeMock.appendMove).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("still reports success when only the transcript append fails", async () => {
		const channel = makeChannel();
		storeMock.appendMove.mockRejectedValue(new Error("mongo blip"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const posted = await postMove(makeClient(channel), makeRoom(), { actorId: "host-1", kind: "guess", text: "played E" });

		// The players saw it. Failing here would make a Mongo blip look like a rejected
		// move to whoever just played.
		expect(posted).toBe(true);
		errorSpy.mockRestore();
	});

	// ⚠️ SECURITY CONTROL, NOT A COURTESY. Move text is composed from user input in
	// places (a host-authored hangman hint, a display name). Without the pin, an
	// "@everyone" inside that text would ping the whole server from the bot's mouth.
	it("pins allowedMentions to the actor so text cannot smuggle a mass ping", async () => {
		const channel = makeChannel();
		await postMove(makeClient(channel), makeRoom(), {
			actorId: "host-1",
			kind: "hint",
			text: "@everyone look at this",
		});

		const payload = channel.send.mock.calls[0][0] as { allowedMentions: { users: string[] } };
		expect(payload.allowedMentions).toEqual({ users: ["host-1"] });
	});

	it("never attaches files to a move", async () => {
		const channel = makeChannel();
		await postMove(makeClient(channel), makeRoom(), { actorId: "host-1", kind: "system", text: "x" });
		expect(channel.send.mock.calls[0][0]).not.toHaveProperty("files");
	});

	it("drops the move rather than throwing when the room channel is gone", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const posted = await postMove(makeClient(null), makeRoom({ channelId: null }), {
			actorId: "host-1",
			kind: "system",
			text: "x",
		});

		expect(posted).toBe(false);
		expect(storeMock.appendMove).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});
