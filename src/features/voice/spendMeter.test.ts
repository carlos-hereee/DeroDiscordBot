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

// The ceiling comes from the platform server through serverPlanAccess; the fake
// answers whatever a case sets, uncovered at $2 by default.
const access = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@features/entitlements/serverPlanAccess.js", () => ({ resolveServerPlanAccess: access.resolve }));

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

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { tryReserve, refund, monthKey, currentMonthCents } from "./spendMeter.js";

const rowKey = (guildId: string, month: string): string => `${guildId}|${month}`;
const OCTOBER = new Date(Date.UTC(2026, 9, 14, 12));
const NOVEMBER = new Date(Date.UTC(2026, 10, 1, 0, 0, 1));

// The guild's ceiling from the server, with a config row carrying the schema
// seed, which the meter ignores. A cap of 0 is stored instead, since 0 is the
// one stored value the meter reads (the kill switch).
function capUsd(usd: number): void {
	if (usd === 0) {
		mocks.findByGuildId.mockResolvedValue({ monthlyCapUsd: 0 });
		return;
	}
	mocks.findByGuildId.mockResolvedValue({ monthlyCapUsd: BOT_CONSTANTS.DERO_VOICE_DEFAULT_CAP_USD });
	access.resolve.mockResolvedValue({ covered: false, voiceCeilingUsd: usd });
}

beforeEach(() => {
	mocks.rows.clear();
	mocks.findByGuildId.mockReset();
	access.resolve.mockReset().mockResolvedValue({ covered: false, voiceCeilingUsd: 2 });
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

	it("meters a guild with no config row against the server's ceiling", async () => {
		mocks.findByGuildId.mockResolvedValue(null);
		expect((await tryReserve("g1", 200, { now: OCTOBER })).status).toBe("ok");
		expect((await tryReserve("g1", 1, { now: OCTOBER })).status).toBe("capReached");
	});

	// The ceiling is the server's (2026-10 item 262): $2 uncovered, $5 covered. A
	// stored cap is read only as the 0 kill switch, because persisted rows carry
	// the old $5 schema seed and must not outrank an uncovered guild's $2.
	it("refuses everything at a stored 0, without asking the server", async () => {
		mocks.findByGuildId.mockResolvedValue({ monthlyCapUsd: 0 });
		access.resolve.mockResolvedValue({ covered: true, voiceCeilingUsd: 5 });
		expect((await tryReserve("g1", 1, { now: OCTOBER })).status).toBe("capReached");
		expect(access.resolve).not.toHaveBeenCalled();
	});

	it("ignores a stored $5 on an uncovered guild and stops it at $2", async () => {
		expect(BOT_CONSTANTS.DERO_VOICE_DEFAULT_CAP_USD).toBe(2);
		mocks.findByGuildId.mockResolvedValue({ monthlyCapUsd: 5 });
		access.resolve.mockResolvedValue({ covered: false, voiceCeilingUsd: 2 });
		expect((await tryReserve("g1", 200, { now: OCTOBER })).status).toBe("ok");
		expect((await tryReserve("g1", 1, { now: OCTOBER })).status).toBe("capReached");
	});

	it("lets a covered guild spend up to $5", async () => {
		mocks.findByGuildId.mockResolvedValue({ monthlyCapUsd: 2 });
		access.resolve.mockResolvedValue({ covered: true, voiceCeilingUsd: 5 });
		expect((await tryReserve("g1", 500, { now: OCTOBER })).status).toBe("ok");
		expect((await tryReserve("g1", 1, { now: OCTOBER })).status).toBe("capReached");
		expect(access.resolve).toHaveBeenCalledWith("g1", OCTOBER);
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

describe("speech to text seconds", () => {
	it("passes the seconds to the store on a speech to text reservation", async () => {
		capUsd(25);
		const reserved = await tryReserve("g1", 1, { sttSeconds: 4, now: OCTOBER });
		expect(reserved).toEqual({ status: "ok", reservation: { guildId: "g1", month: "2026-10", cents: 1, ttsChars: 0, sttSeconds: 4 } });
		expect(mocks.reserve).toHaveBeenCalledWith("g1", "2026-10", 2500, { cents: 1, ttsChars: 0, sttSeconds: 4 });
	});

	it("refunds the seconds with the cents when the transcription failed", async () => {
		capUsd(25);
		const reserved = await tryReserve("g1", 1, { sttSeconds: 4, now: OCTOBER });
		if (reserved.status !== "ok") throw new Error("expected a reservation");
		await refund(reserved.reservation);
		expect(mocks.refund).toHaveBeenCalledWith("g1", "2026-10", { cents: 1, ttsChars: 0, sttSeconds: 4 });
	});

	it("leaves a speech out reservation exactly as it was, with no seconds field", async () => {
		capUsd(25);
		await tryReserve("g1", 2, { ttsChars: 300, now: OCTOBER });
		expect(mocks.reserve).toHaveBeenCalledWith("g1", "2026-10", 2500, { cents: 2, ttsChars: 300 });
	});
});
