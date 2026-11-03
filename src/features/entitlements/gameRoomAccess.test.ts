import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// ── Game Rooms entitlement gate ───────────────────────────────────────────
// The single most important assertion in this file is the fail-open one. This gate is the
// mirror image of earlyAccess: there, an unconfirmable guild must be BLOCKED so an in-window
// feature is never leaked. Here, an unconfirmable member must be ALLOWED, because game rooms
// are free today and a Heroku blip that resolved to "denied" would silently remove a working
// free feature. A future consistency cleanup that makes these two modules match would break
// that on purpose, so the test is named to say so out loud.

// enforceGameRoomTier is a module-load const in @utils/config, so the only way to exercise both
// the enforced and unenforced paths in one suite is to mock the module with a GETTER over a
// hoisted holder. The getter is read through the live binding on every call, so flipping the
// holder between tests flips the gate.
const flags = vi.hoisted(() => ({ enforceGameRoomTier: false }));
vi.mock("@utils/config.js", () => ({
	get enforceGameRoomTier() {
		return flags.enforceGameRoomTier;
	},
}));

// serverApi is the only outbound dependency; mock its `get` so no real HTTP happens. Mocked by
// the SAME specifier gameRoomAccess.ts imports.
vi.mock("@utils/serverApi.js", () => ({
	serverApi: { get: vi.fn() },
}));

import { checkGameRoomAccess, gameRoomUpgradeEmbed, _clearGameRoomAccessCache } from "./gameRoomAccess.js";
import { serverApi } from "@utils/serverApi.js";

const mockGet = serverApi.get as unknown as Mock;

const NOW = new Date("2026-08-10T00:00:00Z");
const GUILD = "guild1";
const USER = "user1";

beforeEach(() => {
	mockGet.mockReset();
	_clearGameRoomAccessCache();
	flags.enforceGameRoomTier = false;
});

