import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { SatelliteRoom } from "./roomTypes.js";

// ── a network ban or a block reaching seats already taken (2026-10 item 244 Phase 5c) ──
// Owner decision 2026-10-24: a network ban or a block list entry seats out the players it
// names who already sit at a network table, and stops relays to them, through the one
// removal path (seatOutSatellitePlayers): off every list, onto kickedIds, so no rating
// counts them, off the table. A satellite that keeps players is rebuilt without the banned
// member; one left with nobody ends, and an ended satellite leaves the row and its channel
// is deleted at once (owner decision 2026-10-24). A banned member sitting in their OWN
// server's host room keeps that seat.
//
// The store is an in memory stand in that applies the same pulls the real one does, so
// every assertion reads the rows the way the next press would.

const store = vi.hoisted(() => {
	const rooms: IGameRoom[] = [];
	// The live statuses, as NON_TERMINAL_ROOM_STATUSES lists them (a hoisted factory cannot import it).
	const live = (room: IGameRoom) => ["draft", "open", "playing"].includes(room.status);
	const copy = (room: IGameRoom): IGameRoom => structuredClone(room);
	const find = (guildId: string, roomId: string) => rooms.find((room) => room.guildId === guildId && room.roomId === roomId);
	const satellitesOf = (room: IGameRoom): SatelliteRoom[] => room.satellites ?? [];
	return {
		rooms,
		api: {
			findOpenBySatelliteUser: async (userId: string) =>
				rooms.filter((room) => live(room) && room.network && satellitesOf(room).some((entry) => entry.userIds.includes(userId))).map(copy),
			findOpenNetwork: async () => rooms.filter((room) => live(room) && room.network).map(copy),
			findOpenBySatelliteGuild: async (guildId: string) =>
				rooms.filter((room) => live(room) && room.network && satellitesOf(room).some((entry) => entry.guildId === guildId)).map(copy),
			findOpenNetworkHostedIn: async (guildId: string) => rooms.filter((room) => live(room) && room.network && room.guildId === guildId).map(copy),
			findByRoomId: async (guildId: string, roomId: string) => {
				const room = find(guildId, roomId);
				return room ? copy(room) : null;
			},
			seatOutSatellitePlayers: async (
				guildId: string,
				roomId: string,
				satelliteGuildId: string,
				userIds: readonly string[],
				options: { endSatellite: boolean }
			) => {
				const room = find(guildId, roomId);
				if (!room || !live(room) || !satellitesOf(room).some((entry) => entry.guildId === satelliteGuildId)) return null;
				const leaving = (userId: string) => userIds.includes(userId);
				room.playerIds = room.playerIds.filter((userId) => !leaving(userId));
				room.spectatorIds = (room.spectatorIds ?? []).filter((userId) => !leaving(userId));
				room.pendingJoinIds = (room.pendingJoinIds ?? []).filter((userId) => !leaving(userId));
				room.satellites = options.endSatellite
					? satellitesOf(room).filter((entry) => entry.guildId !== satelliteGuildId)
					: satellitesOf(room).map((entry) => (entry.guildId === satelliteGuildId ? { ...entry, userIds: entry.userIds.filter((userId) => !leaving(userId)) } : entry));
				room.kickedIds = [...new Set([...(room.kickedIds ?? []), ...userIds])];
				return copy(room);
			},
			endEmptySatellite: async (guildId: string, roomId: string, satelliteGuildId: string) => {
				const room = find(guildId, roomId);
				if (!room || !live(room) || !satellitesOf(room).some((entry) => entry.guildId === satelliteGuildId && entry.userIds.length === 0)) return null;
				room.satellites = satellitesOf(room).filter((entry) => entry.guildId !== satelliteGuildId);
				return copy(room);
			},
			// The Hold'em removal's compare and swap; every write lands here.
			updateSecretIf: async (guildId: string, roomId: string, _readAt: unknown, secret: unknown) => {
				const room = find(guildId, roomId);
				if (room) room.secret = secret as IGameRoom["secret"];
				return room ? copy(room) : null;
			},
			setSatelliteTableMessage: async () => undefined,
		},
	};
});

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: store.api }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: async () => ({ adminRoleId: null }) } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/ratings/recordMatchRatings.js")>()),
	recordMatchRatings: vi.fn(),
}));

