import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn(), moveBoardMessage: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn(), recordCarriedMoves: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("./turnPrompt.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./turnPrompt.js")>()), syncTurnPrompt: vi.fn() }));
vi.mock("./turnClock.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./turnClock.js")>()), syncTurnClocks: vi.fn() }));

import { battleshipTurnAdapter, battleshipTurnClock, redrawBattleshipBoard } from "./roomBattleshipHandlers.js";
import { syncTurnPrompt } from "./turnPrompt.js";
import { syncTurnClocks } from "./turnClock.js";
import { startMatch, type StoredBattleship } from "./roomBattleship.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── a Battleship board that could not be drawn (2026-10 item 276, audit P3) ──
// The redraw returned early when the match had no board message or its channel could not be read,
// and that early return skipped the turn line and the turn clock too: nobody was pinged, and the
// sweep could then forfeit and rate a turn nobody was ever offered. The board is cosmetic; the
// prompt (whose Take your turn plays a shot without a board) and the clock are not.

const A = "player-a";
const B = "player-b";

const playing = (): StoredBattleship => ({ ...startMatch({ playerIds: [A, B] } as IGameRoom, { [A]: "A", [B]: "B" }), status: "playing", boardMessageId: null });
const roomOf = (secret: StoredBattleship): IGameRoom => ({ roomId: "room-1", guildId: "guild-1", game: "battleship", status: "playing", playerIds: [A, B], channelId: "ch-1", secret }) as unknown as IGameRoom;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("redrawBattleshipBoard", () => {
	it("still pings the captain and arms the clock when the match never got a board", async () => {
		const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;
		const room = roomOf(playing());

		await redrawBattleshipBoard(client, room, room.secret as unknown as StoredBattleship);

		expect(syncTurnPrompt).toHaveBeenCalledWith(client, room, battleshipTurnAdapter);
		expect(syncTurnClocks).toHaveBeenCalledWith(client, room, [battleshipTurnClock]);
	});

	it("still pings the captain and arms the clock when the room's channel cannot be read", async () => {
		const client = { channels: { fetch: vi.fn().mockRejectedValue(new Error("Missing Access")) } } as unknown as Client;
		const room = roomOf({ ...playing(), boardMessageId: "board-1" });

		await redrawBattleshipBoard(client, room, room.secret as unknown as StoredBattleship);

		expect(syncTurnPrompt).toHaveBeenCalledOnce();
		expect(syncTurnClocks).toHaveBeenCalledOnce();
	});
});
