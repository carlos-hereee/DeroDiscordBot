import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel, type Client } from "discord.js";

const mocks = vi.hoisted(() => ({
	findNetworkBoardConfigs: vi.fn(),
	updateConfig: vi.fn(),
	findPlayingNetwork: vi.fn(),
	findAllBans: vi.fn(),
	consenting: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: { findNetworkBoardConfigs: mocks.findNetworkBoardConfigs, update: mocks.updateConfig },
}));
vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findPlayingNetwork: mocks.findPlayingNetwork } }));
vi.mock("@db/stores/networkBanStore.js", () => ({ networkBanStore: { findAll: mocks.findAllBans } }));
vi.mock("@db/stores/networkConsentStore.js", () => ({ networkConsentStore: { findConsentingUserIds: mocks.consenting } }));

import {
	_resetNetworkBoardsForTests,
	boardTablesFor,
	buildBoardView,
	collectTables,
	refreshNetworkBoards,
	scheduleNetworkBoardRefresh,
	takingPlayers,
	type BoardTable,
} from "./networkBoard.js";
import { createTable, joinTable, type HoldemTable } from "@features/games/holdemTable.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { NetworkGuildConfig } from "./networkRules.js";

// ── the network board (2026-10 item 244 Phase 5b) ──────────────────────────
// Which tables a server's board lists (other servers' tables still taking players,
// hiding a server it blocks or that blocks it, and anything banned), how it reads, and
// that a refresh posts once, edits after, skips an unchanged board and takes down the
// board of a server that left the network.

const words = rokCommanderCopy.arcadeNetwork;

const A = "100000000000000001";
const B = "200000000000000002";
const C = "300000000000000003";

function tableWith(seats: number, status: HoldemTable["status"] = "joining"): HoldemTable {
	const table = createTable();
	for (let seat = 0; seat < seats; seat++) joinTable(table, `p${seat}`, `P${seat}`);
	table.status = status;
	return table;
}

function room(guildId: string, overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: `room-${guildId}`,
		guildId,
		game: "holdem",
		hostId: `host-${guildId}`,
		status: "playing",
		network: true,
		seatsOpen: false,
		ratingBand: "any",
		requireApproval: false,
		secret: tableWith(1),
		startedAt: new Date("2026-10-23T10:00:00Z"),
		...overrides,
	} as unknown as IGameRoom;
}

const config = (
	guildId: string,
	extra: Partial<NetworkGuildConfig & { arcadeChallengesChannelId: string; arcadeRatedChallengesChannelId: string | null; networkBoardMessageId: string | null }> = {}
) => ({
	guildId,
	challengeReach: "network",
	blockedNetworkGuildIds: [],
	arcadeChallengesChannelId: `challenges-${guildId}`,
	networkBoardMessageId: null,
	...extra,
});

const boardTable = (hostGuildId: string): BoardTable => ({
	roomId: `room-${hostGuildId}`,
	hostGuildId,
	hostId: `host-${hostGuildId}`,
	game: "holdem",
	phase: "joining",
	seated: 1,
	cap: 6,
	ratingBand: "any",
	requireApproval: false,
	hostLabel: "Host",
	hostName: "Host",
	serverName: `Server ${hostGuildId}`,
});

function fakeClient(guildIds: string[] = [A, B, C]): { client: Client; channel: TextChannel; send: ReturnType<typeof vi.fn>; edit: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
	const edit = vi.fn(async () => undefined);
	const remove = vi.fn(async () => undefined);
	const send = vi.fn(async () => ({ id: "board-msg" }));
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(channel, { send, messages: { fetch: vi.fn(async () => ({ edit, delete: remove })) } });
	const client = {
		guilds: { cache: new Map(guildIds.map((id) => [id, { id, name: `Server ${id}` }])) },
		users: { cache: new Map(), fetch: vi.fn(async (id: string) => ({ id, displayName: `Name ${id}`, primaryGuild: null })) },
		channels: { fetch: vi.fn(async () => channel) },
	} as unknown as Client;
	return { client, channel, send, edit, remove };
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetNetworkBoardsForTests();
	mocks.findAllBans.mockResolvedValue([]);
	mocks.consenting.mockImplementation(async (ids: string[]) => new Set(ids));
	mocks.findPlayingNetwork.mockResolvedValue([]);
	mocks.findNetworkBoardConfigs.mockResolvedValue([]);
});

afterEach(() => _resetNetworkBoardsForTests());

