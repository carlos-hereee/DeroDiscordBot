import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { CurvePreset } from "./levelCurve.js";
import type { MultiplierRule, RestrictionMode } from "./xpRules.js";
import type { WeekStart } from "@features/leaderboard/leaderboardWindow.js";

// ── levelingConfig ─────────────────────────────────────────────────────────
// One TTL cached, fully normalized read of a guild's leveling settings.
//
// What:  turns the loosely typed GuildConfig document into a typed settings
//        object with every field guaranteed present and sane.
// Who:   messageXp, reactionXp, voiceXp, awardXp and levelUpAnnouncer. Five
//        callers, which is exactly why the cache lives here and not in one of
//        them (rule 17: one helper per concept).
// When:  on EVERY message the bot sees, which is the whole reason this file
//        exists. A findByGuildId per message would put a database round trip on
//        the hot path of a process that has never had one.
// Where: GuildConfig is declared without a TypeScript interface (the model is
//        `mongoose.model("GuildConfig", schema)` with no generic), so every
//        consumer would otherwise be casting the same nested subtree by hand and
//        each would get the defaults subtly wrong. Normalizing once here means
//        a legacy row, a row edited directly in Mongo, and a freshly configured
//        row all reach the listeners in the same shape.
// How:   ① cache hit inside the TTL wins. ② otherwise read, normalize, cache.
//        ③ a guild with no config row at all caches a NULL, so a bot sitting in
//        a guild that never ran /setup does not re-query on every message.
//
// ⚠️ Mongoose applies schema defaults when it hydrates a document, so a row
// written before the leveling subtree existed already loads with the whole
// subtree defaulted. The normalization below is therefore belt and braces
// rather than a migration, and it earns its keep on the OTHER path: a row a
// human edited directly in Mongo, where a number can be a string and an enum
// can be a value the schema no longer knows.

// How long a resolved answer is trusted. Short enough that an admin who just
// ran /setup-level-system sees the change without wondering whether it saved,
// long enough that a busy channel is not re-reading config every few messages.
// invalidate() below is the exact path for making a change visible instantly.
const CONFIG_TTL_MS = 30_000;

export interface LevelingMessageSettings {
	enabled: boolean;
	min: number;
	max: number;
	cooldownSeconds: number;
}

export interface LevelingReactionSettings {
	enabled: boolean;
	min: number;
	max: number;
	cooldownSeconds: number;
	awards: "reactor" | "author" | "both";
}

export interface LevelingVoiceSettings {
	enabled: boolean;
	perMinute: number;
	cooldownSeconds: number;
	// ⚠️ EMPTY MEANS NOBODY EARNS. See the schema comment in GuildConfig.ts.
	approvedChannels: string[];
	minMembers: number;
	decayAfterMinutes: number;
	decayFactor: number;
}

export interface LevelingSettings {
	enabled: boolean;
	curve: CurvePreset;
	curveMultiplier: number;
	maxLevel: number | null;
	milestoneMode: "prime" | "everyN";
	milestoneEveryN: number;
	message: LevelingMessageSettings;
	reaction: LevelingReactionSettings;
	voice: LevelingVoiceSettings;
	announceMode: "announcements" | "current" | "milestone" | "off";
	announceChannelId: string | null;
	reactionEmoji: string;
	restrictionMode: RestrictionMode;
	restrictedChannels: string[];
	restrictedRoles: string[];
	stackRewards: boolean;
	rewards: Array<{ level: number; roleId: string }>;
	roleMultipliers: MultiplierRule[];
	channelMultipliers: MultiplierRule[];
	stackMultipliers: boolean;
}

