import { describe, it, expect, vi } from "vitest";

// The decreeEditHandlers module imports several stores + the
// ScheduleBoard refresh helper. None of those are exercised by
// parseModalValues / decreeEditCustomIds, but importing the module
// pulls them in, and a couple drag mongoose models behind them. Mock
// the heavy ones so the test process never opens a DB connection.
vi.mock("@db/stores/eventStore.js", () => ({ eventStore: {} }));
vi.mock("@db/stores/eventOverrideStore.js", () => ({ eventOverrideStore: {} }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: {} }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { logAudit: vi.fn() } }));
vi.mock("@features/schedule/ScheduleBoard.js", () => ({ refreshSchedule: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: vi.fn(), registerModal: vi.fn() }));

import { parseModalValues, decreeEditCustomIds, extractAndValidate, resolveOverrideTime } from "./decreeEditHandlers.js";

describe("parseModalValues", () => {
	const originalOccurrence = new Date("2026-05-01T20:00:00Z"); // 8pm UTC

	// ── empty + nothing-to-change branch ────────────────────────
	it("rejects when every field is empty", () => {
		const result = parseModalValues("", "", "", "", originalOccurrence);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/Nothing to change/i);
		}
	});

	it("rejects when every field is whitespace only", () => {
		const result = parseModalValues("  ", "\n", "\t", "   ", originalOccurrence);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/Nothing to change/i);
		}
	});

	// ── title-only branch ───────────────────────────────────────
	it("accepts a title-only edit and leaves the other override fields null", () => {
		const result = parseModalValues("New Decree Title", "", "", "", originalOccurrence);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.values.overrideTitle).toBe("New Decree Title");
			expect(result.values.overrideDescription).toBeNull();
			expect(result.values.overrideTime).toBeNull();
		}
	});

	// ── description-only branch ─────────────────────────────────
	it("accepts a description-only edit and leaves the other override fields null", () => {
		const result = parseModalValues("", "Bring extra rss", "", "", originalOccurrence);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.values.overrideTitle).toBeNull();
			expect(result.values.overrideDescription).toBe("Bring extra rss");
			expect(result.values.overrideTime).toBeNull();
		}
	});

	// ── time-only branch (defaults to UTC) ──────────────────────
	it("accepts a time-only edit and resolves the override to a UTC Date", () => {
		const result = parseModalValues("", "", "21:00", "", originalOccurrence);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.values.overrideTime).toBeInstanceOf(Date);
			// 9pm UTC on the same date as originalOccurrence (2026-05-01).
			// Time is held in UTC so the wall-clock should be exactly 21:00 UTC.
			const t = result.values.overrideTime as Date;
			expect(t.getUTCHours()).toBe(21);
			expect(t.getUTCMinutes()).toBe(0);
			expect(t.getUTCFullYear()).toBe(2026);
			expect(t.getUTCMonth()).toBe(4); // May (0-indexed)
			expect(t.getUTCDate()).toBe(1);
		}
	});

	// ── time-with-timezone branch ───────────────────────────────
	it("accepts a time + timezone edit and resolves the override to the correct UTC instant", () => {
		// 7pm America/New_York on 2026-05-01 = 23:00 UTC (EDT, UTC-4)
		const result = parseModalValues("", "", "7pm", "America/New_York", originalOccurrence);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const t = result.values.overrideTime as Date;
			// Daylight saving in NYC on May 1 puts the offset at -4. The
			// resolved UTC moment should be 23:00 on the same date.
			expect(t.getUTCHours()).toBe(23);
			expect(t.getUTCMinutes()).toBe(0);
		}
	});

	// ── invalid time ────────────────────────────────────────────
	it("rejects an unparseable time string", () => {
		const result = parseModalValues("", "", "tomorrow at noon", "", originalOccurrence);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/not a recognized format/i);
		}
	});

	// ── invalid timezone ────────────────────────────────────────
	it("rejects an unrecognized IANA timezone", () => {
		const result = parseModalValues("", "", "7pm", "America/NotARealZone", originalOccurrence);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/not a recognized IANA name/i);
		}
	});

	// ── timezone without time ───────────────────────────────────
	it("rejects a timezone without a time (ambiguous intent)", () => {
		const result = parseModalValues("", "", "", "America/New_York", originalOccurrence);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/required when a timezone is provided/i);
		}
	});
});

