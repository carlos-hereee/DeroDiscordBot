import { describe, it, expect } from "vitest";
import { ACHIEVEMENTS } from "./achievements.js";
import { buildCounters, evaluate, progressFor, unlockedKey, type AchievementCounters } from "./achievementEngine.js";
import type { IGameRecord } from "./levelingTypes.js";

// ── the achievement engine ─────────────────────────────────────────────────
// One pure function, and the properties that matter are all about it NOT firing
// twice: idempotency against what a member already holds, exact behaviour at a
// threshold boundary, and the absence of any path by which an unlock's own xp
// reward could unlock something else in the same pass.

const counters = (overrides: Partial<AchievementCounters> = {}): AchievementCounters => ({
	messages: 0,
	reactionsGiven: 0,
	voiceMinutes: 0,
	fortuneReadings: 0,
	level: 1,
	milestoneLevels: 0,
	gamesPlayed: 0,
	gamesWon: 0,
	assists: 0,
	perGameWon: {},
	...overrides,
});

const idsOf = (unlocks: ReturnType<typeof evaluate>): string[] => unlocks.map((unlock) => `${unlock.id}:${unlock.tier}`);

describe("threshold boundaries", () => {
	// voice-of-the-realm bronze is 53 messages.
	it("fires EXACTLY at the threshold", () => {
		expect(idsOf(evaluate(counters({ messages: 53 }), []))).toContain("voice-of-the-realm:bronze");
	});

	it("does not fire one short", () => {
		expect(idsOf(evaluate(counters({ messages: 52 }), []))).not.toContain("voice-of-the-realm:bronze");
	});

	it("still fires past it", () => {
		expect(idsOf(evaluate(counters({ messages: 54 }), []))).toContain("voice-of-the-realm:bronze");
	});

	it.each(
		ACHIEVEMENTS.flatMap((achievement) =>
			achievement.tiers.map((tier) => [`${achievement.id}:${tier.name}`, achievement.metric, tier.threshold] as const)
		)
	)("%s fires at its own threshold and not one below", (key, metric, threshold) => {
		// Every tier of every track, swept rather than spot checked, because an off
		// by one in one track is invisible next to eleven that work.
		const at = metricCounters(metric, threshold);
		const below = metricCounters(metric, threshold - 1);

		expect(idsOf(evaluate(at, [])), `${key} at ${threshold}`).toContain(key);
		expect(idsOf(evaluate(below, [])), `${key} at ${threshold - 1}`).not.toContain(key);
	});
});

// Build a counters object whose named metric holds the given value.
function metricCounters(metric: string, value: number): AchievementCounters {
	if (metric.endsWith(".won")) {
		return counters({ perGameWon: { [metric.slice(0, -".won".length)]: value } });
	}
	return counters({ [metric]: value } as Partial<AchievementCounters>);
}

describe("idempotency, which is half the recursion defense", () => {
	it("never re-emits a tier the member already holds", () => {
		const held = [unlockedKey("voice-of-the-realm", "bronze")];
		expect(idsOf(evaluate(counters({ messages: 5_003 }), held))).not.toContain("voice-of-the-realm:bronze");
	});

	it("still emits the tiers above the one held", () => {
		const held = [unlockedKey("voice-of-the-realm", "bronze")];
		const unlocked = idsOf(evaluate(counters({ messages: 251 }), held));
		expect(unlocked).toContain("voice-of-the-realm:silver");
		expect(unlocked).not.toContain("voice-of-the-realm:bronze");
	});

	it("emits nothing at all on a second identical pass", () => {
		// The property that guarantees termination even if the call site were wrong:
		// there are 12 tracks of 4 tiers and each can fire exactly once.
		const state = counters({ messages: 5_003, level: 89, milestoneLevels: 31 });
		const first = evaluate(state, []);
		const held = first.map((unlock) => unlockedKey(unlock.id, unlock.tier));
		expect(evaluate(state, held)).toEqual([]);
	});

	it("is pure: it does not mutate the counters it is given", () => {
		const state = counters({ messages: 5_003 });
		const snapshot = JSON.stringify(state);
		evaluate(state, []);
		expect(JSON.stringify(state)).toBe(snapshot);
	});
});

describe("crossing several tiers in one pass", () => {
	it("emits every tier crossed, in ascending tier order", () => {
		// A member who jumps from nothing to gold gets bronze, silver and gold in
		// the order they were earned rather than an arbitrary one.
		const unlocked = evaluate(counters({ messages: 1_009 }), []).filter((unlock) => unlock.id === "voice-of-the-realm");
		expect(unlocked.map((unlock) => unlock.tier)).toEqual(["bronze", "silver", "gold"]);
	});

	it("emits across several tracks at once", () => {
		const unlocked = idsOf(evaluate(counters({ messages: 53, reactionsGiven: 29, level: 7 }), []));
		expect(unlocked).toEqual(
			expect.arrayContaining(["voice-of-the-realm:bronze", "the-applause:bronze", "ascendant:bronze"])
		);
	});
});

