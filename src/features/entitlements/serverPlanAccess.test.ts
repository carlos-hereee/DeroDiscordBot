import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// ── Dero server plan access ───────────────────────────────────────────────
// The assertions that matter most are the failure ones: whatever goes wrong, the ceiling falls
// to the last known answer or to the FREE $2, never up. Every guild's speech bills one
// ElevenLabs account, so a fallback that pointed up would let an outage spend a paid budget
// in every guild at once.

// serverApi is the only outbound dependency, mocked by the SAME specifier the module imports,
// as gameRoomAccess.test.ts does.
// The real error classes are kept so the not configured case throws the error serverApi throws.
vi.mock("@utils/serverApi.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@utils/serverApi.js")>()),
	serverApi: { get: vi.fn() },
}));

import { resolveServerPlanAccess, isServerCovered, isServerCoveredNow, _clearServerPlanAccessCache } from "./serverPlanAccess.js";
import { serverApi, ServerNotConfiguredError } from "@utils/serverApi.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

const mockGet = serverApi.get as unknown as Mock;

const NOW = new Date("2026-10-29T12:00:00Z");
const GUILD = "guild1";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const COVERED_RESPONSE = { guildId: GUILD, covered: true, voiceCeilingUsd: 5 };
const UNCOVERED_RESPONSE = { guildId: GUILD, covered: false, voiceCeilingUsd: 2 };

const later = (ms: number): Date => new Date(NOW.getTime() + ms);

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	mockGet.mockReset();
	_clearServerPlanAccessCache();
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	warnSpy.mockRestore();
});

describe("resolveServerPlanAccess, the server answers", () => {
	it("reads a covered guild's ceiling from the signed route", async () => {
		mockGet.mockResolvedValue({ guildId: GUILD, covered: true, source: "serverPlan", voiceCeilingUsd: 5, privateQuota: 10 });
		expect(await resolveServerPlanAccess(GUILD, NOW)).toEqual({ covered: true, voiceCeilingUsd: 5 });
		expect(mockGet).toHaveBeenCalledWith("/api/plugin-access/server-plan", { guildId: GUILD });
	});

	it("reads an uncovered guild as $2", async () => {
		mockGet.mockResolvedValue({
			guildId: GUILD,
			covered: false,
			source: "none",
			voiceCeilingUsd: 2,
			privateQuota: 5,
			upgradeUrl: BOT_CONSTANTS.DERO_SERVER_PLAN_URL,
		});
		expect(await resolveServerPlanAccess(GUILD, NOW)).toEqual({ covered: false, voiceCeilingUsd: 2 });
		expect(await isServerCovered(GUILD)).toBe(false);
	});

	it("serves a covered answer from the cache for an hour, then reads again", async () => {
		mockGet.mockResolvedValue({ guildId: GUILD, covered: true, voiceCeilingUsd: 5 });
		await resolveServerPlanAccess(GUILD, NOW);
		await resolveServerPlanAccess(GUILD, later(HOUR_MS - 1));
		expect(mockGet).toHaveBeenCalledTimes(1);

		await resolveServerPlanAccess(GUILD, later(HOUR_MS + 1));
		expect(mockGet).toHaveBeenCalledTimes(2);
	});

	// M5 of 2026-11 item 424: an uncovered answer cached for the hour kept a server that had
	// just paid at the free ceiling, and kept telling it to buy.
	it("M5: reads an uncovered server again after 5 minutes, and not before", async () => {
		mockGet.mockResolvedValueOnce(UNCOVERED_RESPONSE);
		await resolveServerPlanAccess(GUILD, NOW);

		expect(await resolveServerPlanAccess(GUILD, later(5 * MINUTE_MS - 1))).toEqual({ covered: false, voiceCeilingUsd: 2 });
		expect(mockGet).toHaveBeenCalledTimes(1);

		mockGet.mockResolvedValueOnce(COVERED_RESPONSE);
		expect(await resolveServerPlanAccess(GUILD, later(5 * MINUTE_MS))).toEqual({ covered: true, voiceCeilingUsd: 5 });
		expect(mockGet).toHaveBeenCalledTimes(2);
	});

	it("reads a response missing its fields as the free answer, never as covered", async () => {
		mockGet.mockResolvedValue({ guildId: GUILD });
		expect(await resolveServerPlanAccess(GUILD, NOW)).toEqual({ covered: false, voiceCeilingUsd: BOT_CONSTANTS.DERO_VOICE_FREE_CEILING_USD });
	});
});

