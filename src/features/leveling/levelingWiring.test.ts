import { describe, it, expect } from "vitest";

// ── the leveling module graph ──────────────────────────────────────────────
// ⚠️ THIS FEATURE CONTAINS A DELIBERATE CIRCULAR IMPORT, and this file is the
// guard on it. The cycle is:
//
//   xpWriter  ──imports runAchievementPass──>  achievementUnlock
//   achievementUnlock  ──imports awardXp──>  awardXp
//   awardXp  ──imports stage──>  xpWriter
//
// It exists because the flush is where achievements are evaluated (the only
// place they safely can be, see achievementEngine's recursion note) and an
// unlock's xp bonus has to go back through the one public award API rather than
// writing to a store directly.
//
// The cycle is SAFE because every binding in it is a hoisted function
// declaration that is only ever called at runtime, never at module evaluation
// time. If somebody later moves one of these to a `const fn = () => {}` or calls
// one at module scope, the cycle turns into a TDZ error at BOOT, in production,
// with a stack trace that points at an import rather than at the change. Nothing
// else in the suite would catch it: every other leveling test mocks at least one
// side of the cycle, which is exactly what makes this file necessary.
//
// These imports are deliberately UNMOCKED. Importing a Mongoose model only
// registers a schema, it opens no connection, so nothing here can hang.
//
// ── why these tests carry an explicit timeout ──────────────────────────────
// ⚠️ RAISED FROM VITEST'S 5s DEFAULT ON 2026-08-12, AND DO NOT LOWER IT BACK.
// These cases `await import()` the REAL module graph with nothing mocked, so the
// first one pays for transforming and evaluating that whole subtree. Under a full
// suite run, competing with every other file's transforms, that had crept to ~10s
// and this file went red on every run while passing alone in 1.2s. A permanently
// red gate stops being a signal, which is how a real failure hides behind a known
// one, and the project's shipping rules say so explicitly.
//
// The budget does NOT weaken the guard. The failure this file exists to catch is a
// TDZ error, which throws the INSTANT the cycle is evaluated; it does not take
// five seconds and it will not take thirty. The timeout only ever bounds the
// machine's transform speed, so a larger one trades nothing away.
//
// Deleting the file instead is the tempting fix and the wrong one: it reads as a
// slow pointless test precisely because it reports as a timeout rather than an
// assertion, and removing it re-opens a boot-time crash in production.
const GRAPH_LOAD_TIMEOUT_MS = 30_000;

describe("the circular import between xpWriter, achievementUnlock and awardXp", () => {
	it("resolves when xpWriter is loaded first", async () => {
		const xpWriter = await import("./xpWriter.js");
		expect(typeof xpWriter.stage).toBe("function");
		expect(typeof xpWriter.flushNow).toBe("function");
		expect(typeof xpWriter.claimCooldown).toBe("function");
	}, GRAPH_LOAD_TIMEOUT_MS);

	it("resolves when awardXp is loaded first", async () => {
		const awardXp = await import("./awardXp.js");
		expect(typeof awardXp.awardXp).toBe("function");
	}, GRAPH_LOAD_TIMEOUT_MS);

	it("resolves when achievementUnlock is loaded first", async () => {
		const unlock = await import("./achievementUnlock.js");
		expect(typeof unlock.runAchievementPass).toBe("function");
	}, GRAPH_LOAD_TIMEOUT_MS);

	it("leaves every binding in the cycle defined, not undefined", async () => {
		// The specific failure a broken cycle produces: the module loads, but one
		// side sees `undefined` where it expected a function, and the first call at
		// runtime throws "x is not a function" far from the cause.
		const [xpWriter, awardXpModule, unlock] = await Promise.all([
			import("./xpWriter.js"),
			import("./awardXp.js"),
			import("./achievementUnlock.js"),
		]);

		expect(xpWriter.stage).toBeDefined();
		expect(awardXpModule.awardXp).toBeDefined();
		expect(unlock.runAchievementPass).toBeDefined();
	}, GRAPH_LOAD_TIMEOUT_MS);
});

describe("the rest of the leveling graph loads", () => {
	// A cheap boot smoke test for the whole feature. Every one of these is
	// imported by main.ts or by a command, so a module that throws on evaluation
	// takes the bot down at startup rather than failing a request.
	it.each([
		"./levelCurve.js",
		"./primeLevels.js",
		"./levelPeriod.js",
		"./levelingTypes.js",
		"./levelingCopy.js",
		"./levelingEmbeds.js",
		"./levelingConfig.js",
		"./xpRules.js",
		"./messageXp.js",
		"./reactionXp.js",
		"./voiceXp.js",
		"./levelUpAnnouncer.js",
		"./LevelsBoard.js",
		"./roleRewards.js",
		"./achievements.js",
		"./achievementEngine.js",
	])("%s evaluates without throwing", async (specifier) => {
		await expect(import(specifier)).resolves.toBeDefined();
	}, GRAPH_LOAD_TIMEOUT_MS);
});
