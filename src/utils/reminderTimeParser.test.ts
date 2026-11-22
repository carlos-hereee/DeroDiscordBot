import { describe, expect, it } from "vitest";
import { parseReminderTime } from "./reminderTimeParser.js";

// The parser table (2026-11 item 388 Phase 2): every format, read in the zone given, with the
// three refusals. Chicago crosses its fall DST change on 2026-11-01 at 02:00 local.

const MINUTE = 60 * 1000;
const at = (iso: string): Date => new Date(iso);

describe("parseReminderTime", () => {
	const now = at("2026-11-22T15:00:00.000Z");

	it.each([
		["30m", 30 * MINUTE],
		["2h", 120 * MINUTE],
		["3d", 3 * 24 * 60 * MINUTE],
		["1w", 7 * 24 * 60 * MINUTE],
		["2 H", 120 * MINUTE],
	])("reads the relative span %s", (raw, offset) => {
		expect(parseReminderTime(raw, "UTC", now)).toEqual({ ok: true, at: new Date(now.getTime() + offset) });
	});

	it("reads a clock time still ahead today in the member's zone", () => {
		// 15:00 UTC is 09:00 in Chicago (CST, UTC-6), so 7pm is 01:00 UTC tomorrow.
		expect(parseReminderTime("7pm", "America/Chicago", now)).toEqual({ ok: true, at: at("2026-11-23T01:00:00.000Z") });
	});

	it("rolls a clock time already passed today to tomorrow, never a week out", () => {
		expect(parseReminderTime("08:30", "America/Chicago", now)).toEqual({ ok: true, at: at("2026-11-23T14:30:00.000Z") });
		expect(parseReminderTime("19:30", "UTC", at("2026-11-22T20:00:00.000Z"))).toEqual({ ok: true, at: at("2026-11-23T19:30:00.000Z") });
	});

	it("reads MM/DD@HH:MM in the zone", () => {
		expect(parseReminderTime("12/24@18:00", "America/Chicago", now)).toEqual({ ok: true, at: at("2026-12-25T00:00:00.000Z") });
	});

	it("keeps the wall clock across a DST change in America/Chicago", () => {
		const beforeChange = at("2026-10-31T15:00:00.000Z");
		// 09:00 local on 11/02 is after the change, so CST (UTC-6) applies, not CDT.
		expect(parseReminderTime("11/02@09:00", "America/Chicago", beforeChange)).toEqual({ ok: true, at: at("2026-11-02T15:00:00.000Z") });
		// 7pm on 10/31 is still CDT (UTC-5).
		expect(parseReminderTime("7pm", "America/Chicago", beforeChange)).toEqual({ ok: true, at: at("2026-11-01T00:00:00.000Z") });
	});

	it("reads a date well behind us as next year's", () => {
		expect(parseReminderTime("01/05@09:00", "UTC", now)).toEqual({ ok: true, at: at("2027-01-05T09:00:00.000Z") });
	});

	it.each([
		["soon", "unreadable"],
		["", "unreadable"],
		["0m", "unreadable"],
		["13/40@10:00", "unreadable"],
		["11/20@09:00", "past"],
		["9999w", "tooFar"],
	])("refuses %j as %s", (raw, reason) => {
		expect(parseReminderTime(raw, "UTC", now)).toEqual({ ok: false, reason });
	});
});