import { seatOutBannedMember, seatOutBannedServer, seatOutBlockedServers } from "./satelliteSeats.js";
import { relayMove, whenRelayed } from "./satelliteRooms.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { recordMatchRatings } from "@features/ratings/recordMatchRatings.js";
import { act, createTable, dealHand, handInProgress, joinTable, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import type { RoomOverwrite } from "./roomPermissions.js";

type Mock = ReturnType<typeof vi.fn>;
const trailMock = roomTrail.postMove as unknown as Mock;
const finishMock = roomLifecycle.finish as unknown as Mock;
const ratingMock = recordMatchRatings as unknown as Mock;
const words = rokCommanderCopy.arcadeSatellites;

const BANNED = "banned-1";
const FRIEND = "friend-1";

// ── fakes ─────────────────────────────────────────────────────────────
interface FakeChannel {
	id: string;
	guild: { id: string; roles: { everyone: { id: string } } };
	isTextBased: () => boolean;
	isDMBased: () => boolean;
	permissionOverwrites: { set: Mock };
	delete: Mock;
	send: Mock;
	messages: { fetch: Mock };
}

const channels = new Map<string, FakeChannel>();

function satelliteChannel(id: string, guildId: string): FakeChannel {
	const channel: FakeChannel = {
		id,
		guild: { id: guildId, roles: { everyone: { id: `everyone-${guildId}` } } },
		isTextBased: () => true,
		isDMBased: () => false,
		permissionOverwrites: { set: vi.fn().mockResolvedValue(undefined) },
		delete: vi.fn().mockResolvedValue(undefined),
		send: vi.fn().mockResolvedValue({ id: `msg-${id}` }),
		messages: { fetch: vi.fn().mockResolvedValue(null) },
	};
	channels.set(id, channel);
	return channel;
}

const client = {
	user: { id: "bot-1" },
	channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) },
	users: { cache: new Map(), fetch: vi.fn().mockRejectedValue(new Error("unknown user")) },
	guilds: { cache: new Map() },
} as unknown as Client;

function seededRng(seed = 7): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

// A tournament between hands, after hand one settled, every player seated.
function betweenHands(userIds: string[]): HoldemTable {
	const table = createTable();
	for (const userId of userIds) joinTable(table, userId, userId);
	table.status = "playing";
	dealHand(table, seededRng());
	for (let turn = 0; turn < 20 && handInProgress(table); turn++) act(table, whoActs(table)!, "fold");
	table.boardMessageId = null;
	return table;
}

const satellite = (guildId: string, channelId: string, userIds: string[]): SatelliteRoom => ({ guildId, channelId, userIds, tableMessageId: null });

function seedRoom(input: { roomId: string; guildId: string; hostId: string; satellites: SatelliteRoom[]; localPlayers?: string[]; table?: boolean }): void {
	const remote = input.satellites.flatMap((entry) => entry.userIds);
	const players = [input.hostId, ...(input.localPlayers ?? []), ...remote];
	store.rooms.push({
		roomId: input.roomId,
		guildId: input.guildId,
		game: "holdem",
		hostId: input.hostId,
		status: "playing",
		playerIds: players,
		spectatorIds: [],
		pendingJoinIds: [],
		channelId: `${input.roomId}-host-ch`,
		network: true,
		satellites: input.satellites,
		kickedIds: [],
		secret: input.table ? betweenHands(players) : null,
	} as unknown as IGameRoom);
}

const row = (roomId: string): IGameRoom => {
	const found = store.rooms.find((room) => room.roomId === roomId);
	if (!found) throw new Error(`no room ${roomId} in the stand in store`);
	return found;
};
const lines = (): string[] => trailMock.mock.calls.map((call) => (call[2] as { text: string }).text);
const overwriteIds = (channel: FakeChannel): string[] => (channel.permissionOverwrites.set.mock.calls.at(-1)?.[0] as RoomOverwrite[]).map((entry) => entry.id);

beforeEach(() => {
	vi.clearAllMocks();
	store.rooms.length = 0;
	channels.clear();
	trailMock.mockResolvedValue(true);
	finishMock.mockResolvedValue(true);
});

