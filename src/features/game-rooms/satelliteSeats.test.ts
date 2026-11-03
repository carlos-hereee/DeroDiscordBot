import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordAPIError, Events, RESTJSONErrorCodes, type Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		seatOutSatellitePlayers: vi.fn(),
		findByRoomId: vi.fn(),
		updateSecretIf: vi.fn(),
		findOpenBySatellitePlayer: vi.fn(),
		findOpenBySatelliteGuild: vi.fn(),
		findBySatelliteChannel: vi.fn(),
		findOpenNetwork: vi.fn(),
	},
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/ratings/recordMatchRatings.js")>()),
	recordMatchRatings: vi.fn(),
}));

import {
	handleSatelliteChannelDelete,
	handleSatelliteGuildDelete,
	handleSatelliteMemberRemove,
	reconcileSatellitesOnBoot,
	registerSatelliteWatchers,
} from "./satelliteSeats.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { recordMatchRatings } from "@features/ratings/recordMatchRatings.js";
import { act, createTable, dealHand, handInProgress, joinTable, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { SatelliteRoom } from "./roomTypes.js";

// ── a satellite's departures (2026-10 item 244 Phase 5a) ─────────────
// What:  a member of a satellite's server who leaves THAT server, a server that removes
//        Dero, and a deleted satellite channel each seat their players out of the network
//        table the way the host's Remove a player does, excluded from ratings, while the
//        table plays on; and the boot reconcile catches up on the same, carefully.

type Mock = ReturnType<typeof vi.fn>;
const storeMock = gameRoomStore as unknown as Record<keyof typeof gameRoomStore, Mock>;
const trailMock = roomTrail.postMove as unknown as Mock;
const finishMock = roomLifecycle.finish as unknown as Mock;
const ratingMock = recordMatchRatings as unknown as Mock;
const words = rokCommanderCopy.arcadeSatellites;

const HOST = "host-1";
const REMOTE = "remote-1";

function seededRng(seed = 7): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

// A tournament between hands, after hand one settled, with the remote player seated.
function betweenHands(userIds: string[]): HoldemTable {
	const table = createTable();
	for (const userId of userIds) joinTable(table, userId, userId);
	table.status = "playing";
	dealHand(table, seededRng());
	for (let turn = 0; turn < 20 && handInProgress(table); turn++) act(table, whoActs(table)!, "fold");
	table.boardMessageId = null;
	return table;
}

const satelliteOf = (userIds: string[] = [REMOTE], guildId = "remote-guild", channelId = "sat-ch"): SatelliteRoom => ({
	guildId,
	channelId,
	userIds,
	tableMessageId: null,
});

function makeRoom(table: HoldemTable | null, overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "host-guild",
		game: "holdem",
		hostId: HOST,
		status: "playing",
		playerIds: table ? table.seats.map((seat) => seat.userId) : [HOST],
		channelId: "host-ch",
		network: true,
		satellites: [satelliteOf()],
		kickedIds: [],
		secret: table,
		...overrides,
	} as unknown as IGameRoom;
}

// The row after the seat out landed: the leaver is off every list and on kickedIds.
function afterSeatOut(room: IGameRoom, leaving: string[]): IGameRoom {
	return {
		...room,
		playerIds: room.playerIds.filter((userId) => !leaving.includes(userId)),
		kickedIds: [...(room.kickedIds ?? []), ...leaving],
	} as IGameRoom;
}

