import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

// ── xpWriter ───────────────────────────────────────────────────────────────
// Three properties, and every one of them is invisible at the call site:
//   ① the cooldown claim is race safe because it never yields,
//   ② the flush swaps its map BEFORE awaiting, so nothing staged mid flush is
//     double counted or dropped,
//   ③ the cooldown map is bounded.
// None of these can be observed through a listener, and all three fail silently
// when wrong: ① double awards, ② lost or duplicated xp, ③ a slow memory leak.

const mocks = vi.hoisted(() => ({
	memberBulkWrite: vi.fn(),
	periodBulkWrite: vi.fn(),
	findManyInGuild: vi.fn(),
	handleLevelCrossing: vi.fn(),
}));

vi.mock("@db/stores/memberLevelStore.js", () => ({
	memberLevelStore: { bulkWrite: mocks.memberBulkWrite, findManyInGuild: mocks.findManyInGuild },
}));
vi.mock("@db/stores/xpPeriodStore.js", () => ({
	xpPeriodStore: { bulkWrite: mocks.periodBulkWrite },
}));
vi.mock("./levelUpAnnouncer.js", () => ({ handleLevelCrossing: mocks.handleLevelCrossing }));

import {
	_clearXpWriter,
	_cooldownSize,
	_pendingSize,
	claimCooldown,
	flushNow,
	releaseCooldown,
	stage,
	startXpWriter,
	stopXpWriter,
	sweepCooldowns,
} from "./xpWriter.js";

const award = (overrides: Partial<Parameters<typeof stage>[0]> = {}) => ({
	guildId: "g1",
	userId: "u1",
	username: "silent",
	xp: 25,
	counters: { messages: 1 } as Record<string, number>,
	week: "2026-W32",
	month: "2026-08",
	...overrides,
});

beforeEach(() => {
	_clearXpWriter();
	stopXpWriter();
	mocks.memberBulkWrite.mockReset().mockResolvedValue(null);
	mocks.periodBulkWrite.mockReset().mockResolvedValue(null);
	mocks.findManyInGuild.mockReset().mockResolvedValue([]);
	mocks.handleLevelCrossing.mockReset().mockResolvedValue(undefined);
});

describe("① the cooldown claim", () => {
	it("lets exactly ONE of two claims in the same tick through", () => {
		// The entire race defense for the common case. Two messages from one member
		// in the same tick: the second sees the first's write because the claim
		// never yields the event loop between its read and its write.
		const results = [claimCooldown("g1:u1:message", 60_000, 1_000), claimCooldown("g1:u1:message", 60_000, 1_000)];
		expect(results).toEqual([true, false]);
	});

	it("blocks for the whole window and opens on the boundary", () => {
		expect(claimCooldown("k", 60_000, 0)).toBe(true);
		expect(claimCooldown("k", 60_000, 59_999)).toBe(false);
		expect(claimCooldown("k", 60_000, 60_000)).toBe(true);
	});

	it("keys separately per member and per source, so the three sources never share a window", () => {
		// T6: message, reaction and voice each keep their own cooldown. A shared one
		// would mean reacting blocked chatting.
		expect(claimCooldown("g1:u1:message", 60_000, 0)).toBe(true);
		expect(claimCooldown("g1:u1:reaction", 60_000, 0)).toBe(true);
		expect(claimCooldown("g1:u2:message", 60_000, 0)).toBe(true);
		expect(claimCooldown("g2:u1:message", 60_000, 0)).toBe(true);
		expect(_cooldownSize()).toBe(4);
	});

	it("gives a claim back when the award it was taken for did not happen", () => {
		// The reaction path claims before a guard that can still reject, so without
		// this a rejected reaction would burn the member's window for nothing.
		expect(claimCooldown("k", 60_000, 0)).toBe(true);
		releaseCooldown("k");
		expect(claimCooldown("k", 60_000, 1)).toBe(true);
	});

	it("is synchronous, which is the property that makes it safe", () => {
		// Stated as an assertion so a refactor to async fails here rather than
		// silently reopening the race in production.
		expect(claimCooldown("sync-probe", 1_000, 0)).not.toBeInstanceOf(Promise);
	});
});

