import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

// ── blackjackChips (2026-10 item 267, risk R5) ────────────────────────────────
// The row's stacks ledger is what pays a Blackjack table back when the process that held it is
// gone. What is pinned: a free table writes no ledger, every cash out claims its entry before it
// credits, so a seat is paid once however many paths reach it, and the end of a table pays every
// stored stack once and says so in the room. Driven over a mocked store and wallet.

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { openBlackjackStacks: vi.fn(), saveBlackjackStacks: vi.fn(), takeBlackjackStack: vi.fn() } }));
vi.mock("@features/economy/chipWallet.js", () => ({ returnChips: vi.fn(async () => ({ balance: 0 })), refundChipReceipt: vi.fn(async () => true) }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn(async () => true) } }));

import { cashOutBlackjackSeat, openBlackjackLedger, refundStrandedLateCharges, settleBlackjackStacks } from "./blackjackChips.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { refundChipReceipt, returnChips } from "@features/economy/chipWallet.js";
import { roomTrail } from "./roomTrail.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

type Mock = ReturnType<typeof vi.fn>;
const store = gameRoomStore as unknown as Record<"openBlackjackStacks" | "saveBlackjackStacks" | "takeBlackjackStack", Mock>;
const credit = returnChips as unknown as Mock;
const ROOM = { guildId: "g1", roomId: "room-1" };

// A ledger the claims below pull from, the way the store's conditional $pull does.
function ledgerOf(entries: { userId: string; buyIn: number; stack: number }[]) {
	const held = [...entries];
	store.takeBlackjackStack.mockImplementation(async (_guildId: string, _roomId: string, userId: string) => {
		const index = held.findIndex((entry) => entry.userId === userId);
		return index < 0 ? null : held.splice(index, 1)[0];
	});
	return held;
}

beforeEach(() => {
	vi.clearAllMocks();
	store.openBlackjackStacks.mockResolvedValue({});
});

describe("the ledger at open", () => {
	it("holds every paid seat at its buy in on a chip table, and nothing on a free one", async () => {
		expect(await openBlackjackLedger(ROOM, { buyIn: 2500, userIds: ["a", "b"], charged: true })).toBe(true);
		expect(store.openBlackjackStacks).toHaveBeenCalledWith("g1", "room-1", [
			{ userId: "a", buyIn: 2500, stack: 2500 },
			{ userId: "b", buyIn: 2500, stack: 2500 },
		], expect.any(Date));

		store.openBlackjackStacks.mockClear();
		expect(await openBlackjackLedger(ROOM, { buyIn: 2500, userIds: ["a"], charged: false })).toBe(true);
		expect(store.openBlackjackStacks).not.toHaveBeenCalled();
	});

	it("answers false when the write fails, so the caller gives the buy ins back", async () => {
		store.openBlackjackStacks.mockRejectedValue(new Error("mongo down"));
		expect(await openBlackjackLedger(ROOM, { buyIn: 1000, userIds: ["a"], charged: true })).toBe(false);
	});
});

describe("a seat's cash out", () => {
	it("claims the seat's entry, then credits the stack it left with, once", async () => {
		ledgerOf([{ userId: "a", buyIn: 1000, stack: 1300 }]);
		expect(await cashOutBlackjackSeat(ROOM, "a", 1200)).toBe(true);
		expect(credit).toHaveBeenCalledWith({ userId: "a" }, 1200);
		expect(await cashOutBlackjackSeat(ROOM, "a", 1200)).toBe(false);
		expect(credit).toHaveBeenCalledOnce();
	});
});

describe("the end of a table", () => {
	it("pays every stored stack once, skips an empty one, and says what went back", async () => {
		const room = { ...ROOM, game: "blackjack", hostId: "a", channelId: "ch-1", blackjackStacks: [
			{ userId: "a", buyIn: 1000, stack: 1400 },
			{ userId: "b", buyIn: 1000, stack: 0 },
			{ userId: "c", buyIn: 1000, stack: 600 },
		] } as unknown as IGameRoom;
		// c cashed out a moment ago, so only a and b are still on the ledger.
		ledgerOf([
			{ userId: "a", buyIn: 1000, stack: 1400 },
			{ userId: "b", buyIn: 1000, stack: 0 },
		]);

		expect(await settleBlackjackStacks({} as Client, room)).toEqual([{ userId: "a", amount: 1400 }]);
		expect(credit).toHaveBeenCalledOnce();
		expect(roomTrail.postMove).toHaveBeenCalledWith({}, room, expect.objectContaining({ text: gameRoomsCopy.trail.blackjackChipsReturned([{ userId: "a", amount: 1400 }]) }));

		expect(await settleBlackjackStacks({} as Client, room)).toEqual([]);
		expect(credit).toHaveBeenCalledOnce();
	});

	it("pays nothing for any other game", async () => {
		const room = { ...ROOM, game: "holdem", blackjackStacks: [{ userId: "a", buyIn: 1000, stack: 1 }] } as unknown as IGameRoom;
		expect(await settleBlackjackStacks({} as Client, room)).toEqual([]);
		expect(store.takeBlackjackStack).not.toHaveBeenCalled();
	});
});

// ── a late seat's charge a crash stranded (2026-10 item 276, audit P3) ──
describe("refundStrandedLateCharges", () => {
	it("gives every held late charge back through its receipt, which pays only a charge really taken", async () => {
		const room = { game: "blackjack", guildId: "g1", roomId: "room-1", blackjackLateCharges: [{ userId: "carol", buyIn: 1000, chargeId: "c-1" }] } as unknown as IGameRoom;

		await refundStrandedLateCharges(room);

		expect(refundChipReceipt).toHaveBeenCalledWith({ userId: "carol" }, 1000, "c-1");
		expect(credit).not.toHaveBeenCalled();
	});

	it("touches no wallet for another game, or a table with nothing held", async () => {
		await refundStrandedLateCharges({ game: "holdem", guildId: "g1", roomId: "room-1", blackjackLateCharges: [{ userId: "carol", buyIn: 1000, chargeId: "c-1" }] } as unknown as IGameRoom);
		await refundStrandedLateCharges({ game: "blackjack", guildId: "g1", roomId: "room-1", blackjackLateCharges: [] } as unknown as IGameRoom);

		expect(refundChipReceipt).not.toHaveBeenCalled();
	});
});

// 2026-10 item 276, audit P3: the start claim writes a card's or a rematch's stacks itself.
describe("openBlackjackLedger after the start claim", () => {
	it("writes nothing for seats the claim already put on the stacks ledger", async () => {
		expect(await openBlackjackLedger({ guildId: "g1", roomId: "room-1" }, { buyIn: 1000, userIds: ["host", "a"], charged: true, ledgered: true })).toBe(true);
		expect(gameRoomStore.openBlackjackStacks).not.toHaveBeenCalled();
	});
});
