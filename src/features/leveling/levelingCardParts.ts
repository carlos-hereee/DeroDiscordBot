import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import { canvasColor } from "@features/renderer/index.js";

// ── leveling card parts ────────────────────────────────────────────────────
// The tier metal of an achievement, as the leveling cards draw it (account,
// achievement unlock). Feature local because only the leveling cards use it.
// The member face and Dero's pose the leveling cards also draw moved up into
// src/features/renderer/cardParts.ts when the platform cards of 2026-10 item
// 243 Phase 4 became their second users.

// The four tier metals, and the embed's bronze for a tier name this file does
// not know yet, so a fifth tier added to achievements.ts still draws.
const TIER_COLORS: Record<string, ColorResolvable> = {
	bronze: COLORS.ACHIEVEMENT_BRONZE,
	silver: COLORS.ACHIEVEMENT_SILVER,
	gold: COLORS.ACHIEVEMENT_GOLD,
	diamond: COLORS.ACHIEVEMENT_DIAMOND,
};

/** An achievement tier's metal as a brand token, for a glow or anything else that takes a token. */
export function tierToken(tier: string): ColorResolvable {
	return TIER_COLORS[tier] ?? COLORS.ACHIEVEMENT;
}

/** An achievement tier's metal as a canvas color. */
export function tierColor(tier: string): string {
	return canvasColor(tierToken(tier));
}
