import { describe, expect, it, vi } from "vitest";
import { consentingAmong, isConsentCurrent, type VersionedConsentRow } from "./consentVersion.js";

// ── consentVersion (2026-11 item 388, owner decision D25) ──
// The one versioned consent rule network consent and meeting consent share: no row, or a
// row below the version asked about, is no consent.

describe("isConsentCurrent", () => {
	it("counts a row at the version or above", () => {
		expect(isConsentCurrent({ version: 2 }, 2)).toBe(true);
		expect(isConsentCurrent({ version: 3 }, 2)).toBe(true);
	});

	it("refuses a row below the version, and a missing row", () => {
		expect(isConsentCurrent({ version: 1 }, 2)).toBe(false);
		expect(isConsentCurrent(null, 1)).toBe(false);
		expect(isConsentCurrent(undefined, 1)).toBe(false);
	});
});

describe("consentingAmong", () => {
	const rows: VersionedConsentRow[] = [
		{ userId: "a", version: 2 },
		{ userId: "b", version: 1 },
	];

	it("keeps only the members whose row covers the version, in one read", async () => {
		const read = vi.fn(async () => rows);
		await expect(consentingAmong(["a", "b", "c"], read, 2)).resolves.toEqual(new Set(["a"]));
		expect(read).toHaveBeenCalledOnce();
		expect(read).toHaveBeenCalledWith(["a", "b", "c"]);
	});

	it("reads nothing for no members", async () => {
		const read = vi.fn(async () => rows);
		await expect(consentingAmong([], read, 1)).resolves.toEqual(new Set());
		expect(read).not.toHaveBeenCalled();
	});
});
