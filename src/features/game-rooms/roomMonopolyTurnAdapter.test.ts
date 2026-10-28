import { describe, it, expect, vi } from "vitest";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn(), updateSecretIf: vi.fn(), moveBoardMessage: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", () => ({ recordMatchRatings: vi.fn(), monopolyFinishingOrder: vi.fn(() => []) }));

import { monopolyTurnAdapter } from "./roomMonopolyHandlers.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── Monopoly's side of the turn prompt (2026-10 item 257 Phase 4a) ──
// Whose turn it is, a fingerprint that holds for the whole turn, the moves the board's buttons
// would offer as a select, and the buttons that stay on the prompt line because a modal cannot
// open from the turn modal's Submit (risk R6): Trade, and Bid while an auction is open.

const A = "player-a";
const B = "player-b";

const roomOf = (state: MonopolyState): IGameRoom => ({ roomId: "room-1", guildId: "guild-1", game: "monopoly", status: "playing", secret: state }) as unknown as IGameRoom;
const fresh = (): MonopolyState => createInitialState([A, B], { auctionsEnabled: true }, Date.now(), 1);
const customIds = (room: IGameRoom): string[] => monopolyTurnAdapter.extraButtons!(room).map((button) => (button.toJSON() as { custom_id: string }).custom_id);
const optionValues = (room: IGameRoom, userId: string): string[] => {
	const field = monopolyTurnAdapter.view(room, userId)?.fields[0];
	return field && field.kind === "select" ? field.options.map((option) => option.value) : [];
};

describe("whose turn it is", () => {
	it("is the seat on the clock, and nobody once the match is over", () => {
		expect(monopolyTurnAdapter.whoseTurn(roomOf(fresh()))).toBe(A);
		expect(monopolyTurnAdapter.whoseTurn(roomOf({ ...fresh(), phase: "finished" }))).toBeNull();
	});

	it("holds one fingerprint for the whole turn and a new one for the next", () => {
		const state = fresh();
		const sameTurn = { ...state, phase: "post-roll" as const, revision: state.revision + 3 };
		const nextTurn = { ...state, activeSeatIndex: 1, stats: { ...state.stats!, turnsTaken: 1 } };

		expect(monopolyTurnAdapter.fingerprintOf(roomOf(sameTurn))).toBe(monopolyTurnAdapter.fingerprintOf(roomOf(state)));
		expect(monopolyTurnAdapter.fingerprintOf(roomOf(nextTurn))).not.toBe(monopolyTurnAdapter.fingerprintOf(roomOf(state)));
		expect(monopolyTurnAdapter.fingerprintOf(roomOf(state))).not.toContain(":");
	});
});

describe("the modal", () => {
	it("offers the roll before the roll, and the end of the turn after it, to the seat on the clock only", () => {
		const state = fresh();
		expect(optionValues(roomOf(state), A)).toEqual(["roll"]);
		expect(optionValues(roomOf({ ...state, phase: "post-roll" }), A)).toEqual(["end"]);
		expect(monopolyTurnAdapter.view(roomOf(state), B)).toBeNull();
	});

	it("offers the three ways out of jail the board offers", () => {
		const state = fresh();
		state.seats[0] = { ...state.seats[0], inJail: true, jailTurnsRemaining: 3, gojfCards: 1, chips: 500 };
		expect(optionValues(roomOf(state), A)).toEqual(["card", "bail", "jailroll"]);
	});

	it("has nothing to play during an auction: the bid is a button on the prompt line", () => {
		expect(monopolyTurnAdapter.view(roomOf({ ...fresh(), phase: "in-auction" }), A)).toBeNull();
	});

	it("refuses a move it does not know, without acknowledging", async () => {
		const acknowledge = vi.fn();
		const result = await monopolyTurnAdapter.apply({} as never, roomOf(fresh()), A, { move: "teleport" }, acknowledge);

		expect(result).toEqual({ ok: false, reason: gameRoomsCopy.errors.controlRetired });
		expect(acknowledge).not.toHaveBeenCalled();
	});
});

describe("Bid, Trade, Inventory and Surrender ride beside Take your turn", () => {
	// 2026-10 item 263 R3-22: the turn line carries what the board no longer does on a member's turn.
	it("carries Trade, Inventory and Surrender on every prompt line", () => {
		expect(customIds(roomOf(fresh()))).toEqual(["gameroom:mtrade:room-1", "gameroom:minventory:room-1", "gameroom:msurrender:room-1"]);
	});

	it("adds the Bid button, carrying the round it opens, while an auction is open", () => {
		const state: MonopolyState = {
			...fresh(),
			phase: "in-auction",
			pendingAuction: { tileId: "burnt-umber-row", roundOpenedAt: 12345 } as MonopolyState["pendingAuction"],
		};
		expect(customIds(roomOf(state))).toEqual(["gameroom:mauction:room-1:12345", "gameroom:mtrade:room-1", "gameroom:minventory:room-1", "gameroom:msurrender:room-1"]);
	});
});
