import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

// ── holdemChips (2026-10 item 250 Phase 5) ──────────────────────────────────
// Which tables play for chips, the bounds on the host's buy in, what every seat holds
// at the end, and the end of table payment the finish claim makes once.

const mocks = vi.hoisted(() => ({ findConfig: vi.fn(), credit: vi.fn(), debit: vi.fn(), postMove: vi.fn() }));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { credit: mocks.credit, debit: mocks.debit } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: mocks.postMove } }));

import { chipTableFor, chipsOwedAtEnd, isValidBuyIn, settleTableChips } from "./holdemChips.js";
import { createTable, dealHand, joinTable, leaveTable, type HoldemTable } from "@features/games/holdemTable.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const client = {} as Client;

function chipTable(): HoldemTable {
	const table = createTable();
	table.chips = { guildId: "g1" };
	table.startingStack = 1_000;
	for (const userId of ["a", "b", "c"]) joinTable(table, userId, userId);
	return table;
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.credit.mockResolvedValue({ balance: 0 });
	mocks.postMove.mockResolvedValue(true);
});

describe("chipTableFor", () => {
	const ranked = { guildId: "g1", game: "holdem" as const, network: false, casual: false };

	it("plays for chips only in a set up server with chips on, never at a network or bot table", async () => {
		mocks.findConfig.mockResolvedValue({ chipEconomyEnabled: true });
		await expect(chipTableFor(ranked, 0)).resolves.toEqual({ guildId: "g1" });
		await expect(chipTableFor({ ...ranked, network: true }, 0)).resolves.toBeNull();
		await expect(chipTableFor(ranked, 1)).resolves.toBeNull();

		mocks.findConfig.mockResolvedValue({ chipEconomyEnabled: false });
		await expect(chipTableFor(ranked, 0)).resolves.toBeNull();
		mocks.findConfig.mockResolvedValue(null);
		await expect(chipTableFor(ranked, 0)).resolves.toBeNull();
	});

	// 2026-10 item 276, owner decision D1: chips move only in ranked matches, whatever the switch says.
	it("plays a casual match free with chips on, Hold'em and Blackjack alike, and a solo table against Dero too", async () => {
		mocks.findConfig.mockResolvedValue({ chipEconomyEnabled: true });
		await expect(chipTableFor({ ...ranked, casual: true }, 0)).resolves.toBeNull();
		await expect(chipTableFor({ ...ranked, game: "blackjack" }, 0)).resolves.toEqual({ guildId: "g1" });
		await expect(chipTableFor({ ...ranked, game: "blackjack", casual: true }, 0)).resolves.toBeNull();
		await expect(chipTableFor({ ...ranked, game: "solo-blackjack" }, 0)).resolves.toBeNull();
		// A casual match never reads the switch at all.
		mocks.findConfig.mockClear();
		await chipTableFor({ ...ranked, casual: true }, 0);
		expect(mocks.findConfig).not.toHaveBeenCalled();
	});
});

describe("isValidBuyIn", () => {
	it("takes a whole number of chips from 200 to a million", () => {
		expect([199, 200, 2_500, 1_000_000, 1_000_001, 2.5].map(isValidBuyIn)).toEqual([false, true, true, true, false, false]);
	});
});

describe("chipsOwedAtEnd", () => {
	it("owes a seat still in its stack and whatever a hand that never settled holds, a leaver nothing, a waiting seat its buy in", () => {
		const table = chipTable();
		table.status = "playing";
		dealHand(table, () => 0.5);
		leaveTable(table, "c");
		table.pendingSeats = [{ userId: "d", username: "d" }];

		const owed = chipsOwedAtEnd(table);
		const total = owed.reduce((sum, payout) => sum + payout.amount, 0);
		expect(owed.map((payout) => payout.userId).sort()).toEqual(["a", "b", "d"]);
		expect(owed.find((payout) => payout.userId === "d")?.amount).toBe(1_000);
		// Every chip still on the table goes somewhere, the leaver's chips in the hand included
		// (2026-10 item 276, audit P2-14): the leaver's stack was paid at the leave, and what it
		// had put into the hand is shared by the seats still in, never lost.
		const onTable = table.seats.reduce((sum, seat) => sum + seat.stack + seat.totalCommitted, 0);
		expect(table.seats.find((seat) => seat.userId === "c")!.totalCommitted).toBeGreaterThan(0);
		expect(total).toBe(onTable + 1_000);
	});

	// 2026-10 item 276, owner decisions D3 and D12: a ranked leaver's stack waits on the table and
	// goes to the seats still in, all of it to a lone winner, shared (the remainder to the first)
	// among several, so the table always pays out exactly what was paid in.
	it("pays what leavers forfeited to the seats still in, never back to the leavers", () => {
		const table = chipTable();
		table.forfeitedChips = 1_001;
		const owed = chipsOwedAtEnd(table);
		expect(owed).toEqual([
			{ userId: "a", amount: 1_000 + 335 },
			{ userId: "b", amount: 1_000 + 333 },
			{ userId: "c", amount: 1_000 + 333 },
		]);

		const won = chipTable();
		won.seats[1].out = true;
		won.seats[2].out = true;
		won.forfeitedChips = 2_000;
		expect(chipsOwedAtEnd(won)).toEqual([{ userId: "a", amount: 3_000 }]);
	});
});

describe("settleTableChips", () => {
	const room = (table: HoldemTable | null, game = "holdem") => ({ roomId: "r1", guildId: "g1", hostId: "a", game, secret: table }) as unknown as IGameRoom;

	it("pays every seat back to their global wallet and posts one line", async () => {
		const owed = await settleTableChips(client, room(chipTable()));

		expect(owed).toEqual([
			{ userId: "a", amount: 1_000 },
			{ userId: "b", amount: 1_000 },
			{ userId: "c", amount: 1_000 },
		]);
		expect(mocks.credit).toHaveBeenCalledWith({ userId: "b" }, 1_000);
		expect(mocks.postMove).toHaveBeenCalledOnce();
	});

	it("keeps paying past a failed credit", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.credit.mockRejectedValueOnce(new Error("db down"));
		await settleTableChips(client, room(chipTable()));
		expect(mocks.credit).toHaveBeenCalledTimes(3);
	});

	it("does nothing for a free table or another game", async () => {
		const free = createTable();
		joinTable(free, "a", "a");
		await expect(settleTableChips(client, room(free))).resolves.toEqual([]);
		await expect(settleTableChips(client, room(chipTable(), "monopoly"))).resolves.toEqual([]);
		expect(mocks.credit).not.toHaveBeenCalled();
	});
});
