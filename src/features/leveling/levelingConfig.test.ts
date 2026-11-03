import { describe, it, expect } from "vitest";
import GuildConfigModel from "@db/models/GuildConfig.js";
import { levelFromTotalXp } from "./levelCurve.js";
import { normalizeLevelingSettings } from "./levelingConfig.js";

// ── levelingConfig: the one curve ──────────────────────────────────────────
// 2026-10 item 263 Phase 5 (R3-26): every server levels on Dero's quadratic at
// multiplier 1 whatever its row stores. Every curve reader gets its settings from
// normalizeLevelingSettings, so these cases pin the pin at the one place it lives.
// A row can reach the normalizer two ways, as the hydrated Mongoose document the
// guild config store returns and as a plain object, and both must pin.

const SAMPLE_TOTALS = [0, 150, 151, 358, 630, 5_000, 123_456];

const levelsFor = (raw: unknown): number[] => {
	const settings = normalizeLevelingSettings(raw);
	return SAMPLE_TOTALS.map((total) => levelFromTotalXp(total, settings.curve, settings.curveMultiplier, settings.maxLevel));
};

describe("normalizeLevelingSettings pins the curve", () => {
	it("reads Dero at multiplier 1 from a row that stores nothing", () => {
		expect(normalizeLevelingSettings(undefined)).toMatchObject({ curve: "dero", curveMultiplier: 1 });
	});

	it("ignores a plain object stored on linear at multiplier 2", () => {
		const stored = { curve: "linear", curveMultiplier: 2 };
		expect(normalizeLevelingSettings(stored)).toMatchObject({ curve: "dero", curveMultiplier: 1 });
		expect(levelsFor(stored)).toEqual(levelsFor({}));
	});

	it("ignores a hydrated GuildConfig document stored on linear at multiplier 2", () => {
		// The store returns a document, not a plain object, so the normalizer must not
		// depend on walking its fields to find the stored curve.
		const hydrated = GuildConfigModel.hydrate({ guildId: "g1", leveling: { curve: "linear", curveMultiplier: 2 } });
		expect(hydrated.get("leveling.curve")).toBe("linear");

		const raw = (hydrated as unknown as { leveling: unknown }).leveling;
		expect(normalizeLevelingSettings(raw)).toMatchObject({ curve: "dero", curveMultiplier: 1 });
		expect(levelsFor(raw)).toEqual(levelsFor({}));
	});

	it("still reads the max level, which the owner kept", () => {
		expect(normalizeLevelingSettings({ curve: "flat", maxLevel: 40 }).maxLevel).toBe(40);
	});
});
