import { describe, it, expect } from "vitest";
import { createLatencyLog } from "./turnLatency.js";

// ── turn latency ───────────────────────────────────────────────────────────
// The history /dero status reads: per guild, the most recent totals only, a
// true median (the mean of the middle two for an even count) and the slowest.

describe("createLatencyLog", () => {
	it("has nothing to say before the first turn", () => {
		expect(createLatencyLog().summary("g1")).toBeNull();
	});

	it("reports the median and the slowest, odd and even counts", () => {
		const log = createLatencyLog();
		[3000, 1000, 2000].forEach((ms) => log.record("g1", ms));
		expect(log.summary("g1")).toEqual({ count: 3, medianMs: 2000, slowestMs: 3000 });
		log.record("g1", 9000);
		expect(log.summary("g1")).toEqual({ count: 4, medianMs: 2500, slowestMs: 9000 });
	});

	it("keeps only the most recent totals, oldest out first", () => {
		const log = createLatencyLog(3);
		[50_000, 1000, 2000, 3000].forEach((ms) => log.record("g1", ms));
		expect(log.summary("g1")).toEqual({ count: 3, medianMs: 2000, slowestMs: 3000 });
	});

	it("keeps 50 by default", () => {
		const log = createLatencyLog();
		for (let index = 0; index < 60; index++) log.record("g1", index);
		expect(log.summary("g1")?.count).toBe(50);
	});

	it("keeps guilds apart and ignores a nonsense total", () => {
		const log = createLatencyLog();
		log.record("g1", 1000);
		log.record("g2", Number.NaN);
		log.record("g2", -5);
		expect(log.summary("g1")?.count).toBe(1);
		expect(log.summary("g2")).toBeNull();
	});
});
