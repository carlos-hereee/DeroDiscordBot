import { TextChannel, type Guild, type Message } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IOverwriteEntry } from "./communityOverwrites.js";

// ── adoption ─────────────────────────────────────────────────────────
// What:  finds a channel the server ALREADY has for a job Dero is about to build
//        a channel for (a welcome log, a rules channel), moves it into 🪧 NOTICE
//        BOARD when an admin chose that, and decides whether Dero may post its own
//        intro there (2026-10 item 247 Phase 2). It never deletes, renames or
//        rewrites a message, and it never decides which channels are adoptable or
//        whether one moves: the pattern lists live in BOT_CONSTANTS, the overwrite
//        shape in communityOverwrites, and the admin's choice in adoptionChoice.
// Who:   GuildSetupManager: createChannels (fresh install and forced rebuild) and
//        repairOneChannel (the boot sweep and ChannelDeleteWatcher), before either
//        builds the welcome or rules channel; populateChannels, repairOneChannel and
//        refreshIntroEmbeds ask the content gate before posting into an adopted one.
// When:  a scan reads guild.channels.cache only (no API call). The move costs two
//        writes, once per adopted channel. The content gate costs one message fetch.
// Where: the adopted id is recorded on GuildConfig.adoptedChannelIds by the
//        caller, which is what /self-destruct reads to leave the channel standing.
// How:   ① normalize a name (drop its leading emoji and symbols, lowercase it) and
//        require an EXACT match with a pattern, never a substring, so
//        "📋arcade-rules" or "rules-chat" are never taken (risk R2 in the plan);
//        ② prefer a match already inside the notice board, then the lowest
//        position; ③ moving keeps every overwrite Dero does not manage, and writes
//        the overwrites BEFORE the parent, so a refusal leaves the channel untouched.
//        For the welcome slot, Discord's own system channel (where Discord already
//        posts its join messages) is looked at before any name (post-launch plan
//        item 2); for the rules slot, the server's Community rules channel is, so
//        Dero never builds a second rules channel while the server has one
//        (2026-10 item 257).

// ── types ────────────────────────────────────────────────────────────

/** Channels a scan must pass over: ids already stored under another slot, and Dero's own channel names. */
export interface IAdoptionExclusions {
	ids?: ReadonlySet<string>;
	names?: ReadonlySet<string>;
}

/**
 * The server's own welcome or rules channel, and whether it must stay IN PLACE: true
 * for a system channel whose name is not a welcome name (a #general), the server's
 * main chat, which is never offered a move because the notice board's read only
 * shape would silence it. Any other candidate moves only when an admin chose so.
 */
export interface IAdoptionCandidate {
	channel: TextChannel;
	inPlace: boolean;
}

/** The slice of a fetched message the content gate reads. */
export interface IAdoptionMessage {
	author: { id: string };
}

// ── constants ────────────────────────────────────────────────────────

const ADOPTION_REASON = "Dero adopted this channel into the notice board";
// Everything before the first letter or digit, in any script: emoji, their
// variation selectors, and the symbols servers decorate channel names with.
const LEADING_DECORATION = /^[^\p{L}\p{N}]+/u;

// ── matching ─────────────────────────────────────────────────────────

/** A channel name reduced to the base an adoption pattern is compared with: no leading emoji or symbols, lowercase. */
export function normalizeAdoptionName(name: string): string {
	return name.replace(LEADING_DECORATION, "").toLowerCase();
}

/** True when a channel name's base is exactly one of the patterns. */
export function matchesAdoptionPattern(name: string, patterns: readonly string[]): boolean {
	const base = normalizeAdoptionName(name);
	return base.length > 0 && patterns.includes(base);
}

// ── the scan ─────────────────────────────────────────────────────────

/**
 * The server's own text channel to adopt for a pattern list, or null when it has
 * none. Reads the cache only, so it costs nothing and changes nothing; the move is
 * moveIntoNoticeBoard. On a tie, a match already inside the notice board wins
 * (it needs no move), then the lowest position, then the oldest channel.
 */
