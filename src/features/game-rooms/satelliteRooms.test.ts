import { describe, it, expect, vi, beforeEach } from "vitest";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Collection, EmbedBuilder, PermissionFlagsBits, type Client, type Guild } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		finish: vi.fn(),
		markArchived: vi.fn(),
		appendMove: vi.fn(),
		setSatelliteTableMessage: vi.fn(),
		addSatellite: vi.fn(),
		addSatellitePlayers: vi.fn(),
		findByRoomId: vi.fn(),
	},
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));

import {
	labelMentions,
	openSatellite,
	relayMove,
	relayState,
	satelliteComponents,
	whenRelayed,
	type SatelliteTableMessage,
} from "./satelliteRooms.js";
import { finish, archiveRoom } from "./roomLifecycle.js";
import { postMove } from "./roomTrail.js";
import { buildRoomOverwrites, buildSatelliteOverwrites, type RoomOverwrite } from "./roomPermissions.js";
import { GAME_ROOM_ACTIONS, SATELLITE_ACTIONS } from "./gameRoomActions.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { SatelliteRoom } from "./roomTypes.js";

// ── satellite rooms (2026-10 item 244 Phase 5a) ──────────────────────
// What:  the engine half of network tables: the satellite's permission matrix, how a
//        network table names players, the ordered relay into every satellite and its
//        isolation, the mirrored table message, finish locking and the archive deleting
//        every satellite after or with the host room, and opening a satellite.

type Mock = ReturnType<typeof vi.fn>;
const storeMock = gameRoomStore as unknown as Record<keyof typeof gameRoomStore, Mock>;
const configMock = guildConfigStore.findByGuildId as unknown as Mock;
const words = rokCommanderCopy.arcadeSatellites;

// ── fakes ──
// One shared log, so a test reads the order every channel saw things in.
let events: string[] = [];

interface FakeChannel {
	id: string;
	guild: { roles: { everyone: { id: string } } };
	isTextBased: () => boolean;
	isDMBased: () => boolean;
	send: Mock;
	delete: Mock;
	messages: { fetch: Mock };
	permissionOverwrites: { set: Mock };
	posted: Map<string, { edit: Mock }>;
}

function makeChannel(id: string): FakeChannel {
	const posted = new Map<string, { edit: Mock }>();
	let next = 0;
	const channel: FakeChannel = {
		id,
		guild: { roles: { everyone: { id: `everyone-${id}` } } },
		isTextBased: () => true,
		isDMBased: () => false,
		posted,
		send: vi.fn(async (payload: { content?: string; embeds?: unknown[] }) => {
			events.push(`${id}:send:${payload.content ?? "embed"}`);
			const messageId = `${id}-msg-${++next}`;
			const message = {
				id: messageId,
				pin: vi.fn().mockResolvedValue(undefined),
				edit: vi.fn(async () => void events.push(`${id}:edit:${messageId}`)),
			};
			posted.set(messageId, message);
			return message;
		}),
		delete: vi.fn(async () => void events.push(`${id}:delete`)),
		messages: { fetch: vi.fn(async (messageId: string) => posted.get(messageId) ?? null) },
		permissionOverwrites: { set: vi.fn(async (set: RoomOverwrite[]) => void events.push(`${id}:overwrites:${set.length}`)) },
	};
	return channel;
}

function makeClient(channels: FakeChannel[], users: Record<string, unknown> = {}): Client {
	const byId = new Map(channels.map((channel) => [channel.id, channel]));
	return {
		user: { id: "bot-1" },
		channels: { fetch: vi.fn(async (id: string) => byId.get(id) ?? null) },
		users: { cache: new Map(Object.entries(users)), fetch: vi.fn().mockRejectedValue(new Error("unknown user")) },
		guilds: { fetch: vi.fn().mockResolvedValue(null), cache: new Map() },
	} as unknown as Client;
}

const satellite = (guildId: string, channelId: string, userIds: string[] = [`${guildId}-player`]): SatelliteRoom => ({
	guildId,
	channelId,
	userIds,
	tableMessageId: null,
});

function makeRoom(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "host-guild",
		game: "holdem",
		hostId: "host-1",
		playerIds: ["host-1"],
		spectatorIds: [],
		visibility: "public",
		channelId: "host-ch",
		status: "playing",
		network: true,
		satellites: [],
		kickedIds: [],
		...overrides,
	} as unknown as IGameRoom;
}

