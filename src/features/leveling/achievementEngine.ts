import { ACHIEVEMENTS, type AchievementDefinition, type AchievementTier } from "./achievements.js";
import type { IGameRecord } from "./levelingTypes.js";

// ── achievementEngine ──────────────────────────────────────────────────────
// ONE pure function. No discord.js, no store, no clock, no mutable module state.
//
// What:  given a member's counters and what they already hold, return the tiers
//        they have just unlocked.
// Who:   called from the flush path in xpWriter, once per flushed member per
//        flush, and from nowhere else.
// When:  after every flush, for every member the flush touched, whether or not
//        they crossed a level. A member can unlock "sent 53 messages" without
//        leveling at all.
// Where: it reads counters MemberLevel already maintains, so the whole
//        achievement system adds ZERO new listeners and ZERO new writes on the
//        message path. Adding a track later is a data change in
//        achievements.ts, not a code change here.
//
// ⚠️ THE RECURSION TRAP, and it is the one thing that breaks if you get it wrong.
// An unlock grants xp. That xp can cross a level. A level up changes the "level"
// and "milestoneLevels" metrics. If the engine ran from inside an unlock, that
// is a loop that feeds itself.
//
// Two independent things make it impossible rather than merely unlikely:
//   ① CALL SITE. evaluate() is invoked ONLY from the flush path, never from an
//      unlock handler. Unlock xp is STAGED through awardXp with source
//      "achievement", which buffers exactly like message xp, so it lands in the
//      NEXT flush window as an ordinary award rather than re-entering this pass.
//   ② IDEMPOTENCY. An id and tier already present in `unlocked` is never emitted
//      again, however the counters move. So even a caller that ignored ① would
//      terminate: there are 12 tracks of 4 tiers, and each can fire once.
//
// The natural instinct is to evaluate immediately after granting the xp. Do not.

export interface AchievementCounters {
	messages: number;
	reactionsGiven: number;
	voiceMinutes: number;
	fortuneReadings: number;
	level: number;
	milestoneLevels: number;
	gamesPlayed: number;
	gamesWon: number;
	assists: number;
	// Per game wins, for the duelist / strategist / wordsmith tracks.
	perGameWon: Record<string, number>;
}

export interface UnlockedTier {
	id: string;
	tier: AchievementTier["name"];
	threshold: number;
	xp: number;
	earnedBy: string;
	roleId: string | null;
}

// What the member already holds, as `${id}:${tier}` keys.
export const unlockedKey = (id: string, tier: string): string => `${id}:${tier}`;

function readMetric(definition: AchievementDefinition, counters: AchievementCounters): number {
	const metric = definition.metric;
	if (metric.endsWith(".won")) {
		return counters.perGameWon[metric.slice(0, -".won".length)] ?? 0;
	}
	switch (metric) {
		case "messages":
			return counters.messages;
		case "reactionsGiven":
			return counters.reactionsGiven;
		case "voiceMinutes":
			return counters.voiceMinutes;
		case "fortuneReadings":
			return counters.fortuneReadings;
		case "gamesPlayed":
			return counters.gamesPlayed;
		case "gamesWon":
			return counters.gamesWon;
		case "assists":
			return counters.assists;
		case "level":
			return counters.level;
		case "milestoneLevels":
			return counters.milestoneLevels;
		default:
			// A metric added to the type but not to this switch would otherwise read
			// as a permanent zero and its track would never fire, silently.
			return 0;
	}
}

// ── evaluate ───────────────────────────────────────────────────────────────
// Returns every tier newly crossed, in TRACK order and then TIER order, so a
// member who jumps from nothing to gold in one pass gets bronze, silver and gold
// announced in the order they were earned rather than in an arbitrary one.
//
// HIDDEN tracks are evaluated exactly like visible ones. Hidden governs LISTING,
// not earning: a secret nobody can unlock is not a secret, it is a dead entry.
export function evaluate(counters: AchievementCounters, unlocked: readonly string[]): UnlockedTier[] {
	const held = new Set(unlocked);
	const newly: UnlockedTier[] = [];

	for (const definition of ACHIEVEMENTS) {
		const value = readMetric(definition, counters);
		for (const tier of definition.tiers) {
			if (value < tier.threshold) break; // tiers ascend, so nothing after this can qualify
			if (held.has(unlockedKey(definition.id, tier.name))) continue;
			newly.push({
				id: definition.id,
				tier: tier.name,
				threshold: tier.threshold,
				xp: tier.xp,
				// Composed HERE, at unlock time, because /account shows how an
				// achievement was earned and the counter behind it will have moved on
				// by the time anyone opens their profile.
				earnedBy: definition.earnedBy(tier),
				// Only the TOP tier carries a role, when a track declares one.
				roleId: tier.name === "diamond" ? definition.roleId : null,
			});
		}
	}

	return newly;
}

// ── progress, for /account view:achievements ────────────────────────────────────────────
// The next unearned tier of each track and how close the member is to it.
// Returns null for a track that is fully complete, so the caller can drop it.
export interface AchievementProgress {
	id: string;
	label: string;
	nextTier: AchievementTier["name"];
	current: number;
	threshold: number;
	hidden: boolean;
}

export function progressFor(counters: AchievementCounters, unlocked: readonly string[]): AchievementProgress[] {
	const held = new Set(unlocked);
	const rows: AchievementProgress[] = [];

	for (const definition of ACHIEVEMENTS) {
		const value = readMetric(definition, counters);
		const next = definition.tiers.find((tier) => !held.has(unlockedKey(definition.id, tier.name)));
		if (!next) continue; // every tier already held
		rows.push({
			id: definition.id,
			label: definition.label,
			nextTier: next.name,
			current: value,
			threshold: next.threshold,
			hidden: definition.hidden,
		});
	}

	// Closest to completion first, so the two rows /account view:achievements shows are the two
	// worth chasing rather than two arbitrary ones.
	return rows.sort((left, right) => right.current / right.threshold - left.current / left.threshold);
}

// ── counters, read off a MemberLevel document ──────────────────────────────
// Kept here beside the engine so the derivation lives next to the thing it
// feeds, and pure so a test can build counters without a document.
export function buildCounters(
	source: {
		messages?: number;
		reactionsGiven?: number;
		voiceMinutes?: number;
		fortuneReadings?: number;
		games?: Map<string, IGameRecord> | null;
	},
	level: number,
	milestoneLevels: number
): AchievementCounters {
	const perGameWon: Record<string, number> = {};
	let gamesPlayed = 0;
	let gamesWon = 0;
	let assists = 0;

	for (const [slug, record] of source.games ?? new Map<string, IGameRecord>()) {
		perGameWon[slug] = record.won ?? 0;
		gamesPlayed += record.played ?? 0;
		gamesWon += record.won ?? 0;
		assists += record.assists ?? 0;
	}

	return {
		messages: source.messages ?? 0,
		reactionsGiven: source.reactionsGiven ?? 0,
		voiceMinutes: source.voiceMinutes ?? 0,
		fortuneReadings: source.fortuneReadings ?? 0,
		level,
		milestoneLevels,
		gamesPlayed,
		gamesWon,
		assists,
		perGameWon,
	};
}