// ── new split helpers (post timezone-dropdown redesign) ─────────────
// extractAndValidate handles structural validation only, it must NOT
// resolve the override time, because the timezone is collected via a
// separate StringSelectMenu after modal submit. resolveOverrideTime is
// the second half: given a parsed time-of-day plus a chosen IANA zone,
// produce the UTC Date that gets persisted to the override.

describe("extractAndValidate", () => {
	it("rejects when every text field is empty", () => {
		const result = extractAndValidate("", "", "");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/Nothing to change/i);
	});

	it("returns title-only when only title is filled", () => {
		const result = extractAndValidate("Decree of Iron", "", "");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.values.overrideTitle).toBe("Decree of Iron");
			expect(result.values.overrideDescription).toBeNull();
			expect(result.values.timeOfDay).toBeNull();
		}
	});

	it("parses a valid time string into hour/minute without resolving a Date", () => {
		// Critical contract: this helper does NOT need a timezone, so it
		// must not produce a Date here. The Date is built later by
		// resolveOverrideTime once the editor picks a zone.
		const result = extractAndValidate("", "", "7:30 pm");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.values.timeOfDay).toEqual({ hour: 19, minute: 30 });
		}
	});

	it("rejects an unparseable time string", () => {
		const result = extractAndValidate("", "", "tomorrow at noon");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/not a recognized format/i);
	});
});

describe("resolveOverrideTime", () => {
	const originalOccurrence = new Date("2026-05-01T20:00:00Z"); // 8pm UTC

	it("produces the correct UTC instant for a wall-clock time in a zone", () => {
		// 7pm America/New_York on 2026-05-01 (DST, UTC-4) = 23:00 UTC.
		const result = resolveOverrideTime({ hour: 19, minute: 0 }, "America/New_York", originalOccurrence);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.date.getUTCHours()).toBe(23);
			expect(result.date.getUTCMinutes()).toBe(0);
			expect(result.date.getUTCDate()).toBe(1);
			expect(result.date.getUTCMonth()).toBe(4); // May
		}
	});

	it("treats UTC zone identity as a passthrough", () => {
		const result = resolveOverrideTime({ hour: 21, minute: 0 }, "UTC", originalOccurrence);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.date.getUTCHours()).toBe(21);
			expect(result.date.getUTCMinutes()).toBe(0);
		}
	});

	it("rejects an unrecognized IANA zone", () => {
		const result = resolveOverrideTime({ hour: 19, minute: 0 }, "America/NotARealZone", originalOccurrence);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/not a recognized IANA name/i);
	});
});

describe("decreeEditCustomIds", () => {
	it("round-trips eventId and occurrenceUnix through buildEditButton + parse", () => {
		const built = decreeEditCustomIds.buildEditButton("evt-ruins", 1893456000);
		expect(built).toBe("edit_decree:evt-ruins:1893456000");
		const parsed = decreeEditCustomIds.parse(built);
		expect(parsed).toEqual({ eventId: "evt-ruins", occurrenceUnix: 1893456000 });
	});

	it("round-trips through buildEditModal + parse with the same shape", () => {
		const built = decreeEditCustomIds.buildEditModal("evt-altar", 1893460000);
		expect(built).toBe("edit_decree_modal:evt-altar:1893460000");
		const parsed = decreeEditCustomIds.parse(built);
		expect(parsed).toEqual({ eventId: "evt-altar", occurrenceUnix: 1893460000 });
	});

	it("rejects malformed customIds", () => {
		expect(decreeEditCustomIds.parse("edit_decree")).toBeNull();
		expect(decreeEditCustomIds.parse("edit_decree:")).toBeNull();
		expect(decreeEditCustomIds.parse("edit_decree:evt:not-a-number")).toBeNull();
		expect(decreeEditCustomIds.parse("edit_decree:evt:123:extra-segment")).toBeNull();
	});
});