describe("checkGameRoomAccess, enforcement off (production today)", () => {
	it("allows with ZERO server calls", async () => {
		const decision = await checkGameRoomAccess(GUILD, USER, NOW);
		expect(decision.allowed).toBe(true);
		expect(decision.reason).toBeUndefined();
		expect(mockGet).not.toHaveBeenCalled();
	});

	it("reports an infinite private quota, so the provisioner's count never runs", async () => {
		const decision = await checkGameRoomAccess(GUILD, USER, NOW);
		expect(decision.privateQuota).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("checkGameRoomAccess, enforcement on", () => {
	beforeEach(() => {
		flags.enforceGameRoomTier = true;
	});

	it("allows a member whose guild carries the entitlement", async () => {
		mockGet.mockResolvedValue({ guildId: GUILD, userId: USER, allowed: true });
		const decision = await checkGameRoomAccess(GUILD, USER, NOW);
		expect(decision.allowed).toBe(true);
		expect(mockGet).toHaveBeenCalledWith("/api/plugin-access/game-rooms", { guildId: GUILD, userId: USER });
	});

	it("blocks an unentitled member with reason tier and the server's upgrade url", async () => {
		mockGet.mockResolvedValue({
			guildId: GUILD,
			userId: USER,
			allowed: false,
			upgradeUrl: "https://www.companyuno.com/pricing",
		});
		const decision = await checkGameRoomAccess(GUILD, USER, NOW);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("tier");
		expect(decision.upgradeUrl).toBe("https://www.companyuno.com/pricing");
	});

	it("allows a founding member even when the tier answer is no", async () => {
		mockGet.mockResolvedValue({ guildId: GUILD, userId: USER, allowed: false, founding: true });
		const decision = await checkGameRoomAccess(GUILD, USER, NOW);
		expect(decision.allowed).toBe(true);
	});

	it("allows when either id is missing, without calling the server", async () => {
		expect((await checkGameRoomAccess("", USER, NOW)).allowed).toBe(true);
		expect((await checkGameRoomAccess(GUILD, "", NOW)).allowed).toBe(true);
		expect(mockGet).not.toHaveBeenCalled();
	});

	it("carries the server's private quota and tier key, from the wire and from cache", async () => {
		mockGet.mockResolvedValue({ guildId: GUILD, userId: USER, allowed: true, privateQuota: 25, tierKey: "pro" });
		const fresh = await checkGameRoomAccess(GUILD, USER, NOW);
		const cached = await checkGameRoomAccess(GUILD, USER, new Date(NOW.getTime() + 1_000));
		expect(fresh.privateQuota).toBe(25);
		expect(fresh.tierKey).toBe("pro");
		expect(cached.privateQuota).toBe(25);
		expect(cached.tierKey).toBe("pro");
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	it("falls back to the strictest quota when the server omits the number", async () => {
		// An old server build that predates privateQuota must read as the floor, not
		// as unlimited: the response shape is the wire contract, not a promise.
		mockGet.mockResolvedValue({ guildId: GUILD, userId: USER, allowed: true });
		const decision = await checkGameRoomAccess(GUILD, USER, NOW);
		expect(decision.privateQuota).toBe(5);
	});

	it("keys the cache on guild AND user, so two members of one guild resolve independently", async () => {
		mockGet
			.mockResolvedValueOnce({ guildId: GUILD, userId: "founder", founding: true })
			.mockResolvedValueOnce({ guildId: GUILD, userId: "newcomer", allowed: false });
		expect((await checkGameRoomAccess(GUILD, "founder", NOW)).allowed).toBe(true);
		expect((await checkGameRoomAccess(GUILD, "newcomer", NOW)).allowed).toBe(false);
		expect(mockGet).toHaveBeenCalledTimes(2);
	});
});

describe("checkGameRoomAccess FAILS OPEN (the opposite of earlyAccess, deliberately)", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		flags.enforceGameRoomTier = true;
		// The gate logs the failure on purpose; keep it out of the suite output while still
		// proving it was logged, because a gate that quietly stops gating is the thing an
		// operator most needs to see in the Railway logs.
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("ALLOWS when the server call throws, and says so in the logs", async () => {
		mockGet.mockRejectedValue(new Error("server down"));
		const decision = await checkGameRoomAccess(GUILD, USER, NOW);
		expect(decision.allowed).toBe(true);
		expect(decision.reason).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
	});

	// ⚠️ THE QUOTA FAILS THE OTHER WAY FROM THE BOOLEAN, DELIBERATELY. Allowing is
	// "do not take a free feature away in an outage"; the quota falling to unlimited
	// would be "an outage hands every guild a paid ceiling", the wrong direction.
	it("fails open on the QUOTA to the strictest number when nothing is cached", async () => {
		mockGet.mockRejectedValue(new Error("server down"));
		const decision = await checkGameRoomAccess(GUILD, USER, NOW);
		expect(decision.allowed).toBe(true);
		expect(decision.privateQuota).toBe(5);
	});

	it("prefers the last confirmed tier's quota over the floor when one is still known", async () => {
		mockGet
			.mockResolvedValueOnce({ guildId: GUILD, userId: USER, allowed: true, privateQuota: 25, tierKey: "pro" })
			.mockRejectedValueOnce(new Error("server down"));
		await checkGameRoomAccess(GUILD, USER, NOW);
		// Past the confirmed TTL, so the entry is expired but deliberately still in
		// the map; the error path reads its quota back rather than dropping to 5.
		const afterOutage = await checkGameRoomAccess(GUILD, USER, new Date(NOW.getTime() + 61 * 60_000));
		expect(afterOutage.allowed).toBe(true);
		expect(afterOutage.privateQuota).toBe(25);
		expect(afterOutage.tierKey).toBe("pro");
	});

	it("retries after the short error TTL lapses rather than pinning the permissive answer", async () => {
		mockGet
			.mockRejectedValueOnce(new Error("blip"))
			.mockResolvedValueOnce({ guildId: GUILD, userId: USER, allowed: false });
		const first = await checkGameRoomAccess(GUILD, USER, NOW);
		// Advance past the 60s error TTL by injecting `now`, rather than faking timers.
		const second = await checkGameRoomAccess(GUILD, USER, new Date(NOW.getTime() + 61_000));
		expect(first.allowed).toBe(true);
		expect(second.allowed).toBe(false);
		expect(mockGet).toHaveBeenCalledTimes(2);
	});
});

describe("caching", () => {
	beforeEach(() => {
		flags.enforceGameRoomTier = true;
	});

	it("serves a confirmed answer from cache inside the TTL (one server call for two reads)", async () => {
		mockGet.mockResolvedValue({ guildId: GUILD, userId: USER, allowed: true });
		const first = await checkGameRoomAccess(GUILD, USER, NOW);
		const second = await checkGameRoomAccess(GUILD, USER, new Date(NOW.getTime() + 60_000));
		expect(first.allowed).toBe(true);
		expect(second.allowed).toBe(true);
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	it("keeps the upgrade url on a cached denial, not only on the first one", async () => {
		mockGet.mockResolvedValue({ guildId: GUILD, userId: USER, allowed: false, upgradeUrl: "https://x.test/plans" });
		await checkGameRoomAccess(GUILD, USER, NOW);
		const cachedDecision = await checkGameRoomAccess(GUILD, USER, new Date(NOW.getTime() + 1_000));
		expect(mockGet).toHaveBeenCalledTimes(1);
		expect(cachedDecision.allowed).toBe(false);
		expect(cachedDecision.upgradeUrl).toBe("https://x.test/plans");
	});

	it("re-fetches once the confirmed TTL expires", async () => {
		mockGet
			.mockResolvedValueOnce({ guildId: GUILD, userId: USER, allowed: true })
			.mockResolvedValueOnce({ guildId: GUILD, userId: USER, allowed: false });
		const first = await checkGameRoomAccess(GUILD, USER, NOW);
		const second = await checkGameRoomAccess(GUILD, USER, new Date(NOW.getTime() + 60 * 60 * 1000 + 1_000));
		expect(first.allowed).toBe(true);
		expect(second.allowed).toBe(false);
		expect(mockGet).toHaveBeenCalledTimes(2);
	});
});

describe("gameRoomUpgradeEmbed", () => {
	it("uses the server-supplied url when present", () => {
		const embed = gameRoomUpgradeEmbed("https://x.test/plans");
		expect(embed.data.description).toContain("https://x.test/plans");
	});

	it("falls back to the public pricing page when the server sent no url", () => {
		const embed = gameRoomUpgradeEmbed();
		expect(embed.data.description).toContain("https://www.companyuno.com/pricing");
	});

	it("carries no dashes in its copy (owner house rule)", () => {
		const embed = gameRoomUpgradeEmbed();
		const copy = `${embed.data.title ?? ""} ${embed.data.description ?? ""}`;
		// Em dash and en dash, written as escapes because CI's no dash gate reads the literal
		// characters in added lines. Hyphens inside urls and identifiers are fine and are not matched.
		expect(copy).not.toMatch(/[\u2014\u2013]/);
	});
});
