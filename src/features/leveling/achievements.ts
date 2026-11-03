import type { LevelingGameSlug } from "./levelingTypes.js";

// ── achievements ───────────────────────────────────────────────────────────
// The twelve tracks, defined in CODE as a frozen array. This follows how
// src/features/fortune/fortunes.ts and src/features/games/hangmanWords.ts
// already hold their content: the definitions ship with the bot, only member
// PROGRESS is persisted, and admin authored achievements are explicitly out of
// scope.
//
// Context worth keeping: Arcane, the bot this feature is modelled on, has NO
// achievements system at all. The word does not appear anywhere in their
// documentation, command list or premium table. The model below is MEE6's
// Achievements plugin, which the owner asked for, plus one thing nobody in the
// category ships (see HIDDEN below).
//
// ⚠️ EVERY TIER THRESHOLD IS A PRIME NUMBER, and so is every tier's xp reward.
// That is a deliberate design signature: prime numbers are also the milestone
// levels in this system. Do NOT round them to 50 / 250 / 1000 / 5000, and do not
// "tidy" the xp values. achievements.test.ts asserts primality independently.
//
// ⚠️ AN ID IS FOREVER. The unlocked array on MemberLevel stores these strings, so
// renaming one orphans every unlock that already references it and the member
// silently loses an achievement they earned. Add a new id instead.

export type AchievementCategory = "messages" | "reactions" | "voice" | "games" | "levels" | "special";

export type AchievementMetric =
	| "messages"
	| "reactionsGiven"
	| "voiceMinutes"
	| "fortuneReadings"
	| "gamesPlayed"
	| "gamesWon"
	| "assists"
	| "level"
	| "milestoneLevels"
	| `${LevelingGameSlug}.won`;

export type TierName = "bronze" | "silver" | "gold" | "diamond";

export interface AchievementTier {
	name: TierName;
	threshold: number;
	xp: number;
}

export interface AchievementDefinition {
	id: string;
	// The member-facing name. The id is a stable key and is never renamed; this
	// is the string /account view:achievements renders, and it CAN change.
	label: string;
	category: AchievementCategory;
	metric: AchievementMetric;
	tiers: readonly AchievementTier[];
	// ⚠️ A hidden track does not appear in /account view:achievements AT ALL until it unlocks.
	// Not as a locked placeholder, not with its name blanked out: a placeholder
	// tells a member a secret exists, which is most of what the secret was.
	hidden: boolean;
	// Granted on the TOP tier only. Null on every track today; the plumbing exists
	// so a guild-specific reward role is a data change rather than a code change.
	roleId: string | null;
	// The human sentence stored on the unlock, composed AT UNLOCK TIME because
	// /account shows HOW an achievement was earned and the counters will have
	// moved on by the time anyone looks.
	earnedBy: (tier: AchievementTier) => string;
}

// The four tier xp rewards, shared by every track so the ladder means the same
// thing everywhere. All four are prime.
const TIER_XP = { bronze: 101, silver: 307, gold: 1013, diamond: 3001 } as const;

const tiers = (bronze: number, silver: number, gold: number, diamond: number): readonly AchievementTier[] => [
	{ name: "bronze", threshold: bronze, xp: TIER_XP.bronze },
	{ name: "silver", threshold: silver, xp: TIER_XP.silver },
	{ name: "gold", threshold: gold, xp: TIER_XP.gold },
	{ name: "diamond", threshold: diamond, xp: TIER_XP.diamond },
];

