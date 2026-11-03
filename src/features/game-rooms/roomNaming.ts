import { GAME_EMOJI } from "./challengeBoardEmbeds.js";
import type { GameSlug } from "./roomTypes.js";

// ── roomNaming ───────────────────────────────────────────────────────
// What:  turns a game slug plus a host's display name into a legal, readable Discord
//        channel name led by the game's emoji, and resolves a collision when that name
//        is already taken.
// Who:   RoomProvisioner.open, immediately before guild.channels.create.
// When:  once per room opened.
// Where: PURE functions: no store and no I/O. That is the whole point: the ugly cases
//        here (a display name that is entirely emoji, a host who opens a second room
//        while the first is still cooling off) are exactly the ones nobody can reproduce
//        by hand in a guild, so they have to be reachable from a unit test. The one
//        import is GAME_EMOJI, the board's own map, so there is no second emoji table.
// How:   slugify to Discord's safe alphabet, cap the host segment, join, cap the whole,
//        prefix the emoji, and hand collisions a numeric suffix.

// Discord allows 100 characters. The 10 character gap is deliberate headroom for the
// collision suffix, so a maximally long name can still grow a "-2" without being
// re-truncated into a DIFFERENT name that might itself collide.
const CHANNEL_NAME_MAX = 90;

// The host's slice of the name. Long enough to stay recognizable, short enough that the
// game slug is never pushed out of view in a channel list.
const HOST_SEGMENT_MAX = 24;

// Collision suffixes run -2 through -99. GAME_ROOM_MAX_PER_GUILD is 20 and a finished
// room's channel only lingers for GAME_ROOM_ARCHIVE_DELAY_MS, so the real ceiling is far
// below this; 99 is a backstop, not a budget.
const COLLISION_SUFFIX_MAX = 99;

// Strip to Discord's safe channel alphabet. The character class collapses any RUN of
// unsafe characters into a single hyphen, so "Sir  Reginald!!!" yields "sir-reginald"
// rather than "sir--reginald---".
function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// Truncation can land mid-hyphen ("sir-reginald-the-" → trailing hyphen), which Discord
// accepts but reads as a typo. Always re-trim after a slice.
function trimHyphens(input: string): string {
	return input.replace(/^-+|-+$/g, "");
}

// ── the host segment, and the case that ships broken ──────────────────
// What:  the readable half of the name.
// ⚠️ A DISPLAY NAME CAN SLUGIFY TO NOTHING. "日本語", "🎮🎮🎮" and "!!!" all contain zero
// characters in [a-z0-9], so the naive implementation produces "hangman-" and every such
// host collides with every other one on the same game. The fallback keys on the user id,
// which is always ASCII digits, so it can never be empty and is stable for that member
// across rooms. Last 4 digits rather than the whole snowflake because a channel named
// "hangman-player847291039284710" is not more informative than "hangman-player4710".
function resolveHostSegment(hostDisplayName: string, hostId: string): string {
	const slug = trimHyphens(slugify(hostDisplayName).slice(0, HOST_SEGMENT_MAX));
	if (slug) return slug;
	return `player${hostId.slice(-4)}`;
}

// The room's channel name before collision resolution: "<emoji><game>-<host>", the same
// emoji first shape as the arcade's fixed channels (📋arcade-rules, ⚔️challenges).
//
// The game's emoji and slug lead so a channel list groups by game when sorted, which is
// how a member scanning 🎮 ARCADE GAMES actually reads it. The emoji is added AFTER the
// slug is built, because slugify keeps only [a-z0-9] and would strip it, and its length
// comes off the cap so the whole name still fits the 90 character budget.
export function buildRoomChannelName(game: GameSlug, hostDisplayName: string, hostId: string): string {
	const emoji = GAME_EMOJI[game];
	const host = resolveHostSegment(hostDisplayName, hostId);
	return `${emoji}${trimHyphens(`${game}-${host}`.slice(0, CHANNEL_NAME_MAX - emoji.length))}`;
}

// ── collision resolution ──────────────────────────────────────────────
// What:  hand back the first name in the "-2", "-3" ... series that is not taken.
// When:  a host opens a second room of the same game while their previous one is still
//        cooling off in its 4 hour archive window. That is NOT an edge case: F11 stops a
//        host holding two LIVE rooms, but a finished room keeps its channel for hours, so
//        "play again" is the ordinary path into this function.
// How:   the caller supplies `isTaken`, so this stays pure and the provisioner decides
//        what "taken" means (today: a channel of that name already under the category).
//        The base name is re-truncated to leave room for the suffix, then re-trimmed, so
//        a 90 character base cannot produce a 92 character candidate.
export function resolveRoomChannelName(baseName: string, isTaken: (candidate: string) => boolean): string {
	if (!isTaken(baseName)) return baseName;

	for (let attempt = 2; attempt <= COLLISION_SUFFIX_MAX; attempt++) {
		const suffix = `-${attempt}`;
		const candidate = `${trimHyphens(baseName.slice(0, CHANNEL_NAME_MAX - suffix.length))}${suffix}`;
		if (!isTaken(candidate)) return candidate;
	}

	// Unreachable with the per-guild cap in place, and deliberately loud rather than
	// silently returning a name that already exists: Discord would happily create a
	// SECOND channel with a duplicate name, and the adopt-by-name logic elsewhere in the
	// bot would then have two candidates and no way to choose.
	throw new Error(`[roomNaming] exhausted collision suffixes for "${baseName}"`);
}
