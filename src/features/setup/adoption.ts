import { TextChannel, type Guild, type Message } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IOverwriteEntry } from "./communityOverwrites.js";

// ── adoption ─────────────────────────────────────────────────────────
// What:  finds a channel the server ALREADY has for a job Dero is about to build
//        a channel for (a welcome log, a rules channel), moves it into 🪧 NOTICE
//        BOARD, and decides whether Dero may post its own intro there
//        (2026-10 item 247 Phase 2). It never deletes, renames or rewrites a
//        message, and it never decides which channels are adoptable: the pattern
//        lists live in BOT_CONSTANTS and the overwrite shape in communityOverwrites.
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
//        position; ③ moving keeps every overwrite Dero does not manage.

// ── types ────────────────────────────────────────────────────────────

/** Channels a scan must pass over: ids already stored under another slot, and Dero's own channel names. */
export interface IAdoptionExclusions {
	ids?: ReadonlySet<string>;
	names?: ReadonlySet<string>;
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
			channel instanceof TextChannel &&
			!exclude.ids?.has(channel.id) &&
			// A channel already carrying Dero's own name outside our category belongs to
			// another Dero instance sharing this server (a dev bot beside prod), or is an
			// orphan of our own; adopting it would move it out from under its owner.
			!exclude.names?.has(channel.name) &&
			matchesAdoptionPattern(channel.name, patterns)
	);
	if (candidates.length === 0) return null;
	return candidates.sort((a, b) => claimOrder(a, b, category.id))[0] ?? null;
}

// ── the claim ────────────────────────────────────────────────────────

/**
 * Move an adopted channel under the notice board and onto Dero's managed entries,
 * keeping every overwrite Dero does not manage (a role the owner set by hand).
 * A channel already in the notice board is left exactly as it is. Resolves true
 * when it moved; throws what Discord throws so the caller can fall back to a build.
 */
export async function moveIntoNoticeBoard(channel: TextChannel, category: { id: string }, overwrites: IOverwriteEntry[]): Promise<boolean> {
	if (channel.parentId === category.id) return false;

	// Read before the move. lockPermissions false keeps the channel's own entries
	// rather than syncing them to the category, which would wipe what the owner set.
	const managedIds = new Set(overwrites.map((entry) => entry.id));
	const foreign = [...channel.permissionOverwrites.cache.values()].filter((overwrite) => !managedIds.has(overwrite.id));
	await channel.setParent(category.id, { lockPermissions: false, reason: ADOPTION_REASON });
	await channel.permissionOverwrites.set([...overwrites, ...foreign], ADOPTION_REASON);
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
