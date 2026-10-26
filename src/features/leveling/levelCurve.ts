// ── levelCurve ─────────────────────────────────────────────────────────────
// The leveling system's arithmetic, kept PURE and separate from every writer,
// command, board and announcer, the same split versusResolve.ts / versusHandler.ts,
// rpsWinner.ts / rpsHandler.ts and hangmanState.ts / hangmanHandler.ts already
// draw. No discord.js, no store, no I/O, no clock. The one piece of module state
// is a memo table that is a pure function of its key, so two calls with the same
// arguments can never see different answers.
//
// What:  converts between a member's TOTAL xp and their level, in both
//        directions, under a selectable curve preset and a per guild multiplier.
// Who:   xpWriter (level up detection on every flush), /account and /account view:levels (the
//        progress bar and the standings), the achievement engine (the "level"
//        and "milestoneLevels" metrics), /leveling xp set-level (admin correction).
// When:  on the flush path, so several times a second on a busy guild. Every
//        design choice below is about keeping that cheap.
// Where: the durable truth is MemberLevel.totalXp and NOTHING else. `level` is
//        deliberately not a stored field: a stored level is a second source of
//        truth that drifts the instant an admin runs /leveling xp set or a guild changes
//        its curve preset, so it is derived here every time it is needed.

export type CurvePreset = "dero" | "linear" | "exponential" | "flat";

export const CURVE_PRESETS = ["dero", "linear", "exponential", "flat"] as const;

// The owner's chosen default (locked decision D1). Sits deliberately between
// Arcane's linear preset and the steeper exponentials: level 50 lands at roughly
// 6,684 messages against 4,589 for Arcane linear and 9,711 for Arcane
// exponential, with MEE6's published curve at 9,756.
export const DEFAULT_CURVE_PRESET: CurvePreset = "dero";

// Highest level the prefix table is built to. Every lookup below is a bounded
// array read rather than an unbounded loop, so this number is what makes
// levelFromTotalXp O(log n) instead of O(level). 1000 is far past anything a
// real member reaches (the dero curve puts level 1000 at ~1.02 billion xp) and
// costs one 1001-entry array per (preset, multiplier) pair actually in use.
export const MAX_LEVEL_CEILING = 1000;

// ── the four presets ────────────────────────────────────────────────────────
// Each returns the xp required to COMPLETE level n, before the guild multiplier.
//
// ⚠️ The dero coefficients 3, 47 and 101 are ALL PRIME, and that is deliberate,
// not an accident of tuning. It pairs with primeLevels.ts, where prime levels are
// the milestone levels. Do not "tidy" them into round numbers.
//
// `exponential` is ARCANE's exponential preset, not MEE6's. MEE6 publishes
// 5n^2 + 50n + 100; the 75 here is Arcane's. They differ by 25 xp per level and
// mixing them up would silently reprice every guild that picked this preset.
const PRESET_COST: Record<CurvePreset, (level: number) => number> = {
	dero: (level) => 3 * level * level + 47 * level + 101,
	linear: (level) => level * 100 + 75,
	exponential: (level) => 5 * level * level + level * 50 + 75,
	flat: () => 1000,
};

// A guild row can hold a preset string that a later release removed from the
// enum, and Mongoose hands the stale value straight back. Falling back keeps
// that row rendering a sane curve instead of throwing inside a hot flush.
function costFor(preset: CurvePreset): (level: number) => number {
	return PRESET_COST[preset] ?? PRESET_COST[DEFAULT_CURVE_PRESET];
}

// A multiplier that is zero, negative, NaN or Infinity would poison every level
// derived from it AND the memo key, so it is normalized once, here, rather than
// guarded at each of the five call sites. /leveling settings clamps this to
// 0.1 through 100 at the command layer; this is the last line of defense for a
// row edited directly in Mongo.
function normalizeMultiplier(multiplier: number): number {
	return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
}

function safeXp(totalXp: number): number {
	return Number.isFinite(totalXp) && totalXp > 0 ? totalXp : 0;
}

// A guild's maxLevel caps progression below the table's ceiling. null means
// uncapped, which still means the table ceiling, because nothing above it has a
// precomputed cumulative cost.
function effectiveCeiling(maxLevel: number | null | undefined): number {
	if (maxLevel === null || maxLevel === undefined || !Number.isFinite(maxLevel)) return MAX_LEVEL_CEILING;
	return Math.min(MAX_LEVEL_CEILING, Math.max(1, Math.floor(maxLevel)));
}

// ── xpForLevel ──────────────────────────────────────────────────────────────
// The xp needed to COMPLETE level n and stand at level n + 1.
//
// ROUNDS, never floors. Arcane rounds, and the difference is visible: a cost of
// 1075 at multiplier 0.5 is 537.5, which must resolve to 538, not 537.
//
// The floor of 1 is load bearing rather than defensive. A level that costs 0 xp
// would make the cumulative table below non strictly increasing, and a binary
// search over a flat run returns an arbitrary member of that run, so a tiny
// multiplier would make a member's level nondeterministic at the same totalXp.
export function xpForLevel(level: number, preset: CurvePreset = DEFAULT_CURVE_PRESET, multiplier = 1): number {
	if (!Number.isFinite(level) || level < 1) return 0;
	return Math.max(1, Math.round(costFor(preset)(Math.floor(level)) * normalizeMultiplier(multiplier)));
}