describe("takingPlayers", () => {
	it("lists a joining table with a free seat, and not a full one", () => {
		expect(takingPlayers({ secret: tableWith(2), seatsOpen: false } as IGameRoom)).toEqual({ phase: "joining", seated: 2, cap: 6 });
		expect(takingPlayers({ secret: tableWith(BOT_CONSTANTS.HOLDEM_MAX_SEATS), seatsOpen: false } as IGameRoom)).toBeNull();
	});

	it("lists a table mid tournament only while the host has seats open", () => {
		expect(takingPlayers({ secret: tableWith(3, "playing"), seatsOpen: false } as IGameRoom)).toBeNull();
		expect(takingPlayers({ secret: tableWith(3, "playing"), seatsOpen: true } as IGameRoom)).toEqual({ phase: "seatsOpen", seated: 3, cap: 6 });
	});

	it("lists nothing once the tournament is over", () => {
		expect(takingPlayers({ secret: tableWith(2, "finished"), seatsOpen: true } as IGameRoom)).toBeNull();
	});
});

describe("boardTablesFor", () => {
	const hosts = new Map<string, NetworkGuildConfig>([
		[B, config(B)],
		[C, config(C, { blockedNetworkGuildIds: [A] })],
	]);

	it("never lists a server's own tables", () => {
		expect(boardTablesFor(config(B), [boardTable(B)], hosts)).toEqual([]);
	});

	it("hides a server the viewer blocked, and a server that blocked the viewer", () => {
		const viewer = config(A, { blockedNetworkGuildIds: [B] });
		expect(boardTablesFor(viewer, [boardTable(B), boardTable(C)], hosts)).toEqual([]);
		expect(boardTablesFor(config(A), [boardTable(B), boardTable(C)], hosts).map((table) => table.hostGuildId)).toEqual([B]);
	});

	it("lists at most BOARD_MAX_TABLES", () => {
		const many = Array.from({ length: BOT_CONSTANTS.NETWORK.BOARD_MAX_TABLES + 3 }, () => boardTable(B));
		expect(boardTablesFor(config(A), many, hosts)).toHaveLength(BOT_CONSTANTS.NETWORK.BOARD_MAX_TABLES);
	});
});

describe("collectTables", () => {
	const hosts = new Map<string, NetworkGuildConfig>([
		[A, config(A)],
		[B, config(B)],
		[C, { guildId: C, challengeReach: "server" }],
	]);

	it("keeps only tables hosted on the network, by a consenting host, with nothing banned", async () => {
		const { client } = fakeClient();
		mocks.consenting.mockResolvedValue(new Set([`host-${A}`]));
		const tables = await collectTables(client, [room(A), room(B), room(C)], hosts, []);
		// B's host never accepted the network notice; C's server is not on the network.
		expect(tables.map((table) => table.hostGuildId)).toEqual([A]);
	});

	it("drops a table whose server or host the owner banned", async () => {
		const { client } = fakeClient();
		const bans = [
			{ kind: "guild" as const, targetId: A, reason: "", createdAt: new Date() },
			{ kind: "user" as const, targetId: `host-${B}`, reason: "", createdAt: new Date() },
		];
		expect(await collectTables(client, [room(A), room(B)], hosts, bans)).toEqual([]);
	});

	it("drops a table hosted in a server Dero left, whatever its config still says", async () => {
		const { client } = fakeClient([B]);
		expect((await collectTables(client, [room(A), room(B)], hosts, [])).map((table) => table.hostGuildId)).toEqual([B]);
	});
});

describe("buildBoardView", () => {
	it("lists each table with a select whose value names the host server and the room", () => {
		const view = buildBoardView([{ ...boardTable(B), ratingBand: "close", requireApproval: true }], false);
		const description = view.embeds[0].data.description ?? "";
		expect(description).toContain("hosted by Host from **Server");
		expect(description).toContain(words.board.approvalNote);
		expect(description).toContain(words.board.bandNote("Close"));
		const select = view.components[0].components[0].toJSON() as { custom_id: string; options: { value: string }[] };
		expect(select.custom_id).toBe("networkBoard:join");
		expect(select.options[0].value).toBe(`${B}:room-${B}`);
	});

	it("says so honestly when no table takes players, with no select", () => {
		const view = buildBoardView([], false);
		expect(view.embeds[0].data.description).toContain(words.board.empty);
		expect(view.components).toEqual([]);
	});

	it("tells a banned server the network is closed to it, with no select", () => {
		const view = buildBoardView([boardTable(B)], true);
		expect(view.embeds[0].data.description).toContain(words.board.closedHere);
		expect(view.components).toEqual([]);
	});
});

