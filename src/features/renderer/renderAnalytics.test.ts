import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── render analytics ─────────────────────────────────────────────────
// Pins 2026-10 item 244 Phase 1's write path and report: the UTC month key, which
// counters each outcome moves, that avatar rows carry no identity, the kill
// switch, the pending cap, that a failing store never reaches the caller, and
// the hit rate and sizing hint thresholds. The store is mocked (bot rule 6: no
// live database in a unit test), and fake timers drive setImmediate and the
// once a minute summary.

const analyticsSwitch = vi.hoisted(() => ({ enabled: true }));

vi.mock("@utils/config.js", () => ({
	get renderAnalyticsEnabled() {
		return analyticsSwitch.enabled;
	},
	discordBotS3Enabled: false,
}));

vi.mock("@utils/aws/index.js", () => ({
	putObject: vi.fn(async () => undefined),
	getObjectBytes: vi.fn(async () => null),
}));

vi.mock("@db/stores/renderAnalyticsStore.js", () => ({
	renderAnalyticsStore: {
		recordLookup: vi.fn(async () => undefined),
		summarizeBySurface: vi.fn(async () => []),
		topKeys: vi.fn(async () => []),
	},
}));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { renderAnalyticsStore, type RenderLookupWrite, type SurfaceTotals } from "@db/stores/renderAnalyticsStore.js";
import type { Image } from "./canvasModule.js";
import { createAvatarCache, type AvatarLookup } from "./avatarCache.js";
import {
	buildRenderAnalyticsReport,
	monthKeyOf,
	monthsForPeriod,
	recordAvatarLookup,
	recordCardLookup,
	renderAnalyticsHealth,
	resetRenderAnalyticsCounters,
	sizingHintOf,
} from "./renderAnalytics.js";

const LIMITS = BOT_CONSTANTS.RENDER_ANALYTICS;
const recordMock = vi.mocked(renderAnalyticsStore.recordLookup);
const summarizeMock = vi.mocked(renderAnalyticsStore.summarizeBySurface);
const topKeysMock = vi.mocked(renderAnalyticsStore.topKeys);

const CARD_HASH = "a".repeat(64);
const CARD_KEY = `discord-bot/renders/account/3/${CARD_HASH}.png`;

function cardLookup(outcome: "memory" | "s3" | "drawn") {
	return { kind: "account", version: 3, key: CARD_KEY, outcome, bytes: 4096 } as const;
}

function writeAt(index: number): RenderLookupWrite {
	const call = recordMock.mock.calls[index];
	if (!call) throw new Error(`expected a store write at call ${index}`);
	return call[0];
}

// Runs the queued setImmediate callbacks and lets their awaited store calls settle.
async function flushWrites(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

function surfaceTotals(surface: string, hits: number, draws: number, s3Hits = 0): SurfaceTotals {
	return { surface, rows: 1, bytes: 1000, hits, memoryHits: hits - s3Hits, s3Hits, draws };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"] });
	vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
	analyticsSwitch.enabled = true;
	resetRenderAnalyticsCounters();
	recordMock.mockReset();
	recordMock.mockResolvedValue(undefined);
	summarizeMock.mockReset();
	summarizeMock.mockResolvedValue([]);
	topKeysMock.mockReset();
	topKeysMock.mockResolvedValue([]);
});

