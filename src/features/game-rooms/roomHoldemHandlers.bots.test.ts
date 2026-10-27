import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { update: vi.fn(), updateSecretIf: vi.fn(), findByRoomId: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/dero-brain/dealerNarration.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/dero-brain/dealerNarration.js")>()),
	announceDealer: vi.fn(),
}));
vi.mock("@features/ratings/recordMatchRatings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/ratings/recordMatchRatings.js")>()),
	recordMatchRatings: vi.fn(),
}));

import { playHoldemBotTurn } from "./roomHoldemHandlers.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { createTable, dealHand, handInProgress, joinTable, leaveTable, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── Dero bot seats at a Hold'em table (2026-10 item 250 Phase 5) ────────────
// A bot acts only on its own turn and only once the board has shown it for the think
// time, through the same claim a member's press takes; a table no member is left at is
// closed by Dero on its standings.

type Mock = ReturnType<typeof vi.fn>;
const storeMock = gameRoomStore as unknown as Record<"updateSecretIf", Mock>;
const trailMock = roomTrail.postMove as unknown as Mock;
const finishMock = roomLifecycle.finish as unknown as Mock;

const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;
const BOT = "dero-bot-red";

function seededRng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

const makeRoom = (table: HoldemTable): IGameRoom =>
	({ roomId: "room-1", guildId: "guild-1", game: "holdem", hostId: "host", status: "playing", playerIds: ["host"], channelId: "ch-1", botSeats: 1, secret: table }) as unknown as IGameRoom;

// Heads up, the seat on the button posts the small blind and acts first preflop, and the
// first seat to sit holds the button: so whoever sits first is the one to act.
function headsUp(first: string, second: string): HoldemTable {
	const table = createTable();
	joinTable(table, first, first);
	joinTable(table, second, second);
	table.status = "playing";
	dealHand(table, seededRng(2));
	return table;
}

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.updateSecretIf.mockResolvedValue({});
	finishMock.mockResolvedValue(true);
});

describe("a bot's turn", () => {
	it("waits until the board has shown the turn for the think time", async () => {
		const table = headsUp(BOT, "host");
		expect(whoActs(table)).toBe(BOT);
		table.turnPrompt = { stamp: table.lastActionAt, shownAt: Date.now() };
		expect(await playHoldemBotTurn(client, makeRoom(table), new Date())).toBe(false);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("moves once the think time has run, through the table's compare and swap", async () => {
		const table = headsUp(BOT, "host");
		expect(whoActs(table)).toBe(BOT);
		const readAt = table.lastActionAt;
		table.turnPrompt = { stamp: readAt, shownAt: readAt - 10_000 };

		expect(await playHoldemBotTurn(client, makeRoom(table), new Date(readAt + 10_000))).toBe(true);
		expect(storeMock.updateSecretIf).toHaveBeenCalledWith("guild-1", "room-1", { "secret.lastActionAt": readAt, "secret.boardMessageId": null }, expect.anything());
		expect(trailMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ actorId: BOT }));
	});

	it("never acts for a member", async () => {
		const table = headsUp("host", BOT);
		expect(whoActs(table)).toBe("host");
		expect(handInProgress(table)).toBe(true);
		expect(await playHoldemBotTurn(client, makeRoom(table), new Date(Date.now() + 60_000))).toBe(false);
	});
});

describe("a table only bots are left at", () => {
	it("is closed by Dero on its standings, and the finish says so", async () => {
		const table = createTable();
		joinTable(table, "host", "Host");
		joinTable(table, BOT, "Dero Red");
		joinTable(table, "dero-bot-orange", "Dero Orange");
		table.status = "playing";
		dealHand(table, seededRng(9));
		leaveTable(table, "host");

		expect(await playHoldemBotTurn(client, makeRoom(table))).toBe(true);
		expect(trailMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ text: gameRoomsCopy.holdem.botsOnlyEnded }));
		expect(finishMock).toHaveBeenCalledOnce();
	});
});
