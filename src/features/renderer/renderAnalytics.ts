import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { renderAnalyticsStore, type RenderCounterIncrements, type RenderLookupWrite, type SurfaceTotals } from "@db/stores/renderAnalyticsStore.js";
import { renderAnalyticsEnabled } from "@utils/config.js";
import { AVATAR_CACHE_CAPACITY, cachedAvatarCount, type AvatarLookup } from "./avatarCache.js";
import { CARD_CACHE_CAPACITY, cachedCardCount, type CacheTier } from "./cardCache.js";

// ── render analytics ─────────────────────────────────────────────────
// Counts every card and avatar cache lookup per UTC month (2026-10 item 244) and
// builds the report /platform analytics shows. renderCard calls recordCardLookup
// and the shared avatar cache calls recordAvatarLookup; neither waits, because a
// count must never slow, delay or break the card a member is waiting on. It does
// not draw, cache or decide anything about a render, and it never writes a user
// id: avatar rows are keyed by size alone.
//
// How a lookup is written: ① the record call returns at once when the kill
// switch is off; ② otherwise it turns the outcome into counter increments and
// queues ONE atomic upsert with setImmediate, so the write starts after the
// render's own work; ③ past MAX_PENDING_WRITES in flight the lookup is dropped and
// counted instead; ④ a failed write (a synchronous throw or a rejection) is
// caught and counted; ⑤ drops and failures surface as one [render-analytics]
// summary line at most once a SUMMARY_INTERVAL_MS, never one line per event.
//
// The report builder answers a plain view model, because Phase 2 reuses it for
// the owner's Monday DM digest and the platform route behind Dero's Castle.

const LIMITS = BOT_CONSTANTS.RENDER_ANALYTICS;

// Avatar rows are one per size, so they carry no drawing version of their own.
const AVATAR_SURFACE = "avatar";
const AVATAR_ROW_VERSION = 1;

// How much of a key's hash names it in a report line: enough to tell two cards
// apart, short enough to read. The same length names a card's attachment.
const KEY_HASH_DISPLAY_LENGTH = 12;

export type CardLookupOutcome = CacheTier | "drawn";

export interface CardLookup {
	kind: string;
	version: number;
	/** The render cache key, a hash of the card's input, so it carries no user id. */
	key: string;
	outcome: CardLookupOutcome;
	/** Byte length of the image served. */
	bytes: number;
}

export const RENDER_ANALYTICS_PERIODS = ["this-month", "last-month", "all-time"] as const;
export type RenderAnalyticsPeriod = (typeof RENDER_ANALYTICS_PERIODS)[number];

export type SizingHint = "evergreen" | "long-tail" | "none";

export interface SurfaceReport extends SurfaceTotals {
	/** hits / (hits + draws), or null for a surface with no renders in the period. */
	hitRate: number | null;
	hint: SizingHint;
}

export interface TopKeyReport {
	surface: string;
	version: number;
	keyHash: string;
	hits: number;
}

export interface MemoryTierReport {
	cards: number;
	cardCapacity: number;
	avatars: number;
	avatarCapacity: number;
	/** True when S3 hits pass GROW_MEMORY_S3_SHARE of every hit in the period. */
	growMemoryTier: boolean;
}

export interface RenderAnalyticsReport {
	period: RenderAnalyticsPeriod;
	/** The UTC months the period covers, or null for every month on record. */
	months: string[] | null;
	/** The one surface asked for, or null for every surface. */
	surface: string | null;
	surfaces: SurfaceReport[];
	memory: MemoryTierReport;
	top: TopKeyReport[];
	/** Lookups dropped since boot because MAX_PENDING_WRITES were already in flight. */
	droppedWrites: number;
}

export interface RenderAnalyticsHealth {
	pending: number;
	dropped: number;
	failed: number;
}

// ── write path state ─────────────────────────────────────────────────

let pendingWrites = 0;
const sinceBoot = { dropped: 0, failed: 0 };
let summaryWindow = { dropped: 0, failed: 0, lastError: "" };
let summaryTimer: ReturnType<typeof setTimeout> | null = null;

// ── month keys ───────────────────────────────────────────────────────

/** "YYYY-MM" for the UTC month a moment falls in, zero padded so months sort lexically. */
export function monthKeyOf(date: Date): string {
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	return `${date.getUTCFullYear()}-${month}`;
}