describe("② the write buffer", () => {
	it("accumulates repeat awards for one member into one entry", () => {
		stage(award({ xp: 25 }));
		stage(award({ xp: 30 }));
		expect(_pendingSize()).toBe(1);
	});

	it("keeps a member's awards in DIFFERENT periods apart", () => {
		// An award earned at 23:59:59 on a Saturday must land in that week even if
		// the flush carrying it runs three seconds later in the next one. There is
		// no reset job to paper over a misattribution.
		stage(award({ week: "2026-W32" }));
		stage(award({ week: "2026-W33" }));
		expect(_pendingSize()).toBe(2);
	});

	it("does not hold the caller's counters object", () => {
		// A caller reusing one literal across awards must not be able to mutate what
		// is already staged.
		const counters = { messages: 1 };
		stage(award({ counters }));
		counters.messages = 999;
		stage(award({ counters: { messages: 1 } }));

		void flushNow();
		const ops = mocks.memberBulkWrite.mock.calls[0]?.[0] as Array<{ updateOne: { update: { $inc: Record<string, number> } } }>;
		expect(ops?.[0].updateOne.update.$inc.messages).toBe(2);
	});

	it("batches every staged member into ONE bulkWrite", async () => {
		stage(award({ userId: "u1" }));
		stage(award({ userId: "u2" }));
		stage(award({ userId: "u3" }));

		await flushNow();

		expect(mocks.memberBulkWrite).toHaveBeenCalledTimes(1);
		expect(mocks.memberBulkWrite.mock.calls[0][0]).toHaveLength(3);
	});

	it("writes BOTH period keys for every award", async () => {
		stage(award());
		await flushNow();

		const ops = mocks.periodBulkWrite.mock.calls[0][0] as Array<{ updateOne: { filter: { period: string } } }>;
		expect(ops.map((op) => op.updateOne.filter.period).sort()).toEqual(["2026-08", "2026-W32"]);
	});

	it("uses $inc and upsert, never a read then a write", async () => {
		stage(award({ xp: 25, counters: { messages: 1, reactionsGiven: 2 } }));
		await flushNow();

		const op = mocks.memberBulkWrite.mock.calls[0][0][0] as {
			updateOne: { update: { $inc: Record<string, number> }; upsert: boolean };
		};
		expect(op.updateOne.upsert).toBe(true);
		expect(op.updateOne.update.$inc).toEqual({ totalXp: 25, messages: 1, reactionsGiven: 2 });
	});

	it("SWAPS the pending map before awaiting, so a mid flush award is not lost", async () => {
		// The single most important ordering in the file. If the map were cleared
		// after the await, everything staged during the write would be dropped; if
		// it were read after, everything would be written twice.
		stage(award({ userId: "u1" }));
		const inFlight = flushNow();
		stage(award({ userId: "u2" }));

		await inFlight;

		// u1 went out in this flush; u2 survived into the next window.
		expect(mocks.memberBulkWrite.mock.calls[0][0]).toHaveLength(1);
		expect(_pendingSize()).toBe(1);
	});

	it("drains to empty and is a no op when nothing is staged", async () => {
		await flushNow();
		expect(mocks.memberBulkWrite).not.toHaveBeenCalled();

		stage(award());
		await flushNow();
		expect(_pendingSize()).toBe(0);
	});

	it("does NOT re-stage a failed batch", async () => {
		// A bulkWrite that failed part way has already applied some of its ops, so
		// replaying the whole batch would double count every member it reached.
		// Losing one window of xp is recoverable by playing more; silently
		// inflating a leaderboard is not.
		mocks.memberBulkWrite.mockRejectedValueOnce(new Error("mongo is having a day"));
		stage(award());

		await expect(flushNow()).resolves.toBeUndefined();
		expect(_pendingSize()).toBe(0);
	});
});

describe("level crossing dispatch", () => {
	const client = {} as Client;

	it("hands the announcer the exact before and after totals", async () => {
		mocks.findManyInGuild.mockResolvedValue([{ userId: "u1", username: "silent", totalXp: 175 }]);
		startXpWriter(client, { flushIntervalMs: 60_000, sweepIntervalMs: 60_000 });

		stage(award({ xp: 25 }));
		await flushNow();

		expect(mocks.handleLevelCrossing).toHaveBeenCalledWith(
			expect.objectContaining({ guildId: "g1", userId: "u1", oldTotalXp: 150, newTotalXp: 175 })
		);
	});

	it("sums a member's awards across periods into ONE crossing check", async () => {
		// A member who straddled a week boundary in one flush window still only
		// crossed a level once, so the announcer must see one call with the total.
		mocks.findManyInGuild.mockResolvedValue([{ userId: "u1", username: "silent", totalXp: 200 }]);
		startXpWriter(client, { flushIntervalMs: 60_000, sweepIntervalMs: 60_000 });

		stage(award({ xp: 25, week: "2026-W32" }));
		stage(award({ xp: 25, week: "2026-W33" }));
		await flushNow();

		expect(mocks.handleLevelCrossing).toHaveBeenCalledTimes(1);
		expect(mocks.handleLevelCrossing.mock.calls[0][0]).toMatchObject({ oldTotalXp: 150, newTotalXp: 200 });
	});

	it("reads back once per guild rather than once per member", async () => {
		mocks.findManyInGuild.mockResolvedValue([]);
		startXpWriter(client, { flushIntervalMs: 60_000, sweepIntervalMs: 60_000 });

		stage(award({ userId: "u1" }));
		stage(award({ userId: "u2" }));
		stage(award({ guildId: "g2", userId: "u3" }));
		await flushNow();

		expect(mocks.findManyInGuild).toHaveBeenCalledTimes(2);
	});

	it("skips the read back entirely when no client is bound", async () => {
		// stopXpWriter clears the client, which is the state a test or a shutdown
		// leaves behind. The flush must still write, just not try to announce.
		stage(award());
		await flushNow();

		expect(mocks.memberBulkWrite).toHaveBeenCalledTimes(1);
		expect(mocks.findManyInGuild).not.toHaveBeenCalled();
	});
});

describe("③ the sweep", () => {
	it("drops entries older than the longest configurable cooldown and keeps the rest", () => {
		const hour = 3_600_000;
		claimCooldown("old", 1_000, 0);
		claimCooldown("fresh", 1_000, hour);
		expect(_cooldownSize()).toBe(2);

		const removed = sweepCooldowns(hour);
		expect(removed).toBe(1);
		expect(_cooldownSize()).toBe(1);
		// The survivor is still claimable-blocking, which is the point of keeping it.
		expect(claimCooldown("fresh", 1_000, hour + 500)).toBe(false);
	});

	it("is safe to run on an empty map", () => {
		expect(sweepCooldowns(Date.now())).toBe(0);
	});
});

describe("lifecycle", () => {
	it("is idempotent, so a second start does not double the flush", () => {
		const client = {} as Client;
		startXpWriter(client, { flushIntervalMs: 60_000, sweepIntervalMs: 60_000 });
		expect(() => startXpWriter(client, { flushIntervalMs: 60_000, sweepIntervalMs: 60_000 })).not.toThrow();
		stopXpWriter();
	});
});