export const ACHIEVEMENTS: readonly AchievementDefinition[] = Object.freeze([
	{
		id: "voice-of-the-realm",
		label: "Voice of the Realm",
		category: "messages",
		metric: "messages",
		tiers: tiers(53, 251, 1009, 5003),
		hidden: false,
		roleId: null,
		earnedBy: (tier) => `sent ${tier.threshold.toLocaleString()} messages`,
	},
	{
		id: "the-applause",
		label: "The Applause",
		category: "reactions",
		metric: "reactionsGiven",
		tiers: tiers(29, 101, 503, 2003),
		hidden: false,
		roleId: null,
		earnedBy: (tier) => `gave ${tier.threshold.toLocaleString()} reactions`,
	},
	{
		id: "round-table",
		label: "Round Table",
		category: "voice",
		metric: "voiceMinutes",
		tiers: tiers(61, 251, 1009, 3001),
		hidden: false,
		roleId: null,
		earnedBy: (tier) => `spent ${tier.threshold.toLocaleString()} minutes in voice`,
	},
	{
		id: "contender",
		label: "Contender",
		category: "games",
		metric: "gamesPlayed",
		tiers: tiers(11, 41, 151, 503),
		hidden: false,
		roleId: null,
		earnedBy: (tier) => `played ${tier.threshold.toLocaleString()} rounds`,
	},
	{
		id: "champion",
		label: "Champion",
		category: "games",
		metric: "gamesWon",
		tiers: tiers(5, 23, 101, 251),
		hidden: false,
		roleId: null,
		earnedBy: (tier) => `won ${tier.threshold.toLocaleString()} rounds`,
	},
	// ── the two head to head tracks ──
	// ONE track ("duelist", metric "duel.won") until 2026-08-12, when duel split
	// into coin flip and dice roll. It became two tracks rather than one pointed
	// at half the game, because the metric can only name a single slug and
	// choosing either one would have silently stopped counting the other. Same
	// thresholds on both, so neither is the harder achievement.
	//
	// Note `gamesWon` still aggregates across every game, so a member who spreads
	// their wins is not disadvantaged overall by the split; these two only reward
	// specialising.
	{
		id: "coin-caller",
		label: "Coin Caller",
		category: "games",
		metric: "coinflip.won",
		tiers: tiers(3, 17, 71, 199),
		hidden: false,
		roleId: null,
		earnedBy: (tier) => `won ${tier.threshold} coin flips`,
	},
	{
		id: "dice-roller",
		label: "Dice Roller",
		category: "games",
		metric: "diceroll.won",
		tiers: tiers(3, 17, 71, 199),
		hidden: false,
		roleId: null,
		earnedBy: (tier) => `won ${tier.threshold} dice rolls`,
	},
	{
		id: "strategist",
		label: "Strategist",
		category: "games",
		metric: "rps.won",
		tiers: tiers(3, 17, 71, 199),
		hidden: false,
		roleId: null,
		earnedBy: (tier) => `won ${tier.threshold} rounds of rock paper scissors`,
	},
	{
		id: "wordsmith",
		label: "Wordsmith",
		category: "games",
		metric: "hangman.won",
		tiers: tiers(3, 13, 53, 151),
		hidden: false,
		roleId: null,
		earnedBy: (tier) => `solved ${tier.threshold} hangman rounds`,
	},
	{
		id: "ascendant",
		label: "Ascendant",
		category: "levels",
		metric: "level",
		tiers: tiers(7, 23, 47, 89),
		hidden: false,
		roleId: null,
		earnedBy: (tier) => `reached level ${tier.threshold}`,
	},

	// ── the three hidden tracks ──
	// The differentiator, and nearly free given this schema. MEE6 ships none, and
	// the dedicated Achievements bot only offers USER controlled privacy, which is
	// a different thing entirely: these are DESIGNER hidden.
	{
		// ⚠️ The one that ties the whole system together, so get it right. It is
		// hidden, and it rewards reaching PRIME levels, which a member only
		// discovers by hitting a few and noticing the pattern. That is the
		// achievement people screenshot.
		id: "prime-mover",
		label: "Prime Mover",
		category: "special",
		metric: "milestoneLevels",
		tiers: tiers(5, 11, 19, 31),
		hidden: true,
		roleId: null,
		earnedBy: (tier) => `reached ${tier.threshold} milestone levels`,
	},
	{
		id: "the-assist",
		label: "The Assist",
		category: "games",
		metric: "assists",
		tiers: tiers(7, 29, 101, 251),
		hidden: true,
		roleId: null,
		earnedBy: (tier) => `set up ${tier.threshold} wins for somebody else`,
	},
	{
		id: "dero-knows",
		label: "Dero Knows",
		category: "special",
		metric: "fortuneReadings",
		tiers: tiers(13, 53, 199, 601),
		hidden: true,
		roleId: null,
		earnedBy: (tier) => `asked Dero ${tier.threshold} questions`,
	},
] satisfies AchievementDefinition[]);

// Fast lookup for the unlock path and for /account view:achievements, built once.
export const ACHIEVEMENTS_BY_ID: ReadonlyMap<string, AchievementDefinition> = new Map(
	ACHIEVEMENTS.map((achievement) => [achievement.id, achievement])
);
