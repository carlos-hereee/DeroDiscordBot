// src/db/stores/renderAnalyticsStore.ts
import type { PipelineStage } from "mongoose";
import { RenderAnalytics } from "@db/models/RenderAnalytics.js";

// ── Render analytics store ──
// Every DB touch for RenderAnalytics. Thin on purpose: features/renderer/
// renderAnalytics.ts decides the month key, which counters an outcome moves,
// the hit rates and the sizing hints. The store's jobs are the one atomic upsert
// per lookup and the two aggregates the report reads. A null month list means
// every month on record (the all time period).

export interface RenderCounterIncrements {
	hits?: number;
	memoryHits?: number;
	s3Hits?: number;
	draws?: number;
}

export interface RenderLookupWrite {
	cacheKey: string;
	month: string;
	surface: string;
	version: number;
	bytes: number;
	at: Date;
	increments: RenderCounterIncrements;
}

/** One surface's totals over the period: how many distinct keys, their bytes, and the four counters. */
export interface SurfaceTotals {
	surface: string;
	rows: number;
	bytes: number;
	hits: number;
	memoryHits: number;
	s3Hits: number;
	draws: number;
}

/** One cache key's hits over the period, monthly rows summed. */
export interface KeyTotals {
	cacheKey: string;
	surface: string;
	version: number;
	hits: number;
}

function monthMatch(months: readonly string[] | null, surface: string | null = null): PipelineStage.Match {
	const filter: Record<string, unknown> = {};
	if (months) filter.month = { $in: [...months] };
	if (surface) filter.surface = surface;
	return { $match: filter };
}

export const renderAnalyticsStore = {
	// The one write per lookup. $setOnInsert names the row only when the upsert
	// creates it, so the first lookup of a month starts the row and every later one
	// only moves counters; the unique { cacheKey, month } index keeps a racing
	// pair of first lookups on one row.
	async recordLookup({ cacheKey, month, surface, version, bytes, at, increments }: RenderLookupWrite): Promise<void> {
		await RenderAnalytics.updateOne(
			{ cacheKey, month },
			{
				$inc: increments,
				$setOnInsert: { cacheKey, month, surface, version, firstSeenAt: at },
				$set: { lastSeenAt: at, bytes },
			},
			{ upsert: true }
		);
	},

	// Two stage group: first per key (so a key's monthly rows count as one row and
	// its size counts once, at its largest), then per surface.
	async summarizeBySurface(months: readonly string[] | null): Promise<SurfaceTotals[]> {
		return RenderAnalytics.aggregate<SurfaceTotals>([
			monthMatch(months),
			{
				$group: {
					_id: { surface: "$surface", cacheKey: "$cacheKey" },
					bytes: { $max: "$bytes" },
					hits: { $sum: "$hits" },
					memoryHits: { $sum: "$memoryHits" },
					s3Hits: { $sum: "$s3Hits" },
					draws: { $sum: "$draws" },
				},
			},
			{
				$group: {
					_id: "$_id.surface",
					rows: { $sum: 1 },
					bytes: { $sum: "$bytes" },
					hits: { $sum: "$hits" },
					memoryHits: { $sum: "$memoryHits" },
					s3Hits: { $sum: "$s3Hits" },
					draws: { $sum: "$draws" },
				},
			},
			{ $project: { _id: 0, surface: "$_id", rows: 1, bytes: 1, hits: 1, memoryHits: 1, s3Hits: 1, draws: 1 } },
			{ $sort: { surface: 1 } },
		]);
	},

	// A key's monthly rows summed, most hit first. One surface, or every surface when null.
	async topKeys(months: readonly string[] | null, surface: string | null, limit: number): Promise<KeyTotals[]> {
		return RenderAnalytics.aggregate<KeyTotals>([
			monthMatch(months, surface),
			{
				$group: {
					_id: "$cacheKey",
					surface: { $first: "$surface" },
					version: { $first: "$version" },
					hits: { $sum: "$hits" },
				},
			},
			{ $sort: { hits: -1, _id: 1 } },
			{ $limit: limit },
			{ $project: { _id: 0, cacheKey: "$_id", surface: 1, version: 1, hits: 1 } },
		]);
	},
};
