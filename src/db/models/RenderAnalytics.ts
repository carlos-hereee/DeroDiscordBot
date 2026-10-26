// src/db/models/RenderAnalytics.ts
import mongoose from "mongoose";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── RenderAnalytics ──
// One row per render cache key per UTC month, counting how often that card (or
// that avatar size) was served from memory, served from S3, or drawn. Written
// only by features/renderer/renderAnalytics.ts through renderAnalyticsStore, and
// read by /platform analytics. It holds counts and sizes, never an image.
//
// ⚠️ NO USER ID, GUILD ID, USERNAME OR AVATAR KEY EVER LANDS HERE. A card key is
// a hash of the card's input, and an avatar row is keyed by size alone
// ("avatar:128"), because the avatar cache's own key carries a user id. The rows
// are platform wide on purpose, which is why the command reading them is owner
// only (2026-10 item 244, risk R4).

export interface IRenderAnalytics {
	// The render cache key (`discord-bot/renders/<kind>/<version>/<hash>.png`), or `avatar:<size>`.
	cacheKey: string;
	// "YYYY-MM" in UTC, zero padded so months sort lexically.
	month: string;
	// The render kind (`account`, `level-up`), or "avatar".
	surface: string;
	version: number;
	hits: number;
	memoryHits: number;
	s3Hits: number;
	draws: number;
	// Byte length of the image last served under this key; 0 for avatar rows.
	bytes: number;
	firstSeenAt: Date;
	lastSeenAt: Date;
}

const renderAnalyticsSchema = new mongoose.Schema<IRenderAnalytics>({
	cacheKey: { type: String, required: true },
	month: { type: String, required: true },
	surface: { type: String, required: true },
	version: { type: Number, required: true },
	hits: { type: Number, default: 0 },
	memoryHits: { type: Number, default: 0 },
	s3Hits: { type: Number, default: 0 },
	draws: { type: Number, default: 0 },
	bytes: { type: Number, default: 0 },
	firstSeenAt: { type: Date, required: true },
	lastSeenAt: { type: Date, required: true },
});

// ⚠️ REQUIRED, not an optimization. Every lookup is an upsert on { cacheKey,
// month }, and the first two lookups of a key in a month can race the upsert;
// this constraint is what keeps them on ONE row rather than two rows each
// holding half the month's count. Same reasoning as DeroVoiceSpend.
renderAnalyticsSchema.index({ cacheKey: 1, month: 1 }, { unique: true });

// Serves the top N query: one month (or a few), optionally one surface, most hit first.
renderAnalyticsSchema.index({ month: 1, surface: 1, hits: -1 });

// A key nobody has looked up for 13 months is history nobody reads, so Mongo's
// TTL monitor removes it rather than letting the long tail grow forever (risk R3).
renderAnalyticsSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: BOT_CONSTANTS.RENDER_ANALYTICS.RETENTION_SECONDS });

export const RenderAnalytics = mongoose.model<IRenderAnalytics>("RenderAnalytics", renderAnalyticsSchema);
