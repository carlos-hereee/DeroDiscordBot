import { serverApi } from "@utils/serverApi.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── Dero server plan access ──
// What:  answers, per guild, whether the server is COVERED (the Dero server plan, or a Company
//        Uno subscription reached through pairing) and what monthly voice ceiling that buys.
//        It does not decide game room quotas (gameRoomAccess.ts reads its own route) and it
//        does not meter anything: spendMeter.tryReserve reads the ceiling from here.
// Who:   spendMeter.tryReserve on every paid voice reservation, the voice budget refusals
//        (listenHandler, /dero join, turnLoop, the brain executor) to pick their line, and
//        /dero plan to choose between the buy pitch and the "already covered" line.
// When:  per call, served from a per guild cache; the network is touched at most once an hour
//        per guild while the server answers, and once a minute while it does not.
// Where: nexious-server's signed GET /api/plugin-access/server-plan is the authority (2026-10
//        item 262). The bot never stores a guild's coverage.
// How:   ① a cached answer inside its TTL is returned as is. ② otherwise the route is read and
//        the answer cached for an hour. ③ on ANY error (not configured, unreachable, a 4xx or a
//        5xx) the last known answer is returned when one exists, else the FREE answer, and that
//        fallback is cached for a minute.
//
// ⚠️ THIS READ FAILS TO THE FREE CEILING, never up. It must never fall to a guild's stored
// monthlyCapUsd and never to DERO_VOICE_MAX_CAP_USD: every guild's speech bills the ONE
// ElevenLabs account, so a Heroku outage that resolved to a paid ceiling would let every guild
// spend a paid budget at once. gameRoomAccess fails OPEN on its boolean (it must not take a
// free feature away) but strict on its quota; this module only has a number, so it is strict.

// Same two TTLs as gameRoomAccess: an hour for a confirmed answer, because a plan change is
// rare and a voice click should not wait on Heroku, and a minute for an error, so a recovered
// server is picked up quickly.
const CONFIRMED_TTL_MS = 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;

const SERVER_PLAN_ROUTE = "/api/plugin-access/server-plan";

/** One guild's coverage, as the bot acts on it. */
export interface ServerPlanAccess {
	covered: boolean;
	/** The monthly voice ceiling in whole dollars. */
	voiceCeilingUsd: number;
}

interface ServerPlanResponse {
	guildId: string;
	covered?: boolean;
	source?: string;
	voiceCeilingUsd?: number;
	privateQuota?: number;
	upgradeUrl?: string;
}

interface CacheEntry {
	access: ServerPlanAccess;
	// An EXPIRED entry is deliberately never deleted: it is the "last known answer" the error
	// path prefers over the free fallback, so a guild that pays keeps its budget through an outage.
	expiresAt: number;
}

const FREE_ACCESS: ServerPlanAccess = {
	covered: false,
	voiceCeilingUsd: BOT_CONSTANTS.DERO_VOICE_FREE_CEILING_USD,
};

const accessCache = new Map<string, CacheEntry>();

// Test seam: reset the cache between cases.
export const _clearServerPlanAccessCache = (): void => accessCache.clear();

// A response missing a field reads as the free answer for that field, never as covered: the
// wire shape is a contract, and an older or broken server build must not raise a ceiling.
function toAccess(response: ServerPlanResponse | null | undefined): ServerPlanAccess {
	const covered = response?.covered === true;
	const ceiling = response?.voiceCeilingUsd;
	const voiceCeilingUsd = typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 0 ? ceiling : FREE_ACCESS.voiceCeilingUsd;
	return { covered, voiceCeilingUsd };
}

/**
 * The guild's coverage and voice ceiling. Never throws: an unanswerable guild reads as its last
 * known answer, else as uncovered at the free ceiling.
 */
export async function resolveServerPlanAccess(guildId: string, now: Date = new Date()): Promise<ServerPlanAccess> {
	// ①
	const cached = accessCache.get(guildId);
	if (cached && cached.expiresAt > now.getTime()) return cached.access;

	try {
		// ②
		const response = await serverApi.get<ServerPlanResponse>(SERVER_PLAN_ROUTE, { guildId });
		const access = toAccess(response);
		accessCache.set(guildId, { access, expiresAt: now.getTime() + CONFIRMED_TTL_MS });
		return access;
	}
	catch (error) {
		// ③ Logged rather than swallowed, so an operator sees in the Railway logs that guilds are
		// running on a fallback budget.
		console.warn(`[server-plan] coverage lookup failed guild=${guildId}, using the last known or free ceiling`, error);
		const access = cached?.access ?? FREE_ACCESS;
		accessCache.set(guildId, { access, expiresAt: now.getTime() + ERROR_TTL_MS });
		return access;
	}
}

/** Whether the guild is covered, for the lines that only pick wording. */
export async function isServerCovered(guildId: string): Promise<boolean> {
	return (await resolveServerPlanAccess(guildId)).covered;
}
