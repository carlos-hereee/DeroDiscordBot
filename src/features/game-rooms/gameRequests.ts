import { gameRequestStore } from "@db/stores/gameRequestStore.js";
import type { IGameRequest } from "@db/models/GameRequest.js";

// ── gameRequests ───────────────────────────────────────────────────────────
// What:  the rules of the game request ballot behind the "Don't see your favorite
//        game?" button on 📋arcade-rules (2026-10 item 245 Phase 4a): what a valid
//        name is, when two names are the same game, how the pool ranks, adding,
//        voting and removing.
// Who:   gameRequestHandlers.ts, the only caller. It owns everything Discord and the
//        owner or admin gate on removal; this module owns no interaction at all, so
//        its rules test without one.
// Where: every operation is scoped by guildId and goes through gameRequestStore,
//        which stays a thin wrapper (house rule 6).
// How:   identity is the nameKey (trimmed, whitespace collapsed, lowercased), so
//        "Chess" and "  cHESS " are one request; the unique index makes that hold
//        under a race as well.

// The name field's bounds, also set on the modal's text input so Discord refuses
// most bad input before it reaches here. Two characters admits "Go"; forty is long
// enough for a real title and short enough to fit a select option's label untouched.
export const GAME_REQUEST_NAME_MIN = 2;
export const GAME_REQUEST_NAME_MAX = 40;

// How many requests one server's ballot holds. Discord's ceiling for a select menu's
// options, so every request on the ballot is one a member can actually vote for: a
// pool longer than the vote select would rank its newest entries below the cut,
// where nobody could ever pick them. An admin's Remove makes room.
export const GAME_REQUEST_POOL_CAP = 25;

// Inserted after a mention's sigil, it renders as nothing and stops Discord parsing
// the text as a mention, which is the same trick dero-brain's neutralizeMassMentions
// uses for @everyone and @here.
const ZERO_WIDTH_SPACE = "​";

// Mongo's duplicate key error, which the unique { guildId, nameKey } index raises
// when two members add the same game at the same moment.
const DUPLICATE_KEY_ERROR = 11000;

export type GameNameCheck = { ok: true; name: string; nameKey: string } | { ok: false; reason: "length" };

export type AddGameRequestResult =
	| { ok: true; request: IGameRequest }
	| { ok: false; reason: "length" }
	| { ok: false; reason: "duplicate"; existingName: string }
	| { ok: false; reason: "full" };

export type VoteGameRequestResult = { ok: true; voted: boolean; request: IGameRequest } | { ok: false; reason: "notFound" };

/**
 * Clean a typed game name. Trims and collapses whitespace, checks the length on what
 * a member would see, and breaks every mention form so a stored name can never ping
 * anyone wherever it is shown later. The nameKey is the identity two names share when
 * they are the same game ignoring case and spacing.
 */
export function normalizeGameName(raw: string): GameNameCheck {
	const collapsed = raw.replace(/\s+/g, " ").trim();
	if (collapsed.length < GAME_REQUEST_NAME_MIN || collapsed.length > GAME_REQUEST_NAME_MAX) return { ok: false, reason: "length" };
	return { ok: true, name: neutralizeMentions(collapsed), nameKey: collapsed.toLowerCase() };
}

// @everyone, @here, <@id>, <@!id> and <@&id> all need an "@" Discord can read, and a
// channel mention needs "<#", so one zero width space after each sigil covers them.
function neutralizeMentions(text: string): string {
	return text.replace(/@/g, `@${ZERO_WIDTH_SPACE}`).replace(/<#/g, `<#${ZERO_WIDTH_SPACE}`);
}

/**
 * The pool in ballot order: most votes first, then the older request, then by name so
 * the order is total and a redraw never shuffles two equal entries.
 */
export function rankGameRequests(requests: readonly IGameRequest[]): IGameRequest[] {
	return [...requests].sort(
		(a, b) =>
			b.voterIds.length - a.voterIds.length ||
			new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
			a.nameKey.localeCompare(b.nameKey)
	);
}

/** One server's ballot, ranked. */
export async function listGameRequests(guildId: string): Promise<IGameRequest[]> {
	return rankGameRequests(await gameRequestStore.listByGuild(guildId));
}

/**
 * Add a game to a server's ballot with the adder's vote already on it, since naming a
 * game is the strongest vote there is. A name matching an existing request ignoring
 * case is refused and the refusal names the one already there, so the member can go
 * vote for it instead.
 */
export async function addGameRequest(guildId: string, userId: string, rawName: string): Promise<AddGameRequestResult> {
	const check = normalizeGameName(rawName);
	if (!check.ok) return check;

	// The duplicate is checked before the cap, so a member naming a game that is
	// already there is pointed at it even when the ballot is full.
	const existing = await gameRequestStore.findByKey(guildId, check.nameKey);
	if (existing) return { ok: false, reason: "duplicate", existingName: existing.name };
	if ((await gameRequestStore.countByGuild(guildId)) >= GAME_REQUEST_POOL_CAP) return { ok: false, reason: "full" };

	try {
		const request = await gameRequestStore.create({ guildId, nameKey: check.nameKey, name: check.name, addedBy: userId, voterIds: [userId] });
		return { ok: true, request };
	} catch (error) {
		// Someone added the same game between the read above and this insert; the
		// unique index refused the second one, and so does this.
		if ((error as { code?: number }).code !== DUPLICATE_KEY_ERROR) throw error;
		const raced = await gameRequestStore.findByKey(guildId, check.nameKey);
		return { ok: false, reason: "duplicate", existingName: raced?.name ?? check.name };
	}
}

/**
 * A member's vote on one request: cast it, or take it back when it was already cast.
 * One vote per member per game holds because the store adds with $addToSet, so even
 * two casts racing each other leave the member on the list once.
 */
export async function toggleGameRequestVote(guildId: string, nameKey: string, userId: string): Promise<VoteGameRequestResult> {
	const current = await gameRequestStore.findByKey(guildId, nameKey);
	if (!current) return { ok: false, reason: "notFound" };

	const hadVoted = current.voterIds.includes(userId);
	const updated = hadVoted
		? await gameRequestStore.removeVoter(guildId, nameKey, userId)
		: await gameRequestStore.addVoter(guildId, nameKey, userId);
	if (!updated) return { ok: false, reason: "notFound" };
	return { ok: true, voted: !hadVoted, request: updated };
}

/**
 * Strike a request from the ballot, returning what was removed or null when it was
 * already gone. NOT GATED HERE: the caller must have passed the owner or admin gate,
 * which needs the interaction and therefore lives in gameRequestHandlers.
 */
export async function removeGameRequest(guildId: string, nameKey: string): Promise<IGameRequest | null> {
	return gameRequestStore.deleteByKey(guildId, nameKey);
}
