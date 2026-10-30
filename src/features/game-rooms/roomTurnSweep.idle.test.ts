import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findNonTerminal: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));

import { sweepIdleRooms } from "./roomTurnSweep.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { createTable } from "@features/games/holdemTable.js";
import { createInitialState } from "@features/games/monopolyState.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the idle sweep ─────────────────────────────────────────────────────────
// What:  any room in a non terminal status with no action for 30 minutes is finished
//        as abandoned, so no forgotten draft or match holds its host's one room slot.
// How:   the store and the lifecycle are mocked; what is under test is which rooms
//        the sweep decides are idle, read from each game's own stamp. The default
//        room is a coin flip, a game the sweep covers; hangman and Monopoly in play
//        are exempt and have their own cases below.

const storeMock = gameRoomStore as unknown as { findNonTerminal: ReturnType<typeof vi.fn> };
const finishMock = roomLifecycle.finish as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-10-23T20:00:00.000Z");
const MINUTE = 60_000;
const ago = (minutes: number): Date => new Date(NOW.getTime() - minutes * MINUTE);
const client = {} as Client;

function makeRoom(overrides: Partial<IGameRoom>): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "coinflip",
		status: "playing",
		playerIds: ["host"],
		channelId: "ch-1",
		moves: [],
		secret: null,
		startedAt: ago(60),
		createdAt: ago(60),
		updatedAt: ago(60),
		...overrides,
	} as unknown as IGameRoom;
}

function holdemRoom(lastActionMinutesAgo: number, updatedMinutesAgo: number): IGameRoom {
	const table = createTable(ago(lastActionMinutesAgo).getTime());
	return makeRoom({ game: "holdem", secret: table as never, updatedAt: ago(updatedMinutesAgo) });
}

beforeEach(() => {
	vi.clearAllMocks();
	finishMock.mockResolvedValue(true);
});

