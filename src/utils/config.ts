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

// ── Leveling paid-tier enforcement ──
// What: when true, earning xp asks nexious-server whether this guild carries the entitlement.
//   When false (the default, and the production state today, and the state the owner intends
//   for the foreseeable future) the gate returns allowed immediately with ZERO network calls.
// Who: read only by features/entitlements/levelingAccess.ts.
// When: leveling is FREE for every member, mirroring the mini games decision, so this is not
//   expected to be flipped. The seam exists so that if it ever is, the change is a config flip
//   rather than threading a gate through the award path after the fact.
// Where: identical shape and reasoning to enforceGameRoomTier above, deliberately. nexious-server
//   remains the tier authority; the bot's own DB never stores a guild's platform tier.
// How: same explicit string comparison, NOT a truthiness check, so a stray "false" in the env
//   cannot read as on.
//
// ⚠️ This is NOT a kill switch for the leveling feature. Turning leveling OFF is
// GuildConfig.leveling.enabled per guild, which needs no deploy. Do not conflate the two: this
// flag decides who is ENTITLED, and it fails OPEN, so setting it could never disable anything.
const enforceLevelingTier = (() => {
	const raw = (process.env.ENFORCE_LEVELING_TIER ?? "").toLowerCase().trim();
	return raw === "1" || raw === "true" || raw === "yes";
})();

// ── ElevenLabs API key (Dero voice) ──
// What: the key every text to speech call sends as the xi-api-key header.
// Who: read only by features/voice/elevenLabsTts.ts. Never logged, never echoed
//   to Discord; /dero-config status reports only whether it is set.
// When: empty (the default) means no speech call is ever sent: the provider
//   refuses before fetch, so a guild that enabled voice without the key gets a
//   plain "Dero cannot speak right now" instead of a 401 round trip.
// Where: set on Railway and in the local .env by the owner, by hand.
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || "";

// ── Dero brain key ──
// What: the HMAC secret the launcher's local Dero signs every /brain request
//   with. Its own secret, deliberately NOT DASHBOARD_SIGNING_SECRET: the brain
//   is not dashboard traffic, and a leak of one must not open the other.
// Who: read only by api/middleware/verifyBrainSignature.ts. Never logged.
// When: empty (the default) or shorter than DERO_BRAIN_MIN_KEY_LENGTH means
//   every /brain route answers 503. There is no api key fallback of any kind.
// Where: set by the owner in the bot's local .env and on Railway, and in the
//   launcher's gitignored .env under the same name.
const deroBrainKey = process.env.DERO_BRAIN_KEY || "";

// ── Dero voice soak sampler ──
// What: whether the soak sampler writes its one row a minute while a call is open.
// Who: read only by main.ts, which starts features/voice/soakSampler.ts with it.
// When: exactly "1" turns it on; anything else, unset included, leaves it off,
//   so a typo can never leave a production bot writing a row every minute.
// Where: set by the owner for the 30 minute soak, then unset.
const deroVoiceSamplerEnabled = process.env.DERO_VOICE_SAMPLER === "1";

// ── Rendered card store on S3 (2026-10 item 243) ──
// What: the bot's own IAM key, bucket and region for the rendered card cache,
//   plus the switch that turns that S3 tier on. The key is the BOT's, not
//   nexious-server's: it may write only under discord-bot/ on the shared
//   Company Uno bucket, so a leak of one never opens the other.
// Who: the credentials, bucket and region are read only by utils/aws/index.ts;
//   the switch only by features/renderer/s3.ts. None of them is ever logged.
// When: off (the default, and every dev session) means no S3 call is ever sent;
//   cards render on demand behind the in-memory cache.
// Where: set by the owner on Railway; the bucket and region are the same values
//   as nexious-server's AWS_BUCKET_NAME and AWS_REGION.
// How: the same explicit string comparison as the flags above. The switch reads
//   as on only when all four values are set as well, and a switch that is on
//   with a value missing warns once at boot, naming the missing variables (never
//   a value), so a half configured env degrades to the memory cache instead of
//   failing every upload.
const discordBotAwsAccessKey = process.env.DISCORD_BOT_AWS_ACCESS_KEY || "";
const discordBotAwsSecretKey = process.env.DISCORD_BOT_AWS_SECRET_KEY || "";
const discordBotAwsBucketName = process.env.DISCORD_BOT_AWS_BUCKET_NAME || "";
const discordBotAwsRegion = process.env.DISCORD_BOT_AWS_REGION || "";
const discordBotS3Enabled = (() => {
	const raw = (process.env.DISCORD_BOT_S3_ENABLED ?? "").toLowerCase().trim();
	if (raw !== "1" && raw !== "true" && raw !== "yes") return false;
	const required = {
		DISCORD_BOT_AWS_ACCESS_KEY: discordBotAwsAccessKey,
		DISCORD_BOT_AWS_SECRET_KEY: discordBotAwsSecretKey,
		DISCORD_BOT_AWS_BUCKET_NAME: discordBotAwsBucketName,
		DISCORD_BOT_AWS_REGION: discordBotAwsRegion,
	};
	const missing = Object.entries(required)
		.filter(([, value]) => !value)
		.map(([name]) => name);
	if (missing.length === 0) return true;
	console.warn(
		`[config] DISCORD_BOT_S3_ENABLED is on but these are not set: ${missing.join(", ")}. ` +
		"Rendered cards stay in the memory cache and nothing is written to S3 until they are set and the bot restarts.",
	);
	return false;
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
	enforceLevelingTier,
	elevenLabsApiKey,
	deroBrainKey,
	deroVoiceSamplerEnabled,
	discordBotAwsAccessKey,
	discordBotAwsSecretKey,
	discordBotAwsBucketName,
	discordBotAwsRegion,
	discordBotS3Enabled,
};
