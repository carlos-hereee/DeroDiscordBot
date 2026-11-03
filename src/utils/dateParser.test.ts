import { describe, it, expect } from "vitest";
import { parseEventDate, parseEventDateTime, parseEventDateTimeMinutes } from "./dateParser.js";

// ── typed times in a timezone (2026-10 item 263 Phase 4c, R3-30) ──
// The KvK season reads its dates in UTC, the game's clock; party games and stream
// announcements pass the server's zone. A UTC read must build the same instant the
// parser built before zones existed, or every KvK season would move.

describe("parseEventDateTime and parseEventDateTimeMinutes", () => {
	it("read in UTC by default, the instant they always built", () => {
		expect(parseEventDateTime("03/20 @12", 2026)?.toISOString()).toBe("2026-03-20T12:00:00.000Z");
		expect(parseEventDateTimeMinutes("04/26 @19:30", 2026)?.toISOString()).toBe("2026-04-26T19:30:00.000Z");
		expect(parseEventDate("03/14", 2026)?.toISOString()).toBe("2026-03-14T00:00:00.000Z");
	});

	it("read 7 PM New York as 7 PM New York on both sides of the 2026-11-01 change", () => {
		expect(parseEventDateTimeMinutes("10/31 @19:00", 2026, "America/New_York")?.toISOString()).toBe("2026-10-31T23:00:00.000Z");
		expect(parseEventDateTimeMinutes("11/07 @19:00", 2026, "America/New_York")?.toISOString()).toBe("2026-11-08T00:00:00.000Z");
		expect(parseEventDateTime("11/07 @19", 2026, "America/New_York")?.toISOString()).toBe("2026-11-08T00:00:00.000Z");
	});

	it("refuse a date the calendar does not have, in every zone", () => {
		expect(parseEventDateTimeMinutes("02/31 @19:00", 2026)).toBeNull();
		expect(parseEventDateTimeMinutes("02/31 @19:00", 2026, "Asia/Tokyo")).toBeNull();
		expect(parseEventDateTime("13/01 @10", 2026, "Europe/Berlin")).toBeNull();
	});
});
