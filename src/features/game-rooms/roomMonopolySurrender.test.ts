import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client } from "discord.js";

// ── roomMonopolySurrender ────────────────────────────────────────────
// Any seat can surrender in two presses and the match goes on (2026-10 item 254, Arcade
// 12). A host hands hosting to the next member who hosts no other open room; the match
// ends on its standings only when bots alone, or nobody able to host, would be left.

const row = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: vi.fn(async () => row.current), findOpenByHost: vi.fn(async () => null), transferHost: vi.fn() },
}));
// The commit, standing in for the compare and swap: it runs the move against the stored
// match and writes what it returns, or answers with the move's own refusal.
vi.mock("./roomMonopolyHandlers.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./roomMonopolyHandlers.js")>();
	return {
		monopolyStateOf: actual.monopolyStateOf,
		commitMonopolyMove: vi.fn(async (_client: unknown, _room: unknown, actorId: string, move: (state: unknown, actorId: string) => { ok: boolean; state?: unknown; reason?: string; trailLines?: string[] }) => {
			const result = move(row.current?.secret, actorId);
			if (!result.ok) return { ok: false, reason: result.reason };
			(row.current as Record<string, unknown>).secret = result.state;
			return { ok: true, state: result.state };
		}),
	};
});
vi.mock("@utils/textModal.js", () => ({ showNotice: vi.fn(), showConfirm: vi.fn(), acknowledgeConfirm: vi.fn() }));
// The confirm's answer posts in 💬dero-commands (2026-10 item 257 Phase 5); where it lands has
// its own suite (utils/answerInChannel.test.ts).
vi.mock("@utils/answerInChannel.js", () => ({ answerInChannel: vi.fn() }));

import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { acknowledgeConfirm, showConfirm, showNotice } from "@utils/textModal.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { commitMonopolyMove } from "./roomMonopolyHandlers.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { finishOnStandings, handleMsurrender, handleMsurrenderConfirm, surrenderMonopolySeat, surrenderMove } from "./roomMonopolySurrender.js";

const A = "player-a";
const B = "player-b";
const C = "player-c";
const RED = "dero-bot-red";
const BLUE = "dero-bot-blue";
const words = gameRoomsCopy.monopoly;

const storeMock = gameRoomStore as unknown as {
	findOpenByHost: ReturnType<typeof vi.fn>;
	transferHost: ReturnType<typeof vi.fn>;
};
const commitMock = commitMonopolyMove as unknown as ReturnType<typeof vi.fn>;
const client = {} as Client;

function seed(seats: string[], hostId = A): IGameRoom {
	const state = createInitialState(seats, { auctionsEnabled: false }, 1_000, 1);
	row.current = { roomId: "room-1", guildId: "guild-1", game: "monopoly", status: "playing", hostId, playerIds: seats.filter((seat) => !seat.startsWith("dero-bot-")), secret: state };
	return row.current as unknown as IGameRoom;
}

const stored = (): MonopolyState => row.current?.secret as MonopolyState;
const seatOf = (userId: string) => stored().seats.find((seat) => seat.userId === userId);
// The lines the surrender's move posted, off the commit's move run again on its read.
const committedLines = (index = 0): string[] => {
	const [, , actorId, move] = commitMock.mock.calls[index] as [unknown, unknown, string, (state: MonopolyState, actorId: string) => { trailLines: string[] }];
	return move(createInitialState((row.current?.playerIds as string[]) ?? [], { auctionsEnabled: false }, 1_000, 1), actorId).trailLines ?? [];
};

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.findOpenByHost.mockResolvedValue(null);
	storeMock.transferHost.mockImplementation(async (_guildId: string, _roomId: string, _from: string, to: string) => {
		(row.current as Record<string, unknown>).hostId = to;
		return row.current;
	});
});

describe("surrenderMove", () => {
	it("takes the seat out with the surrender line first, and the match goes on", () => {
		const state = createInitialState([A, B, C], { auctionsEnabled: false }, 1_000, 1);
		const result = surrenderMove(state, B, [words.surrendered(B)], false);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.trailLines[0]).toBe(words.surrendered(B));
		expect(result.state.seats[1].bankrupt).toBe(true);
		expect(result.state.phase).not.toBe("finished");
	});

	it("ends on the standings when Dero bots alone would be left, the richest bot winning", () => {
		const state = createInitialState([A, RED, BLUE], { auctionsEnabled: false }, 1_000, 1);
		state.seats[2].chips = 2_000;
		const result = surrenderMove(state, A, [words.surrendered(A)], false);
		expect(result.ok && result.state.phase).toBe("finished");
		if (!result.ok) return;
		expect(result.state.winnerId).toBe(BLUE);
		expect(result.trailLines).toContain(words.botsAloneEnd);
		expect(result.trailLines.some((line) => line.startsWith("It is now"))).toBe(false);
	});

	it("ends on the standings when nobody left can host", () => {
		const state = createInitialState([A, B, C], { auctionsEnabled: false }, 1_000, 1);
		state.seats[1].chips = 3_000;
		const result = surrenderMove(state, A, [words.surrendered(A)], true);
		expect(result.ok && result.state.winnerId).toBe(B);
		if (result.ok) expect(result.trailLines).toContain(words.noHostLeftEnd);
	});

	it("needs no standings when one seat is left: the forfeit itself names the winner", () => {
		const result = surrenderMove(createInitialState([A, B], { auctionsEnabled: false }, 1_000, 1), A, [], true);
		expect(result.ok && result.state.winnerId).toBe(B);
		if (result.ok) expect(result.trailLines).not.toContain(words.noHostLeftEnd);
	});

	it("finishOnStandings forfeits the poorest first, a tie going against the later seat", () => {
		const state = createInitialState([A, B, C], { auctionsEnabled: false }, 1_000, 1);
		state.seats[0].chips = 900;
		const ended = finishOnStandings(state);
		expect(ended.state.winnerId).toBe(B);
		// A at 900 goes first; B and C tie at the start's chips, so the later seat, C, goes next.
		expect(ended.state.seats.map((seat) => seat.bankruptedAt)).toEqual([1, null, 2]);
	});
});

