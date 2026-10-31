import { afterEach, describe, expect, it, vi } from "vitest";

// isDashboardApiKey reads the configured key at module load, so each case mocks the config
// module and imports a fresh copy, the same way verifySignature.test.ts loads its middleware.
async function loadAuth(apiKey: string) {
	vi.resetModules();
	vi.doMock("@utils/config.js", () => ({ dashboardApiKey: apiKey }));
	return import("./auth.js");
}

afterEach(() => {
	vi.resetModules();
	vi.doUnmock("@utils/config.js");
});

describe("isDashboardApiKey", () => {
	it("accepts the configured key", async () => {
		const { isDashboardApiKey } = await loadAuth("the-shared-key");
		expect(isDashboardApiKey("the-shared-key")).toBe(true);
	});

	it("refuses a different key, including one of a different length", async () => {
		const { isDashboardApiKey } = await loadAuth("the-shared-key");
		expect(isDashboardApiKey("the-shared-kez")).toBe(false);
		expect(isDashboardApiKey("short")).toBe(false);
		expect(isDashboardApiKey("the-shared-key-and-more")).toBe(false);
	});

	it("refuses a missing, empty or repeated header", async () => {
		const { isDashboardApiKey } = await loadAuth("the-shared-key");
		expect(isDashboardApiKey(undefined)).toBe(false);
		expect(isDashboardApiKey("")).toBe(false);
		expect(isDashboardApiKey(["the-shared-key", "the-shared-key"])).toBe(false);
	});

	it("opens nothing when no key is configured", async () => {
		const { isDashboardApiKey } = await loadAuth("");
		expect(isDashboardApiKey("")).toBe(false);
		expect(isDashboardApiKey("anything")).toBe(false);
	});
});