export function scanAndClaim(
	guild: Pick<Guild, "channels">,
	category: { id: string },
	patterns: readonly string[],
	exclude: IAdoptionExclusions = {}
): TextChannel | null {
	// A real Guild always carries the cache; a partial one (a payload not yet
	// hydrated, a test fake) has none, and "nothing to adopt" is the safe reading.
	const candidates = [...(guild.channels.cache?.values() ?? [])].filter(
		(channel): channel is TextChannel =>
			// A text channel only: the slot is typed TextChannel everywhere downstream,
			// and an announcement or forum channel named "rules" cannot take Dero's posts.
			channel instanceof TextChannel && isAdoptable(channel, exclude) && matchesAdoptionPattern(channel.name, patterns)
	);
	if (candidates.length === 0) return null;
	return candidates.sort((a, b) => claimOrder(a, b, category.id))[0] ?? null;
}

/**
 * The server's own welcome channel, or null. Discord's system channel comes first,
 * because it is the one channel the server itself names as where members arrive;
 * then the scan by name (scanAndClaim). A system channel carrying a welcome name is
 * moved like any name match. One with another name (Discord's default is #general)
 * is the server's main chat, so it is taken in place (IWelcomeCandidate.inPlace).
 * Reads the cache only.
 */
export function findWelcomeChannel(
	guild: Pick<Guild, "channels" | "systemChannelId">,
	category: { id: string },
	patterns: readonly string[],
	exclude: IAdoptionExclusions = {}
): IAdoptionCandidate | null {
	const system = guild.systemChannelId ? guild.channels.cache?.get(guild.systemChannelId) : undefined;
	if (system instanceof TextChannel && isAdoptable(system, exclude)) {
		return { channel: system, inPlace: !matchesAdoptionPattern(system.name, patterns) };
	}
	const named = scanAndClaim(guild, category, patterns, exclude);
	return named ? { channel: named, inPlace: false } : null;
}

/**
 * The server's own rules channel, or null. Discord's Community rules channel comes
 * first, whatever it is named, because it is the one the server itself names as its
 * rules; then the scan by name (scanAndClaim). Never in place: it is offered a move
 * like any name match. Reads the cache only.
 */
export function findRulesChannel(
	guild: Pick<Guild, "channels" | "rulesChannelId">,
	category: { id: string },
	patterns: readonly string[],
	exclude: IAdoptionExclusions = {}
): IAdoptionCandidate | null {
	const own = guild.rulesChannelId ? guild.channels.cache?.get(guild.rulesChannelId) : undefined;
	if (own instanceof TextChannel && isAdoptable(own, exclude)) return { channel: own, inPlace: false };
	const named = scanAndClaim(guild, category, patterns, exclude);
	return named ? { channel: named, inPlace: false } : null;
}

// ── the claim ────────────────────────────────────────────────────────

/**
 * Move an adopted channel under the notice board and onto Dero's managed entries,
 * keeping every overwrite Dero does not manage (a role the owner set by hand).
 * A channel already in the notice board is left exactly as it is. Resolves true
 * when it moved; throws what Discord throws, and a refused overwrite throws before
 * anything changed.
 */
export async function moveIntoNoticeBoard(channel: TextChannel, category: { id: string }, overwrites: IOverwriteEntry[]): Promise<boolean> {
	if (channel.parentId === category.id) return false;

	// Read before the write. lockPermissions false keeps the channel's own entries
	// rather than syncing them to the category, which would wipe what the owner set.
	const managedIds = new Set(overwrites.map((entry) => entry.id));
	const foreign = [...channel.permissionOverwrites.cache.values()].filter((overwrite) => !managedIds.has(overwrite.id));
	// The overwrite FIRST: Discord can refuse it (350003 on a channel Onboarding uses,
	// 50013 on one the owner locked down), and with the parent set first that refusal
	// left the channel half moved, which made setup build a second rules channel
	// (2026-10 item 257, item 2). Refused here, the channel has not moved at all.
	await channel.permissionOverwrites.set([...overwrites, ...foreign], ADOPTION_REASON);
	await channel.setParent(category.id, { lockPermissions: false, reason: ADOPTION_REASON });
	return true;
}

