import { EmbedBuilder, type ColorResolvable } from "discord.js";
import { serverApi } from "@utils/serverApi.js";
import { COLORS } from "@base/copy/brand.js";

// ── Studio early-access feature gate ("Dero's new powers first") ──
// What: decides whether a guild may use a slash command that is currently inside its
//   Studio-only early-access window. New Dero powers ship LISTED here so Studio-owned
//   guilds get them before general release; once a feature's generalReleaseAt passes it
//   opens to every guild automatically, with no manual flip.
// Who: called by main.ts' interactionCreate dispatch before command.execute. Any feature
//   that wants to branch on eligibility can also call resolveGuildEarlyAccess directly.
// When: on every chat-input command whose name appears in EARLY_ACCESS_FEATURES and is
//   still in-window. Commands not listed (the overwhelming majority) short-circuit with
//   no network call at all.
// Where: the bot's own DB never stores a guild's platform tier, so this bridges to
//   nexious-server (the tier authority) over the signed serverApi. earlyPluginAccess on
//   the server is the source of truth; the bot only caches the resolved boolean.
// How: ① feature not listed, or already past generalReleaseAt -> open to everyone.
//   ② still early -> resolve the guild owner's eligibility from the server (cached).
//   Fail CLOSED on any server error so an in-window feature is never leaked to a guild we
//   cannot confirm; the feature still reaches everyone at generalReleaseAt regardless.

// Slash-command name -> the moment the feature graduates to every tier. Adding a new
// Studio-first power is a ONE-LINE entry here plus the command itself; the dispatch gate
// does the rest. Past-dated entries are harmless (they read as generally available) and
// can be pruned once well clear of the date.
//
// Empty by default: no Dero feature is mid-rollout right now. The mechanism is live and
// enforced, so the next new power ships Studio-first simply by landing here with a future
// date.
export const EARLY_ACCESS_FEATURES: Record<string, { generalReleaseAt: Date }> = {};

export interface EarlyAccessDecision {
  allowed: boolean;
  // Present only when blocked, so the caller can tell the user when it opens to everyone.
  generalReleaseAt?: Date;
}

// ── Guild eligibility cache ──
// Owner tier changes rarely, so a CONFIRMED answer is cached for an hour to keep the
// Discord command hot path off Heroku. A server ERROR is cached only briefly so a
// transient blip does not lock a Studio guild out of an early feature for the full hour.
const CONFIRMED_TTL_MS = 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;
interface EligibilityEntry {
  value: boolean;
  expiresAt: number;
}
const eligibilityCache = new Map<string, EligibilityEntry>();

// Test seam: reset the cache between cases.
export const _clearEarlyAccessCache = (): void => eligibilityCache.clear();

interface GuildAccessResponse {
  guildId: string;
  earlyAccess?: boolean;
}

// Resolve (and cache) whether a guild's app owner carries early plugin access. Fail
// CLOSED: any not-configured / transport / 4xx / 5xx error resolves to false so an
// in-window feature is never exposed to a guild we cannot confirm.
export const resolveGuildEarlyAccess = async (guildId: string, now: Date = new Date()): Promise<boolean> => {
  if (!guildId) return false;
  const cached = eligibilityCache.get(guildId);
  if (cached && cached.expiresAt > now.getTime()) return cached.value;
  try {
    const res = await serverApi.get<GuildAccessResponse>("/api/plugin-access/guild", { guildId });
    const value = res?.earlyAccess === true;
    eligibilityCache.set(guildId, { value, expiresAt: now.getTime() + CONFIRMED_TTL_MS });
    return value;
  } catch {
    // Fail closed, but only briefly: retry within a minute so one bad round-trip does
    // not lock a Studio guild out of an early feature for the full confirmed TTL.
    eligibilityCache.set(guildId, { value: false, expiresAt: now.getTime() + ERROR_TTL_MS });
    return false;
  }
};

// Decide whether `commandName` may run in `guildId` right now.
export const checkEarlyAccess = async (
  commandName: string,
  guildId: string,
  now: Date = new Date()
): Promise<EarlyAccessDecision> => {
  const feature = EARLY_ACCESS_FEATURES[commandName];
  if (!feature) return { allowed: true };
  if (now.getTime() >= feature.generalReleaseAt.getTime()) return { allowed: true };
  const eligible = await resolveGuildEarlyAccess(guildId, now);
  return eligible ? { allowed: true } : { allowed: false, generalReleaseAt: feature.generalReleaseAt };
};

// Ephemeral notice shown when a guild hits a feature still in its Studio-only window.
// Admin-facing and practical (bot copy rule 5), pack-neutral wording, with the general
// release date as Discord relative + long-date timestamps so it localizes per viewer.
export const earlyAccessEmbed = (generalReleaseAt: Date): EmbedBuilder => {
  const releaseTs = Math.floor(generalReleaseAt.getTime() / 1000);
  return new EmbedBuilder()
    // COLORS is a plain string map, so its values widen to string; the cast pins the
    // brand indigo hex back to a ColorResolvable.
    .setColor(COLORS.DERO as ColorResolvable)
    .setTitle("Early access feature")
    .setDescription(
      [
        "This Dero feature is in **early access for Studio plans** on Company Uno.",
        `It opens to everyone <t:${releaseTs}:R> (on <t:${releaseTs}:D>).`,
        "",
        "Studio unlocks new Dero powers the moment they ship. See https://www.companyuno.com/pricing.",
      ].join("\n")
    );
};
