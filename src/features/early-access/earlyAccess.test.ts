import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
	checkEarlyAccess,
	resolveGuildEarlyAccess,
	EARLY_ACCESS_FEATURES,
	_clearEarlyAccessCache,
} from "./earlyAccess.js";
import { serverApi } from "@utils/serverApi.js";

// serverApi is the only outbound dependency; mock its `get` so no real HTTP happens.
vi.mock("@utils/serverApi.js", () => ({
	serverApi: { get: vi.fn() },
}));

const mockGet = serverApi.get as unknown as Mock;

const FUTURE = new Date("2999-01-01T00:00:00Z");
const PAST = new Date("2000-01-01T00:00:00Z");
const NOW = new Date("2026-07-23T00:00:00Z");

beforeEach(() => {
	mockGet.mockReset();
	_clearEarlyAccessCache();
	// Reset the shared registry to empty; each test adds only what it needs.
	for (const key of Object.keys(EARLY_ACCESS_FEATURES)) delete EARLY_ACCESS_FEATURES[key];
});

describe("checkEarlyAccess", () => {
	it("allows a command not in the registry, with no server call", async () => {
		const decision = await checkEarlyAccess("ping", "guild1", NOW);
		expect(decision.allowed).toBe(true);
		expect(mockGet).not.toHaveBeenCalled();
	});

	it("allows a listed command once its general release date has passed, no server call", async () => {
		EARLY_ACCESS_FEATURES["new-power"] = { generalReleaseAt: PAST };
		const decision = await checkEarlyAccess("new-power", "guild1", NOW);
		expect(decision.allowed).toBe(true);
		expect(mockGet).not.toHaveBeenCalled();
	});

	it("allows an in-window command for a Studio-eligible guild", async () => {
		EARLY_ACCESS_FEATURES["new-power"] = { generalReleaseAt: FUTURE };
		mockGet.mockResolvedValue({ guildId: "guild1", earlyAccess: true });
		const decision = await checkEarlyAccess("new-power", "guild1", NOW);
		expect(decision.allowed).toBe(true);
		expect(mockGet).toHaveBeenCalledWith("/api/plugin-access/guild", { guildId: "guild1" });
	});

	it("blocks an in-window command for an ineligible guild and returns the release date", async () => {
		EARLY_ACCESS_FEATURES["new-power"] = { generalReleaseAt: FUTURE };
		mockGet.mockResolvedValue({ guildId: "guild1", earlyAccess: false });
		const decision = await checkEarlyAccess("new-power", "guild1", NOW);
		expect(decision.allowed).toBe(false);
		expect(decision.generalReleaseAt).toBe(FUTURE);
	});

	it("fails closed (blocks) when the server call throws", async () => {
		EARLY_ACCESS_FEATURES["new-power"] = { generalReleaseAt: FUTURE };
		mockGet.mockRejectedValue(new Error("server down"));
		const decision = await checkEarlyAccess("new-power", "guild1", NOW);
		expect(decision.allowed).toBe(false);
	});
});

describe("resolveGuildEarlyAccess caching", () => {
	it("returns false for an empty guildId without calling the server", async () => {
		expect(await resolveGuildEarlyAccess("", NOW)).toBe(false);
		expect(mockGet).not.toHaveBeenCalled();
	});

	it("caches a confirmed answer within the TTL (one server call for two reads)", async () => {
		mockGet.mockResolvedValue({ guildId: "guild1", earlyAccess: true });
		const first = await resolveGuildEarlyAccess("guild1", NOW);
		const second = await resolveGuildEarlyAccess("guild1", new Date(NOW.getTime() + 60_000));
		expect(first).toBe(true);
		expect(second).toBe(true);
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	it("retries after an error once the short negative TTL lapses", async () => {
		mockGet
			.mockRejectedValueOnce(new Error("blip"))
			.mockResolvedValueOnce({ guildId: "guild1", earlyAccess: true });
		const first = await resolveGuildEarlyAccess("guild1", NOW);
		// Advance beyond the 60s error TTL so the second read re-hits the server.
		const second = await resolveGuildEarlyAccess("guild1", new Date(NOW.getTime() + 61_000));
		expect(first).toBe(false);
		expect(second).toBe(true);
		expect(mockGet).toHaveBeenCalledTimes(2);
	});
});