describe("resolveServerPlanAccess FAILS TO THE FREE CEILING, never up", () => {
	it("keeps the last known answer through a 5xx", async () => {
		mockGet.mockResolvedValueOnce({ guildId: GUILD, covered: true, voiceCeilingUsd: 5 });
		await resolveServerPlanAccess(GUILD, NOW);

		mockGet.mockRejectedValueOnce(Object.assign(new Error("server error"), { status: 503 }));
		expect(await resolveServerPlanAccess(GUILD, later(HOUR_MS + 1))).toEqual({ covered: true, voiceCeilingUsd: 5 });
		expect(warnSpy).toHaveBeenCalled();
	});

	it("gives $2 uncovered when the server is unreachable and nothing is cached", async () => {
		mockGet.mockRejectedValue(new Error("ECONNREFUSED"));
		expect(await resolveServerPlanAccess(GUILD, NOW)).toEqual({ covered: false, voiceCeilingUsd: 2 });
	});

	it("gives $2 uncovered when the bot is not configured to reach the server", async () => {
		mockGet.mockRejectedValue(new ServerNotConfiguredError());
		const access = await resolveServerPlanAccess(GUILD, NOW);
		expect(access).toEqual({ covered: false, voiceCeilingUsd: 2 });
		expect(access.voiceCeilingUsd).not.toBe(BOT_CONSTANTS.DERO_VOICE_MAX_CAP_USD);
	});

	it("caches an error only for a minute, so a recovered server is read again", async () => {
		mockGet.mockRejectedValueOnce(new Error("down"));
		await resolveServerPlanAccess(GUILD, NOW);
		await resolveServerPlanAccess(GUILD, later(MINUTE_MS - 1));
		expect(mockGet).toHaveBeenCalledTimes(1);

		mockGet.mockResolvedValueOnce({ guildId: GUILD, covered: true, voiceCeilingUsd: 5 });
		expect(await resolveServerPlanAccess(GUILD, later(MINUTE_MS + 1))).toEqual({ covered: true, voiceCeilingUsd: 5 });
		expect(mockGet).toHaveBeenCalledTimes(2);
	});
});

describe("isServerCoveredNow, the read /dero plan makes (M5 of 2026-11 item 424)", () => {
	it("asks the server past a live cached answer and stores what it hears for the voice ceiling", async () => {
		mockGet.mockResolvedValueOnce(UNCOVERED_RESPONSE);
		await resolveServerPlanAccess(GUILD, NOW);

		mockGet.mockResolvedValueOnce(COVERED_RESPONSE);
		expect(await isServerCoveredNow(GUILD, later(MINUTE_MS))).toBe(true);
		expect(mockGet).toHaveBeenCalledTimes(2);
		expect(mockGet).toHaveBeenLastCalledWith("/api/plugin-access/server-plan", { guildId: GUILD });

		expect(await resolveServerPlanAccess(GUILD, later(2 * MINUTE_MS))).toEqual({ covered: true, voiceCeilingUsd: 5 });
		expect(mockGet).toHaveBeenCalledTimes(2);
	});

	it("also notices that a covered server no longer is", async () => {
		mockGet.mockResolvedValueOnce(COVERED_RESPONSE);
		await resolveServerPlanAccess(GUILD, NOW);

		mockGet.mockResolvedValueOnce(UNCOVERED_RESPONSE);
		expect(await isServerCoveredNow(GUILD, later(MINUTE_MS))).toBe(false);
		expect(await resolveServerPlanAccess(GUILD, later(2 * MINUTE_MS))).toEqual({ covered: false, voiceCeilingUsd: 2 });
	});

	it("returns the last known answer on an error, and never raises an uncovered server's ceiling", async () => {
		mockGet.mockResolvedValueOnce(UNCOVERED_RESPONSE);
		await resolveServerPlanAccess(GUILD, NOW);

		mockGet.mockRejectedValueOnce(new Error("down"));
		expect(await isServerCoveredNow(GUILD, later(MINUTE_MS))).toBe(false);
		expect(await resolveServerPlanAccess(GUILD, later(MINUTE_MS + 1))).toEqual({ covered: false, voiceCeilingUsd: 2 });
		expect(mockGet).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("keeps a covered server covered through an error", async () => {
		mockGet.mockResolvedValueOnce(COVERED_RESPONSE);
		await resolveServerPlanAccess(GUILD, NOW);

		mockGet.mockRejectedValueOnce(Object.assign(new Error("server error"), { status: 503 }));
		expect(await isServerCoveredNow(GUILD, later(MINUTE_MS))).toBe(true);
		expect(await resolveServerPlanAccess(GUILD, later(MINUTE_MS + 1))).toEqual({ covered: true, voiceCeilingUsd: 5 });
	});

	it("reads an unknown server as free when the server cannot answer", async () => {
		mockGet.mockRejectedValue(new Error("down"));
		expect(await isServerCoveredNow(GUILD, NOW)).toBe(false);
		expect(await resolveServerPlanAccess(GUILD, later(1))).toEqual({ covered: false, voiceCeilingUsd: BOT_CONSTANTS.DERO_VOICE_FREE_CEILING_USD });
	});

	// The owner's read and a voice reservation can be in flight together. The one that fails
	// must not put back the answer from before the one that succeeded.
	it("never overwrites an answer another read stored while this one was failing", async () => {
		let failSlowRead: (error: Error) => void = () => undefined;
		mockGet.mockImplementationOnce(() => new Promise((_resolve, reject) => { failSlowRead = reject; }));
		const slowRead = resolveServerPlanAccess(GUILD, NOW);

		mockGet.mockResolvedValueOnce(COVERED_RESPONSE);
		expect(await isServerCoveredNow(GUILD, NOW)).toBe(true);

		failSlowRead(new Error("timeout"));
		expect(await slowRead).toEqual({ covered: true, voiceCeilingUsd: 5 });
		expect(await resolveServerPlanAccess(GUILD, later(1))).toEqual({ covered: true, voiceCeilingUsd: 5 });
	});
});
