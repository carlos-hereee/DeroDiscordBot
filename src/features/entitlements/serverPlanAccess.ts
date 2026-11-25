import { serverApi } from "@utils/serverApi.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { CONFIRMED_TTL_MS, ERROR_TTL_MS, UNCOVERED_TTL_MS } from "./entitlementTtl.js";

// ── Dero server plan access ──
// What:  answers, per guild, whether the server is COVERED (the Dero server plan, or a Company
//        Uno subscription reached through pairing) and what monthly voice ceiling that buys.
//        It does not decide game room quotas (gameRoomAccess.ts reads its own route) and it
//        does not meter anything: spendMeter.tryReserve reads the ceiling from here.
// Who:   spendMeter.tryReserve on every paid voice reservation, the voice budget refusals
//        (listenHandler, /dero join, turnLoop, the brain executor) to pick their line, and
//        /dero plan (isServerCoveredNow) to choose between the buy pitch and the "already
//        covered" line.
// When:  per call, served from a per guild cache; the network is touched at most once an hour
//        for a covered guild, once every five minutes for an uncovered one, and once a minute
//        while the server does not answer. /dero plan always asks (2026-11 item 424).
// Where: nexious-server's signed GET /api/plugin-access/server-plan is the authority (2026-10
//        item 262). The bot never stores a guild's coverage.
// How:   ① a cached answer inside its TTL is returned as is. ② otherwise the route is read and
//        the answer cached for an hour when covered, five minutes when not, so a purchase is
//        noticed soon after it is made. ③ on ANY error (not configured, unreachable, a 4xx or a
//        5xx) the last known answer is returned when one exists, else the FREE answer, and that
//        fallback is cached for a minute.
//
// ⚠️ THIS READ FAILS TO THE FREE CEILING, never up. It must never fall to a guild's stored
// monthlyCapUsd and never to DERO_VOICE_MAX_CAP_USD: every guild's speech bills the ONE
// ElevenLabs account, so a Heroku outage that resolved to a paid ceiling would let every guild
// spend a paid budget at once. gameRoomAccess fails OPEN on its boolean (it must not take a
// free feature away) but strict on its quota; this module only has a number, so it is strict.

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

// Asks the server and stores the outcome: steps ② and ③ of the header, with no cache check, so
// both reads below share one fallback rule and one set of TTLs.
async function readFromServer(guildId: string, now: Date): Promise<ServerPlanAccess> {
	try {
		// ②
		const response = await serverApi.get<ServerPlanResponse>(SERVER_PLAN_ROUTE, { guildId });
		const access = toAccess(response);
		const ttlMs = access.covered ? CONFIRMED_TTL_MS : UNCOVERED_TTL_MS;
		accessCache.set(guildId, { access, expiresAt: now.getTime() + ttlMs });
		return access;
	}
	catch (error) {
		// ③ Logged rather than swallowed, so an operator sees in the Railway logs that guilds are
		// running on a fallback budget.
		console.warn(`[server-plan] coverage lookup failed guild=${guildId}, using the last known or free ceiling`, error);
		// Looked up here and not before the request: /dero plan and a voice reservation can be in
		// flight together, and the one that fails must not put back an answer the other replaced.
		const access = accessCache.get(guildId)?.access ?? FREE_ACCESS;
		accessCache.set(guildId, { access, expiresAt: now.getTime() + ERROR_TTL_MS });
		return access;
	}
}

/**
 * The guild's coverage and voice ceiling. Never throws: an unanswerable guild reads as its last
 * known answer, else as uncovered at the free ceiling.
 */
export async function resolveServerPlanAccess(guildId: string, now: Date = new Date()): Promise<ServerPlanAccess> {
	// ①
	const cached = accessCache.get(guildId);
	if (cached && cached.expiresAt > now.getTime()) return cached.access;
	return readFromServer(guildId, now);
}

/** Whether the guild is covered, for the lines that only pick wording. */
export async function isServerCovered(guildId: string): Promise<boolean> {
	return (await resolveServerPlanAccess(guildId)).covered;
}

/**
 * Whether the guild is covered at this moment, for /dero plan: always asks the server and stores
 * the answer, so the owner who checks right after paying also ends the cached answer the voice
 * budget reads. Never throws, and falls back exactly as resolveServerPlanAccess does.
 */
export async function isServerCoveredNow(guildId: string, now: Date = new Date()): Promise<boolean> {
	return (await readFromServer(guildId, now)).covered;
}
