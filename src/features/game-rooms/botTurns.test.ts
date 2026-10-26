import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

const mocks = vi.hoisted(() => ({
	findPlayingWithBots: vi.fn(),
	playHoldemBotTurn: vi.fn(),
	commitMonopolyMove: vi.fn(),
	commitShot: vi.fn(),
	commitReady: vi.fn(),
}));

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findPlayingWithBots: mocks.findPlayingWithBots } }));
vi.mock("./roomHoldemHandlers.js", () => ({ playHoldemBotTurn: mocks.playHoldemBotTurn }));
vi.mock("./roomMonopolyHandlers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./roomMonopolyHandlers.js")>()),
	commitMonopolyMove: mocks.commitMonopolyMove,
}));
vi.mock("./roomBattleshipHandlers.js", () => ({ commitShot: mocks.commitShot, commitReady: mocks.commitReady }));

import { playBattleshipBotTurn, playMonopolyBotTurn, sweepBotTurns } from "./botTurns.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { createMatch, markReady, startBattle } from "@features/games/battleshipState.js";
import { serializeMatch } from "./roomBattleship.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── botTurns, the bot driver (2026-10 item 250 Phase 5) ─────────────────────
// Each tick moves at most one bot one step per room, through the same commit a member's
// press uses; a Monopoly match no member is left in ends by forfeiting the poorest bot;
// a battleship bot readies in setup and fires on its turn; one room's failure never
// stops another's bots.

type Move = (state: MonopolyState, actorId: string) => { ok: boolean; state?: MonopolyState };

const client = {} as Client;
const room = (game: string, secret: unknown): IGameRoom =>
	({ roomId: `room-${game}`, guildId: "g1", game, hostId: "host", status: "playing", playerIds: ["host"], botSeats: 1, secret }) as unknown as IGameRoom;

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.commitMonopolyMove.mockResolvedValue({ ok: true });
	mocks.commitShot.mockResolvedValue(undefined);
	mocks.commitReady.mockResolvedValue(undefined);
});

describe("Monopoly", () => {
	it("moves the bot on the clock through the member's commit, off the turn gate since the engine checks it", async () => {
		const state = createInitialState(["dero-bot-red", "host"], { auctionsEnabled: false });

		expect(await playMonopolyBotTurn(client, room("monopoly", state))).toBe(true);

		const [, , actorId, move, options] = mocks.commitMonopolyMove.mock.calls[0] as [Client, IGameRoom, string, Move, { onTurnOnly: boolean }];
		expect(actorId).toBe("dero-bot-red");
		expect(options).toEqual({ onTurnOnly: false });
		// The bot's step is the roll its turn opens with.
		const rolled = move(state, actorId);
		expect(rolled.ok).toBe(true);
		expect(rolled.state?.rolledThisTurn).toBe(true);
	});

	it("does nothing while a member is on the clock", async () => {
		const state = createInitialState(["host", "dero-bot-red"], { auctionsEnabled: false });
		expect(await playMonopolyBotTurn(client, room("monopoly", state))).toBe(false);
		expect(mocks.commitMonopolyMove).not.toHaveBeenCalled();
	});

	it("ends a match no member is left in by forfeiting the poorest bot", async () => {
		const state = createInitialState(["host", "dero-bot-orange", "dero-bot-gold"], { auctionsEnabled: false });
		state.seats[0].bankrupt = true;
		state.seats[1].chips = 900;
		state.seats[2].chips = 400;

		await playMonopolyBotTurn(client, room("monopoly", state));

		const [, , actorId] = mocks.commitMonopolyMove.mock.calls[0] as [Client, IGameRoom, string];
		expect(actorId).toBe("dero-bot-gold");
	});
});

describe("Battleship", () => {
	function match(status: "setup" | "battle") {
		const state = createMatch([
			{ userId: "host", username: "Host" },
			{ userId: "dero-bot-red", username: "Dero Red" },
		]);
		if (status === "battle") {
			markReady(state, "host");
			markReady(state, "dero-bot-red");
			startBattle(state);
			state.turn = 1;
		}
		return serializeMatch(state);
	}

	it("readies the bot's fleet during setup", async () => {
		expect(await playBattleshipBotTurn(client, room("battleship", match("setup")))).toBe(true);
		expect(mocks.commitReady).toHaveBeenCalledWith(client, expect.anything(), "dero-bot-red", 1);
	});

	it("aims and fires on the bot's turn through the Fire button's core", async () => {
		expect(await playBattleshipBotTurn(client, room("battleship", match("battle")))).toBe(true);
		const [, , aimed, , shooter] = mocks.commitShot.mock.calls[0] as [Client, IGameRoom, { pending: Record<string, unknown> }, unknown, { userId: string; name: string }];
		expect(aimed.pending["dero-bot-red"]).toEqual({ x: expect.any(Number), y: expect.any(Number) });
		expect(shooter).toEqual({ userId: "dero-bot-red", name: "Dero Red" });
	});
});

describe("the tick", () => {
	it("drives each room's game, and one room's failure never stops the next", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.findPlayingWithBots.mockResolvedValue([room("holdem", null), room("holdem", null)]);
		mocks.playHoldemBotTurn.mockRejectedValueOnce(new Error("discord down")).mockResolvedValueOnce(true);

		await expect(sweepBotTurns(client)).resolves.toEqual({ moved: 1 });
		expect(mocks.playHoldemBotTurn).toHaveBeenCalledTimes(2);
	});

	it("skips a tick while the last one still runs", async () => {
		let release: () => void = () => undefined;
		mocks.findPlayingWithBots.mockReturnValue(new Promise((resolve) => (release = () => resolve([]))));
		const first = sweepBotTurns(client);
		await expect(sweepBotTurns(client)).resolves.toEqual({ moved: 0 });
		release();
		await first;
		expect(mocks.findPlayingWithBots).toHaveBeenCalledOnce();
	});
});
