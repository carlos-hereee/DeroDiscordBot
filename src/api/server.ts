import express from "express";
import type { Server } from "http";
import cors from "cors";
import { Client } from "discord.js";
import { verifySignature } from "./middleware/verifySignature.js";
import { createEventsRouter } from "./routes/events.routes.js";
import { createAnnounceRouter, createStandaloneGoLiveRouter } from "./routes/announce.routes.js";
import { healthRouter } from "./routes/health.routes.js";
import { createLeaderboardRouter } from "./routes/leaderboard.routes.js";
import { createPlayersRouter } from "./routes/players.routes.js";
import { remindersRouter } from "./routes/reminders.routes.js";
import { createScheduleRouter } from "./routes/schedule.routes.js";
import { createLeaderboardTrackingRouter } from "./routes/leaderboardTracking.routes.js";
import { createAutoHealRouter } from "./routes/autoHeal.routes.js";
import { createPairingRouter } from "./routes/pairing.routes.js";
import { createGameRoomsRouter } from "./routes/gameRooms.routes.js";
import { createStreamerRouter } from "./routes/streamer.routes.js";
import { dashboardOrigin, port } from "@utils/config.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

// the Discord client is a dependency because the events router has one route
// (POST /api/events/:eventId/test-reminder) that needs to post to a channel.
// the rest of the API is pure DB reads/writes and does not touch the client.
export function startApiServer(client: Client): Server {
	const app = express();

	// Parse JSON bodies. The verify callback captures the exact raw UTF-8 bytes BEFORE
	// JSON.parse normalizes them, which verifySignature needs to recompute the HMAC the
	// dashboard proxy stamped onto the request. Re-serializing req.body after parsing would
	// drift on whitespace, key order, and number formatting.
	app.use(
		express.json({
			verify: (req, _res, buf) => {
				(req as express.Request).rawBody = buf.toString("utf8");
			},
		})
	);

	// allow your portfolio website to call the API
	// replace with your actual portfolio domain in production
	app.use(cors({ origin: dashboardOrigin }));

	// Health checks.
	// What: two paths that return the same payload. Root /health is the
	//   classic platform probe (Railway/Render watchdogs hit this). /api/health
	//   exists so the dashboard's plugin proxy, which prepends /api to every
	//   forwarded path, can reach it without the bot having to special-case
	//   the "health" wildcard on the proxy side.
	// Who: Railway/Render deploy infra hits /health. The Company Uno plugin
	//   proxy (forwardToBot.ts) hits /api/health when PluginSettings's Test
	//   Connection button calls checkHealth().
	// When: on deploy boot loop + on every owner-initiated Test Connection click.
	// Where: mounted BEFORE verifySignature so neither path requires an HMAC
	//   signature or API key. Health is public by design, returning "ok" from
	//   an unauthenticated probe leaks nothing, and requiring a signature would
	//   defeat the whole point of a liveness check.
	// How: one shared handler, two mount points. Keep the body identical so
	//   downstream consumers do not need to branch on which URL they hit.
	const healthHandler = (_: express.Request, res: express.Response) => res.json({ status: "ok" });
	app.get("/health", healthHandler);
	app.get("/api/health", healthHandler);

	// All /api routes below this point require a valid HMAC signature from the dashboard proxy.
	// During the rollout window verifySignature falls back to plain API-key auth if signing
	// headers are absent or the secret is not yet configured, see the middleware comment for
	// the exact fall-through rules. Health routes above are intentionally outside this gate.
	app.use(verifySignature);

	// routes
	app.use("/api/events", createEventsRouter(client));
	// Go-live-now sits as a sibling router under the same /api/events mount so its
	// route shape (POST /:eventId/go-live-now) lives next to the persisted-event
	// CRUD without forcing the events router to take on transient announcements.
	// Unmatched paths in the events router fall through to this one in mount order.
	app.use("/api/events", createAnnounceRouter(client));
	// /api/health/guild is the guild-aware Test Connection endpoint. It lives
	// AFTER verifySignature on purpose so a probing attacker cannot enumerate
	// which guildIds the bot has configs for. The unauthenticated /health and
	// /api/health liveness probes mounted above remain public for Railway/Render.
	app.use("/api/health", healthRouter);
	// Leaderboard and players are now factories because both routes enrich
	// stored PlayerActivity rows with each warrior's CURRENT per guild
	// nickname at read time (see api/utils/enrichWithNicknames.ts). The
	// nickname lookup needs the live Discord client to resolve GuildMember
	// objects, so we inject the client here the same way createEventsRouter
	// receives it for the test fire route.
	app.use("/api/leaderboard", createLeaderboardRouter(client));
	app.use("/api/players", createPlayersRouter(client));
	app.use("/api/reminders", remindersRouter);
	// Game room history for the dashboard. No client injection: unlike leaderboard
	// and players it does not enrich rows with live nicknames, because a room row
	// already carries the ids the dashboard needs and the match is over by the time
	// it is listed.
	app.use("/api/game-rooms", createGameRoomsRouter());
	// /api/streamer, the Dero Live stream companion's read-only recent-activity
	// summary (counts and highlights from leveling plus active events, never a
	// transcript). Behind verifySignature like every /api route; the platform
	// side additionally allowlists the "streamer" prefix on the general-events
	// proxy entry ONLY. No client injection: pure DB reads.
	app.use("/api/streamer", createStreamerRouter());
	// Schedule-level pause/resume for the Command Center button. Separate
	// router from the per-event pause that lives in events.routes, the
	// guild-wide flag has different semantics than the per-event flag.
	app.use("/api/schedule", createScheduleRouter());
	// Standalone /api/go-live-now (no eventId) for the Command Center
	// Go Live button. The event-bound version remains mounted under
	// /api/events/:eventId/go-live-now via createAnnounceRouter.
	app.use("/api/go-live-now", createStandaloneGoLiveRouter(client));
	// /api/leaderboard-tracking, HTTP twin of the slash command for the
	// Command Center leaderboard pause/continue button.
	app.use("/api/leaderboard-tracking", createLeaderboardTrackingRouter());
	// /api/auto-heal, HTTP twin of /configure-auto-heal for the Settings
	// tab toggle. Same idempotency + payload shape as leaderboard-tracking.
	app.use("/api/auto-heal", createAutoHealRouter());
	// /api/pairing, exchanges a one-time claim code (issued + DM'd on
	// guildCreate in Phase 1 of FUTURE_PLANS item 63) for guildId +
	// ownerUserId so the platform server can bind this Discord guild into
	// the user's pluginConfig. Unlike every other /api/* route this one does
	// NOT take ?guildId= because the code IS the discriminator, the
	// platform does not yet know the guildId at redemption time. Still
	// behind verifySignature because the signed proxy is the only caller.
	app.use("/api/pairing", createPairingRouter());

	// Return the Server handle so main.ts can close it during graceful shutdown
	// (stop accepting new requests before the Discord client and Mongo connection
	// are torn down).
	return app.listen(port, () => {
		console.log(LOG_MESSAGES.api.serverRunning(port));
	});
}