export interface GuildLevelingContext {
	settings: LevelingSettings;
	// Read straight off the guild config because the announcer needs them and
	// re-reading the document there would defeat this cache.
	announcementsChannelId: string | null;
	adminChannelId: string | null;
	leaderboardChannelId: string | null;
	weekStart: WeekStart;
	homebaseDestroyed: boolean;
	// The guild's owner-authored copy overrides, carried through in the shape
	// getCopyOverride expects (it accepts anything exposing a .get). The level up
	// congratulations is the ONE string in this feature with a real voice, so it
	// is overridable per guild under the keys "leveling.levelUp" and
	// "leveling.milestone"; carrying the map here means the announcer does not
	// re-read the document and defeat this cache to resolve it.
	copyOverrides: { get?: (key: string) => string | undefined } | null;
}

interface CacheEntry {
	value: GuildLevelingContext | null;
	expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// Test seams, matching the `_clearEarlyAccessCache` convention used across the
// entitlement modules.
export const _clearLevelingConfigCache = (): void => cache.clear();
export const _levelingConfigCacheSize = (): number => cache.size;

// Drop one guild's cached answer. Called by /setup-level-system after a write so
// an admin sees their change immediately rather than up to a TTL later, which is
// the difference between "it saved" and "did that work?".
export function invalidateLevelingConfig(guildId: string): void {
	cache.delete(guildId);
}

// ── numeric coercion ──
// A hand edited Mongo row can hold a string where a number belongs, and NaN
// propagates silently through a multiplier into a $inc. Every numeric read below
// goes through here so one bad field degrades to its default rather than
// poisoning a member's total.
function num(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function multiplierList(value: unknown, idKey: "roleId" | "channelId"): MultiplierRule[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => {
			const row = entry as Record<string, unknown>;
			return { id: String(row?.[idKey] ?? ""), multiplier: num(row?.multiplier, 1) };
		})
		.filter((rule) => rule.id.length > 0);
}

// Clamp a cooldown into the range /setup-level-system enforces, so a value
// written straight into Mongo cannot exceed what the sweep considers expirable.
function cooldown(value: unknown, fallback: number): number {
	return Math.min(BOT_CONSTANTS.LEVELING.MAX_COOLDOWN_SECONDS, Math.max(1, num(value, fallback)));
}

export function normalizeLevelingSettings(raw: unknown): LevelingSettings {
	const source = (raw ?? {}) as Record<string, unknown>;
	const message = (source.message ?? {}) as Record<string, unknown>;
	const reaction = (source.reaction ?? {}) as Record<string, unknown>;
	const voice = (source.voice ?? {}) as Record<string, unknown>;

	const maxLevelRaw = source.maxLevel;
	return {
		// Defaults TRUE here as well as in the schema, so a row whose subtree was
		// somehow written as an empty object still earns. Leveling ships on.
		enabled: bool(source.enabled, true),
		curve: oneOf(source.curve, ["dero", "linear", "exponential", "flat"] as const, "dero"),
		curveMultiplier: num(source.curveMultiplier, 1),
		maxLevel: maxLevelRaw === null || maxLevelRaw === undefined ? null : num(maxLevelRaw, 0) || null,
		milestoneMode: oneOf(source.milestoneMode, ["prime", "everyN"] as const, "prime"),
		milestoneEveryN: Math.max(1, num(source.milestoneEveryN, 5)),

		message: {
			enabled: bool(message.enabled, true),
			min: Math.max(1, num(message.min, 15)),
			max: Math.max(1, num(message.max, 40)),
			cooldownSeconds: cooldown(message.cooldownSeconds, 60),
		},
		reaction: {
			enabled: bool(reaction.enabled, true),
			min: Math.max(1, num(reaction.min, 10)),
			max: Math.max(1, num(reaction.max, 25)),
			cooldownSeconds: cooldown(reaction.cooldownSeconds, 300),
			awards: oneOf(reaction.awards, ["reactor", "author", "both"] as const, "reactor"),
		},
		voice: {
			enabled: bool(voice.enabled, true),
			perMinute: Math.max(1, num(voice.perMinute, 5)),
			cooldownSeconds: cooldown(voice.cooldownSeconds, 180),
			// No default population here, and that is the point: an unset list
			// normalizes to EMPTY, and empty means nobody earns voice xp.
			approvedChannels: stringList(voice.approvedChannels),
			minMembers: Math.max(1, num(voice.minMembers, 2)),
			decayAfterMinutes: Math.max(1, num(voice.decayAfterMinutes, 120)),
			// Clamped to [0, 1]: a "decay" above 1 would be a bonus for idling,
			// which is the exact opposite of what the setting exists for.
			decayFactor: Math.min(1, Math.max(0, num(voice.decayFactor, 0.25))),
		},

		announceMode: oneOf(source.announceMode, ["announcements", "current", "milestone", "off"] as const, "announcements"),
		announceChannelId: typeof source.announceChannelId === "string" ? source.announceChannelId : null,
		reactionEmoji: typeof source.reactionEmoji === "string" && source.reactionEmoji.length > 0 ? source.reactionEmoji : "🎉",

		restrictionMode: oneOf(source.restrictionMode, ["exclude", "only"] as const, "exclude"),
		restrictedChannels: stringList(source.restrictedChannels),
		restrictedRoles: stringList(source.restrictedRoles),

		stackRewards: bool(source.stackRewards, true),
		rewards: Array.isArray(source.rewards)
			? source.rewards
					.map((entry) => {
						const row = entry as Record<string, unknown>;
						return { level: num(row?.level, 0), roleId: String(row?.roleId ?? "") };
					})
					.filter((reward) => reward.level > 0 && reward.roleId.length > 0)
			: [],
		roleMultipliers: multiplierList(source.roleMultipliers, "roleId"),
		channelMultipliers: multiplierList(source.channelMultipliers, "channelId"),
		stackMultipliers: bool(source.stackMultipliers, false),
	};
}

// ── peekLevelingConfig ──
// The cached answer if it is warm, undefined if it is not. Deliberately
// SYNCHRONOUS, and it exists for exactly one caller: the message listener needs
// the guild's cooldown window before it can claim a cooldown, and the claim must
// happen without the event loop yielding. Peeking first means the common case
// (a warm cache, which is every message after the first in a 30 second window)
// reaches the claim with no await in front of it at all. A cold peek falls back
// to the async read, which is correct but simply slower.
export function peekLevelingConfig(guildId: string, now: number = Date.now()): GuildLevelingContext | null | undefined {
	const cached = cache.get(guildId);
	if (cached && cached.expiresAt > now) return cached.value;
	return undefined;
}

export async function getLevelingConfig(guildId: string, now: number = Date.now()): Promise<GuildLevelingContext | null> {
	const cached = cache.get(guildId);
	if (cached && cached.expiresAt > now) return cached.value;

	let value: GuildLevelingContext | null = null;
	try {
		const config = await guildConfigStore.findByGuildId(guildId);
		if (config) {
			const raw = config as unknown as Record<string, unknown>;
			value = {
				settings: normalizeLevelingSettings(raw.leveling),
				announcementsChannelId: (raw.announcementsChannelId as string | null) ?? null,
				adminChannelId: (raw.adminChannelId as string | null) ?? null,
				leaderboardChannelId: (raw.leaderboardChannelId as string | null) ?? null,
				weekStart: raw.weekStart === "monday" ? "monday" : "sunday",
				homebaseDestroyed: bool(raw.homebaseDestroyed, false),
				copyOverrides: (raw.copyOverrides as { get?: (key: string) => string | undefined } | undefined) ?? null,
			};
		}
	} catch (err) {
		// A database blip must not take the message path down with it. Caching the
		// null briefly means a recovered database is picked up within the TTL
		// instead of being hammered once per message while it is struggling.
		console.warn(`[leveling] config read failed for guild ${guildId}, treating as unconfigured`, err);
		value = null;
	}

	// A guild with NO config row caches the null too. Without that, a bot sitting
	// in a guild that never ran /setup would query on literally every message.
	cache.set(guildId, { value, expiresAt: now + CONFIG_TTL_MS });
	return value;
}
