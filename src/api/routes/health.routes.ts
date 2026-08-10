import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { requireGuildId } from "../middleware/requireGuildId.js";
import { lastReminderTickAt } from "@features/reminders/ReminderScheduler.js";

// ── Guild-aware health ──────────────────────────────────────────────────────
// What:  GET /api/health/guild?guildId=... returns whether THIS bot knows the
//        given guild and has completed setup. This is the endpoint behind the
//        dashboard's "Test Connection" button. The plain liveness endpoints
//        (/health and /api/health) live in server.ts and answer "is the
//        process alive" without consulting Mongo or guild scope.
// Who:   PluginContext.checkHealth on the dashboard, called from
//        PluginSettings's Test Connection button AND at EventCreatePage
//        mount so the page can disable the KvK toggle when no season is
//        configured. Hitting this endpoint with a bogus guildId (e.g.
//        999999999999999999) was previously returning success because the
//        old /api/health handler ignored the guildId param entirely.
// When:  on every owner-initiated Test Connection click and on
//        EventCreatePage mount.
// Where: mounted AFTER verifySignature so it inherits the dashboard signing
//        contract. The plain /health and /api/health remain pre-signature
//        for Railway/Render watchdogs that have no signing key.
// How:   look up GuildConfig by guildId.
//          - missing config        → 404 + { ok: false, reason: "guild_not_found" }
//          - present but unfinished → 200 + { ok: false, reason: "guild_setup_incomplete" }
//          - present and finished  → 200 + { ok: true, kvkSeasonEnd }
//        404 (not 403) on miss is deliberate: the bot follows the same
//        existence-non-leakage rule as the rest of the API (CLAUDE.md
//        invariant #2). A signature-verified caller that just typoed a
//        digit gets the same 404 a probing attacker would.
//
//        kvkSeasonEnd is only included on the success path. The dashboard
//        reads it to decide whether the KvK announcement toggle should be
//        enabled on EventCreatePage. null means "no active season, run
//        /configure-kvk-season first" and the dashboard greys out the
//        toggle with a hint pointing at the slash command.
export const healthRouter = Router();

healthRouter.get("/guild", async (req: Request, res: Response) => {
	const guildId = requireGuildId(req, res);
	if (guildId === null) return;

	try {
		const config = await guildConfigStore.findByGuildId(guildId);
		if (!config) {
			res.status(404).json({ ok: false, reason: "guild_not_found" });
			return;
		}
		if (!config.setupComplete) {
			// 200 (not 4xx) because the guild IS known to this bot, the
			// caller's input was valid. This is informational status, not
			// failure: the dashboard can render "bot is in your server but
			// /setup has not been run yet" with a CTA to finish setup.
			res.status(200).json({ ok: false, reason: "guild_setup_incomplete" });
			return;
		}
		// Surface the canonical KvK season end alongside the ok flag so the
		// dashboard can derive UI state (toggle enabled / disabled, hint
		// copy) without a second round trip. ISO string keeps the wire
		// format JSON friendly. null when no season has been configured
		// yet, the dashboard treats that as "KvK toggle off, point user
		// at /configure-kvk-season".
		// Surface the schedule-level pause state alongside kvkSeasonEnd so
		// the Command Center can render its pause banner without an extra
		// round trip. Same "single endpoint, multiple fields" pattern this
		// endpoint already uses for KvK status. leaderboardTrackingEnabled
		// is surfaced here too so the leaderboard pause/continue button on
		// Command Center can read state from the same call.
		const schedulePausedRaw = (config as unknown as { schedulePaused?: { paused?: boolean; pausedUntil?: Date | null } }).schedulePaused;
		// leaderboardChannelMissing is true when the channel id is unset OR
		// the slot is in userRemovedChannels (user explicitly removed it via
		// the slash command follow-up button). The Command Center uses this
		// to decide whether to render the Pause/Resume leaderboard button,
		// pausing tracking when there is no visible leaderboard channel is
		// misleading, so the button hides until the channel is restored.
		const userRemovedSlots = ((config as unknown as { userRemovedChannels?: string[] }).userRemovedChannels ?? []) as string[];
		const leaderboardChannelMissing =
			!config.leaderboardChannelId || userRemovedSlots.includes("leaderboardChannelId");
		res.status(200).json({
			ok: true,
			kvkSeasonEnd: config.kvkSeasonEnd ? new Date(config.kvkSeasonEnd).toISOString() : null,
			schedulePaused: {
				paused: Boolean(schedulePausedRaw?.paused),
				pausedUntil: schedulePausedRaw?.pausedUntil
					? new Date(schedulePausedRaw.pausedUntil).toISOString()
					: null,
			},
			leaderboardTrackingEnabled:
				(config as unknown as { leaderboardTrackingEnabled?: boolean }).leaderboardTrackingEnabled !== false,
			leaderboardChannelMissing,
			// Surface autoHealEnabled too so the Settings tab can render
			// the same state-pill + button pattern as the leaderboard
			// section. Default true if the field is unset on a legacy
			// row (mirrors the schema default).
			autoHealEnabled:
				(config as unknown as { autoHealEnabled?: boolean }).autoHealEnabled !== false,
		});
	} catch (error) {
		// Don't leak Mongo errors to the dashboard. A real outage shows up
		// as ok:false and the user is told to try again, same UX as a
		// transient network hiccup.
		console.error("[health/guild] lookup failed:", error);
		res.status(500).json({ ok: false, reason: "internal_error" });
	}
});

// ── readiness probe (audit L2) ──────────────────────────────────────
// What:  GET /api/health/ready reports whether the bot is actually FUNCTIONING,
//        not merely alive. The plain /health and /api/health liveness probes in
//        server.ts answer "is the process up"; this answers "is Mongo connected
//        AND is the per-minute scheduler actually ticking." Returns 200 ok:true
//        when healthy, 503 ok:false when degraded, so an uptime monitor can
//        alert on the "process alive but not working" failure mode that liveness
//        alone misses (e.g. Mongo dropped, or the cron wedged).
// Who:   operators / uptime monitors via the signed proxy. No guildId, it is a
//        global bot-health signal, not per-tenant.
// Where: mounted under verifySignature like /guild, so it does not expose
//        internal state to the public. The pre-signature liveness probes remain
//        for Railway/Render watchdogs that have no signing key.
healthRouter.get("/ready", (_req: Request, res: Response) => {
	// mongoose readyState 1 = connected. Anything else = down or still connecting.
	const mongoConnected = mongoose.connection.readyState === 1;
	// The tick runs every 60s; treat > 3 minutes since the last one (or never,
	// just after boot) as not-ready so a wedged scheduler surfaces as degraded.
	const tickAgeMs = lastReminderTickAt ? Date.now() - lastReminderTickAt.getTime() : null;
	const tickFresh = tickAgeMs !== null && tickAgeMs < 3 * 60 * 1000;
	const ok = mongoConnected && tickFresh;
	res.status(ok ? 200 : 503).json({
		ok,
		mongoConnected,
		lastTickAt: lastReminderTickAt ? lastReminderTickAt.toISOString() : null,
		tickAgeMs,
	});
});
