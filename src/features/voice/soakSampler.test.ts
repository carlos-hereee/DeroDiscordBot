import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { formatSoakSample, startSoakSampler, takeSoakSample, type SoakSamplerDeps } from "./soakSampler.js";

// ── soak sampler ───────────────────────────────────────────────────────────
// The row the owner's soak is judged on: numbers only, the guild id the only
// id, nothing written with no call open, one row a minute when on, and no timer
// at all when off.

const GUILD_ID = "100000000000000001";
const MB = 1024 * 1024;

function makeDeps(overrides: Partial<SoakSamplerDeps> = {}): SoakSamplerDeps & { write: ReturnType<typeof vi.fn> } {
	const write = vi.fn();
	return {
		now: () => new Date("2026-10-20T12:00:00Z"),
		rssBytes: () => 151.26 * MB,
		sessionStats: () => ({ guildIds: [GUILD_ID], rejoinsTotal: 1 }),
		queueDepth: () => 0,
		turnsFinished: () => 7,
		findSpend: vi.fn(async () => ({ guildId: GUILD_ID, month: "2026-10", ttsChars: 1200, sttSeconds: 95, estimatedCents: 12 })),
		latencyMedianMs: () => 4200,
		...overrides,
		write,
	};
}

beforeEach(() => {
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("formatSoakSample", () => {
	it("turns the readings into one row of numbers, memory in megabytes to one decimal", () => {
		const sample = formatSoakSample({
			rssBytes: 151.26 * MB,
			sessions: 1,
			rejoinsTotal: 2,
			queueDepth: 1,
			turnsFinished: 9,
			spend: { ttsChars: 1200, sttSeconds: 95, estimatedCents: 12 },
			latencyMedianMs: 4200,
		});
		expect(sample).toEqual({
			rssMb: 151.3,
			sessions: 1,
			reconnects: 2,
			queueDepth: 1,
			turnsFinished: 9,
			ttsChars: 1200,
			sttSeconds: 95,
			spendCents: 12,
			latencyMedianMs: 4200,
		});
		for (const value of Object.values(sample)) expect(typeof value).toBe("number");
	});

	it("reads a month with no spend row as zero and a guild with no measured turn as a null median", () => {
		const sample = formatSoakSample({ rssBytes: 0, sessions: 1, rejoinsTotal: 0, queueDepth: 0, turnsFinished: 0, spend: null, latencyMedianMs: null });
		expect(sample).toMatchObject({ ttsChars: 0, sttSeconds: 0, spendCents: 0, latencyMedianMs: null });
	});
});

describe("takeSoakSample", () => {
	it("writes one row for the call's guild, reading this UTC month's spend", async () => {
		const deps = makeDeps();
		const taken = await takeSoakSample(deps);
		expect(deps.findSpend).toHaveBeenCalledWith(GUILD_ID, "2026-10");
		expect(deps.write).toHaveBeenCalledTimes(1);
		expect(deps.write).toHaveBeenCalledWith(GUILD_ID, taken?.sample);
		expect(taken?.sample).toMatchObject({ rssMb: 151.3, sessions: 1, reconnects: 1, turnsFinished: 7, sttSeconds: 95, spendCents: 12 });
	});

	it("carries no text and no id but the guild's", async () => {
		const deps = makeDeps();
		await takeSoakSample(deps);
		const [guildId, row] = deps.write.mock.calls[0] as [string, Record<string, unknown>];
		expect(guildId).toBe(GUILD_ID);
		expect(Object.values(row).every((value) => value === null || typeof value === "number")).toBe(true);
	});

	it("writes nothing while no call is open", async () => {
		const deps = makeDeps({ sessionStats: () => ({ guildIds: [], rejoinsTotal: 0 }) });
		expect(await takeSoakSample(deps)).toBeNull();
		expect(deps.write).not.toHaveBeenCalled();
		expect(deps.findSpend).not.toHaveBeenCalled();
	});

	it("samples the oldest call and counts every open one", async () => {
		const deps = makeDeps({ sessionStats: () => ({ guildIds: [GUILD_ID, "100000000000000002"], rejoinsTotal: 0 }) });
		const taken = await takeSoakSample(deps);
		expect(taken?.guildId).toBe(GUILD_ID);
		expect(taken?.sample.sessions).toBe(2);
	});
});

describe("startSoakSampler", () => {
	it("is off by default: no timer, no row, nothing returned", async () => {
		vi.useFakeTimers();
		const deps = makeDeps();
		expect(startSoakSampler(false, deps)).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(10 * BOT_CONSTANTS.DERO_VOICE_SAMPLER_INTERVAL_MS);
		expect(deps.write).not.toHaveBeenCalled();
	});

	it("when on, writes one row a minute and stops cleanly", async () => {
		vi.useFakeTimers();
		const deps = makeDeps();
		const sampler = startSoakSampler(true, deps);
		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.DERO_VOICE_SAMPLER_INTERVAL_MS - 1);
		expect(deps.write).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(deps.write).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2 * BOT_CONSTANTS.DERO_VOICE_SAMPLER_INTERVAL_MS);
		expect(deps.write).toHaveBeenCalledTimes(3);

		sampler?.stop();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(5 * BOT_CONSTANTS.DERO_VOICE_SAMPLER_INTERVAL_MS);
		expect(deps.write).toHaveBeenCalledTimes(3);
	});

	it("logs a failed tick and keeps going", async () => {
		vi.useFakeTimers();
		const findSpend = vi.fn().mockRejectedValueOnce(new Error("mongo down")).mockResolvedValue(null);
		const deps = makeDeps({ findSpend });
		const sampler = startSoakSampler(true, deps);
		await vi.advanceTimersByTimeAsync(2 * BOT_CONSTANTS.DERO_VOICE_SAMPLER_INTERVAL_MS);
		expect(console.error).toHaveBeenCalledTimes(1);
		expect(deps.write).toHaveBeenCalledTimes(1);
		sampler?.stop();
	});

	it.each([
		["1", true],
		["true", false],
		["yes", false],
		["", false],
	])("config reads DERO_VOICE_SAMPLER=%j as %s", async (value, expected) => {
		// A fresh config module per value, since config.ts reads the env once at
		// load. dotenv never overrides a value already in process.env.
		vi.stubEnv("DERO_VOICE_SAMPLER", value);
		vi.resetModules();
		const config = await import("@utils/config.js");
		expect(config.deroVoiceSamplerEnabled).toBe(expected);
		vi.unstubAllEnvs();
	});
});
