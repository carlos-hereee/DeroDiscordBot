import { describe, it, expect } from "vitest";
import { monthKey, periodKeysFor, weekKey } from "./levelPeriod.js";

// Every Date below is built with the LOCAL-time constructor, matching how
// leaderboardWindow's rotation reads a date back (getDay/getMonth/getDate), so
// the suite is correct whatever timezone the runner sits in.
//
// The point of this file is the BOUNDARY behaviour. A period key that shifts by
// a day, or that splits one week into two labels, silently scatters a member's
// weekly xp across two rows and the standings quietly under report. There is no
// reset job to catch it, by design, so the key itself has to be right.

describe("weekKey", () => {
	it("labels the current week the way the plan documents it", () => {
		// 2026-08-11 is a Tuesday; the Sunday-anchored week begins 2026-08-09,
		// which is the 32nd week to begin in 2026.
		expect(weekKey(new Date(2026, 7, 11, 12, 0, 0), "sunday")).toBe("2026-W32");
	});

	it("holds steady across every day of one Sunday-anchored week", () => {
		// 2026-08-09 (Sun) through 2026-08-15 (Sat) are one week and must produce
		// one key. This is the assertion that actually protects the standings.
		const keys = new Set<string>();
		for (let day = 9; day <= 15; day += 1) {
			keys.add(weekKey(new Date(2026, 7, day, 6, 30, 0), "sunday"));
		}
		expect([...keys]).toEqual(["2026-W32"]);
	});

	it("rolls at the guild's configured weekStart, not at a fixed day", () => {
		const saturday = new Date(2026, 7, 15, 23, 59, 59, 999);
		const sunday = new Date(2026, 7, 16, 0, 0, 0, 0);

		// Sunday anchored: the roll happens between these two instants.
		expect(weekKey(saturday, "sunday")).toBe("2026-W32");
		expect(weekKey(sunday, "sunday")).toBe("2026-W33");

		// Monday anchored: the same two instants sit in the SAME week, because
		// that week does not end until Sunday night.
		expect(weekKey(saturday, "monday")).toBe(weekKey(sunday, "monday"));
	});

	it("separates the last millisecond of a week from the first of the next", () => {
		const lastMs = new Date(2026, 7, 15, 23, 59, 59, 999);
		const firstMs = new Date(2026, 7, 16, 0, 0, 0, 0);
		expect(weekKey(lastMs, "sunday")).not.toBe(weekKey(firstMs, "sunday"));
	});

	it("keeps a week that straddles New Year under ONE key", () => {
		// 2027-01-01 is a Friday, so the Sunday-anchored week containing it began
		// on 2026-12-27. Splitting that week would scatter one member's xp across
		// two rows for no reason a member could ever understand.
		const decemberSide = weekKey(new Date(2026, 11, 30, 12, 0, 0), "sunday");
		const januarySide = weekKey(new Date(2027, 0, 1, 12, 0, 0), "sunday");
		expect(januarySide).toBe(decemberSide);
		expect(januarySide.startsWith("2026-W")).toBe(true);
	});

	it("gives every year a W01 rather than starting some years at W02", () => {
		// The first week to BEGIN in 2027 starts Sunday 2027-01-03. Numbering from
		// the last week-start of the previous year instead would label it W02 and
		// leave 2027 with no W01 at all.
		expect(weekKey(new Date(2027, 0, 3, 9, 0, 0), "sunday")).toBe("2027-W01");
		expect(weekKey(new Date(2027, 0, 9, 9, 0, 0), "sunday")).toBe("2027-W01");
		expect(weekKey(new Date(2027, 0, 10, 9, 0, 0), "sunday")).toBe("2027-W02");
	});

	it("zero pads the week number so keys sort lexically", () => {
		// XpPeriod is queried and displayed by this string, so "2026-W02" must not
		// sort after "2026-W10".
		expect(weekKey(new Date(2026, 0, 8, 9, 0, 0), "sunday")).toMatch(/^\d{4}-W\d{2}$/);
	});

	it("advances by exactly one across a DST transition", () => {
		// US DST springs forward on 2026-03-08, a Sunday, which is also a week
		// boundary under Sunday anchoring. A millisecond subtraction of local
		// dates would be an hour short here and could floor to the wrong week.
		expect(weekKey(new Date(2026, 2, 7, 12, 0, 0), "sunday")).toBe("2026-W09");
		expect(weekKey(new Date(2026, 2, 8, 12, 0, 0), "sunday")).toBe("2026-W10");
		expect(weekKey(new Date(2026, 2, 14, 12, 0, 0), "sunday")).toBe("2026-W10");
	});
});

describe("monthKey", () => {
	it("labels the calendar month, zero padded", () => {
		expect(monthKey(new Date(2026, 7, 11, 12, 0, 0), "sunday")).toBe("2026-08");
		expect(monthKey(new Date(2026, 0, 1, 0, 0, 0), "sunday")).toBe("2026-01");
		expect(monthKey(new Date(2026, 11, 31, 23, 59, 59), "sunday")).toBe("2026-12");
	});

	it("ignores weekStart, because a calendar month has no anchor day", () => {
		const moment = new Date(2026, 7, 11, 12, 0, 0);
		expect(monthKey(moment, "sunday")).toBe(monthKey(moment, "monday"));
	});

	it("separates the last millisecond of a month from the first of the next", () => {
		expect(monthKey(new Date(2026, 6, 31, 23, 59, 59, 999), "sunday")).toBe("2026-07");
		expect(monthKey(new Date(2026, 7, 1, 0, 0, 0, 0), "sunday")).toBe("2026-08");
	});
});

describe("periodKeysFor", () => {
	it("returns both keys for the same instant", () => {
		const moment = new Date(2026, 7, 11, 12, 0, 0);
		expect(periodKeysFor(moment, "sunday")).toEqual({ week: "2026-W32", month: "2026-08" });
	});

	it("can straddle a month boundary inside one week, which is legal and expected", () => {
		// 2026-08-01 is a Saturday, so this instant is in July's LAST week and in
		// August's month. Two rows, two different periods, one award. Nothing here
		// needs them to agree.
		const keys = periodKeysFor(new Date(2026, 7, 1, 12, 0, 0), "sunday");
		expect(keys.month).toBe("2026-08");
		expect(keys.week).toBe(weekKey(new Date(2026, 6, 28, 12, 0, 0), "sunday"));
	});
});