afterEach(() => {
	resetRenderAnalyticsCounters();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("month keys", () => {
	it("puts the last second of a month and the first second of the next in different UTC months", () => {
		expect(monthKeyOf(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
		expect(monthKeyOf(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
	});

	it("zero pads the month so months sort lexically", () => {
		expect(monthKeyOf(new Date("2027-01-15T00:00:00Z"))).toBe("2027-01");
	});

	it("reads last month across a year boundary, and all time as every month", () => {
		const january = new Date("2027-01-05T00:00:00Z");
		expect(monthsForPeriod("this-month", january)).toEqual(["2027-01"]);
		expect(monthsForPeriod("last-month", january)).toEqual(["2026-12"]);
		expect(monthsForPeriod("all-time", january)).toBeNull();
	});

	it("stamps a lookup with the UTC month it happened in", async () => {
		vi.setSystemTime(new Date("2026-10-31T23:59:59Z"));
		recordCardLookup(cardLookup("drawn"));
		vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
		recordCardLookup(cardLookup("drawn"));
		await flushWrites();

		expect(writeAt(0).month).toBe("2026-10");
		expect(writeAt(1).month).toBe("2026-11");
	});
});

describe("card lookups", () => {
	it("moves hits and memoryHits for a memory hit", async () => {
		recordCardLookup(cardLookup("memory"));
		await flushWrites();
		expect(writeAt(0).increments).toEqual({ hits: 1, memoryHits: 1 });
	});

	it("moves hits and s3Hits for an S3 hit", async () => {
		recordCardLookup(cardLookup("s3"));
		await flushWrites();
		expect(writeAt(0).increments).toEqual({ hits: 1, s3Hits: 1 });
	});

	it("moves draws for a drawn card, and names the row by key, surface, version and size", async () => {
		recordCardLookup(cardLookup("drawn"));
		await flushWrites();
		expect(writeAt(0)).toMatchObject({ cacheKey: CARD_KEY, surface: "account", version: 3, bytes: 4096, increments: { draws: 1 } });
	});

	it("does not write before the caller's own work is done", () => {
		recordCardLookup(cardLookup("memory"));
		expect(recordMock).not.toHaveBeenCalled();
	});
});

describe("avatar lookups", () => {
	it("writes surface avatar under avatar:<size> and nothing that identifies a member", async () => {
		recordAvatarLookup({ size: 128, outcome: "memory" });
		recordAvatarLookup({ size: 128, outcome: "fetched" });
		await flushWrites();

		expect(writeAt(0)).toMatchObject({ cacheKey: "avatar:128", surface: "avatar", version: 1, bytes: 0, increments: { hits: 1, memoryHits: 1 } });
		expect(writeAt(1).increments).toEqual({ draws: 1 });
		const written = JSON.stringify(recordMock.mock.calls);
		for (const forbidden of ["userId", "guildId", "username", "avatarHash"]) expect(written).not.toContain(forbidden);
	});

	it("reports a download as fetched and a repeat or a shared download as memory, with no user id", async () => {
		const lookups: AvatarLookup[] = [];
		const cache = createAvatarCache({
			download: async () => Buffer.from("png"),
			decode: async () => ({}) as Image,
			onLookup: (lookup) => lookups.push(lookup),
		});
		const request = { userId: "123456", avatarHash: "abc", size: 64 as const, url: "https://cdn.discordapp.com/avatars/123456/abc.png?size=64" };

		await Promise.all([cache.fetch(request), cache.fetch(request)]);
		await cache.fetch(request);

		expect(lookups).toEqual([
			{ size: 64, outcome: "fetched" },
			{ size: 64, outcome: "memory" },
			{ size: 64, outcome: "memory" },
		]);
	});
});

describe("kill switch", () => {
	it("writes nothing when RENDER_ANALYTICS_ENABLED is off", async () => {
		analyticsSwitch.enabled = false;
		recordCardLookup(cardLookup("drawn"));
		recordAvatarLookup({ size: 64, outcome: "fetched" });
		await flushWrites();

		expect(recordMock).not.toHaveBeenCalled();
		expect(renderAnalyticsHealth()).toEqual({ pending: 0, dropped: 0, failed: 0 });
	});
});

describe("pending cap", () => {
	it("drops and counts the lookup past the cap while earlier writes hang", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		recordMock.mockImplementation(() => new Promise<void>(() => undefined));

		for (let index = 0; index <= LIMITS.MAX_PENDING_WRITES; index++) recordCardLookup(cardLookup("drawn"));
		await flushWrites();

		expect(LIMITS.MAX_PENDING_WRITES).toBe(500);
		expect(recordMock).toHaveBeenCalledTimes(500);
		expect(renderAnalyticsHealth()).toEqual({ pending: 500, dropped: 1, failed: 0 });
		await vi.advanceTimersByTimeAsync(LIMITS.SUMMARY_INTERVAL_MS);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe("store failures", () => {
	it("leaves the caller unaffected by a throwing and a rejecting store, and logs one summary line", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		recordMock
			.mockImplementationOnce(() => {
				throw new Error("sync boom");
			})
			.mockRejectedValueOnce(new Error("async boom"));

		expect(() => recordCardLookup(cardLookup("memory"))).not.toThrow();
		expect(() => recordAvatarLookup({ size: 64, outcome: "fetched" })).not.toThrow();
		await flushWrites();

		expect(renderAnalyticsHealth()).toEqual({ pending: 0, dropped: 0, failed: 2 });
		expect(warn).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(LIMITS.SUMMARY_INTERVAL_MS);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toMatch(/^\[render-analytics\].*2 writes to RenderAnalytics failed/);
	});
});

describe("report", () => {
	it("computes hit rates and the three sizing hints at and around their thresholds", () => {
		expect(LIMITS.SIZING_MIN_RENDERS).toBe(50);
		expect(sizingHintOf(91, 9)).toBe("evergreen");
		expect(sizingHintOf(90, 10)).toBe("none");
		expect(sizingHintOf(9, 91)).toBe("long-tail");
		expect(sizingHintOf(10, 90)).toBe("none");
		expect(sizingHintOf(49, 0)).toBe("none");
		expect(sizingHintOf(0, 49)).toBe("none");
	});

	it("builds per surface lines, the memory tier and the top keys for this month", async () => {
		summarizeMock.mockResolvedValue([surfaceTotals("account", 91, 9), surfaceTotals("hangman", 9, 91), surfaceTotals("level-up", 10, 5)]);
		topKeysMock.mockResolvedValue([{ cacheKey: CARD_KEY, surface: "account", version: 3, hits: 91 }]);

		const report = await buildRenderAnalyticsReport({ period: "this-month" });

		expect(summarizeMock).toHaveBeenCalledWith(["2026-10"]);
		expect(topKeysMock).toHaveBeenCalledWith(["2026-10"], null, LIMITS.TOP_N);
		expect(report.surfaces.map(({ surface, hitRate, hint }) => ({ surface, hitRate, hint }))).toEqual([
			{ surface: "account", hitRate: 0.91, hint: "evergreen" },
			{ surface: "hangman", hitRate: 0.09, hint: "long-tail" },
			{ surface: "level-up", hitRate: 10 / 15, hint: "none" },
		]);
		expect(report.top).toEqual([{ surface: "account", version: 3, keyHash: CARD_HASH.slice(0, 12), hits: 91 }]);
		expect(report.memory).toMatchObject({ cardCapacity: 100, avatarCapacity: 500, growMemoryTier: false });
	});

	it("says grow the memory tier only when S3 hits pass 30 percent of all hits", async () => {
		summarizeMock.mockResolvedValue([surfaceTotals("account", 100, 0, 31)]);
		expect((await buildRenderAnalyticsReport({ period: "all-time" })).memory.growMemoryTier).toBe(true);

		summarizeMock.mockResolvedValue([surfaceTotals("account", 100, 0, 30)]);
		expect((await buildRenderAnalyticsReport({ period: "all-time" })).memory.growMemoryTier).toBe(false);
		expect(summarizeMock).toHaveBeenLastCalledWith(null);
	});

	it("narrows the lines and the top keys to one surface when asked", async () => {
		summarizeMock.mockResolvedValue([surfaceTotals("account", 5, 5), surfaceTotals("hangman", 1, 1)]);

		const report = await buildRenderAnalyticsReport({ period: "last-month", surface: "hangman" });

		expect(topKeysMock).toHaveBeenCalledWith(["2026-09"], "hangman", LIMITS.TOP_N);
		expect(report.surfaces.map((line) => line.surface)).toEqual(["hangman"]);
		expect(report.surfaces[0].hint).toBe("none");
	});
});