describe("surrenderMonopolySeat", () => {
	it("lets a seat that is not the host surrender without touching who hosts", async () => {
		seed([A, B, C]);
		expect(await surrenderMonopolySeat(client, row.current as unknown as IGameRoom, B)).toBe("surrendered");
		expect(seatOf(B)?.bankrupt).toBe(true);
		expect(storeMock.transferHost).not.toHaveBeenCalled();
		expect(commitMock.mock.calls[0][4]).toMatchObject({ onTurnOnly: false, kind: "forfeit" });
	});

	it("hands a surrendering host's room to the next member in turn order, skipping bots and anyone hosting another room", async () => {
		seed([A, RED, B, C]);
		storeMock.findOpenByHost.mockImplementation(async (_guildId: string, userId: string) => (userId === B ? { roomId: "elsewhere" } : null));

		expect(await surrenderMonopolySeat(client, row.current as unknown as IGameRoom, A)).toBe("surrendered");
		expect(storeMock.transferHost).toHaveBeenCalledExactlyOnceWith("guild-1", "room-1", A, C);
		expect(row.current?.hostId).toBe(C);
		expect(committedLines()).toEqual(expect.arrayContaining([words.surrendered(A), words.hostHandedOn(C)]));
		expect(stored().phase).not.toBe("finished");
	});

	it("tries the next member when the index refuses one in a race", async () => {
		seed([A, B, C]);
		storeMock.transferHost.mockResolvedValueOnce("taken").mockImplementationOnce(async () => row.current);
		await surrenderMonopolySeat(client, row.current as unknown as IGameRoom, A);
		expect(storeMock.transferHost.mock.calls.map((call) => call[3])).toEqual([B, C]);
	});

	it("ends the match on its standings when every member left already hosts another room", async () => {
		seed([A, B, C]);
		storeMock.findOpenByHost.mockResolvedValue({ roomId: "elsewhere" });
		await surrenderMonopolySeat(client, row.current as unknown as IGameRoom, A);
		expect(storeMock.transferHost).not.toHaveBeenCalled();
		expect(stored().phase).toBe("finished");
	});

	it("ends the match when a host's surrender leaves Dero bots alone", async () => {
		seed([A, RED, BLUE]);
		await surrenderMonopolySeat(client, row.current as unknown as IGameRoom, A);
		expect(storeMock.transferHost).not.toHaveBeenCalled();
		expect(stored().phase).toBe("finished");
	});

	it("retries a busy board, hands hosting on once, and says the seat is still in after every try", async () => {
		seed([A, B, C]);
		for (let attempt = 0; attempt < BOT_CONSTANTS.GAME_ROOM_KICK_ATTEMPTS; attempt++) commitMock.mockResolvedValueOnce({ ok: false, reason: words.boardBusy });
		expect(await surrenderMonopolySeat(client, row.current as unknown as IGameRoom, A)).toBe("busy");
		expect(storeMock.transferHost).toHaveBeenCalledOnce();
		expect(commitMock).toHaveBeenCalledTimes(BOT_CONSTANTS.GAME_ROOM_KICK_ATTEMPTS);
	});

	it("has nothing to surrender for a seat already out", async () => {
		seed([A, B, C]);
		stored().seats[1].bankrupt = true;
		expect(await surrenderMonopolySeat(client, row.current as unknown as IGameRoom, B)).toBe("notInMatch");
		expect(commitMock).not.toHaveBeenCalled();
	});
});

describe("the two presses", () => {
	function press(userId: string) {
		return {
			user: { id: userId },
			client,
			reply: vi.fn(async () => undefined),
			deferUpdate: vi.fn(async () => undefined),
			editReply: vi.fn(async () => undefined),
		} as unknown as ButtonInteraction & { reply: ReturnType<typeof vi.fn>; deferUpdate: ReturnType<typeof vi.fn>; editReply: ReturnType<typeof vi.fn> };
	}

	// 2026-10 item 257: the shared confirm, whose Submit (or fallback button) surrenders.
	it("answers the first press with the shared confirm, and surrenders nothing", async () => {
		const room = seed([A, B]);
		const interaction = press(B);
		await handleMsurrender(interaction, room);
		expect(showConfirm).toHaveBeenCalledWith(interaction, expect.objectContaining({ confirmId: "gameroom:msurrenderok:room-1" }));
		expect(commitMock).not.toHaveBeenCalled();
	});

	it("refuses a seat already out with a private notice, and opens no confirm", async () => {
		const room = seed([A, B, C]);
		stored().seats[2].bankrupt = true;
		const interaction = press(C);
		await handleMsurrender(interaction, room);
		expect(showNotice).toHaveBeenCalledOnce();
		expect(showConfirm).not.toHaveBeenCalled();
	});

	it("surrenders on the confirm, acknowledged first, then says how it went", async () => {
		const room = seed([A, B, C]);
		const interaction = press(B);
		await handleMsurrenderConfirm(interaction, room);
		expect(vi.mocked(acknowledgeConfirm).mock.invocationCallOrder[0]).toBeLessThan(commitMock.mock.invocationCallOrder[0]);
		expect(answerInChannel).toHaveBeenCalledWith(interaction, "member", { content: words.surrenderDone });
		expect(showNotice).not.toHaveBeenCalled();
		expect(seatOf(B)?.bankrupt).toBe(true);
	});
});