// ── a member ban ──────────────────────────────────────────────────────
describe("a network ban on a member", () => {
	it("seats them out of tables in two servers, rebuilding the satellite that stays and ending the one left empty", async () => {
		const kept = satelliteChannel("sat-a", "remote-a");
		const emptied = satelliteChannel("sat-b", "remote-b");
		seedRoom({ roomId: "table-a", guildId: "host-a", hostId: "host-a-1", satellites: [satellite("remote-a", "sat-a", [BANNED, FRIEND])], table: true });
		seedRoom({ roomId: "table-b", guildId: "host-b", hostId: "host-b-1", satellites: [satellite("remote-b", "sat-b", [BANNED])], table: true });

		expect(await seatOutBannedMember(client, BANNED)).toBe(2);

		// Off every list and onto kickedIds at both tables: no door lets them back, no rating counts them.
		for (const roomId of ["table-a", "table-b"]) {
			expect(row(roomId).playerIds).not.toContain(BANNED);
			expect(row(roomId).kickedIds).toContain(BANNED);
		}
		// The satellite that keeps a player stays, rebuilt without the banned member's overwrite.
		expect(row("table-a").satellites).toEqual([satellite("remote-a", "sat-a", [FRIEND])]);
		expect(overwriteIds(kept)).toContain(FRIEND);
		expect(overwriteIds(kept)).not.toContain(BANNED);
		expect(kept.delete).not.toHaveBeenCalled();
		// The satellite left with nobody ends: off the row, its channel deleted.
		expect(row("table-b").satellites).toEqual([]);
		expect(emptied.delete).toHaveBeenCalledOnce();
		expect(emptied.delete.mock.calls[0][0]).not.toContain("archived");
		// The neutral line, once per table, never the owner's note.
		expect(lines()).toEqual([words.seatOut.banned(BANNED), words.seatOut.banned(BANNED)]);
	});

	it("leaves their seat off the table, and the match it ends rates without them", async () => {
		satelliteChannel("sat-b", "remote-b");
		seedRoom({ roomId: "table-b", guildId: "host-b", hostId: "host-b-1", satellites: [satellite("remote-b", "sat-b", [BANNED])], table: true });

		await seatOutBannedMember(client, BANNED);

		const table = row("table-b").secret as unknown as HoldemTable;
		expect(table.seats.find((seat) => seat.userId === BANNED)?.out).toBe(true);
		// Two seats and one left: the table ends, and the finish rates with the banned member excluded.
		expect(finishMock).toHaveBeenCalledOnce();
		expect(ratingMock).toHaveBeenCalledOnce();
		expect(ratingMock.mock.calls[0][2]).toEqual([BANNED]);
	});

	it("keeps their seat in a room hosted in their own server, which a network ban never reaches", async () => {
		seedRoom({ roomId: "home-table", guildId: "home", hostId: "home-host", localPlayers: [BANNED], satellites: [satellite("remote-a", "sat-a", [FRIEND])] });
		satelliteChannel("sat-a", "remote-a");

		expect(await seatOutBannedMember(client, BANNED)).toBe(0);

		expect(row("home-table").playerIds).toContain(BANNED);
		expect(row("home-table").kickedIds).toEqual([]);
		expect(row("home-table").satellites).toEqual([satellite("remote-a", "sat-a", [FRIEND])]);
		expect(trailMock).not.toHaveBeenCalled();
	});

	it("ends every satellite of the tables a banned host hosts, while the host room plays on", async () => {
		const first = satelliteChannel("sat-a", "remote-a");
		const second = satelliteChannel("sat-c", "remote-c");
		seedRoom({ roomId: "hosted", guildId: "home", hostId: BANNED, localPlayers: ["local-1"], satellites: [satellite("remote-a", "sat-a", ["guest-a"]), satellite("remote-c", "sat-c", ["guest-c"])] });

		expect(await seatOutBannedMember(client, BANNED)).toBe(2);

		expect(row("hosted").satellites).toEqual([]);
		expect(row("hosted").kickedIds).toEqual(["guest-a", "guest-c"]);
		expect(row("hosted").playerIds).toEqual([BANNED, "local-1"]);
		expect(row("hosted").status).toBe("playing");
		expect(first.delete).toHaveBeenCalledOnce();
		expect(second.delete).toHaveBeenCalledOnce();
	});
});

