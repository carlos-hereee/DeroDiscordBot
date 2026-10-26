import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@db/stores/luckStatStore.js", () => ({ luckStatStore: { increment: vi.fn(), addReading: vi.fn() } }));

import { luckIncrementsFor, luckScore, recordFortuneReading, recordLuckResult } from "./luckStats.js";
import { luckStatStore } from "@db/stores/luckStatStore.js";

// ── luckStats ────────────────────────────────────────────────────────────
// The luck board's math and its one write (2026-10 item 244): a tie records
// nothing, a decided game counts for both players and a win for one, and the score
// (wins minus half of decided) shows only from 20 decided games.

const storeMock = luckStatStore as unknown as { increment: ReturnType<typeof vi.fn>; addReading: ReturnType<typeof vi.fn> };
const NOW = new Date("2026-10-31T23:59:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.increment.mockResolvedValue(undefined);
});

describe("luckScore", () => {
	it("shows nothing under 20 decided games", () => {
		expect(luckScore({ decided: 19, wins: 19 })).toBeNull();
		expect(luckScore({ decided: 0, wins: 0 })).toBeNull();
	});

	it("is wins minus half of decided from 20 decided games", () => {
		expect(luckScore({ decided: 20, wins: 10 })).toBe(0);
		expect(luckScore({ decided: 20, wins: 14 })).toBe(4);
		expect(luckScore({ decided: 30, wins: 9 })).toBe(-6);
		expect(luckScore({ decided: 21, wins: 11 })).toBe(0.5);
	});

	// 2026-10 item 250 Phase 5: the magic 8 ball's luck above the average reading.
	it("adds the 8 ball's points, but readings never reach the 20 decided games", () => {
		expect(luckScore({ decided: 20, wins: 10, readings: 40, fortunePoints: 3.5 })).toBe(3.5);
		expect(luckScore({ decided: 19, wins: 10, readings: 400, fortunePoints: 30 })).toBeNull();
	});
});

describe("recordFortuneReading", () => {
	it("adds one reading and its luck above average to the month's fortune row", async () => {
		await recordFortuneReading({ guildId: "g1", userId: "u1", luckAboveAverage: 1.25, now: NOW });
		expect(storeMock.addReading).toHaveBeenCalledWith({ guildId: "g1", userId: "u1", game: "fortune", month: "2026-10" }, 1.25);
	});

	it("never rejects when the write fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		storeMock.addReading.mockRejectedValue(new Error("db down"));
		await expect(recordFortuneReading({ guildId: "g1", userId: "u1", luckAboveAverage: -1, now: NOW })).resolves.toBeUndefined();
	});
});

describe("luckIncrementsFor", () => {
	it("records nothing for a tie", () => {
		expect(luckIncrementsFor(["a", "b"], null)).toEqual([]);
	});

	it("counts a decided game for both players and a win for the winner", () => {
		expect(luckIncrementsFor(["a", "b"], "b")).toEqual([
			{ userId: "a", increments: { decided: 1, wins: 0 } },
			{ userId: "b", increments: { decided: 1, wins: 1 } },
		]);
	});
});

describe("recordLuckResult", () => {
	it("writes one row per player in the guild's UTC month", async () => {
		await recordLuckResult({ guildId: "guild-1", game: "diceroll", playerIds: ["a", "b"], winnerId: "a", now: NOW });

		expect(storeMock.increment).toHaveBeenCalledTimes(2);
		expect(storeMock.increment).toHaveBeenCalledWith(
			{ guildId: "guild-1", userId: "a", game: "diceroll", month: "2026-10" },
			{ decided: 1, wins: 1 }
		);
		expect(storeMock.increment).toHaveBeenCalledWith(
			{ guildId: "guild-1", userId: "b", game: "diceroll", month: "2026-10" },
			{ decided: 1, wins: 0 }
		);
	});

	it("writes nothing for a dice tie", async () => {
		await recordLuckResult({ guildId: "guild-1", game: "diceroll", playerIds: ["a", "b"], winnerId: null, now: NOW });
		expect(storeMock.increment).not.toHaveBeenCalled();
	});

	it("writes nothing for a game that is not a luck game", async () => {
		await recordLuckResult({ guildId: "guild-1", game: "battleship", playerIds: ["a", "b"], winnerId: "a", now: NOW });
		expect(storeMock.increment).not.toHaveBeenCalled();
	});

	it("never rejects when the write fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		storeMock.increment.mockRejectedValue(new Error("atlas down"));

		await expect(recordLuckResult({ guildId: "guild-1", game: "rps", playerIds: ["a", "b"], winnerId: "b", now: NOW })).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledOnce();
		errorSpy.mockRestore();
	});
});
