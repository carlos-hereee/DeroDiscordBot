import { describe, it, expect } from "vitest";
import { currentUtcMonth, previousUtcMonth, utcMonthKey } from "./utcMonthKey.js";

// ── utcMonthKey ────────────────────────────────────────────────────────────
// The month keys every ratings collection buckets by, and the month the monthly
// arcade post looks back on. The edges that matter are UTC midnight on the last
// day of a month and the January rollover into the year before.

describe("utcMonthKey", () => {
	it("zero pads the month and reads UTC, not the host's zone", () => {
		expect(utcMonthKey(new Date("2026-03-05T12:00:00Z"))).toBe("2026-03");
		expect(utcMonthKey(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
		expect(utcMonthKey(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
	});
});

describe("currentUtcMonth", () => {
	it("answers the whole month a moment falls in, the preview's month", () => {
		expect(currentUtcMonth(new Date("2026-10-23T17:00:00Z"))).toEqual({
			key: "2026-10",
			start: new Date("2026-10-01T00:00:00Z"),
			end: new Date("2026-11-01T00:00:00Z"),
		});
	});

	it("carries December's end on into January of the next year", () => {
		expect(currentUtcMonth(new Date("2026-12-31T23:59:59Z")).end).toEqual(new Date("2027-01-01T00:00:00Z"));
	});
});

describe("previousUtcMonth", () => {
	it("answers the whole month before, start inclusive and end exclusive", () => {
		expect(previousUtcMonth(new Date("2026-11-01T14:05:00Z"))).toEqual({
			key: "2026-10",
			start: new Date("2026-10-01T00:00:00Z"),
			end: new Date("2026-11-01T00:00:00Z"),
		});
	});

	it("carries January back into December of the year before", () => {
		expect(previousUtcMonth(new Date("2027-01-01T15:05:00Z"))).toEqual({
			key: "2026-12",
			start: new Date("2026-12-01T00:00:00Z"),
			end: new Date("2027-01-01T00:00:00Z"),
		});
	});
});
