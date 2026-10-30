import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

// ── chipPot (2026-10 item 276 Phase 6b, owner decisions D3, D4, D7, D10, D12) ──────
// The winner takes all pot of a ranked Monopoly match and a wagered ranked Battleship match.
// What is pinned: it pays the whole pot to a winner who paid in, shares it among the payers still
// in otherwise, and every payout adds up to exactly what was paid in. The pot is opened by the
// start claim's own write (2026-10 item 278), pinned in startClaimCrash.test.ts.

const mocks = vi.hoisted(() => ({ credit: vi.fn(), postMove: vi.fn() }));

vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { credit: mocks.credit, debit: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: mocks.postMove } }));

import { isPotGame, potPayouts, potTotalOf, settleChipPot } from "./chipPot.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { ChipPot, IGameRoom } from "@db/models/GameRoom.js";

const client = {} as Client;
const ROOM = { guildId: "g1", roomId: "r1" };
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
});

describe("isPotGame", () => {
	it("names the ranked games whose buy ins sit in a pot, and no table game", () => {
		expect(isPotGame("monopoly")).toBe(true);
		expect(isPotGame("battleship")).toBe(true);
		expect(isPotGame("holdem")).toBe(false);
		expect(isPotGame("blackjack")).toBe(false);
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