// ── a server ban ──────────────────────────────────────────────────────
describe("a network ban on a server", () => {
	it("ends its satellites at other servers' tables and every satellite of the tables it hosts", async () => {
		const there = satelliteChannel("sat-banned", "banned-guild");
		const elsewhere = satelliteChannel("sat-elsewhere", "remote-c");
		const atItsTable = satelliteChannel("sat-at-banned", "remote-d");
		seedRoom({ roomId: "visited", guildId: "host-a", hostId: "host-a-1", satellites: [satellite("banned-guild", "sat-banned", ["member-1", "member-2"]), satellite("remote-c", "sat-elsewhere", ["guest-c"])] });
		seedRoom({ roomId: "its-own", guildId: "banned-guild", hostId: "banned-host", satellites: [satellite("remote-d", "sat-at-banned", ["guest-d"])] });

		expect(await seatOutBannedServer(client, "banned-guild")).toBe(3);

		// Its satellite elsewhere ends; the other server's satellite at that table stays.
		expect(row("visited").satellites).toEqual([satellite("remote-c", "sat-elsewhere", ["guest-c"])]);
		expect(row("visited").kickedIds).toEqual(["member-1", "member-2"]);
		expect(there.delete).toHaveBeenCalledOnce();
		expect(elsewhere.delete).not.toHaveBeenCalled();
		// Every satellite of the table it hosts ends; its own room plays on.
		expect(row("its-own").satellites).toEqual([]);
		expect(row("its-own").kickedIds).toEqual(["guest-d"]);
		expect(row("its-own").status).toBe("playing");
		expect(atItsTable.delete).toHaveBeenCalledOnce();
	});

	it("relays nothing to an ended satellite, while the satellite that stays still gets every move", async () => {
		const ended = satelliteChannel("sat-banned", "banned-guild");
		const stays = satelliteChannel("sat-elsewhere", "remote-c");
		seedRoom({ roomId: "visited", guildId: "host-a", hostId: "host-a-1", satellites: [satellite("banned-guild", "sat-banned", ["member-1"]), satellite("remote-c", "sat-elsewhere", ["guest-c"])] });

		await seatOutBannedServer(client, "banned-guild");
		await relayMove(client, row("visited"), "🃏 host-a-1 raises.");
		await whenRelayed("visited");

		expect(ended.send).not.toHaveBeenCalled();
		expect(stays.send).toHaveBeenCalledOnce();
	});

	it("touches nothing at a table that keeps no satellite in that server", async () => {
		satelliteChannel("sat-elsewhere", "remote-c");
		seedRoom({ roomId: "unrelated", guildId: "host-a", hostId: "host-a-1", satellites: [satellite("remote-c", "sat-elsewhere", ["guest-c"])] });

		expect(await seatOutBannedServer(client, "banned-guild")).toBe(0);

		expect(row("unrelated").satellites).toHaveLength(1);
		expect(row("unrelated").kickedIds).toEqual([]);
	});
});

// ── a block ───────────────────────────────────────────────────────────
describe("a block between two servers", () => {
	it("ends the satellites between them both ways and leaves a third server's satellite alone", async () => {
		const blockedAtOurs = satelliteChannel("sat-x-at-g", "guild-x");
		const thirdAtOurs = satelliteChannel("sat-y-at-g", "guild-y");
		const oursAtTheirs = satelliteChannel("sat-g-at-x", "guild-g");
		seedRoom({ roomId: "ours", guildId: "guild-g", hostId: "g-host", satellites: [satellite("guild-x", "sat-x-at-g", ["x-1"]), satellite("guild-y", "sat-y-at-g", ["y-1"])] });
		seedRoom({ roomId: "theirs", guildId: "guild-x", hostId: "x-host", satellites: [satellite("guild-g", "sat-g-at-x", ["g-1"])] });

		expect(await seatOutBlockedServers(client, "guild-g", "guild-x")).toBe(2);

		expect(row("ours").satellites).toEqual([satellite("guild-y", "sat-y-at-g", ["y-1"])]);
		expect(row("ours").kickedIds).toEqual(["x-1"]);
		expect(row("theirs").satellites).toEqual([]);
		expect(row("theirs").kickedIds).toEqual(["g-1"]);
		expect(blockedAtOurs.delete).toHaveBeenCalledOnce();
		expect(oursAtTheirs.delete).toHaveBeenCalledOnce();
		expect(thirdAtOurs.delete).not.toHaveBeenCalled();
		expect(lines()).toEqual([words.seatOut.blocked("x-1"), words.seatOut.blocked("g-1")]);
	});

	it("relays nothing across the block afterwards", async () => {
		const blocked = satelliteChannel("sat-x-at-g", "guild-x");
		const third = satelliteChannel("sat-y-at-g", "guild-y");
		seedRoom({ roomId: "ours", guildId: "guild-g", hostId: "g-host", satellites: [satellite("guild-x", "sat-x-at-g", ["x-1"]), satellite("guild-y", "sat-y-at-g", ["y-1"])] });

		await seatOutBlockedServers(client, "guild-g", "guild-x");
		await relayMove(client, row("ours"), "🃏 g-host checks.");
		await whenRelayed("ours");

		expect(blocked.send).not.toHaveBeenCalled();
		expect(third.send).toHaveBeenCalledOnce();
	});
});

// ── the neutral words ─────────────────────────────────────────────────
describe("the seat out lines", () => {
	it("name neither who acted nor why", () => {
		for (const line of [words.seatOut.banned("u-1"), words.seatOut.blocked("u-1")]) {
			expect(line).toContain("<@u-1>");
			expect(line.toLowerCase()).not.toMatch(/owner|admin|reason|because they/);
		}
	});
});
