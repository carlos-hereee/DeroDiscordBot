import { describe, it, expect, vi, beforeEach } from "vitest";

// ── spend meter ────────────────────────────────────────────────────────────
// The stores are thin and untested, so the fake below reproduces the ONE
// property the meter relies on: the reserve only matches while
// estimatedCents <= capCents - amount, and the check and the increment happen
// together. Everything else (the month key, the cap source, the refund's month)
// is the meter's own logic and is what these cases pin.

type Row = { estimatedCents: number; ttsChars: number };
type Usage = { cents: number; ttsChars: number };

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	findMonth: vi.fn(),
	ensureMonth: vi.fn(),
	reserve: vi.fn(),
	refund: vi.fn(),
	rows: new Map<string, { estimatedCents: number; ttsChars: number }>(),
}));

vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({
	deroVoiceConfigStore: { findByGuildId: mocks.findByGuildId },
}));
vi.mock("@db/stores/deroVoiceSpendStore.js", () => ({
	deroVoiceSpendStore: {
		findMonth: mocks.findMonth,
		ensureMonth: mocks.ensureMonth,
		reserve: mocks.reserve,
		refund: mocks.refund,
	},
}));

import { tryReserve, refund, monthKey, currentMonthCents } from "./spendMeter.js";

const rowKey = (guildId: string, month: string): string => `${guildId}|${month}`;
const OCTOBER = new Date(Date.UTC(2026, 9, 14, 12));
const NOVEMBER = new Date(Date.UTC(2026, 10, 1, 0, 0, 1));

function capUsd(usd: number | null): void {
	mocks.findByGuildId.mockResolvedValue(usd === null ? null : { monthlyCapUsd: usd });
}

beforeEach(() => {
	mocks.rows.clear();
	mocks.findByGuildId.mockReset();
	mocks.ensureMonth.mockReset().mockImplementation(async (guildId: string, month: string) => {
		if (!mocks.rows.has(rowKey(guildId, month))) mocks.rows.set(rowKey(guildId, month), { estimatedCents: 0, ttsChars: 0 });
	});
	mocks.reserve.mockReset().mockImplementation(async (guildId: string, month: string, capCents: number, usage: Usage) => {
		const row: Row | undefined = mocks.rows.get(rowKey(guildId, month));
		if (!row || row.estimatedCents > capCents - usage.cents) return null;
		row.estimatedCents += usage.cents;
		row.ttsChars += usage.ttsChars;
		return { guildId, month, sttSeconds: 0, ...row };
	});
	mocks.refund.mockReset().mockImplementation(async (guildId: string, month: string, usage: Usage) => {
		const row = mocks.rows.get(rowKey(guildId, month));
		if (!row) return;
		row.estimatedCents -= usage.cents;
		row.ttsChars -= usage.ttsChars;
	});
	mocks.findMonth.mockReset().mockImplementation(async (guildId: string, month: string) => mocks.rows.get(rowKey(guildId, month)) ?? null);
});

describe("monthKey", () => {
	it("is YYYY-MM, zero padded, in UTC", () => {
		expect(monthKey(OCTOBER)).toBe("2026-10");
		expect(monthKey(new Date(Date.UTC(2026, 0, 31, 23, 59)))).toBe("2026-01");
	});

	it("uses UTC even when the local date would still be the previous month", () => {
		// 00:30 UTC on Nov 1 is still Oct 31 in the Americas.
		expect(monthKey(new Date(Date.UTC(2026, 10, 1, 0, 30)))).toBe("2026-11");
	});
});

