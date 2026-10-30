import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

// ── chipPot (2026-10 item 276 Phase 6b, owner decisions D3, D4, D7, D10, D12) ──────
// The winner takes all pot of a ranked Monopoly match and a wagered ranked Battleship match.
// What is pinned: the pot opens only for a charged pot game, gives a payer the room did not
// seat their buy in back, refunds when the row was no longer playing and never when the write
// threw; it pays the whole pot to a winner who paid in, shares it among the payers still in
// otherwise, and every payout adds up to exactly what was paid in.

const mocks = vi.hoisted(() => ({ openChipPot: vi.fn(), credit: vi.fn(), postMove: vi.fn() }));

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { openChipPot: mocks.openChipPot } }));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { credit: mocks.credit, debit: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: mocks.postMove } }));

import { isPotGame, openChipPot, potPayouts, potTotalOf, settleChipPot } from "./chipPot.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { ChipPot, IGameRoom } from "@db/models/GameRoom.js";

const client = {} as Client;
const ROOM = { guildId: "g1", roomId: "r1" };
const charged = (userIds: string[], buyIn = 1_500) => ({ buyIn, userIds, charged: true });
const creditsTo = (userId: string): number[] => mocks.credit.mock.calls.filter((call) => (call[0] as { userId: string }).userId === userId).map((call) => call[1] as number);
const sumOf = (payouts: { amount: number }[]): number => payouts.reduce((sum, payout) => sum + payout.amount, 0);

function finished(game: "monopoly" | "battleship", pot: ChipPot | null, bankrupt: string[] = []): IGameRoom {
	const seats = (pot?.userIds ?? []).map((userId) => ({ userId, bankrupt: bankrupt.includes(userId) }));
	return { ...ROOM, game, hostId: "a", chipPot: pot, secret: game === "monopoly" ? { seats } : null } as unknown as IGameRoom;
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.credit.mockResolvedValue({ balance: 0 });
	mocks.postMove.mockResolvedValue(true);
	mocks.openChipPot.mockResolvedValue({});
});

describe("openChipPot", () => {
	it("opens no pot for a free match or a game without one", async () => {
		expect(isPotGame("holdem")).toBe(false);
		await expect(openChipPot({ ...ROOM, game: "monopoly" }, { ...charged(["a", "b"]), charged: false }, ["a", "b"])).resolves.toBeNull();
		await expect(openChipPot({ ...ROOM, game: "holdem" }, charged(["a", "b"]), ["a", "b"])).resolves.toBeNull();
		expect(mocks.openChipPot).not.toHaveBeenCalled();
		expect(mocks.credit).not.toHaveBeenCalled();
	});

	it("writes every seated payer into the pot and gives an unseated payer their buy in back", async () => {
		const pot = await openChipPot({ ...ROOM, game: "monopoly" }, charged(["a", "b", "c"]), ["a", "b"]);
		expect(pot).toEqual({ buyIn: 1_500, userIds: ["a", "b"] });
		expect(mocks.openChipPot).toHaveBeenCalledWith("g1", "r1", { buyIn: 1_500, userIds: ["a", "b"] });
		expect(creditsTo("c")).toEqual([1_500]);
		expect(creditsTo("a")).toEqual([]);
	});

	it("gives every buy in back when the row was no longer playing, since that finish paid no pot", async () => {
		mocks.openChipPot.mockResolvedValue(null);
		await expect(openChipPot({ ...ROOM, game: "battleship" }, charged(["a", "b"], 250), ["a", "b"])).resolves.toBeNull();
		expect(creditsTo("a")).toEqual([250]);
		expect(creditsTo("b")).toEqual([250]);
	});

	// The house rule for chips: a crash loses chips, never mints them. A write that threw may
	// have landed, and a refund on top of a pot the finish then pays would pay twice.
	it("refunds nothing when the write threw", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.openChipPot.mockRejectedValue(new Error("db down"));
		await expect(openChipPot({ ...ROOM, game: "monopoly" }, charged(["a", "b"]), ["a", "b"])).resolves.toBeNull();
		expect(mocks.credit).not.toHaveBeenCalled();
	});
});

describe("potPayouts", () => {
	const pot: ChipPot = { buyIn: 1_500, userIds: ["a", "b", "c"] };

	it("pays the whole pot, every leaver's buy in included, to a winner who paid in", () => {
		expect(potTotalOf(pot)).toBe(4_500);
		expect(potPayouts(finished("monopoly", pot, ["b", "c"]), "a", false)).toEqual([{ userId: "a", amount: 4_500 }]);
		expect(potPayouts(finished("battleship", { buyIn: 250, userIds: ["a", "b"] }), "b", false)).toEqual([{ userId: "b", amount: 500 }]);
	});

	it("shares a pot with no winner among the payers still in, so a forfeited buy in goes to those who stayed", () => {
		const shared = potPayouts(finished("monopoly", { buyIn: 1_000, userIds: ["a", "b", "c", "d"] }, ["d"]), null, true);
		expect(shared.map((payout) => payout.userId)).toEqual(["a", "b", "c"]);
		// 4,000 among three: the remainder goes to the first, so nothing is lost to rounding.
		expect(shared).toEqual([
			{ userId: "a", amount: 1_334 },
			{ userId: "b", amount: 1_333 },
			{ userId: "c", amount: 1_333 },
		]);
		expect(sumOf(shared)).toBe(4_000);
	});

	it("shares among every payer when nobody is still in, and pays nothing from no pot", () => {
		expect(sumOf(potPayouts(finished("monopoly", pot, ["a", "b", "c"]), null, true))).toBe(4_500);
		expect(potPayouts(finished("monopoly", null), "a", false)).toEqual([]);
	});

	it("never pays a winner who paid nothing in, sharing among the payers instead", () => {
		expect(potPayouts(finished("battleship", { buyIn: 250, userIds: ["a", "b"] }), "z", false)).toEqual([
			{ userId: "a", amount: 250 },
			{ userId: "b", amount: 250 },
		]);
	});
});

describe("settleChipPot", () => {
	it("pays the winner once and posts the prize line", async () => {
		const settlement = await settleChipPot(client, finished("monopoly", { buyIn: 1_500, userIds: ["a", "b"] }, ["b"]), "a", false);
		expect(settlement).toEqual({ total: 3_000, payouts: [{ userId: "a", amount: 3_000 }] });
		expect(creditsTo("a")).toEqual([3_000]);
		expect(mocks.postMove).toHaveBeenCalledWith(client, expect.anything(), expect.objectContaining({ text: gameRoomsCopy.chipPot.winnerTakes("a", 3_000) }));
	});

	it("keeps paying past a failed credit, and settles nothing for a room with no pot", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.credit.mockRejectedValueOnce(new Error("db down"));
		await settleChipPot(client, finished("battleship", { buyIn: 250, userIds: ["a", "b"] }), null, true);
		expect(mocks.credit).toHaveBeenCalledTimes(2);
		await expect(settleChipPot(client, finished("monopoly", null), "a", false)).resolves.toBeNull();
	});
});