// ── the cumulative table, computed once per (preset, multiplier) pair ───────
// index L holds the total xp required to REACH level L. Index 0 and index 1 are
// both 0: a member starts at level 1 owing nothing, which is why their first
// level up is to level 2 (151 xp on the dero curve, roughly six messages).
//
// ⚠️ Build this ONCE and binary search it. The obvious implementation, and what
// most tutorial code in this category does, is to loop and subtract per call:
// that is O(level) on a path that runs on every flushed member of every flush,
// and it becomes real CPU on a busy guild. It is also why nothing here ever
// touches the database to answer "what level is this".
const prefixCache = new Map<string, number[]>();

function prefixSums(preset: CurvePreset, multiplier: number): number[] {
	const normalized = normalizeMultiplier(multiplier);
	const key = `${preset}:${normalized}`;
	const cached = prefixCache.get(key);
	if (cached) return cached;

	const table = new Array<number>(MAX_LEVEL_CEILING + 1);
	table[0] = 0;
	table[1] = 0;
	for (let level = 2; level <= MAX_LEVEL_CEILING; level += 1) {
		table[level] = table[level - 1] + xpForLevel(level - 1, preset, normalized);
	}

	prefixCache.set(key, table);
	return table;
}

// ── totalXpForLevel ─────────────────────────────────────────────────────────
// Cumulative xp required to REACH the given level. The exact inverse of
// levelFromTotalXp at every level boundary, which is the property the whole
// progress bar rests on and which the suite sweeps.
export function totalXpForLevel(
	level: number,
	preset: CurvePreset = DEFAULT_CURVE_PRESET,
	multiplier = 1
): number {
	const table = prefixSums(preset, multiplier);
	if (!Number.isFinite(level) || level <= 1) return 0;
	if (level >= MAX_LEVEL_CEILING) return table[MAX_LEVEL_CEILING];
	return table[Math.floor(level)];
}

// ── levelFromTotalXp ────────────────────────────────────────────────────────
// The hot one. A binary search for the highest level whose cumulative cost the
// member has already paid.
//
// Never throws, whatever it is handed: a negative balance (possible after an
// admin /leveling xp remove), zero, a NaN read back from a corrupted row, or an amount
// past the table's ceiling all resolve to a level inside [1, ceiling].
export function levelFromTotalXp(
	totalXp: number,
	preset: CurvePreset = DEFAULT_CURVE_PRESET,
	multiplier = 1,
	maxLevel: number | null = null
): number {
	const xp = safeXp(totalXp);
	if (xp <= 0) return 1;

	const table = prefixSums(preset, multiplier);
	const ceiling = effectiveCeiling(maxLevel);

	// Upper-biased midpoint so the search converges on the HIGHEST level whose
	// entry is still within budget. A floored midpoint here would loop forever
	// once low and high are adjacent.
	let low = 1;
	let high = ceiling;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (table[mid] <= xp) low = mid;
		else high = mid - 1;
	}
	return low;
}

// ── the progress bar's two numbers ──────────────────────────────────────────
// xpIntoLevel + xpToNextLevel === xpForLevel(currentLevel), always, which is
// what lets /account render a bar from these two alone without a third lookup.
// The one exception is a member sitting at the cap, where there is no next
// level to fill and xpToNextLevel is 0 by definition.

export function xpIntoLevel(
	totalXp: number,
	preset: CurvePreset = DEFAULT_CURVE_PRESET,
	multiplier = 1,
	maxLevel: number | null = null
): number {
	const xp = safeXp(totalXp);
	const level = levelFromTotalXp(xp, preset, multiplier, maxLevel);
	return Math.max(0, xp - totalXpForLevel(level, preset, multiplier));
}

export function xpToNextLevel(
	totalXp: number,
	preset: CurvePreset = DEFAULT_CURVE_PRESET,
	multiplier = 1,
	maxLevel: number | null = null
): number {
	const xp = safeXp(totalXp);
	const level = levelFromTotalXp(xp, preset, multiplier, maxLevel);
	// At the cap there is nothing further to earn toward, so the bar reads full
	// rather than counting up to a level the member can never reach.
	if (level >= effectiveCeiling(maxLevel)) return 0;
	return Math.max(0, totalXpForLevel(level + 1, preset, multiplier) - xp);
}

// Test seam. The memo is a pure function of its key so clearing it can never
// change an answer; it exists so a suite can prove the table is built once.
export const _clearCurveCache = (): void => prefixCache.clear();

export const _curveCacheSize = (): number => prefixCache.size;