describe("tryReserve against the cap", () => {
	it("allows a reservation that lands exactly on the cap", async () => {
		capUsd(1); // 100 cents
		expect((await tryReserve("g1", 99, { now: OCTOBER })).status).toBe("ok");
		expect((await tryReserve("g1", 1, { now: OCTOBER })).status).toBe("ok");
		expect(mocks.rows.get(rowKey("g1", "2026-10"))?.estimatedCents).toBe(100);
	});

	it("refuses a reservation one cent over the cap, and writes nothing", async () => {
		capUsd(1);
		await tryReserve("g1", 100, { now: OCTOBER });
		const over = await tryReserve("g1", 1, { now: OCTOBER });

		expect(over.status).toBe("capReached");
		expect(mocks.rows.get(rowKey("g1", "2026-10"))?.estimatedCents).toBe(100);
	});

	it("refuses everything at a cap of 0, the second kill switch", async () => {
		capUsd(0);
		expect((await tryReserve("g1", 1, { now: OCTOBER })).status).toBe("capReached");
	});

	it("meters a guild with no config row against the default cap", async () => {
		capUsd(null);
		expect((await tryReserve("g1", 2500, { now: OCTOBER })).status).toBe("ok");
		expect((await tryReserve("g1", 1, { now: OCTOBER })).status).toBe("capReached");
	});

	it("counts the characters alongside the cents", async () => {
		capUsd(25);
		await tryReserve("g1", 3, { ttsChars: 600, now: OCTOBER });
		expect(mocks.rows.get(rowKey("g1", "2026-10"))?.ttsChars).toBe(600);
	});

	it("lets concurrent reservations through only up to the cap", async () => {
		capUsd(0.05); // 5 cents
		const results = await Promise.all(Array.from({ length: 8 }, () => tryReserve("g1", 1, { now: OCTOBER })));

		expect(results.filter((result) => result.status === "ok")).toHaveLength(5);
		expect(mocks.rows.get(rowKey("g1", "2026-10"))?.estimatedCents).toBe(5);
	});

	it("treats a lost race on creating the month row as success", async () => {
		capUsd(25);
		mocks.ensureMonth.mockImplementationOnce(async (guildId: string, month: string) => {
			mocks.rows.set(rowKey(guildId, month), { estimatedCents: 0, ttsChars: 0 });
			throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
		});
		expect((await tryReserve("g1", 1, { now: OCTOBER })).status).toBe("ok");
	});

	it("rethrows any other failure to create the month row", async () => {
		capUsd(25);
		mocks.ensureMonth.mockRejectedValueOnce(new Error("connection lost"));
		await expect(tryReserve("g1", 1, { now: OCTOBER })).rejects.toThrow("connection lost");
	});
});

describe("month rollover", () => {
	it("starts a new month at zero, whatever the last month spent", async () => {
		capUsd(1);
		await tryReserve("g1", 100, { now: OCTOBER });
		expect((await tryReserve("g1", 1, { now: OCTOBER })).status).toBe("capReached");

		expect((await tryReserve("g1", 100, { now: NOVEMBER })).status).toBe("ok");
		expect(mocks.rows.get(rowKey("g1", "2026-11"))?.estimatedCents).toBe(100);
	});
});

describe("refund", () => {
	it("gives the reservation back", async () => {
		capUsd(1);
		const reserved = await tryReserve("g1", 60, { ttsChars: 500, now: OCTOBER });
		if (reserved.status !== "ok") throw new Error("expected a reservation");
		await refund(reserved.reservation);

		expect(mocks.rows.get(rowKey("g1", "2026-10"))).toEqual({ estimatedCents: 0, ttsChars: 0 });
		expect((await tryReserve("g1", 100, { now: OCTOBER })).status).toBe("ok");
	});

	it("credits the month the reservation was taken in, even after the month turns", async () => {
		capUsd(25);
		const reserved = await tryReserve("g1", 4, { now: OCTOBER });
		if (reserved.status !== "ok") throw new Error("expected a reservation");
		await refund(reserved.reservation);

		expect(mocks.refund).toHaveBeenCalledWith("g1", "2026-10", { cents: 4, ttsChars: 0 });
	});

	it("never throws, so it cannot mask the provider error it follows", async () => {
		mocks.refund.mockRejectedValueOnce(new Error("connection lost"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expect(refund({ guildId: "g1", month: "2026-10", cents: 3, ttsChars: 600 })).resolves.toBeUndefined();
		warn.mockRestore();
	});
});

describe("currentMonthCents", () => {
	it("reads this month's estimate, and 0 when nothing was spent", async () => {
		capUsd(25);
		expect(await currentMonthCents("g1", OCTOBER)).toBe(0);
		await tryReserve("g1", 7, { now: OCTOBER });
		expect(await currentMonthCents("g1", OCTOBER)).toBe(7);
	});
});
