import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Client } from "discord.js";

// ── awardXp ────────────────────────────────────────────────────────────────
// The single public entry point, so this file pins the contract every other
// caller in the codebase depends on: it NEVER throws, "message" is the only
// buffered source, and a game's win/loss record moves in the SAME atomic write
// as the xp so the two can never disagree on /account.

const mocks = vi.hoisted(() => ({
	checkLevelingAccess: vi.fn(),
	getLevelingConfig: vi.fn(),
	stage: vi.fn(),
	handleLevelCrossing: vi.fn(),
	incrementAndReturn: vi.fn(),
	periodBulkWrite: vi.fn(),
	// The XpDaily counter as an in memory fake keyed the way the real unique index
	// is, so the cap tests below read real arithmetic. It lives in vi.hoisted, OUTSIDE
	// the awardXp module, which is what lets the restart test throw awardXp's module
	// away and keep the count: the store is the memory, awardXp holds none.
	dailyCounts: new Map<string, number>(),
	dailyIncrement: vi.fn(),
}));

vi.mock("@features/entitlements/levelingAccess.js", () => ({ checkLevelingAccess: mocks.checkLevelingAccess }));
vi.mock("./levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));
vi.mock("./xpWriter.js", () => ({ stage: mocks.stage }));
vi.mock("./levelUpAnnouncer.js", () => ({ handleLevelCrossing: mocks.handleLevelCrossing }));
vi.mock("@db/stores/memberLevelStore.js", () => ({
	memberLevelStore: { incrementAndReturn: mocks.incrementAndReturn },
}));
vi.mock("@db/stores/xpPeriodStore.js", () => ({ xpPeriodStore: { bulkWrite: mocks.periodBulkWrite } }));
vi.mock("@db/stores/xpDailyStore.js", () => ({ xpDailyStore: { incrementAndReturn: mocks.dailyIncrement } }));

import { awardXp, type AwardXpInput } from "./awardXp.js";

const client = {} as Client;

const input = (overrides: Partial<AwardXpInput> = {}): AwardXpInput => ({
	client,
	guildId: "g1",
	userId: "u1",
	username: "silent",
	amount: 25,
	source: "game",
	...overrides,
});

const incrementsOf = (): Record<string, number> => mocks.incrementAndReturn.mock.calls[0][3] as Record<string, number>;

beforeEach(() => {
	mocks.checkLevelingAccess.mockReset().mockResolvedValue({ allowed: true });
	mocks.getLevelingConfig.mockReset().mockResolvedValue({
		settings: { enabled: true, curve: "dero", curveMultiplier: 1, maxLevel: null },
		weekStart: "sunday",
	});
	mocks.stage.mockReset();
	mocks.handleLevelCrossing.mockReset().mockResolvedValue(undefined);
	mocks.incrementAndReturn.mockReset().mockResolvedValue({ totalXp: 175 });
	mocks.periodBulkWrite.mockReset().mockResolvedValue(null);
	mocks.dailyCounts.clear();
	mocks.dailyIncrement.mockReset().mockImplementation(async (guildId: string, userId: string, day: string, amount: number) => {
		const key = `${guildId}:${userId}:${day}`;
		const next = (mocks.dailyCounts.get(key) ?? 0) + amount;
		mocks.dailyCounts.set(key, next);
		return next;
	});
});

describe("it never throws", () => {
	// The contract every call site relies on. Awards fire after a successful
	// primary action, inside collector callbacks with no caller left to catch
	// anything, so a throw here would break a working game at bookkeeping time.
	it("swallows a rejecting store", async () => {
		mocks.incrementAndReturn.mockRejectedValue(new Error("mongo is down"));
		await expect(awardXp(input())).resolves.toBeUndefined();
	});

	it("swallows a rejecting config read", async () => {
		mocks.getLevelingConfig.mockRejectedValue(new Error("mongo is down"));
		await expect(awardXp(input())).resolves.toBeUndefined();
	});

	it("swallows a rejecting announcer", async () => {
		mocks.handleLevelCrossing.mockRejectedValue(new Error("discord is down"));
		await expect(awardXp(input())).resolves.toBeUndefined();
	});

	it("swallows a failing period write without losing the lifetime award", async () => {
		// Period rows are derivable and back the weekly board; the lifetime total is
		// the durable truth. A failure in the disposable half must not undo the
		// durable one.
		mocks.periodBulkWrite.mockRejectedValue(new Error("mongo is down"));
		await expect(awardXp(input())).resolves.toBeUndefined();
		expect(mocks.incrementAndReturn).toHaveBeenCalledTimes(1);
		expect(mocks.handleLevelCrossing).toHaveBeenCalledTimes(1);
	});
});

// 2026-10 item 250 Phase 5: a Dero bot seat is not a member and earns nothing, at the
// one door every award passes, so no game's payout has to remember it.
describe("a Dero bot seat", () => {
	it("earns nothing and writes nothing, not even a game record", async () => {
		await awardXp(input({ userId: "dero-bot-red", game: "holdem", outcome: "won" }));
		expect(mocks.incrementAndReturn).not.toHaveBeenCalled();
		expect(mocks.stage).not.toHaveBeenCalled();
		expect(mocks.getLevelingConfig).not.toHaveBeenCalled();
	});
});

describe("the buffered / write-through fork", () => {
	it("STAGES a message award instead of writing it", async () => {
		// Messages arrive faster than a database round trip, which is the whole
		// reason the buffer exists.
		await awardXp(input({ source: "message", counters: { messages: 1 } }));

		expect(mocks.stage).toHaveBeenCalledTimes(1);
		expect(mocks.incrementAndReturn).not.toHaveBeenCalled();
		expect(mocks.stage.mock.calls[0][0]).toMatchObject({ guildId: "g1", userId: "u1", xp: 25 });
	});

	it("stamps the period keys at STAGE time, not at flush time", async () => {
		await awardXp(input({ source: "message" }));
		const staged = mocks.stage.mock.calls[0][0] as { week: string; month: string };
		expect(staged.week).toMatch(/^\d{4}-W\d{2}$/);
		expect(staged.month).toMatch(/^\d{4}-\d{2}$/);
	});

	it("STAGES an achievement award, for a completely different reason", async () => {
		// ⚠️ Not a performance decision like message xp. An achievement's bonus is
		// granted from inside the flush's own achievement pass, so writing it
		// through would let it cross a level in the SAME pass that granted it, and
		// a level change moves the metrics that pass was evaluating. Buffering
		// pushes it into the next flush window as an ordinary award. See the
		// recursion note in achievementEngine.ts.
		await awardXp(input({ source: "achievement", amount: 101 }));

		expect(mocks.stage).toHaveBeenCalledTimes(1);
		expect(mocks.incrementAndReturn).not.toHaveBeenCalled();
	});

	it.each(["reaction", "voice", "game", "gameRoom", "admin"] as const)(
		"writes %s through immediately",
		async (source) => {
			// A game result or an admin correction must be visible on the very next
			// /account, not up to a flush window later.
			await awardXp(input({ source }));
			expect(mocks.incrementAndReturn).toHaveBeenCalledTimes(1);
			expect(mocks.stage).not.toHaveBeenCalled();
		}
	);
});

describe("the per game record rides in the same write as the xp", () => {
	it("increments played AND the outcome in one $inc", async () => {
		// Two separate writes could partially fail and leave a member's total
		// disagreeing with their win/loss line, and /account renders both.
		await awardXp(input({ game: "diceroll", outcome: "won", amount: 100 }));

		expect(incrementsOf()).toEqual({
			totalXp: 100,
			"games.diceroll.played": 1,
			"games.diceroll.won": 1,
		});
	});

	it("maps the assist outcome onto the plural counter field", async () => {
		// "assist" is the outcome, "assists" is the count. Mapped once in awardXp so
		// no call site has to remember the difference.
		await awardXp(input({ game: "hangman", outcome: "assist" }));
		expect(incrementsOf()["games.hangman.assists"]).toBe(1);
	});

	it("records a draw", async () => {
		await awardXp(input({ game: "rps", outcome: "drawn" }));
		expect(incrementsOf()["games.rps.drawn"]).toBe(1);
	});

	it("counts a round played even with no outcome", async () => {
		await awardXp(input({ game: "diceroll" }));
		expect(incrementsOf()["games.diceroll.played"]).toBe(1);
	});

	it("carries lifetime counters alongside", async () => {
		await awardXp(input({ counters: { fortuneReadings: 1 } }));
		expect(incrementsOf()).toEqual({ totalXp: 25, fortuneReadings: 1 });
	});
});

describe("no op cases, which cost no database round trip", () => {
	it("does nothing for a zero award with no counters and no game", async () => {
		// Callers are encouraged to call unconditionally and let awardXp decide, so
		// the empty case must be genuinely free.
		await awardXp(input({ amount: 0 }));
		expect(mocks.incrementAndReturn).not.toHaveBeenCalled();
		expect(mocks.checkLevelingAccess).not.toHaveBeenCalled();
	});

	it("still writes a counter only award", async () => {
		await awardXp(input({ amount: 0, counters: { voiceMinutes: 3 } }));
		expect(incrementsOf()).toEqual({ voiceMinutes: 3 });
	});

	it("writes nothing when the guild has leveling disabled", async () => {
		mocks.getLevelingConfig.mockResolvedValue({ settings: { enabled: false }, weekStart: "sunday" });
		await awardXp(input());
		expect(mocks.incrementAndReturn).not.toHaveBeenCalled();
		expect(mocks.stage).not.toHaveBeenCalled();
	});

	it("writes nothing when the guild has no config row at all", async () => {
		mocks.getLevelingConfig.mockResolvedValue(null);
		await awardXp(input());
		expect(mocks.incrementAndReturn).not.toHaveBeenCalled();
	});

	it("writes nothing when the entitlement gate denies", async () => {
		mocks.checkLevelingAccess.mockResolvedValue({ allowed: false, reason: "tier" });
		await awardXp(input());
		expect(mocks.incrementAndReturn).not.toHaveBeenCalled();
	});

	it("ignores a negative or non finite amount rather than running a total backwards", async () => {
		await awardXp(input({ amount: -500 }));
		await awardXp(input({ amount: Number.NaN }));
		expect(mocks.incrementAndReturn).not.toHaveBeenCalled();
	});
});

describe("level crossing", () => {
	it("derives the previous total by subtraction, with no second read", async () => {
		// $inc is atomic and server side, so the returned post increment document is
		// the truth and the old total is exactly it minus what was awarded.
		mocks.incrementAndReturn.mockResolvedValue({ totalXp: 964 });
		await awardXp(input({ amount: 100 }));

		expect(mocks.handleLevelCrossing).toHaveBeenCalledWith(
			expect.objectContaining({ oldTotalXp: 864, newTotalXp: 964 })
		);
	});

	it("passes the source channel through for announceMode current", async () => {
		await awardXp(input({ channelId: "c-general" }));
		expect(mocks.handleLevelCrossing.mock.calls[0][0]).toMatchObject({ sourceChannelId: "c-general" });
	});
});

describe("the duplicate key retry", () => {
	it("retries ONCE on 11000 and succeeds, because the row now exists", async () => {
		// Two concurrent upserts on a missing key can both attempt an insert and one
		// loses (mongoose issue 7183). The unique { guildId, userId } index is what
		// turns that race into this recoverable error instead of two rows.
		const duplicate = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
		mocks.incrementAndReturn.mockRejectedValueOnce(duplicate).mockResolvedValueOnce({ totalXp: 175 });

		await awardXp(input());

		expect(mocks.incrementAndReturn).toHaveBeenCalledTimes(2);
		expect(mocks.handleLevelCrossing).toHaveBeenCalledTimes(1);
	});

	it("gives up after the retry rather than looping", async () => {
		const duplicate = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
		mocks.incrementAndReturn.mockRejectedValue(duplicate);

		await expect(awardXp(input())).resolves.toBeUndefined();
		expect(mocks.incrementAndReturn).toHaveBeenCalledTimes(2);
		expect(mocks.handleLevelCrossing).not.toHaveBeenCalled();
	});

	it("does not retry an error that is not a duplicate key", async () => {
		mocks.incrementAndReturn.mockRejectedValue(new Error("something else entirely"));
		await expect(awardXp(input())).resolves.toBeUndefined();
		expect(mocks.incrementAndReturn).toHaveBeenCalledTimes(1);
	});
});

// ── the daily cap (the 1.7.0 test fixes, item 5) ───────────────────────────
// 50 XP a member a server a Central day, shared by message, reaction and soloLuck.
// Every case drives the real awardXp against the in memory XpDaily fake above, so
// what is pinned is the arithmetic and the wiring together, not a mocked answer.
describe("the daily cap", () => {
	const stagedXp = (call: number): number => (mocks.stage.mock.calls[call][0] as { xp: number }).xp;

	afterEach(() => {
		vi.useRealTimers();
	});

	it("pays only what is left: 49 then 2 gives 1, then nothing", async () => {
		await awardXp(input({ source: "message", amount: 49 }));
		await awardXp(input({ source: "reaction", amount: 2 }));
		await awardXp(input({ source: "soloLuck", amount: 3 }));

		expect(stagedXp(0)).toBe(49);
		// The reaction wrote through with the trimmed amount, not the offered one.
		expect(mocks.incrementAndReturn).toHaveBeenCalledTimes(1);
		expect(incrementsOf()).toEqual({ totalXp: 1 });
		// At zero remaining with nothing else to record, awardXp writes nothing at all.
		expect(mocks.stage).toHaveBeenCalledTimes(1);
	});

	it("shares one allowance across the three capped sources, buffered or not", async () => {
		await awardXp(input({ source: "soloLuck", amount: 30 }));
		await awardXp(input({ source: "message", amount: 30 }));

		expect(stagedXp(0)).toBe(20);
	});

	it("keeps counting a message at the cap, because the counter is not pay", async () => {
		await awardXp(input({ source: "message", amount: 50 }));
		await awardXp(input({ source: "message", amount: 1, counters: { messages: 1 } }));

		expect(mocks.stage).toHaveBeenCalledTimes(2);
		expect(mocks.stage.mock.calls[1][0]).toMatchObject({ xp: 0, counters: { messages: 1 } });
	});

	it("counts per member and per server", async () => {
		await awardXp(input({ source: "message", amount: 50 }));
		await awardXp(input({ source: "message", amount: 5, userId: "u2" }));
		await awardXp(input({ source: "message", amount: 5, guildId: "g2" }));

		expect(stagedXp(1)).toBe(5);
		expect(stagedXp(2)).toBe(5);
	});

	it("resets at midnight Central, not at midnight UTC", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// 18:59 Central on 23 October: fill the day.
		vi.setSystemTime(new Date("2026-10-23T23:59:00Z"));
		await awardXp(input({ source: "message", amount: 50 }));
		// 19:30 Central, past UTC midnight but the SAME Central day: still capped.
		vi.setSystemTime(new Date("2026-10-24T00:30:00Z"));
		await awardXp(input({ source: "message", amount: 5 }));
		// 00:10 Central on 24 October: a new day, a fresh 50.
		vi.setSystemTime(new Date("2026-10-24T05:10:00Z"));
		await awardXp(input({ source: "message", amount: 5 }));

		expect(mocks.stage).toHaveBeenCalledTimes(2);
		expect(stagedXp(1)).toBe(5);
		expect(mocks.dailyIncrement.mock.calls.map((call) => call[2])).toEqual(["2026-10-23", "2026-10-23", "2026-10-24"]);
	});

	it("survives a restart, because the count is the store's and not awardXp's", async () => {
		await awardXp(input({ source: "message", amount: 49 }));

		// A fresh awardXp module is a fresh process as far as awardXp can tell: any
		// count it had kept in memory is gone. Only the store keeps the 49.
		vi.resetModules();
		const { awardXp: awardXpAfterRestart } = await import("./awardXp.js");
		await awardXpAfterRestart(input({ source: "message", amount: 2 }));

		expect(stagedXp(1)).toBe(1);
	});

	it.each(["voice", "game", "gameRoom", "achievement", "admin"] as const)(
		"pays %s in full past the cap and never touches the counter",
		async (source) => {
			await awardXp(input({ source: "message", amount: 50 }));
			mocks.dailyIncrement.mockClear();

			await awardXp(input({ source, amount: 120 }));

			expect(mocks.dailyIncrement).not.toHaveBeenCalled();
			const paid =
				source === "achievement" ? stagedXp(1) : (mocks.incrementAndReturn.mock.calls[0][3] as { totalXp: number }).totalXp;
			expect(paid).toBe(120);
		}
	);

	it("writes soloLuck through rather than staging it", async () => {
		await awardXp(input({ source: "soloLuck", amount: 3 }));

		expect(mocks.stage).not.toHaveBeenCalled();
		expect(incrementsOf()).toEqual({ totalXp: 3 });
	});

	it("retries the counter once on a duplicate key race", async () => {
		const duplicate = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
		mocks.dailyIncrement.mockRejectedValueOnce(duplicate);

		await awardXp(input({ source: "message", amount: 4 }));

		expect(mocks.dailyIncrement).toHaveBeenCalledTimes(2);
		expect(stagedXp(0)).toBe(4);
	});

	it("drops the award rather than paying past the cap when the counter cannot be read", async () => {
		mocks.dailyIncrement.mockRejectedValue(new Error("mongo is down"));

		await expect(awardXp(input({ source: "reaction", amount: 1 }))).resolves.toBeUndefined();
		expect(mocks.incrementAndReturn).not.toHaveBeenCalled();
	});
});
