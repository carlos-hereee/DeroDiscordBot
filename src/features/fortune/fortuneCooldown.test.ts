import { describe, it, expect, vi, beforeEach } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── fortuneCooldown (2026-10 item 254) ──────────────────────────────────────
// One reading per member per server every 22 hours, persisted. The store is swapped
// for an in memory table that keeps the real store's contract (a claim wins only when
// no reading falls inside the window; a restore only undoes its own claim), and that
// table stands in for the database, so it survives a module reload the way a row
// survives a deploy.

const db = vi.hoisted(() => ({ rows: new Map<string, Date>() }));

vi.mock("@db/stores/fortuneCooldownStore.js", () => {
	const key = (guildId: string, userId: string): string => `${guildId}:${userId}`;
	return {
		fortuneCooldownStore: {
			async claim(guildId: string, userId: string, cutoff: Date, now: Date) {
				const previous = db.rows.get(key(guildId, userId)) ?? null;
				if (previous && previous.getTime() > cutoff.getTime()) return { claimed: false };
				db.rows.set(key(guildId, userId), now);
				return { claimed: true, previousAt: previous };
			},
			async lastReadingAt(guildId: string, userId: string) {
				return db.rows.get(key(guildId, userId)) ?? null;
			},
			async restore(guildId: string, userId: string, claimedAt: Date, previousAt: Date | null) {
				if (db.rows.get(key(guildId, userId))?.getTime() !== claimedAt.getTime()) return;
				if (previousAt === null) db.rows.delete(key(guildId, userId));
				else db.rows.set(key(guildId, userId), previousAt);
			},
		},
	};
});

const HOUR = 60 * 60 * 1000;
const WINDOW = BOT_CONSTANTS.FORTUNE_COOLDOWN_HOURS * HOUR;
const START = new Date("2026-10-26T18:00:00Z");
const at = (offsetMs: number): Date => new Date(START.getTime() + offsetMs);

async function freshModule() {
	vi.resetModules();
	return import("./fortuneCooldown.js");
}

beforeEach(() => {
	db.rows.clear();
});

describe("the fortune cooldown", () => {
	it("is 22 hours, the owner's call", () => {
		expect(BOT_CONSTANTS.FORTUNE_COOLDOWN_HOURS).toBe(22);
	});

	it("refuses a second reading a minute short of 22 hours, naming when it is ready, and allows it at 22 hours", async () => {
		const { claimFortuneSlot } = await freshModule();
		expect((await claimFortuneSlot("g1", "u1", START)).ok).toBe(true);

		const early = await claimFortuneSlot("g1", "u1", at(WINDOW - 60_000));
		expect(early).toEqual({ ok: false, readyAt: at(WINDOW) });

		expect((await claimFortuneSlot("g1", "u1", at(WINDOW))).ok).toBe(true);
	});

	it("keeps the cooldown through a restart, because it lives in the store and not in the process", async () => {
		const before = await freshModule();
		expect((await before.claimFortuneSlot("g1", "u1", START)).ok).toBe(true);

		const after = await freshModule();
		expect((await after.claimFortuneSlot("g1", "u1", at(HOUR))).ok).toBe(false);
	});

	it("keeps two servers' cooldowns apart for the same member", async () => {
		const { claimFortuneSlot } = await freshModule();
		expect((await claimFortuneSlot("g1", "u1", START)).ok).toBe(true);
		expect((await claimFortuneSlot("g2", "u1", at(HOUR))).ok).toBe(true);
		expect((await claimFortuneSlot("g1", "u1", at(HOUR))).ok).toBe(false);
	});

	it("lets only one of two presses at once read", async () => {
		const { claimFortuneSlot } = await freshModule();
		const [first, second] = await Promise.all([claimFortuneSlot("g1", "u1", START), claimFortuneSlot("g1", "u1", START)]);
		expect([first.ok, second.ok].sort()).toEqual([false, true]);
	});

	it("gives the slot back after a reading that failed, restoring the previous reading's time", async () => {
		const { claimFortuneSlot, releaseFortuneSlot } = await freshModule();
		await claimFortuneSlot("g1", "u1", START);
		const tomorrow = await claimFortuneSlot("g1", "u1", at(WINDOW + HOUR));
		if (!tomorrow.ok) throw new Error("expected the next day's claim to win");

		await releaseFortuneSlot(tomorrow.slot);
		expect(db.rows.get("g1:u1")).toEqual(START);
		expect((await claimFortuneSlot("g1", "u1", at(WINDOW + 2 * HOUR))).ok).toBe(true);
	});

	it("keys a reading outside a server on dm", async () => {
		const { claimFortuneSlot } = await freshModule();
		await claimFortuneSlot(null, "u1", START);
		expect(db.rows.has("dm:u1")).toBe(true);
	});
});