// ── the stored record ────────────────────────────────────────────────

/**
 * The adopted channel ids on a stored GuildConfig row. A legacy row predates the
 * field and a hydrated document hands back a MongooseArray, so every reader comes
 * through here rather than trusting the shape.
 */
export function readAdoptedChannelIds(stored: unknown): string[] {
	const ids = (stored as { adoptedChannelIds?: unknown } | null | undefined)?.adoptedChannelIds;
	return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/** An admin's answer for one adopted channel: move it into the notice board, or leave it where it is. */
export type AdoptionChoice = "move" | "stay";

/**
 * The admin's stored answer for one adopted channel, or null when nobody has chosen.
 * A hydrated document hands back a Map and a lean read a plain object, so both shapes
 * are read here rather than at every caller.
 */
export function readAdoptionChoice(stored: unknown, channelId: string): AdoptionChoice | null {
	const choices = (stored as { adoptedChannelChoices?: unknown } | null | undefined)?.adoptedChannelChoices;
	const value = choices instanceof Map ? choices.get(channelId) : (choices as Record<string, unknown> | undefined)?.[channelId];
	return value === "move" || value === "stay" ? value : null;
}

// ── the content gate ─────────────────────────────────────────────────

/**
 * Whether Dero may post its intro in an adopted channel, given its recent messages:
 * yes when there are none, or when one of them is Dero's own intro (isDeroMarker),
 * and no when the channel holds only someone else's content.
 */
export function acceptsDeroContent<M extends IAdoptionMessage>(messages: Iterable<M>, isDeroMarker: (message: M) => boolean): boolean {
	let sawAny = false;
	for (const message of messages) {
		sawAny = true;
		if (isDeroMarker(message)) return true;
	}
	return !sawAny;
}

/**
 * The content gate over one fetch of the channel's most recent messages. A failed
 * fetch reads as "owner content": with no way to see the channel, leaving it alone
 * is the only answer that can never post over what the owner wrote.
 */
export async function fetchAcceptsDeroContent(channel: Pick<TextChannel, "id" | "messages">, isDeroMarker: (message: Message) => boolean): Promise<boolean> {
	try {
		const recent = await channel.messages.fetch({ limit: BOT_CONSTANTS.ADOPTION_CONTENT_SCAN_LIMIT });
		return acceptsDeroContent(recent.values(), isDeroMarker);
	} catch (error) {
		console.warn(`[adoption] could not read channel ${channel.id}; leaving its content alone`, error);
		return false;
	}
}

// ── helpers ──────────────────────────────────────────────────────────

// Not an id already stored under another slot, and not a channel carrying Dero's own
// name: one outside our category belongs to another Dero instance sharing this
// server (a dev bot beside prod), or is an orphan of our own, and adopting it would
// move it out from under its owner.
function isAdoptable(channel: TextChannel, exclude: IAdoptionExclusions): boolean {
	return !exclude.ids?.has(channel.id) && !exclude.names?.has(channel.name);
}

// rawPosition, not position: discord.js derives position by walking the guild's
// channel cache, while rawPosition is Discord's own sort value for the channel.
// Snowflakes grow with time, so a shorter id is always the older channel.
function claimOrder(a: TextChannel, b: TextChannel, categoryId: string): number {
	const aOutside = a.parentId === categoryId ? 0 : 1;
	const bOutside = b.parentId === categoryId ? 0 : 1;
	if (aOutside !== bOutside) return aOutside - bOutside;
	if (a.rawPosition !== b.rawPosition) return a.rawPosition - b.rawPosition;
	return a.id.length - b.id.length || a.id.localeCompare(b.id);
}