function previousMonthKey(date: Date): string {
	return monthKeyOf(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
}

/** The months a period reads, or null for every month on record. */
export function monthsForPeriod(period: RenderAnalyticsPeriod, now: Date = new Date()): string[] | null {
	if (period === "this-month") return [monthKeyOf(now)];
	if (period === "last-month") return [previousMonthKey(now)];
	return null;
}

// ── recording ────────────────────────────────────────────────────────

function cardIncrements(outcome: CardLookupOutcome): RenderCounterIncrements {
	if (outcome === "memory") return { hits: 1, memoryHits: 1 };
	if (outcome === "s3") return { hits: 1, s3Hits: 1 };
	return { draws: 1 };
}

/**
 * Counts one card lookup: served from memory, served from S3, or drawn. Returns
 * at once and never throws; the write happens later, or not at all when the
 * kill switch is off or too many writes are already pending.
 */
export function recordCardLookup({ kind, version, key, outcome, bytes }: CardLookup): void {
	if (!renderAnalyticsEnabled) return;
	try {
		const at = new Date();
		enqueueWrite({ cacheKey: key, month: monthKeyOf(at), surface: kind, version, bytes, at, increments: cardIncrements(outcome) });
	}
	catch (error) {
		noteProblem("failed", error);
	}
}

/**
 * Counts one avatar lookup. A memory hit or a shared in flight download is a
 * hit; a download attempt, whether it worked or not, is a draw. The row is keyed
 * `avatar:<size>`: the avatar cache's own key carries a user id, so it is never
 * written anywhere.
 */
export function recordAvatarLookup({ size, outcome }: AvatarLookup): void {
	if (!renderAnalyticsEnabled) return;
	try {
		const at = new Date();
		const increments: RenderCounterIncrements = outcome === "memory" ? { hits: 1, memoryHits: 1 } : { draws: 1 };
		enqueueWrite({
			cacheKey: `${AVATAR_SURFACE}:${size}`,
			month: monthKeyOf(at),
			surface: AVATAR_SURFACE,
			version: AVATAR_ROW_VERSION,
			bytes: 0,
			at,
			increments,
		});
	}
	catch (error) {
		noteProblem("failed", error);
	}
}

// The cap counts writes queued AND in flight, so a Mongo that has stopped
// answering holds at most MAX_PENDING_WRITES promises in memory, not one per
// card rendered since it stopped.
function enqueueWrite(write: RenderLookupWrite): void {
	if (pendingWrites >= LIMITS.MAX_PENDING_WRITES) {
		noteProblem("dropped");
		return;
	}
	pendingWrites += 1;
	setImmediate(() => {
		void performWrite(write);
	});
}

// The await sits inside the try, so a store that throws before returning a
// promise is caught the same way as one that rejects.
async function performWrite(write: RenderLookupWrite): Promise<void> {
	try {
		await renderAnalyticsStore.recordLookup(write);
	}
	catch (error) {
		noteProblem("failed", error);
	}
	finally {
		pendingWrites -= 1;
	}
}

function noteProblem(kind: "dropped" | "failed", error?: unknown): void {
	sinceBoot[kind] += 1;
	summaryWindow[kind] += 1;
	if (error !== undefined) summaryWindow.lastError = error instanceof Error ? error.message : String(error);
	if (summaryTimer) return;
	summaryTimer = setTimeout(logSummary, LIMITS.SUMMARY_INTERVAL_MS);
	// The summary is a courtesy, never a reason to keep the process alive at shutdown.
	summaryTimer.unref();
}

function logSummary(): void {
	summaryTimer = null;
	const { dropped, failed, lastError } = summaryWindow;
	summaryWindow = { dropped: 0, failed: 0, lastError: "" };
	const lastErrorNote = lastError ? ` Last error: ${lastError}.` : "";
	console.warn(
		`[render-analytics] in the last minute ${dropped} lookups were dropped (more than ${LIMITS.MAX_PENDING_WRITES} writes pending) ` +
		`and ${failed} writes to RenderAnalytics failed. Renders were not affected.${lastErrorNote}`
	);
}

/** Writes in flight, and lookups dropped or failed since boot. */
export function renderAnalyticsHealth(): RenderAnalyticsHealth {
	return { pending: pendingWrites, dropped: sinceBoot.dropped, failed: sinceBoot.failed };
}

/** Zero every counter and cancel a pending summary, so a test can start clean. Writes already in flight still finish. */
export function resetRenderAnalyticsCounters(): void {
	if (summaryTimer) clearTimeout(summaryTimer);
	summaryTimer = null;
	pendingWrites = 0;
	sinceBoot.dropped = 0;
	sinceBoot.failed = 0;
	summaryWindow = { dropped: 0, failed: 0, lastError: "" };
}

// ── report ───────────────────────────────────────────────────────────

/** hits / (hits + draws), or null when nothing was rendered. */
export function hitRateOf(hits: number, draws: number): number | null {
	const renders = hits + draws;
	return renders === 0 ? null : hits / renders;
}

/**
 * A surface's cache sizing hint, judged only over SIZING_MIN_RENDERS or more:
 * "evergreen" above EVERGREEN_HIT_RATE (the cache earns its keep), "long tail"
 * below LONG_TAIL_HIT_RATE (almost every card is drawn fresh), otherwise none.
 */
export function sizingHintOf(hits: number, draws: number): SizingHint {
	if (hits + draws < LIMITS.SIZING_MIN_RENDERS) return "none";
	const rate = hitRateOf(hits, draws) ?? 0;
	if (rate > LIMITS.EVERGREEN_HIT_RATE) return "evergreen";
	if (rate < LIMITS.LONG_TAIL_HIT_RATE) return "long-tail";
	return "none";
}

/** True when S3 served more than GROW_MEMORY_S3_SHARE of every hit, so more cards in memory would save S3 reads. */
export function shouldGrowMemoryTier(surfaces: readonly SurfaceTotals[]): boolean {
	const hits = surfaces.reduce((sum, surface) => sum + surface.hits, 0);
	const s3Hits = surfaces.reduce((sum, surface) => sum + surface.s3Hits, 0);
	return hits > 0 && s3Hits / hits > LIMITS.GROW_MEMORY_S3_SHARE;
}

// A card key ends `<hash>.png`; an avatar key is `avatar:<size>` and reads as itself.
function keyHashOf(cacheKey: string): string {
	const lastSegment = cacheKey.split("/").pop() ?? cacheKey;
	return lastSegment.replace(/\.(png|gif)$/, "").slice(0, KEY_HASH_DISPLAY_LENGTH);
}

function surfaceReportOf(totals: SurfaceTotals): SurfaceReport {
	return { ...totals, hitRate: hitRateOf(totals.hits, totals.draws), hint: sizingHintOf(totals.hits, totals.draws) };
}

export interface RenderAnalyticsReportRequest {
	period: RenderAnalyticsPeriod;
	surface?: string | null;
	now?: Date;
}

/**
 * The render analytics report for a period: per surface totals with hit rates
 * and sizing hints, the memory tier, and the top keys (one surface's, or every
 * surface's). The memory tier verdict always reads every surface, since the
 * memory tier is shared. Reads Mongo; throws when the read fails, for the
 * caller to answer honestly.
 */
export async function buildRenderAnalyticsReport({ period, surface = null, now = new Date() }: RenderAnalyticsReportRequest): Promise<RenderAnalyticsReport> {
	const months = monthsForPeriod(period, now);
	const [totals, topKeys] = await Promise.all([
		renderAnalyticsStore.summarizeBySurface(months),
		renderAnalyticsStore.topKeys(months, surface, LIMITS.TOP_N),
	]);
	const surfaces = totals.filter((row) => !surface || row.surface === surface).map(surfaceReportOf);
	return {
		period,
		months,
		surface,
		surfaces,
		memory: {
			cards: cachedCardCount(),
			cardCapacity: CARD_CACHE_CAPACITY,
			avatars: cachedAvatarCount(),
			avatarCapacity: AVATAR_CACHE_CAPACITY,
			growMemoryTier: shouldGrowMemoryTier(totals),
		},
		top: topKeys.map((row) => ({ surface: row.surface, version: row.version, keyHash: keyHashOf(row.cacheKey), hits: row.hits })),
		droppedWrites: sinceBoot.dropped,
	};
}
