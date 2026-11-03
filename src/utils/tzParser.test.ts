import { describe, it, expect } from "vitest";
import { COMMON_TIMEZONES, DEFAULT_SERVER_TIMEZONE, TIMEZONE_OPTIONS, isValidTimezone, resolveServerTimezone } from "./tzParser.js";

// ── the server's timezone and the shared zone list (2026-10 item 263 Phase 4c) ──

describe("resolveServerTimezone", () => {
	it("keeps a real zone and reads anything else as UTC", () => {
		expect(DEFAULT_SERVER_TIMEZONE).toBe("UTC");
		expect(resolveServerTimezone("America/New_York")).toBe("America/New_York");
		expect(resolveServerTimezone("Mars/Olympus")).toBe("UTC");
		expect(resolveServerTimezone("")).toBe("UTC");
		expect(resolveServerTimezone(null)).toBe("UTC");
		expect(resolveServerTimezone(undefined)).toBe("UTC");
		expect(resolveServerTimezone(42)).toBe("UTC");
	});
});

describe("TIMEZONE_OPTIONS", () => {
	it("fills one Discord select, UTC first, every value a real zone the autocomplete also ranks first", () => {
		expect(TIMEZONE_OPTIONS).toHaveLength(25);
		expect(TIMEZONE_OPTIONS[0]?.value).toBe("UTC");
		expect(new Set(TIMEZONE_OPTIONS.map((option) => option.value)).size).toBe(25);
		for (const option of TIMEZONE_OPTIONS) {
			expect(isValidTimezone(option.value)).toBe(true);
			expect(COMMON_TIMEZONES as readonly string[]).toContain(option.value);
		}
	});
});