describe("sweepIdleRooms", () => {
	it("pins the budget at 30 minutes", () => {
		expect(BOT_CONSTANTS.GAME_ROOM_IDLE_ABANDON_MS).toBe(30 * MINUTE);
	});

	it("finishes a room idle for 31 minutes as abandoned, and leaves one idle for 29", async () => {
		const stale = makeRoom({ roomId: "stale", updatedAt: ago(31) });
		const fresh = makeRoom({ roomId: "fresh", updatedAt: ago(29) });
		storeMock.findNonTerminal.mockResolvedValue([stale, fresh]);

		const summary = await sweepIdleRooms(client, NOW);

		expect(summary).toEqual({ roomsAbandoned: 1 });
		expect(finishMock).toHaveBeenCalledOnce();
		expect(finishMock).toHaveBeenCalledWith(client, stale, { abandoned: true, now: NOW });
	});

	it("covers a draft, which has no channel and no moves, from the row's own stamp", async () => {
		const draft = makeRoom({ status: "draft", channelId: null, startedAt: null, updatedAt: ago(45) });
		storeMock.findNonTerminal.mockResolvedValue([draft]);

		await sweepIdleRooms(client, NOW);

		expect(finishMock).toHaveBeenCalledWith(client, draft, { abandoned: true, now: NOW });
	});

	it("falls back to createdAt for a row that was never written again", async () => {
		const untouched = makeRoom({ updatedAt: undefined, createdAt: ago(31) });
		storeMock.findNonTerminal.mockResolvedValue([untouched]);

		await sweepIdleRooms(client, NOW);

		expect(finishMock).toHaveBeenCalledOnce();
	});

	// 2026-10 item 267: a Blackjack table's turn clock plays a silent seat's turn for it, which writes
	// the row, so the sweep reads when a MEMBER last acted instead of the row's own stamp.
	it("reads a playing Blackjack table's last member action rather than the row's stamp", async () => {
		const silent = makeRoom({ roomId: "silent", game: "blackjack", blackjackActedAt: ago(31), updatedAt: ago(1) });
		const played = makeRoom({ roomId: "played", game: "solo-blackjack", blackjackActedAt: ago(2), updatedAt: ago(1) });
		storeMock.findNonTerminal.mockResolvedValue([silent, played]);

		await sweepIdleRooms(client, NOW);

		expect(finishMock).toHaveBeenCalledOnce();
		expect(finishMock).toHaveBeenCalledWith(client, silent, { abandoned: true, now: NOW });
	});

	it("reads a Hold'em table's own action stamp rather than the row's", async () => {
		const idleTable = holdemRoom(31, 1);
		const liveTable = holdemRoom(1, 40);
		storeMock.findNonTerminal.mockResolvedValue([idleTable, liveTable]);

		await sweepIdleRooms(client, NOW);

		expect(finishMock).toHaveBeenCalledOnce();
		expect(finishMock).toHaveBeenCalledWith(client, idleTable, { abandoned: true, now: NOW });
	});

	it("counts a Hold'em buy in, which posts a trail line and moves no stamp", async () => {
		const joining = holdemRoom(45, 45);
		joining.moves = [{ actorId: "p1", at: ago(5), kind: "join", text: "bought in" }] as IGameRoom["moves"];
		storeMock.findNonTerminal.mockResolvedValue([joining]);

		await sweepIdleRooms(client, NOW);

		expect(finishMock).not.toHaveBeenCalled();
	});

	it("leaves Monopoly to its own day long seat clock", async () => {
		const board = createInitialState(["host", "guest"], { auctionsEnabled: false });
		storeMock.findNonTerminal.mockResolvedValue([makeRoom({ game: "monopoly", secret: board as never, updatedAt: ago(120) })]);

		expect(await sweepIdleRooms(client, NOW)).toEqual({ roomsAbandoned: 0 });
		expect(finishMock).not.toHaveBeenCalled();
	});

	// 2026-10 item 276, audit P1-5: a row the start claim moved to playing whose board was never
	// written (the engine threw on one seat) has no seat for the Monopoly sweep to forfeit, so it
	// used to hold its host's one room slot for good.
	it("finishes a playing Monopoly row with no board once it idles past the budget", async () => {
		const stranded = makeRoom({ game: "monopoly", secret: null, updatedAt: ago(45) });
		storeMock.findNonTerminal.mockResolvedValue([stranded]);

		expect(await sweepIdleRooms(client, NOW)).toEqual({ roomsAbandoned: 1 });
		expect(finishMock).toHaveBeenCalledWith(client, stranded, { abandoned: true, now: NOW });
	});

	it("leaves a Monopoly row with no board alone inside the budget, while its seed may still be writing it", async () => {
		storeMock.findNonTerminal.mockResolvedValue([makeRoom({ game: "monopoly", secret: null, updatedAt: ago(5) })]);

		expect(await sweepIdleRooms(client, NOW)).toEqual({ roomsAbandoned: 0 });
	});

	// The owner's decision of 2026-10-23: hangman has no clock, hosted or solo, so a
	// round in play sits as long as its players like. Paired with the draft case so the
	// exemption cannot quietly widen to unanswered challenges.
	it.each(["hangman", "solo-hangman"] as const)("leaves a %s round in play alone however long it idles", async (game) => {
		storeMock.findNonTerminal.mockResolvedValue([makeRoom({ game, updatedAt: ago(600) })]);

		expect(await sweepIdleRooms(client, NOW)).toEqual({ roomsAbandoned: 0 });
		expect(finishMock).not.toHaveBeenCalled();
	});

	it("still sweeps a hangman DRAFT nobody answered", async () => {
		const draft = makeRoom({ game: "hangman", status: "draft", channelId: null, startedAt: null, updatedAt: ago(45) });
		storeMock.findNonTerminal.mockResolvedValue([draft]);

		await sweepIdleRooms(client, NOW);

		expect(finishMock).toHaveBeenCalledWith(client, draft, { abandoned: true, now: NOW });
	});

	it("does not count a room another path already finished in the same tick", async () => {
		finishMock.mockResolvedValue(false);
		storeMock.findNonTerminal.mockResolvedValue([makeRoom({ updatedAt: ago(40) })]);

		expect(await sweepIdleRooms(client, NOW)).toEqual({ roomsAbandoned: 0 });
	});

	it("keeps sweeping when one room throws", async () => {
		finishMock.mockRejectedValueOnce(new Error("Discord said no")).mockResolvedValueOnce(true);
		storeMock.findNonTerminal.mockResolvedValue([
			makeRoom({ roomId: "first", updatedAt: ago(40) }),
			makeRoom({ roomId: "second", updatedAt: ago(40) }),
		]);
		const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);

		expect(await sweepIdleRooms(client, NOW)).toEqual({ roomsAbandoned: 1 });
		quiet.mockRestore();
	});
});
