import { serverApi } from "@utils/serverApi.js";
import { enforceLevelingTier } from "@utils/config.js";

// ── Leveling entitlement seam ──
// What:  decides whether a guild's members may EARN xp. Today it says yes to
//        everyone. It is built ahead of any price so that if leveling ever gains
//        a tier gate, every call site already exists, is in the right place, and
//        is already correct.
// Who:   called from inside awardXp, and from nowhere else. One call site, on
//        purpose: awardXp is already the single public entry point for granting
//        xp (every listener, every game hook and every admin command goes
//        through it), so gating there gates the whole feature by construction
//        and there is no second path to forget.
// When:  on every award, but ONLY over the network when the enforcement flag is
//        on. With ENFORCE_LEVELING_TIER unset (production today, and the state
//        the owner intends to keep) this costs nothing at all, which matters
//        more here than it does for game rooms: this sits on the message path.
// Where: nexious-server is the tier authority. The bot's own DB never stores a
//        guild's platform tier, an invariant earlyAccess.ts states explicitly,
//        and this feature does not break it.
// How:   ① flag off, or missing context, allow with zero I/O. ② cached answer
//        inside its TTL, return it. ③ otherwise resolve over the signed
//        serverApi and cache. ④ on ANY error, allow.
//
// ⚠️ THIS GATE FAILS OPEN, exactly like gameRoomAccess.ts and deliberately unlike
// earlyAccess.ts. The next reader will notice the inconsistency and want to
// resolve it. Do not. earlyAccess fails CLOSED and that is correct THERE: an
// unconfirmable guild must not be handed an in-window feature early, and the
// feature reaches everyone at generalReleaseAt regardless, so the worst case is
// a short wait. Here the worst case is the opposite and much worse: leveling is
// FREE and ON in every guild, so a Heroku blip that resolved to "denied" would
// silently stop a whole server earning xp, and members would simply see their
// progress stop with no error anywhere. A gate protecting nothing must never be
// able to break something.
//
// ⚠️ AND THIS IS NOT A KILL SWITCH. Turning leveling off is
// GuildConfig.leveling.enabled per guild, which needs no deploy. Because this
// gate fails open, setting the env flag could never disable anything, which is
// the correct property for an entitlement check and the wrong one for a switch.

// A confirmed answer holds for an hour, because a plan change is rare and the
// award path must not wait on Heroku. An ERROR is cached only briefly, so one
// bad round trip does not pin a stale answer for the full hour. Same two TTLs as
// gameRoomAccess and earlyAccess.
const CONFIRMED_TTL_MS = 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;

interface EligibilityEntry {
	value: boolean;
	expiresAt: number;
}

// Keyed on guildId ALONE, unlike gameRoomAccess which keys on guild plus user.
// That difference is deliberate and worth stating: game rooms grandfather
// founding USERS, so two members of one guild can legitimately resolve
// differently. Leveling has no per member grandfathering, so a per user key
// would multiply the cache by the member count and buy nothing. If per member
// entitlement ever lands here, this key has to change with it.
const eligibilityCache = new Map<string, EligibilityEntry>();

// Test seam: reset the cache between cases.
export const _clearLevelingAccessCache = (): void => eligibilityCache.clear();

export interface LevelingAccessDecision {
	allowed: boolean;
	// Present only when blocked. A single reason today; a union member gets added
	// the day a second kind of block exists, which keeps a caller's switch honest.
	reason?: "tier";
	// Where to go to fix it. Server supplied so pricing can move without a bot
	// deploy.
	upgradeUrl?: string;
}

interface LevelingAccessResponse {
	guildId: string;
	allowed?: boolean;
	upgradeUrl?: string;
}

// Note there is deliberately NO generalReleaseAt anywhere in this module.
// earlyAccess entries carry one and auto graduate when the date passes, because
// an early access window is temporary by definition. A paid tier never
// graduates, so a date here would be a promise to eventually give it away.
export const checkLevelingAccess = async (
	guildId: string,
	now: Date = new Date()
): Promise<LevelingAccessDecision> => {
	// ① Not enforcing. This is the production state today and it must cost
	// nothing: no cache read, no network call, no allocation beyond the returned
	// object. This branch is on the message path of every guild the bot is in.
	if (!enforceLevelingTier) return { allowed: true };

	// ② Missing context. A DM, a partial event, anything without a guild. Never
	// block on absent context in a fail open gate; there is nothing here to
	// confirm and nothing to protect.
	if (!guildId) return { allowed: true };

	const cached = eligibilityCache.get(guildId);
	if (cached && cached.expiresAt > now.getTime()) {
		return cached.value ? { allowed: true } : { allowed: false, reason: "tier" };
	}

	try {
		const res = await serverApi.get<LevelingAccessResponse>("/api/plugin-access/leveling", { guildId });
		const value = res?.allowed === true;
		eligibilityCache.set(guildId, { value, expiresAt: now.getTime() + CONFIRMED_TTL_MS });
		return value ? { allowed: true } : { allowed: false, reason: "tier", upgradeUrl: res?.upgradeUrl };
	} catch (err) {
		// Fail OPEN, and cache the permissive answer only briefly so a recovered
		// server is picked up within the minute. Logged rather than swallowed: a
		// gate that quietly stops gating is exactly the thing an operator needs to
		// see in the Railway logs.
		console.warn("[leveling] entitlement lookup failed, allowing access", err);
		eligibilityCache.set(guildId, { value: true, expiresAt: now.getTime() + ERROR_TTL_MS });
		return { allowed: true };
	}
};