const client = { user: { id: "bot-1" }, channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;
const lines = (): string[] => trailMock.mock.calls.map((call) => (call[2] as { text: string }).text);

beforeEach(() => {
	vi.clearAllMocks();
	trailMock.mockResolvedValue(true);
	finishMock.mockResolvedValue(true);
	storeMock.updateSecretIf.mockResolvedValue({});
	storeMock.findOpenBySatellitePlayer.mockResolvedValue([]);
});

describe("a remote member leaving their own server", () => {
	it("is seated out the way a removal is, and the match it ends rates without them", async () => {
		const room = makeRoom(betweenHands([HOST, REMOTE]));
		const updated = afterSeatOut(room, [REMOTE]);
		storeMock.findOpenBySatellitePlayer.mockResolvedValue([room]);
		storeMock.seatOutSatellitePlayers.mockResolvedValue(updated);
		storeMock.findByRoomId.mockResolvedValue(updated);

		expect(await handleSatelliteMemberRemove(client, { id: REMOTE, guild: { id: "remote-guild" } })).toBe(1);

		expect(storeMock.findOpenBySatellitePlayer).toHaveBeenCalledWith("remote-guild", REMOTE);
		expect(storeMock.seatOutSatellitePlayers).toHaveBeenCalledWith("host-guild", "room-1", "remote-guild", [REMOTE], { endSatellite: false });
		expect(lines()[0]).toBe(words.seatOut.leftServer(REMOTE));
		// Off the table the way Leave table takes a seat, which leaves one player and ends it.
		const left = storeMock.updateSecretIf.mock.calls[0][3] as HoldemTable;
		expect(left.seats.find((seat) => seat.userId === REMOTE)?.out).toBe(true);
		expect(finishMock).toHaveBeenCalledOnce();
		// Excluded, exactly as Phase 4's removal is: the row the finish rated carries them on kickedIds.
		expect(ratingMock).toHaveBeenCalledOnce();
		expect(ratingMock.mock.calls[0][2]).toEqual([REMOTE]);
	});

	it("leaves a table with players left playing on, without ending the host room", async () => {
		const room = makeRoom(betweenHands([HOST, "p2", REMOTE]));
		const updated = afterSeatOut(room, [REMOTE]);
		storeMock.findOpenBySatellitePlayer.mockResolvedValue([room]);
		storeMock.seatOutSatellitePlayers.mockResolvedValue(updated);
		storeMock.findByRoomId.mockResolvedValue(updated);

		await handleSatelliteMemberRemove(client, { id: REMOTE, guild: { id: "remote-guild" } });

		expect(storeMock.updateSecretIf).toHaveBeenCalledOnce();
		expect(finishMock).not.toHaveBeenCalled();
	});

	it("costs a departure that seats nobody one read and no write", async () => {
		await handleSatelliteMemberRemove(client, { id: "nobody", guild: { id: "some-guild" } });

		expect(storeMock.findOpenBySatellitePlayer).toHaveBeenCalledWith("some-guild", "nobody");
		expect(storeMock.seatOutSatellitePlayers).not.toHaveBeenCalled();
		expect(trailMock).not.toHaveBeenCalled();
	});

	it("writes no line when the room closed before the seat out landed", async () => {
		storeMock.findOpenBySatellitePlayer.mockResolvedValue([makeRoom(betweenHands([HOST, REMOTE]))]);
		storeMock.seatOutSatellitePlayers.mockResolvedValue(null);

		expect(await handleSatelliteMemberRemove(client, { id: REMOTE, guild: { id: "remote-guild" } })).toBe(0);
		expect(trailMock).not.toHaveBeenCalled();
	});
});

describe("a remote server removing Dero", () => {
	it("ends that satellite and seats out everybody it seated", async () => {
		const room = makeRoom(betweenHands([HOST, "p2", REMOTE, "remote-2"]), { satellites: [satelliteOf([REMOTE, "remote-2"])] });
		const updated = afterSeatOut({ ...room, satellites: [] } as IGameRoom, [REMOTE, "remote-2"]);
		storeMock.findOpenBySatelliteGuild.mockResolvedValue([room]);
		storeMock.seatOutSatellitePlayers.mockResolvedValue(updated);
		storeMock.findByRoomId.mockResolvedValue(updated);

		expect(await handleSatelliteGuildDelete(client, { id: "remote-guild" })).toBe(2);

		expect(storeMock.seatOutSatellitePlayers).toHaveBeenCalledWith("host-guild", "room-1", "remote-guild", [REMOTE, "remote-2"], { endSatellite: true });
		expect(lines()).toEqual([words.seatOut.serverRemovedDero(REMOTE), words.seatOut.serverRemovedDero("remote-2")]);
	});
});

describe("a satellite channel being deleted", () => {
	it("seats out its players when the table is live", async () => {
		const room = makeRoom(betweenHands([HOST, "p2", REMOTE]));
		storeMock.findBySatelliteChannel.mockResolvedValue(room);
		storeMock.seatOutSatellitePlayers.mockResolvedValue(afterSeatOut(room, [REMOTE]));
		storeMock.findByRoomId.mockResolvedValue(afterSeatOut(room, [REMOTE]));

		expect(await handleSatelliteChannelDelete(client, { id: "sat-ch", guildId: "remote-guild" })).toBe(1);
		expect(storeMock.seatOutSatellitePlayers).toHaveBeenCalledWith("host-guild", "room-1", "remote-guild", [REMOTE], { endSatellite: true });
		expect(lines()).toEqual([words.seatOut.channelGone(REMOTE)]);
	});

	// The archive deletes every satellite of a finished room, and each delete arrives here.
	it("leaves a finished room alone", async () => {
		storeMock.findBySatelliteChannel.mockResolvedValue(makeRoom(null, { status: "finished" }));

		expect(await handleSatelliteChannelDelete(client, { id: "sat-ch", guildId: "remote-guild" })).toBe(0);
		expect(storeMock.seatOutSatellitePlayers).not.toHaveBeenCalled();
	});
});

describe("registerSatelliteWatchers", () => {
	it("binds the member, guild and channel departures, and ignores a DM channel", async () => {
		const handlers = new Map<string, (payload: unknown) => void>();
		const fakeClient = { on: vi.fn((event: string, handler: (payload: unknown) => void) => handlers.set(event, handler)) } as unknown as Client;
		storeMock.findOpenBySatelliteGuild.mockResolvedValue([]);
		storeMock.findBySatelliteChannel.mockResolvedValue(null);

		registerSatelliteWatchers(fakeClient);
		expect([...handlers.keys()].sort()).toEqual([Events.ChannelDelete, Events.GuildDelete, Events.GuildMemberRemove].sort());

		handlers.get(Events.GuildMemberRemove)!({ id: REMOTE, guild: { id: "remote-guild" } });
		handlers.get(Events.GuildDelete)!({ id: "remote-guild" });
		handlers.get(Events.ChannelDelete)!({ id: "dm-1" });
		handlers.get(Events.ChannelDelete)!({ id: "sat-ch", guild: { id: "remote-guild" } });
		await new Promise((resolve) => setImmediate(resolve));

		expect(storeMock.findOpenBySatellitePlayer).toHaveBeenCalledWith("remote-guild", REMOTE);
		expect(storeMock.findOpenBySatelliteGuild).toHaveBeenCalledWith("remote-guild");
		expect(storeMock.findBySatelliteChannel).toHaveBeenCalledOnce();
		expect(storeMock.findBySatelliteChannel).toHaveBeenCalledWith("remote-guild", "sat-ch");
	});
});

describe("the boot reconcile", () => {
	const apiError = (code: number) => new DiscordAPIError({ code, message: "test" }, code, 404, "GET", "url", {});

	function bootClient(guild: unknown, channelFetch: Mock): Client {
		return {
			user: { id: "bot-1" },
			guilds: { cache: new Map(guild ? [["remote-guild", guild]] : []) },
			channels: { fetch: channelFetch },
		} as unknown as Client;
	}

	beforeEach(() => {
		const room = makeRoom(null);
		storeMock.findOpenNetwork.mockResolvedValue([room]);
		storeMock.seatOutSatellitePlayers.mockResolvedValue(afterSeatOut(room, [REMOTE]));
		storeMock.findByRoomId.mockResolvedValue(afterSeatOut(room, [REMOTE]));
	});

	it("ends the satellite of a server that removed the bot while it was down", async () => {
		await reconcileSatellitesOnBoot(bootClient(null, vi.fn()));
		expect(storeMock.seatOutSatellitePlayers).toHaveBeenCalledWith("host-guild", "room-1", "remote-guild", [REMOTE], { endSatellite: true });
		expect(lines()).toEqual([words.seatOut.serverRemovedDero(REMOTE)]);
	});

	// An outage is not a removal, and a timeout is not a deletion.
	it("seats nobody out for an unavailable server or a failed fetch", async () => {
		await reconcileSatellitesOnBoot(bootClient({ available: false }, vi.fn()));
		const flaky = { available: true, members: { fetch: vi.fn().mockRejectedValue(new Error("timeout")) } };
		await reconcileSatellitesOnBoot(bootClient(flaky, vi.fn().mockRejectedValue(new Error("timeout"))));
		expect(storeMock.seatOutSatellitePlayers).not.toHaveBeenCalled();
	});

	it("ends a satellite whose channel Discord says is gone", async () => {
		const guild = { available: true, members: { fetch: vi.fn() } };
		await reconcileSatellitesOnBoot(bootClient(guild, vi.fn().mockRejectedValue(apiError(RESTJSONErrorCodes.UnknownChannel))));
		expect(storeMock.seatOutSatellitePlayers).toHaveBeenCalledWith("host-guild", "room-1", "remote-guild", [REMOTE], { endSatellite: true });
		expect(lines()).toEqual([words.seatOut.channelGone(REMOTE)]);
	});

	it("seats out a member Discord says has left their server, and keeps the satellite", async () => {
		const guild = { available: true, members: { fetch: vi.fn().mockRejectedValue(apiError(RESTJSONErrorCodes.UnknownMember)) } };
		await reconcileSatellitesOnBoot(bootClient(guild, vi.fn().mockResolvedValue({ id: "sat-ch" })));
		expect(storeMock.seatOutSatellitePlayers).toHaveBeenCalledWith("host-guild", "room-1", "remote-guild", [REMOTE], { endSatellite: false });
		expect(lines()).toEqual([words.seatOut.leftServer(REMOTE)]);
	});
});
