import { EmbedBuilder, type ColorResolvable } from "discord.js";
import { serverApi } from "@utils/serverApi.js";
import { enforceGameRoomTier } from "@utils/config.js";
import { COLORS } from "@base/copy/brand.js";

// ── Game Rooms entitlement seam ──
// What:  decides whether a member may OPEN a game room. Today it says yes to everyone. It is
//        built ahead of the price so that when game rooms become a paid feature, every call
//        site already exists, is in the right place, and is already correct.
// Who:   called from inside the `gameroom:` button handlers, never from main.ts. main.ts runs
//        its gates inside `if (interaction.isChatInputCommand())` and returns from the button
//        and modal branches before reaching any gate, so a button-driven feature must gate
//        itself, exactly the way PowerUps.handlePowerUpButton re-verifies admin on every click.
// When:  on every room-creation attempt, but ONLY over the network when the enforcement flag is
//        on. With ENFORCE_GAME_ROOM_TIER unset (production today) this costs nothing at all.
// Where: nexious-server is the tier authority. The bot's own DB never stores a guild's platform
//        tier, an invariant earlyAccess.ts states explicitly, and this feature does not break it:
//        founding-member grandfathering is recorded on the server, not here.
// How:   ① flag off, or missing context, allow with zero I/O. ② cached answer inside its TTL,
//        return it. ③ otherwise resolve from the server over the signed serverApi and cache the
//        result. ④ on ANY error, allow.
//
// ⚠️ THIS GATE FAILS OPEN. earlyAccess.ts fails CLOSED and that is correct THERE: an unconfirmable
// guild must not be handed an in-window feature early, and the feature reaches everyone at
// generalReleaseAt regardless, so the worst case is a short wait. Here the worst case is the
// opposite and much worse: game rooms are FREE right now, so a Heroku blip that resolved to
// "denied" would silently take a working free feature away from members who are entitled to it.
// The next reader will assume these two modules should match. They must not. Any change that
// makes this one fail closed needs a deliberate decision, not a consistency cleanup.

// ── Eligibility cache ──
// A confirmed answer holds for an hour, because a plan change is rare and the Discord button
// path should not wait on Heroku. An ERROR is cached only briefly, so one bad round-trip does
// not pin a stale answer for the full hour. Same two TTLs as earlyAccess.
const CONFIRMED_TTL_MS = 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;

interface EligibilityEntry {
	value: boolean;
	// Carried alongside the boolean, unlike earlyAccess's cache, because a DENIAL is only useful
	// to a member if it comes with the link that resolves it. Caching the bare boolean would make
	// the first denial in an hour show an upgrade link and every later one show none.
	upgradeUrl?: string;
	expiresAt: number;
}

// Keyed on `${guildId}:${userId}`, NOT on guildId alone. earlyAccess keys on the slash command
// name and the guild because a guild's plan grants a guild's access; here it is founding USERS
// who are grandfathered, so two members of the same guild can legitimately resolve differently.
const eligibilityCache = new Map<string, EligibilityEntry>();

// Test seam: reset the cache between cases.
export const _clearGameRoomAccessCache = (): void => eligibilityCache.clear();

export interface GameRoomAccessDecision {
	allowed: boolean;
	// Present only when blocked. A single reason today; a union member gets added the day a
	// second kind of block exists, which keeps the caller's switch honest.
	reason?: "tier";
	// Where to go to fix it. Server-supplied so pricing can move without a bot deploy.
	upgradeUrl?: string;
}

interface GameRoomAccessResponse {
	guildId: string;
	userId: string;
	allowed?: boolean;
	// A founding member keeps access permanently, whatever the tier answer says. Resolved on the
	// server so the grandfather list has exactly one home.
	founding?: boolean;
	upgradeUrl?: string;
}

// Note there is deliberately NO generalReleaseAt anywhere in this module. earlyAccess entries
// carry one and auto-graduate when the date passes, because an early-access window is temporary
// by definition. A paid tier never graduates, so a date here would be a promise to eventually
// give the feature away.
export const checkGameRoomAccess = async (
	guildId: string,
	userId: string,
	now: Date = new Date()
): Promise<GameRoomAccessDecision> => {
	// ① Not enforcing. This is the production state today and it must cost nothing: no cache
	// read, no network call, no allocation beyond the returned object.
	if (!enforceGameRoomTier) return { allowed: true };

	// ② Missing context. A DM, a partial interaction, anything without both ids. Never block on
	// absent context in a fail-open gate; there is nothing here to confirm and nothing to protect.
	if (!guildId || !userId) return { allowed: true };

	const key = `${guildId}:${userId}`;
	const cached = eligibilityCache.get(key);
	if (cached && cached.expiresAt > now.getTime()) {
		return cached.value ? { allowed: true } : { allowed: false, reason: "tier", upgradeUrl: cached.upgradeUrl };
	}

	try {
		const res = await serverApi.get<GameRoomAccessResponse>("/api/plugin-access/game-rooms", { guildId, userId });
		// A founding member is allowed even when the tier check says no. The server owns that list;
		// the bot only honors the flag.
		const value = res?.founding === true || res?.allowed === true;
		eligibilityCache.set(key, { value, upgradeUrl: res?.upgradeUrl, expiresAt: now.getTime() + CONFIRMED_TTL_MS });
		return value ? { allowed: true } : { allowed: false, reason: "tier", upgradeUrl: res?.upgradeUrl };
	} catch (err) {
		// Fail OPEN, and cache the permissive answer only briefly so a recovered server is picked
		// up within the minute. Logged rather than swallowed: a gate that quietly stops gating is
		// exactly the thing an operator needs to see in the Railway logs.
		console.warn("[game-rooms] entitlement lookup failed, allowing access", err);
		eligibilityCache.set(key, { value: true, expiresAt: now.getTime() + ERROR_TTL_MS });
		return { allowed: true };
	}
};

// Ephemeral notice shown when a member hits the tier wall. Builds its own EmbedBuilder rather
// than going through utils/embedBuilder.ts's base(), the same way earlyAccessEmbed does: a tier
// notice is a platform-level message and is not part of a guild's voice pack, so it must read
// identically whichever pack the guild runs.
export const gameRoomUpgradeEmbed = (upgradeUrl?: string): EmbedBuilder => {
	const link = upgradeUrl || "https://www.companyuno.com/pricing";
	return new EmbedBuilder()
		// COLORS is a plain string map, so its values widen to string; the cast pins the brand
		// indigo hex back to a ColorResolvable.
		.setColor(COLORS.DERO as ColorResolvable)
		.setTitle("Game rooms")
		.setDescription(
			[
				"Opening a game room is part of a paid plan on Company Uno.",
				"",
				`See what is included at ${link}.`,
			].join("\n")
		);
};
