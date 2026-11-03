import { describe, it, expect } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { XP_SOURCES } from "./levelingTypes.js";
import { dailyCapDayKey, grantedUnderCap, isDailyCappedSource } from "./dailyXpCap.js";

// ── dailyXpCap ─────────────────────────────────────────────────────────────
// The pure half of the daily cap. awardXp.test.ts drives the wiring; this pins the
// owner's numbers and the two pieces of arithmetic everything else trusts.

describe("the cap's settings", () => {
	it("is 50 XP a day, counted in Central time", () => {
		expect(BOT_CONSTANTS.LEVELING.DAILY_XP_CAP).toBe(50);
		expect(BOT_CONSTANTS.LEVELING.DAILY_CAP_TIME_ZONE).toBe("America/Chicago");
		// One zone for the digest and the cap, never two strings that can drift.
		expect(BOT_CONSTANTS.LEVELING.DAILY_CAP_TIME_ZONE).toBe(BOT_CONSTANTS.LEVELING.WEEKLY_DIGEST_TIMEZONE);
	});

	it("covers message, reaction and soloLuck, and nothing else", () => {
		const capped = XP_SOURCES.filter((source) => isDailyCappedSource(source));
		expect(capped).toEqual(["message", "reaction", "soloLuck"]);
	});

	it("pays a message and a reaction exactly 1 XP", () => {
		expect(BOT_CONSTANTS.LEVELING.MESSAGE_XP).toBe(1);
		expect(BOT_CONSTANTS.LEVELING.REACTION_XP).toBe(1);
	});
});

describe("dailyCapDayKey", () => {
	it("names the Central calendar day, zero padded", () => {
		expect(dailyCapDayKey(new Date("2026-10-23T17:00:00Z"))).toBe("2026-10-23");
		expect(dailyCapDayKey(new Date("2026-02-03T12:00:00Z"))).toBe("2026-02-03");
	});

	it("turns over at Central midnight, five hours after UTC midnight in daylight time", () => {
		expect(dailyCapDayKey(new Date("2026-10-24T04:59:00Z"))).toBe("2026-10-23");
		expect(dailyCapDayKey(new Date("2026-10-24T05:00:00Z"))).toBe("2026-10-24");
	});

	it("follows standard time in winter, six hours after UTC midnight", () => {
		expect(dailyCapDayKey(new Date("2026-12-02T05:59:00Z"))).toBe("2026-12-01");
		expect(dailyCapDayKey(new Date("2026-12-02T06:00:00Z"))).toBe("2026-12-02");
	});
});

describe("grantedUnderCap", () => {
	it("pays the whole award while it fits", () => {
		expect(grantedUnderCap(3, 3)).toBe(3);
		expect(grantedUnderCap(1, 50)).toBe(1);
	});

	it("pays the remainder on the award that crosses the cap", () => {
		// 49 already counted, 2 offered: the counter now reads 51.
		expect(grantedUnderCap(2, 51)).toBe(1);
	});

	it("pays nothing once the day is spent, however far past the cap the counter is", () => {
		expect(grantedUnderCap(1, 51)).toBe(0);
		expect(grantedUnderCap(3, 400)).toBe(0);
	});

	it("serializes two awards racing for the last point", () => {
		// Mongo applies the two $inc writes one after the other, so each gets its own
		// post increment count back and only the first is paid.
		expect(grantedUnderCap(1, 50)).toBe(1);
		expect(grantedUnderCap(1, 51)).toBe(0);
	});
});