const tableMessage = (customIds: string[] = ["gameroom:hmove:room-1:fold"]): SatelliteTableMessage => ({
	embeds: [new EmbedBuilder().setDescription("the table")],
	components: [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			...customIds.map((customId) => new ButtonBuilder().setCustomId(customId).setLabel(customId).setStyle(ButtonStyle.Secondary))
		),
	],
	files: [],
});

beforeEach(() => {
	vi.clearAllMocks();
	events = [];
	configMock.mockResolvedValue({ adminRoleId: null });
	(botLogStore.log as unknown as Mock).mockResolvedValue(undefined);
	storeMock.finish.mockImplementation(async () => makeRoom());
	storeMock.markArchived.mockImplementation(async () => void events.push("row:archived"));
	storeMock.appendMove.mockResolvedValue({});
	storeMock.setSatelliteTableMessage.mockResolvedValue({});
});

// ── the matrix ──
describe("a satellite's permission overwrites", () => {
	const input = { everyoneRoleId: "everyone-2", botId: "bot-1", playerIds: ["r1", "r2"], adminRoleId: "admin-2" };

	// ⚠️ A satellite spends no @everyone allow in any phase: it is a window onto a stranger's
	// table, so nobody in the remote guild but its players (and its admins, read only) sees it.
	it.each(["playing", "finished"] as const)("never allows @everyone anything while %s", (phase) => {
		const everyone = buildSatelliteOverwrites({ ...input, phase }).find((entry) => entry.id === "everyone-2");
		expect(everyone?.allow).toBeUndefined();
		expect(everyone?.deny).toContain(PermissionFlagsBits.ViewChannel);
	});

	it("lets exactly the seated players in, with no host entry, and the admin role read", () => {
		const ids = buildSatelliteOverwrites({ ...input, phase: "playing" }).map((entry) => entry.id);
		expect(ids).toEqual(["everyone-2", "bot-1", "r1", "r2", "admin-2"]);
	});

	it("locks on finish: @everyone may not send, and the players keep read only", () => {
		const locked = buildSatelliteOverwrites({ ...input, phase: "finished" });
		expect(locked.find((entry) => entry.id === "everyone-2")?.deny).toContain(PermissionFlagsBits.SendMessages);
		expect(locked.find((entry) => entry.id === "r1")?.allow).toEqual([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
	});

	// The host room's own matrix did not move: a public room still spends ONE @everyone overwrite.
	it("leaves a public host room's single @everyone overwrite as it was", () => {
		const overwrites = buildRoomOverwrites({
			everyoneRoleId: "everyone-1",
			botId: "bot-1",
			hostId: "host-1",
			playerIds: ["host-1", "p2"],
			spectatorIds: ["s1", "s2"],
			visibility: "public",
			phase: "playing",
		});
		const everyone = overwrites.filter((entry) => entry.id === "everyone-1");
		expect(everyone).toHaveLength(1);
		expect(everyone[0].allow).toEqual([PermissionFlagsBits.ViewChannel]);
		expect(overwrites.map((entry) => entry.id)).toEqual(["everyone-1", "bot-1", "host-1", "p2"]);
	});
});

describe("the controls a satellite carries", () => {
	// ⚠️ The router's hostOnly gate carries an admin override that reads the CLICKER, who in
	// a satellite is an admin of another server. No satellite action may ever be hostOnly.
	it("allows no host only action", () => {
		for (const action of SATELLITE_ACTIONS) expect(GAME_ROOM_ACTIONS[action].hostOnly).toBe(false);
	});

	it("strips the host's controls from the mirrored table and drops an emptied row", () => {
		const rows = [
			...tableMessage(["gameroom:hmove:room-1:fold", "gameroom:hstart:room-1", "gameroom:hend:room-1"]).components,
			...tableMessage(["gameroom:hseats:room-1:on", "gameroom:requests:room-1"]).components,
		];
		const kept = satelliteComponents(rows);
		expect(kept).toHaveLength(1);
		expect(kept[0].components.map((button) => ("custom_id" in button.data ? button.data.custom_id : null))).toEqual(["gameroom:hmove:room-1:fold"]);
	});
});

// ── names ──
describe("naming players at a network table", () => {
	it("names a player by display name and the server tag they wear, escaping markdown", async () => {
		const client = clientWithUsers({ "111": { displayName: "Sir_Ana", primaryGuild: { identityEnabled: true, tag: "ABC" } } });
		expect(await labelMentions(client, "<@111> raises to 40")).toBe(`${words.playerLabel("Sir\\_Ana", "ABC")} raises to 40`);
	});

	it("leaves the tag off when the player wears none, or hides it", async () => {
		const client = clientWithUsers({ "111": { displayName: "Ana", primaryGuild: { identityEnabled: false, tag: "ABC" } } });
		expect(await labelMentions(client, "<@111> folds")).toBe("Ana folds");
	});

	it("never prints a raw id for a player Discord cannot resolve", async () => {
		const client = clientWithUsers({});
		const line = await labelMentions(client, "<@999> busts");
		expect(line).toBe(`${words.unknownPlayer} busts`);
		expect(line).not.toContain("999");
	});
});

function clientWithUsers(users: Record<string, unknown>): Client {
	return makeClient([], users);
}

// ── the relay ──
describe("the relay into every satellite", () => {
	it("keeps the room's order across two satellites, even when a step is slow", async () => {
		const [a, b] = [makeChannel("sat-a"), makeChannel("sat-b")];
		// The first send in satellite A takes a while. Without the per room chain, the
		// table and the second line would overtake it in B, and in A itself.
		const firstSend = a.send.getMockImplementation()!;
		a.send.mockImplementationOnce(async (payload: { content?: string }) => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return firstSend(payload);
		});
		const client = makeClient([a, b]);
		const room = makeRoom({ satellites: [satellite("g-a", "sat-a"), satellite("g-b", "sat-b")] });

		void relayMove(client, room, "line 1");
		void relayState(client, room, tableMessage());
		void relayMove(client, room, "line 2");
		await whenRelayed(room.roomId);

		expect(events).toEqual([
			"sat-a:send:line 1",
			"sat-b:send:line 1",
			"sat-a:send:embed",
			"sat-b:send:embed",
			"sat-a:send:line 2",
			"sat-b:send:line 2",
		]);
	});

	it("never lets one failing satellite block the next, and never rejects", async () => {
		const [a, b] = [makeChannel("sat-a"), makeChannel("sat-b")];
		a.send.mockRejectedValue(new Error("Missing Access"));
		const client = makeClient([a, b]);
		const room = makeRoom({ satellites: [satellite("g-a", "sat-a"), satellite("g-b", "sat-b")] });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		await expect(relayMove(client, room, "line")).resolves.toBeUndefined();

		expect(b.send).toHaveBeenCalledWith(expect.objectContaining({ content: "line" }));
		warn.mockRestore();
	});

	it("posts the host room's line first, and a failing satellite cannot fail the move", async () => {
		const host = makeChannel("host-ch");
		const [a, b] = [makeChannel("sat-a"), makeChannel("sat-b")];
		a.send.mockRejectedValue(new Error("Unknown Channel"));
		const client = makeClient([host, a, b]);
		const room = makeRoom({ network: false, satellites: [satellite("g-a", "sat-a"), satellite("g-b", "sat-b")] });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(await postMove(client, room, { actorId: "host-1", kind: "system", text: "the flop" })).toBe(true);
		await whenRelayed(room.roomId);

		expect(events[0]).toBe("host-ch:send:the flop");
		expect(storeMock.appendMove).toHaveBeenCalledOnce();
		expect(events).toContain("sat-b:send:the flop");
		// Nothing a relay posts pings anybody.
		expect(b.send.mock.calls[0][0]).toEqual({ content: "the flop", allowedMentions: { parse: [] } });
		warn.mockRestore();
	});

	it("posts the mirrored table once, remembers it, and edits that same message after", async () => {
		const a = makeChannel("sat-a");
		const client = makeClient([a]);
		const room = makeRoom({ satellites: [satellite("g-a", "sat-a")] });

		void relayState(client, room, tableMessage());
		// The second relay reads the SAME stale row, with no table message id on it yet.
		void relayState(client, room, tableMessage());
		await whenRelayed(room.roomId);

		expect(a.send).toHaveBeenCalledOnce();
		expect(storeMock.setSatelliteTableMessage).toHaveBeenCalledWith("host-guild", "room-1", "sat-a", "sat-a-msg-1");
		expect(events).toEqual(["sat-a:send:embed", "sat-a:edit:sat-a-msg-1"]);
	});
});

// ── the end of a match ──
describe("finish and archive with satellites", () => {
	it("locks every satellite after the host room, from the claimed row, and posts the result without buttons", async () => {
		const host = makeChannel("host-ch");
		const [a, b] = [makeChannel("sat-a"), makeChannel("sat-b")];
		const client = makeClient([host, a, b]);
		const satellites = [satellite("g-a", "sat-a"), satellite("g-b", "sat-b")];
		// The caller read the room before either satellite opened; the claim returns the row as it is now.
		storeMock.finish.mockResolvedValue(makeRoom({ satellites }));

		expect(await finish(client, makeRoom({ satellites: [] }), { winnerId: "host-1" })).toBe(true);
		await whenRelayed("room-1");

		const hostLock = events.indexOf("host-ch:overwrites:3");
		expect(hostLock).toBeGreaterThanOrEqual(0);
		for (const channel of [a, b]) {
			const [locked] = channel.permissionOverwrites.set.mock.calls[0] as [RoomOverwrite[]];
			expect(locked).toEqual(
				buildSatelliteOverwrites({ everyoneRoleId: `everyone-${channel.id}`, botId: "bot-1", playerIds: satellites.find((entry) => entry.channelId === channel.id)!.userIds, phase: "finished", adminRoleId: null })
			);
			expect(events.indexOf(`${channel.id}:overwrites:3`)).toBeGreaterThan(hostLock);
			const result = channel.send.mock.calls[0][0] as { components?: unknown[]; embeds: unknown[] };
			expect(result.components).toBeUndefined();
			expect(result.embeds).toHaveLength(1);
		}
	});

	it("persists before it locks anything, and locks no satellite when the finish lost its claim", async () => {
		const [host, a] = [makeChannel("host-ch"), makeChannel("sat-a")];
		const client = makeClient([host, a]);
		storeMock.finish.mockResolvedValue(null);

		expect(await finish(client, makeRoom({ satellites: [satellite("g-a", "sat-a")] }))).toBe(false);
		await whenRelayed("room-1");

		expect(a.permissionOverwrites.set).not.toHaveBeenCalled();
		expect(host.permissionOverwrites.set).not.toHaveBeenCalled();
	});

	it("deletes every satellite with the host room, before the row closes", async () => {
		const host = makeChannel("host-ch");
		const [a, b] = [makeChannel("sat-a"), makeChannel("sat-b")];
		const client = makeClient([host, a, b]);

		await archiveRoom(client, makeRoom({ status: "finished", satellites: [satellite("g-a", "sat-a"), satellite("g-b", "sat-b")] }));

		expect(events).toEqual(["sat-a:delete", "sat-b:delete", "host-ch:delete", "row:archived"]);
	});

	it("archives the host room even when a satellite's server removed the bot", async () => {
		const host = makeChannel("host-ch");
		const b = makeChannel("sat-b");
		const client = makeClient([host, b]);

		await archiveRoom(client, makeRoom({ status: "finished", satellites: [satellite("gone", "sat-gone"), satellite("g-b", "sat-b")] }));

		expect(events).toEqual(["sat-b:delete", "host-ch:delete", "row:archived"]);
	});
});

// ── opening a satellite ──
describe("openSatellite", () => {
	interface RemoteGuildOptions {
		categoryId?: string | null;
		remoteMembers?: string[];
		hostMembers?: string[];
	}

	function makeRemoteGuild(options: RemoteGuildOptions = {}) {
		const created = makeChannel("sat-new");
		const remoteMembers = new Set(options.remoteMembers ?? ["r1"]);
		const hostMembers = new Set(options.hostMembers ?? ["host-1"]);
		const memberFetch = (members: Set<string>) => vi.fn(async (userId: string) => (members.has(userId) ? { id: userId } : Promise.reject(new Error("Unknown Member"))));
		const hostGuild = { id: "host-guild", members: { fetch: memberFetch(hostMembers) } };
		const client = {
			user: { id: "bot-1" },
			channels: { fetch: vi.fn(async (id: string) => (id === "sat-new" ? created : null)) },
			users: { cache: new Map([["host-1", { displayName: "Host One" }]]), fetch: vi.fn(async () => ({ displayName: "Host One" })) },
			guilds: { cache: new Map([["host-guild", hostGuild]]) },
		};
		configMock.mockResolvedValue(options.categoryId === null ? { adminRoleId: "admin-2" } : { gamesCategoryId: options.categoryId ?? "cat-2", adminRoleId: "admin-2" });
		const guild = {
			id: "remote-guild",
			client,
			roles: { everyone: { id: "everyone-remote" } },
			members: { fetch: memberFetch(remoteMembers) },
			channels: {
				fetch: vi.fn(async (id: string) => (id === "cat-2" ? { id: "cat-2", type: ChannelType.GuildCategory, children: { cache: new Collection() } } : null)),
				create: vi.fn().mockResolvedValue(created),
			},
		};
		return { guild: guild as unknown as Guild, created, create: guild.channels.create };
	}

	it("refuses a table that is not open to other servers, before touching Discord", async () => {
		const { guild, create } = makeRemoteGuild();
		expect(await openSatellite(makeRoom({ network: false }), guild, ["r1"])).toEqual({ ok: false, reason: "notNetwork" });
		expect(create).not.toHaveBeenCalled();
	});

	it("refuses honestly when the remote server has not run /setup", async () => {
		const { guild, create } = makeRemoteGuild({ categoryId: null });
		expect(await openSatellite(makeRoom(), guild, ["r1"])).toEqual({ ok: false, reason: "notSetUp" });
		expect(create).not.toHaveBeenCalled();
		expect(words.refusals.notSetUp).toContain("/setup");
	});

	it("refuses a member the host removed, and a member of the hosting server", async () => {
		const removed = makeRemoteGuild();
		expect(await openSatellite(makeRoom({ kickedIds: ["r1"] }), removed.guild, ["r1"])).toEqual({ ok: false, reason: "removed" });

		const both = makeRemoteGuild({ remoteMembers: ["r1"], hostMembers: ["host-1", "r1"] });
		expect(await openSatellite(makeRoom(), both.guild, ["r1"])).toEqual({ ok: false, reason: "inHostServer" });
		expect(both.create).not.toHaveBeenCalled();
	});

	it("opens a players only channel in the remote arcade category, then claims it on the host row", async () => {
		const { guild, create } = makeRemoteGuild();
		const claimed = makeRoom({ satellites: [satellite("remote-guild", "sat-new", ["r1"])] });
		storeMock.addSatellite.mockResolvedValue(claimed);

		const opened = await openSatellite(makeRoom(), guild, ["r1"]);

		expect(opened).toEqual({ ok: true, room: claimed, channelId: "sat-new" });
		const options = create.mock.calls[0][0] as { parent: string; permissionOverwrites: RoomOverwrite[] };
		expect(options.parent).toBe("cat-2");
		expect(options.permissionOverwrites).toEqual(
			buildSatelliteOverwrites({ everyoneRoleId: "everyone-remote", botId: "bot-1", playerIds: ["r1"], phase: "playing", adminRoleId: "admin-2" })
		);
		expect(storeMock.addSatellite).toHaveBeenCalledWith("host-guild", "room-1", { guildId: "remote-guild", channelId: "sat-new", userIds: ["r1"], tableMessageId: null });
	});

	it("deletes its own channel and joins the satellite that won when the claim is lost", async () => {
		const { guild, created } = makeRemoteGuild();
		storeMock.addSatellite.mockResolvedValue(null);
		const winner = satellite("remote-guild", "sat-winner", ["r0"]);
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ satellites: [winner] }));
		storeMock.addSatellitePlayers.mockResolvedValue(makeRoom({ satellites: [{ ...winner, userIds: ["r0", "r1"] }] }));

		const opened = await openSatellite(makeRoom(), guild, ["r1"]);

		expect(created.delete).toHaveBeenCalledOnce();
		expect(storeMock.addSatellitePlayers).toHaveBeenCalledWith("host-guild", "room-1", "remote-guild", ["r1"]);
		expect(opened.ok).toBe(true);
	});
});