describe("refreshing the boards", () => {
	it("posts a server's first board and remembers its message, then edits it when it changes", async () => {
		const { client, send, edit } = fakeClient();
		mocks.findNetworkBoardConfigs.mockResolvedValue([config(A)]);
		await refreshNetworkBoards(client);
		expect(send).toHaveBeenCalledTimes(1);
		expect(mocks.updateConfig).toHaveBeenCalledWith(A, { networkBoardMessageId: "board-msg" });

		// B joins the network and opens a table: A's board changes and is edited in place,
		// and B's board (already posted, so it has a message id) is edited too.
		mocks.findNetworkBoardConfigs.mockResolvedValue([config(A, { networkBoardMessageId: "board-msg" }), config(B, { networkBoardMessageId: "board-b" })]);
		mocks.findPlayingNetwork.mockResolvedValue([room(B)]);
		await refreshNetworkBoards(client);
		expect(edit).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledTimes(1);
		const aBoard = (edit.mock.calls[0] as unknown as [{ embeds: { data: { description?: string } }[] }])[0];
		expect(aBoard.embeds[0].data.description).toContain(`Server ${B}`);
	});

	it("does not edit a board that would read the same as last time", async () => {
		const { client, edit } = fakeClient();
		mocks.findNetworkBoardConfigs.mockResolvedValue([config(A, { networkBoardMessageId: "board-msg" })]);
		await refreshNetworkBoards(client);
		await refreshNetworkBoards(client);
		expect(edit).toHaveBeenCalledTimes(1);
	});

	it("takes down the board of a server that left the network and forgets its message", async () => {
		const { client, remove, send } = fakeClient();
		mocks.findNetworkBoardConfigs.mockResolvedValue([config(A, { challengeReach: "server", networkBoardMessageId: "board-msg" })]);
		await refreshNetworkBoards(client);
		expect(remove).toHaveBeenCalled();
		expect(mocks.updateConfig).toHaveBeenCalledWith(A, { networkBoardMessageId: null });
		expect(send).not.toHaveBeenCalled();
	});

	// 2026-10 item 254, Arcade 5: every network table is rated, so the board lives in
	// 🏆rated-challenges, and the one a server already had in ⚔️challenges goes once the new
	// one is up, never before.
	it("moves a board from ⚔️challenges to 🏆rated-challenges, deleting the old one only after the new one posts", async () => {
		const order: string[] = [];
		const legacyDelete = vi.fn(async () => void order.push("delete old"));
		const ratedSend = vi.fn(async () => {
			order.push("post new");
			return { id: "board-new" };
		});
		const rated = Object.assign(Object.create(TextChannel.prototype) as TextChannel, { id: `rated-${A}`, send: ratedSend, messages: { fetch: vi.fn(async () => null) } });
		const challenges = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
			id: `challenges-${A}`,
			send: vi.fn(),
			messages: { fetch: vi.fn(async (id: string) => (id === "board-old" ? { delete: legacyDelete } : null)) },
		});
		const channels: Record<string, TextChannel> = { [rated.id]: rated, [challenges.id]: challenges };
		const client = {
			guilds: { cache: new Map([[A, { id: A, name: `Server ${A}` }]]) },
			users: { cache: new Map(), fetch: vi.fn() },
			channels: { fetch: vi.fn(async (id: string) => channels[id] ?? null) },
		} as unknown as Client;
		mocks.updateConfig.mockImplementation(async () => void order.push("store id"));
		mocks.findNetworkBoardConfigs.mockResolvedValue([config(A, { arcadeRatedChallengesChannelId: rated.id, networkBoardMessageId: "board-old" })]);

		await refreshNetworkBoards(client);

		expect(ratedSend).toHaveBeenCalledTimes(1);
		expect(challenges.send).not.toHaveBeenCalled();
		expect(mocks.updateConfig).toHaveBeenCalledWith(A, { networkBoardMessageId: "board-new" });
		expect(order).toEqual(["post new", "store id", "delete old"]);
	});

	it("posts a server's first board in 🏆rated-challenges when it has one", async () => {
		const { client, send } = fakeClient();
		mocks.findNetworkBoardConfigs.mockResolvedValue([config(A, { arcadeRatedChallengesChannelId: `rated-${A}` })]);

		await refreshNetworkBoards(client);

		expect(send).toHaveBeenCalledTimes(1);
		expect((client.channels.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(`rated-${A}`);
	});

	it("starts no timer and reads nothing when asked to refresh before the boards were started", () => {
		vi.useFakeTimers();
		try {
			scheduleNetworkBoardRefresh();
			vi.advanceTimersByTime(BOT_CONSTANTS.NETWORK.BOARD_REFRESH_DEBOUNCE_MS * 2);
			expect(mocks.findNetworkBoardConfigs).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
