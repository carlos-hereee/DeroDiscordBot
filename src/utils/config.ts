import "dotenv/config.js";

// Accept both "development" (what the `npm run development` script sets) and
// the shorthand "dev". The previous check only matched "dev", so isDev was
// always false in the documented dev workflow, a latent trap for any future
// branch that keys off it.
const isDev = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "dev";
const isProduction = process.env.NODE_ENV === "production";
const dbEnv = process.env.DB_ENV || "development";

// ── client id ────────────────────────────────────────────────
// What:  pick the bot's Discord client id based on NODE_ENV so dev
//        and prod can coexist in a single .env file (or be set in
//        separate Railway environment scopes) without ever risking
//        the dev process attaching to the prod application id.
// Who:   deploy-commands.ts, botInviteLink (below), and any future
//        code path that needs to reference the bot's identity.
// When:  read once at module load. Process restart picks up env
//        changes; live edits do not.
// Where: NOTE, Discord client ids are NOT secrets. They appear on
//        every OAuth URL and the bot's Discord profile. Storing
//        them in env is purely an environment-separation
//        convenience; the only true secret in this file is
//        DISCORD_TOKEN.
// How:   ① if NODE_ENV=production AND DISCORD_CLIENT_ID_PROD is
//          set, use it.
//        ② otherwise, if dev/anything-else AND DISCORD_CLIENT_ID_DEV
//          is set, use it.
//        ③ legacy fallback to the single DISCORD_CLIENT_ID var so
//          existing deployments that haven't migrated to the split
//          form keep working.
//        ④ empty string sentinel if nothing is set; deploy-commands
//          surfaces a missing-credentials error in that case.
const clientId = (() => {
	if (isProduction && process.env.DISCORD_CLIENT_ID_PROD) {
		return process.env.DISCORD_CLIENT_ID_PROD;
	}
	if (!isProduction && process.env.DISCORD_CLIENT_ID_DEV) {
		return process.env.DISCORD_CLIENT_ID_DEV;
	}
	return process.env.DISCORD_CLIENT_ID || "";
})();

const discordToken = process.env.DISCORD_TOKEN || "";
const discordGuildId = process.env.DISCORD_GUILD_ID || "";
// ── discordGuildIds (plural) ───────────────────────────────────
// What:  comma-separated parsing of DISCORD_GUILD_ID so dev-mode
//        deploy-commands can register to multiple test guilds in
//        one run. Setting DISCORD_GUILD_ID="1234,5678,9012" pushes
//        the slash command schemas to each guild in sequence.
//        Single-id values still work, the split gives a one-
//        element array, which deploy-commands iterates over the
//        same way as a multi-id value.
// Who:   deploy-commands.ts at the dev branch.
// When:  read once at module load. Solo dev workflow: each
//        deploy-commands run hits every listed guild.
// Where: trims whitespace and filters empties so trailing commas
//        or extra spaces in the env string do not silently produce
//        empty-string guild ids that Discord rejects with 404.
// How:   plain split, no schema validation, Discord's API will
//        reject a malformed snowflake at registration time, which
//        surfaces in the deploy-commands output for fast feedback.
const discordGuildIds = discordGuildId
	.split(",")
	.map((id) => id.trim())
	.filter((id) => id.length > 0);
const creatorId = process.env.CREATOR_DISCORD_ID || "";

