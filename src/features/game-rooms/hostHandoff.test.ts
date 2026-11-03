import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { transferHost: vi.fn(), findOpenByHost: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() }, resolveRoomChannel: vi.fn(async () => null) }));
vi.mock("./challengeCard.js", () => ({ cardStateFor: vi.fn(() => ({})), refreshCard: vi.fn(), refreshTableCard: vi.fn() }));
vi.mock("@features/games/blackjackHandler.js", () => ({ blackjackSeatHoldersOf: vi.fn(() => []), sharedTableSeatsOf: vi.fn(() => null) }));

import { handHostingOn, hostCandidatesOf, isRankedRoom, nextFreeHost, passHosting } from "./hostHandoff.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { blackjackSeatHoldersOf } from "@features/games/blackjackHandler.js";
import { createTable, joinTable } from "@features/games/holdemTable.js";
import { createInitialState } from "@features/games/monopolyState.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── hostHandoff (2026-10 item 276, owner decision D17) ───────────────
// Who may take hosting, in which order, and the one conditional write that moves it. The
// store is mocked (house rule 6), so transferHost's index refusal is modelled as "taken".

type Mock = ReturnType<typeof vi.fn>;
const store = gameRoomStore as unknown as Record<"transferHost" | "findOpenByHost", Mock>;
const postMove = roomTrail.postMove as unknown as Mock;
const client = { guilds: { cache: new Map(), fetch: vi.fn(async () => null) } } as unknown as Client;
const words = gameRoomsCopy.hostPass;

const makeRoom = (overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: "guild-1",
		game: "holdem",
		hostId: "host",
		playerIds: ["host", "a", "b"],
		kickedIds: [],
		status: "playing",
		channelId: "ch-1",
		openerMessageId: null,
		...overrides,
	}) as unknown as IGameRoom;

beforeEach(() => {
	vi.clearAllMocks();
	store.findOpenByHost.mockResolvedValue(null);
});

describe("hostCandidatesOf", () => {
	it("names Hold'em seats still in, next seat after the host first, never a bot, an out seat or another server's seat", () => {
		const table = createTable();
		for (const id of ["a", "host", "dero-bot-red", "remote", "b"]) joinTable(table, id, id);
		table.seats.find((seat) => seat.userId === "a")!.out = "busted" as never;

		expect(hostCandidatesOf(makeRoom({ secret: table as never }))).toEqual(["b"]);
		table.seats.find((seat) => seat.userId === "a")!.out = null;
		expect(hostCandidatesOf(makeRoom({ secret: table as never }))).toEqual(["b", "a"]);
	});

	it("names Monopoly seats in turn order from the host's, never a bankrupt seat", () => {
		const state = createInitialState(["a", "host", "b", "c"], { auctionsEnabled: false }, 1_000, 1);
		state.seats[2].bankrupt = true;

		expect(hostCandidatesOf(makeRoom({ game: "monopoly", playerIds: ["host", "a", "b", "c"], secret: state as never }))).toEqual(["c", "a"]);
	});

	it("names a Blackjack table's seat holders, late seats included, and never a member the host removed", () => {
		(blackjackSeatHoldersOf as unknown as Mock).mockReturnValue(["host", "a", "b"]);

		expect(hostCandidatesOf(makeRoom({ game: "blackjack", kickedIds: ["a"] }))).toEqual(["b"]);
	});

	it("names the other captain at Battleship, and nobody against a Dero bot", () => {
		const human = { players: [{ userId: "host" }, { userId: "a" }] };
		const bot = { players: [{ userId: "host" }, { userId: "dero-bot-red" }] };

		expect(hostCandidatesOf(makeRoom({ game: "battleship", playerIds: ["host", "a"], secret: human as never }))).toEqual(["a"]);
		expect(hostCandidatesOf(makeRoom({ game: "battleship", playerIds: ["host"], secret: bot as never }))).toEqual([]);
	});
});

describe("isRankedRoom", () => {
	it("is a rated game with no bots and no Casual", () => {
		expect(isRankedRoom({ game: "holdem", botSeats: 0, casual: false })).toBe(true);
		expect(isRankedRoom({ game: "holdem", botSeats: 1, casual: false })).toBe(false);
		expect(isRankedRoom({ game: "holdem", botSeats: 0, casual: true })).toBe(false);
	});
});

describe("passHosting", () => {
	it("moves hosting in one conditional write and names the new host on the trail", async () => {
		const room = makeRoom();
		store.transferHost.mockResolvedValue({ ...room, hostId: "a" });

		expect(await passHosting(client, room, "a")).toMatchObject({ kind: "passed" });

		expect(store.transferHost).toHaveBeenCalledWith("guild-1", "room-1", "host", "a");
		expect(postMove).toHaveBeenCalledWith(client, expect.objectContaining({ hostId: "a" }), expect.objectContaining({ text: words.trailLine("host", "a") }));
	});

	it("answers taken when the pick already hosts an open room, and says nothing", async () => {
		store.transferHost.mockResolvedValue("taken");

		expect(await passHosting(client, makeRoom(), "a")).toEqual({ kind: "taken" });
		expect(postMove).not.toHaveBeenCalled();
	});

	it("answers gone when the room closed or someone else moved hosting first", async () => {
		store.transferHost.mockResolvedValue(null);

		expect(await passHosting(client, makeRoom(), "a")).toEqual({ kind: "gone" });
		expect(postMove).not.toHaveBeenCalled();
	});
});

describe("handHostingOn", () => {
	it("tries the next candidate when the index refuses one, and names who hosts now", async () => {
		const room = makeRoom({ hostId: "leaver" });
		store.transferHost.mockResolvedValueOnce("taken").mockImplementationOnce(async () => ({ ...room, hostId: "b" }));

		expect(await handHostingOn(client, room, "leaver", ["a", "b"])).toBe("b");

		expect(store.transferHost.mock.calls.map((call) => call[3])).toEqual(["a", "b"]);
		expect(postMove).toHaveBeenCalledWith(client, expect.anything(), expect.objectContaining({ text: words.handedOn("b") }));
	});

	it("posts no line of its own for the member the caller's board already named", async () => {
		const room = makeRoom({ hostId: "leaver" });
		store.transferHost.mockResolvedValue({ ...room, hostId: "a" });

		await handHostingOn(client, room, "leaver", ["a"], "a");

		expect(postMove).not.toHaveBeenCalled();
	});

	it("says the match plays on with no host when nobody can take it", async () => {
		store.transferHost.mockResolvedValue("taken");
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(await handHostingOn(client, makeRoom({ hostId: "leaver" }), "leaver", ["a"])).toBeNull();

		expect(postMove).toHaveBeenCalledWith(client, expect.anything(), expect.objectContaining({ text: words.noHostLeft }));
	});
});

describe("nextFreeHost", () => {
	it("skips a candidate who already hosts an open room, writing nothing", async () => {
		store.findOpenByHost.mockImplementation(async (_guildId: string, userId: string) => (userId === "a" ? { roomId: "elsewhere" } : null));

		expect(await nextFreeHost(makeRoom(), ["a", "b"])).toBe("b");
		expect(store.transferHost).not.toHaveBeenCalled();
	});
});
