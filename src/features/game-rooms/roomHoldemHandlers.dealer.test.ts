import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { update: vi.fn(), findPlayingByGame: vi.fn(), updateSecretIf: vi.fn(), findByRoomId: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
// The dealer is the thing under observation: its announce is a spy, and the real
// public view is kept so the test can read what each hook handed over.
vi.mock("@features/dero-brain/dealerNarration.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/dero-brain/dealerNarration.js")>()),
	announceDealer: vi.fn(),
}));

import { handleDeal, handleMove, sweepHoldemClocks } from "./roomHoldemHandlers.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { announceDealer, type AnnounceInput } from "@features/dero-brain/dealerNarration.js";
import { createTable, joinTable, dealHand, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the dealer hooks ──────────────────────────────────────────────────
// Each hold em path that changes a hand (a deal, a button action, a turn clock
// fold) hands announceDealer a public view from before and after the change,
// and only once its write has landed: a claim that lost the race announces
// nothing, because its change never happened.

const storeMock = gameRoomStore as unknown as Record<"update" | "findPlayingByGame" | "updateSecretIf" | "findByRoomId", ReturnType<typeof vi.fn>>;
const announceMock = announceDealer as unknown as ReturnType<typeof vi.fn>;

function seededRng(seed = 11): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function seatedTable(seats = 3): HoldemTable {
	const table = createTable(5, { maxSeats: 6, startingStack: 5000, smallBlind: 100, bigBlind: 200 });
	for (let index = 0; index < seats; index++) joinTable(table, `p${index}`, `Player ${index}`);
	return table;
}

function dealtTable(): HoldemTable {
	const table = seatedTable();
	table.status = "playing";
	dealHand(table, seededRng());
	return table;
}

const makeRoom = (table: HoldemTable): IGameRoom =>
	({ roomId: "room-1", guildId: "guild-1", game: "holdem", status: "playing", playerIds: table.seats.map((seat) => seat.userId), channelId: "ch-1", secret: table }) as unknown as IGameRoom;

const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;

function makeInteraction(userId: string): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild: { members: { cache: { get: () => ({ displayName: "P" }) } } },
		user: { id: userId, username: userId, globalName: userId },
		client,
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

const announced = (): AnnounceInput => announceMock.mock.calls[0][0] as AnnounceInput;

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
	storeMock.updateSecretIf.mockResolvedValue({} as never);
});

describe("handleDeal announces the deal", () => {
	it("with the view before the deal and the dealt hand after it", async () => {
		const table = seatedTable();
		await handleDeal(makeInteraction("p0"), makeRoom(table));
		expect(announceMock).toHaveBeenCalledTimes(1);
		const input = announced();
		expect(input).toMatchObject({ client, roomId: "room-1" });
		expect(input.before.handNumber).toBe(0);
		expect(input.after).toMatchObject({ handNumber: 1, smallBlind: 100, bigBlind: 200, board: [] });
		expect(input.after.actingUserId).not.toBeNull();
	});

	it("not when the deal claim lost the race", async () => {
		storeMock.updateSecretIf.mockResolvedValue(null);
		await handleDeal(makeInteraction("p0"), makeRoom(seatedTable()));
		expect(announceMock).not.toHaveBeenCalled();
	});

	it("not when a hand is already running", async () => {
		await handleDeal(makeInteraction("p0"), makeRoom(dealtTable()));
		expect(announceMock).not.toHaveBeenCalled();
	});
});

describe("handleMove announces the action", () => {
	it("with both views and the engine's outcome", async () => {
		const table = dealtTable();
		const actor = whoActs(table)!;
		await handleMove(makeInteraction(actor), makeRoom(table), "fold");
		expect(announceMock).toHaveBeenCalledTimes(1);
		const input = announced();
		expect(input.before.actingUserId).toBe(actor);
		expect(input.after.actingUserId).not.toBe(actor);
		expect(input.outcome).toMatchObject({ ok: true });
	});

	it("not when somebody else's write landed first", async () => {
		storeMock.updateSecretIf.mockResolvedValue(null);
		const table = dealtTable();
		await handleMove(makeInteraction(whoActs(table)!), makeRoom(table), "fold");
		expect(announceMock).not.toHaveBeenCalled();
	});

	it("not for an illegal action", async () => {
		const table = dealtTable();
		await handleMove(makeInteraction(whoActs(table)!), makeRoom(table), "check");
		// Preflop facing the big blind, checking is illegal for the first actor.
		expect(announceMock).not.toHaveBeenCalled();
	});
});

describe("the turn clock announces the forced action", () => {
	it("with both views and the fold's outcome", async () => {
		const table = dealtTable();
		table.lastActionAt = Date.now() - BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS - 1000;
		const stalling = whoActs(table);
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);
		expect(await sweepHoldemClocks(client)).toEqual({ forced: 1 });
		expect(announceMock).toHaveBeenCalledTimes(1);
		const input = announced();
		expect(input.before.actingUserId).toBe(stalling);
		expect(input.outcome).toMatchObject({ ok: true, userId: stalling });
	});

	it("not when the player acted first", async () => {
		storeMock.updateSecretIf.mockResolvedValue(null);
		const table = dealtTable();
		table.lastActionAt = Date.now() - BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS - 1000;
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);
		await sweepHoldemClocks(client);
		expect(announceMock).not.toHaveBeenCalled();
	});
});