describe("⚠️ a tier's own xp reward cannot unlock anything in the same pass", () => {
	it("reads level from the counters it was handed, never from an award it just emitted", () => {
		// The recursion trap: an unlock grants xp, xp can cross a level, a level
		// changes the "level" and "milestoneLevels" metrics. This is structural
		// rather than defensive, because evaluate is pure and takes a SNAPSHOT: it
		// has no way to apply the xp it returns, so ascendant cannot advance on the
		// bonus that ascendant just paid.
		const state = counters({ level: 7 });
		const unlocked = evaluate(state, []).filter((unlock) => unlock.id === "ascendant");

		expect(unlocked.map((unlock) => unlock.tier)).toEqual(["bronze"]);
		// The xp is REPORTED for the caller to stage, and the counters are untouched.
		expect(unlocked[0].xp).toBeGreaterThan(0);
		expect(state.level).toBe(7);
	});

	it("returns the tier xp for the caller to stage rather than applying it", () => {
		const unlocked = evaluate(counters({ messages: 53 }), []);
		const bronze = unlocked.find((unlock) => unlock.id === "voice-of-the-realm");
		expect(bronze?.xp).toBe(101);
	});
});

describe("hidden tracks are EVALUATED like any other", () => {
	it("unlocks prime-mover normally once its metric qualifies", () => {
		// Hidden governs LISTING, not earning. A secret nobody can unlock is not a
		// secret, it is a dead entry.
		expect(idsOf(evaluate(counters({ milestoneLevels: 5 }), []))).toContain("prime-mover:bronze");
	});

	it("unlocks dero-knows from fortuneReadings", () => {
		expect(idsOf(evaluate(counters({ fortuneReadings: 13 }), []))).toContain("dero-knows:bronze");
	});

	it("unlocks the-assist from assists", () => {
		expect(idsOf(evaluate(counters({ assists: 7 }), []))).toContain("the-assist:bronze");
	});
});

describe("only the top tier can carry a role", () => {
	it("reports roleId on diamond and null everywhere below", () => {
		const unlocked = evaluate(counters({ messages: 5_003 }), []).filter((unlock) => unlock.id === "voice-of-the-realm");
		for (const unlock of unlocked) {
			if (unlock.tier !== "diamond") expect(unlock.roleId).toBeNull();
		}
	});
});

describe("progressFor", () => {
	it("reports the next unearned tier of each track", () => {
		const rows = progressFor(counters({ messages: 60 }), [unlockedKey("voice-of-the-realm", "bronze")]);
		const row = rows.find((entry) => entry.id === "voice-of-the-realm");
		expect(row).toMatchObject({ nextTier: "silver", current: 60, threshold: 251 });
	});

	it("drops a track that is fully complete", () => {
		const held = ACHIEVEMENTS.find((achievement) => achievement.id === "voice-of-the-realm")!.tiers.map((tier) =>
			unlockedKey("voice-of-the-realm", tier.name)
		);
		const rows = progressFor(counters({ messages: 99_999 }), held);
		expect(rows.find((entry) => entry.id === "voice-of-the-realm")).toBeUndefined();
	});

	it("sorts closest to completion first, so a nudge names what is actually near", () => {
		const rows = progressFor(counters({ messages: 52, reactionsGiven: 1 }), []);
		expect(rows[0].id).toBe("voice-of-the-realm");
	});

	it("still reports hidden tracks, leaving the caller to filter them", () => {
		// The filter lives at the /achievements call site on purpose: that is the one
		// place deciding what a member may SEE, and keeping it out of the engine
		// means the engine cannot accidentally stop hidden tracks from unlocking.
		const rows = progressFor(counters(), []);
		expect(rows.some((row) => row.hidden)).toBe(true);
	});
});

describe("buildCounters", () => {
	const games = new Map<string, IGameRecord>([
		["duel", { played: 10, won: 6, lost: 4, drawn: 0, assists: 0 }],
		["hangman", { played: 8, won: 2, lost: 3, drawn: 0, assists: 3 }],
	]);

	it("sums played, won and assists across every game", () => {
		const built = buildCounters({ games }, 5, 3);
		expect(built.gamesPlayed).toBe(18);
		expect(built.gamesWon).toBe(8);
		expect(built.assists).toBe(3);
	});

	it("keeps per game wins separate for the per game tracks", () => {
		const built = buildCounters({ games }, 5, 3);
		expect(built.perGameWon).toEqual({ duel: 6, hangman: 2 });
	});

	it("carries level and milestone count from its arguments, not from the document", () => {
		// Both are DERIVED from totalXp by the caller, because neither is stored.
		const built = buildCounters({ games }, 13, 6);
		expect(built.level).toBe(13);
		expect(built.milestoneLevels).toBe(6);
	});

	it("defaults every counter on a member with no data", () => {
		const built = buildCounters({}, 1, 0);
		expect(built).toMatchObject({ messages: 0, reactionsGiven: 0, voiceMinutes: 0, fortuneReadings: 0, gamesPlayed: 0 });
		expect(evaluate(built, [])).toEqual([]);
	});
});