// ── bot invite link ───────────────────────────────────────────
// What:  the canonical OAuth2 install URL for whichever bot
//        identity is loaded in this process (dev or prod). Wired
//        into the introductions intro embed via ChannelContent so
//        a dev instance never serves the prod invite URL.
// Who:   ChannelContent.introductionComponents() consumes this.
// When:  evaluated once at module load with the resolved clientId.
// Where: permissions=8 (Administrator) ships today as a known
//        workaround for the Discord catch-22 around bot member
//        overwrites in private channels. Tech-debt item is to
//        refactor channel creation to use the bot's integration
//        role overwrite and drop back to the minimum-bits set
//        (268659792), see BOT_CONSTANTS.MIN_PERMISSIONS_DOCS.
const botInviteLink = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&integration_type=0&scope=bot+applications.commands`;
const port = process.env.PORT || 4937;
const uri = process.env.MONGOOSE_URI || "";
const dashboardApiKey = process.env.DASHBOARD_API_KEY || "";
// Shared HMAC secret used by the dashboard's Heroku proxy to sign each forwarded request.
// Empty during rollout, the auth middleware falls back to apiKeyAuth until this is set
// on both sides. Once present, signed requests are accepted and apiKey alone is rejected.
// Reused for the reverse direction (bot → server) by serverApi.ts.
const dashboardSigningSecret = process.env.DASHBOARD_SIGNING_SECRET || "";

// ── require signed requests (strict mode) ──
// What: when true, verifySignature rejects any /api/* request that is not
//   HMAC-signed, instead of falling back to plain x-api-key auth.
// Who: read by api/middleware/verifySignature.ts.
// When: OFF by default so the signing rollout can land one side at a time
//   (the fallback to apiKeyAuth keeps the API reachable while only one side
//   signs). Flip to true AFTER both the server and bot are signing every
//   request, at that point the static-api-key fallback is the last path by
//   which a caller could pass an arbitrary ?guildId= with only the shared key,
//   so closing it is the bot-side hardening for audit item C2.
// Where: pairs with dashboardSigningSecret. Strict mode with no secret set is
//   a misconfiguration and fails closed (the middleware cannot verify anything
//   without the secret).
// How: any non-empty truthy string turns it on; empty/unset = off.
const requireSignedRequests = (() => {
	const raw = (process.env.REQUIRE_SIGNED_REQUESTS ?? "").toLowerCase().trim();
	return raw === "1" || raw === "true" || raw === "yes";
})();

// ── PlayerActivity retention window (audit H7) ──
// What: number of days of PlayerActivity history to keep. A daily cleanup cron
//   in ReminderScheduler deletes rows whose eventOccurrence is older than this.
// Who: read by the retention cron only.
// When: 0 (the default when unset, non-numeric, or <= 0) DISABLES cleanup,
//   nothing is ever deleted. PlayerActivity is leaderboard history, so deletion
//   is opt-in: the owner sets a window deliberately (e.g. 365 to keep a year).
// How: parsed as an integer; anything not a positive finite number means off.
const playerActivityRetentionDays = (() => {
	const raw = Number.parseInt(process.env.PLAYER_ACTIVITY_RETENTION_DAYS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
})();

// ── Future-A remote events flag ──
// What: when true, eventStore reads/writes route through the nexious-server's
//   /api/events surface instead of this bot's local Mongo `Event` collection.
// Who: every slash command, scheduler tick, and HTTP route that calls eventStore.
// When: flipped to true AFTER F4 migration has copied existing events from the bot
//   DB to the server DB. Default false so deploying the F2 code without the flag set
//   is a no-op (safe rollback path).
// Where: read by db/stores/eventStore.ts which delegates to remoteEventStore when on.
// How: any non-empty truthy string ("1", "true", "yes") turns it on. Empty/unset = off.
const useRemoteEvents = (() => {
	const raw = (process.env.USE_REMOTE_EVENTS ?? "").toLowerCase().trim();
	return raw === "1" || raw === "true" || raw === "yes";
})();

// ── Game Rooms paid-tier enforcement ──
// What: when true, opening a game room asks nexious-server whether this member's guild carries
//   the entitlement. When false (the default, and the production state today) the gate returns
//   allowed immediately with ZERO network calls.
// Who: read only by features/entitlements/gameRoomAccess.ts. Never read in main.ts, because
//   main.ts runs its gates inside `if (interaction.isChatInputCommand())` and game rooms are
//   button driven; the gate is called inside the button handler instead.
// When: flipped on only once game rooms are actually being charged for. The seam exists ahead
//   of the price so every call site is already correct and in the right place when it lands.
// Where: pairs with dashboardSigningSecret, since the lookup rides the same signed serverApi
//   channel. The bot's own DB never stores a guild's platform tier; nexious-server is the
//   authority. That invariant is stated in earlyAccess.ts and this flag does not break it.
// How: same explicit string comparison as the flags above, NOT a truthiness check, so a stray
//   "false" in the env cannot read as on.
const enforceGameRoomTier = (() => {
	const raw = (process.env.ENFORCE_GAME_ROOM_TIER ?? "").toLowerCase().trim();
	return raw === "1" || raw === "true" || raw === "yes";
})();
// CORS allow-list for the dashboard.
// What: the Express `cors({ origin })` middleware accepts a string (single
//   origin), an array (multiple origins), or a function. We want multiple
//   origins in prod (e.g. the production Vercel URL AND any preview deploys)
//   without redeploying the bot every time we add one, so this supports a
//   comma-separated env var.
// Who: consumed by src/api/server.ts when it calls cors({ origin }). The
//   allowed origins must include every host the browser loads the Company
//   Uno client from, misconfigure this and the browser blocks every API
//   call from the dashboard with a CORS error.
// When: read once at bot boot. Change of env var requires a restart.
// Where: the Heroku-hosted server is NOT an origin, it is a backend calling
//   this bot via node-fetch which is not CORS-constrained. Only browser
//   origins belong in this list.
// How: split on commas, trim, drop empties. If nothing is set we fall back
//   to localhost for dev ergonomics, but emit a LOUD warn on boot so a prod
//   deploy that forgot DASHBOARD_ORIGIN is obvious in Railway logs.
const dashboardOriginRaw = process.env.DASHBOARD_ORIGIN || "";
const dashboardOrigin: string | string[] = dashboardOriginRaw
	? dashboardOriginRaw.split(",").map((o) => o.trim()).filter(Boolean)
	: "http://localhost:5173";
if (isProduction && !dashboardOriginRaw) {
	// Don't crash, some operators may rely on a reverse proxy handling CORS.
	// But log loud enough that the first thing they see in Railway logs is this.
	console.warn(
		"[config] DASHBOARD_ORIGIN not set in production, defaulting to http://localhost:5173. " +
		"The production Vercel client will be blocked by CORS. Set DASHBOARD_ORIGIN to your " +
		"Vercel URL (comma-separated for multiple) and restart.",
	);
}

export {
	isDev,
	isProduction,
	dbEnv,
	clientId,
	discordToken,
	discordGuildId,
	discordGuildIds,
	creatorId,
	botInviteLink,
	port,
	uri,
	dashboardApiKey,
	dashboardSigningSecret,
	requireSignedRequests,
	dashboardOrigin,
	useRemoteEvents,
	playerActivityRetentionDays,
	enforceGameRoomTier,
};
