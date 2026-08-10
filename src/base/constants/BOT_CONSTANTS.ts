export const BOT_CONSTANTS = {
	// reminder
	DEFAULT_REMINDER_OFFSETS: [30, 15], // minutes before event to send reminders
	EVENT_WINDOW_MINUTES: 60, // how long after start time the event is considered "active"
	// used by ActivityTracker to know when to track voice

	// participation scoring weights
	SCORE_WEIGHTS: {
		ACKNOWLEDGED_REMINDER: 10,
		WAS_ONLINE_AT_START: 20,
		JOINED_VOICE: 30,
		VOICE_MINUTE_BONUS: 1, // per minute in VC
		MAX_VOICE_BONUS: 60, // cap so one player cant dominate just by idling
	},

	// default prep steps applied to every new event
	// admin can override these per event later
	DEFAULT_PREP_STEPS: [
		{ label: "Activate stats token", order: 1 },
		{ label: "Fetch rune buff", order: 2 },
		{ label: "Use army expansion", order: 3 },
	],

	// ── admin commands that require role check ────────────────────
	// /list-events and /leaderboard are deliberately NOT in this set,
	// both are read-only and were moved to the public #command-center
	// when the public/admin command guide split landed on 2026-04-24.
	// Mortals seeing their rank and what's scheduled is the whole point.
	// New admin streamer commands (configure-stream-schedule,
	// pause-schedule, continue-schedule, go-live-soon, announce-stream)
	// are gated because they write state.
	ADMIN_COMMANDS: new Set<string>([
		"configure-kvk-season",
		"delete-event",
		"configure-stream-schedule",
		"pause-schedule",
		"continue-schedule",
		"go-live-soon",
		"announce-stream",
	]),
	// scheduler
	SCHEDULER_CRON: "* * * * *", // every minute
	REMINDER_FIRE_WINDOW_MS: 60_000, // how close to reminder time before we fire it
	// Max number of guilds the per-minute tick reads in parallel. The tick fans
	// out one events+config read per guild; without a ceiling, thousands of
	// guilds means thousands of simultaneous DB/HTTP calls in one tick, which
	// saturates the connection pool (or Heroku, under USE_REMOTE_EVENTS) and can
	// blow the 60s budget. 20 keeps the pool busy without stampeding it. Read by
	// ReminderScheduler via mapWithConcurrency.
	SCHEDULER_GUILD_CONCURRENCY: 20,

	// ── reminder log sentinel offsets ──────────────────────────────
	// offsetMinutes values that aren't real "N minutes before event" markers.
	// these exist so the compound unique index on
	// { eventId, eventOccurrence, offsetMinutes } stays honest even for
	// non-standard fires (season end announcements, dashboard test fires).
	REMINDER_LOG_OFFSETS: {
		SEASON_END: -1, // used by ReminderScheduler when announcing end of season
		TEST: -2, // used by test reminder fires dispatched from the dashboard
	},

	// ── dashboard test reminder ───────────────────────────────────
	// rate limit so a jumpy admin cannot spam their alliance channel
	TEST_REMINDER_COOLDOWN_MS: 60_000, // one test per event per 60 seconds

	// ── leaderboard board refresh debounce (v1.6 Phase 2, item 13) ──
	// Activity writes (✅ reactions, voice sessions) trigger a LeaderboardBoard
	// refresh, but a busy event produces a flurry of writes. Collapse them to
	// one edit per guild per window so the board updates promptly without
	// hammering Discord with dozens of edits. Read by scheduleLeaderboardRefresh.
	LEADERBOARD_REFRESH_DEBOUNCE_MS: 60_000, // at most one activity-driven refresh per guild per 60s

	// ── game rooms ────────────────────────────────────────────────
	// What:  the four numbers and one schedule that bound the Game Rooms
	//        feature. A room is one match of one mini game in its own
	//        Discord channel, archived (channel deleted, transcript kept)
	//        once the match has been over for a while.
	// Who:   RoomProvisioner reads the caps, roomLifecycle reads the delay,
	//        ReminderScheduler reads the cron, the challenge board reads the
	//        spectator cap.
	// When:  every room open, and every sweep tick.
	// Where: these are the knobs an operator would actually turn, which is
	//        why they are constants here rather than env vars: a config typo
	//        must not be able to silently delete a live match early.

	// How long a finished room's channel survives before the sweep deletes
	// it. Long enough for both players to scroll the match back and share it,
	// short enough that a busy guild never approaches Discord's hard cap of
	// 50 channels per category. The transcript is already in Mongo before the
	// delete happens, so this window is about convenience, not durability.
	GAME_ROOM_ARCHIVE_DELAY_MS: 4 * 60 * 60 * 1000, // 4 hours

	// Concurrent non-terminal rooms allowed per guild. Discord caps a category
	// at 50 channels and a full category makes EVERY new room fail, so this
	// keeps a guild an order of magnitude clear of the ceiling even before the
	// sweep runs. Hitting it produces an honest "the arena is full" reply, not
	// a silent no-op.
	GAME_ROOM_MAX_PER_GUILD: 20,

	// Explicit spectators on an invite-only room. Each one is a real permission
	// overwrite, and Discord's select menus cap at 25 options, so the two limits
	// agree at 25 by coincidence and by design. This binds ONLY the private
	// path: a public match spends a single @everyone overwrite no matter how
	// many members watch. A truncated list must SAY it was truncated.
	GAME_ROOM_MAX_SPECTATORS: 25,

	// How often the archive sweep looks for finished rooms past their
	// archiveAt. Deliberately its OWN cron and not a passenger on the
	// per-minute reminder tick, which has a 60s budget and an overlap guard
	// that a slow channel-delete fan-out would blow.
	GAME_ROOM_SWEEP_CRON: "*/5 * * * *", // every 5 minutes

	// How long a draft room (host picked a game but never pressed Start) may
	// hold that host's one room slot before it is reaped. Without this, an
	// abandoned draft locks the host out of the board forever, since the
	// partial unique index counts "draft" as live.
	GAME_ROOM_DRAFT_TIMEOUT_MS: 10 * 60_000, // 10 minutes

	// ── invite URL provenance ─────────────────────────────────────
	// The actual OAuth install URL is composed in @utils/config as
	// `botInviteLink` so dev and prod each serve their own client id.
	// The hardcoded prod URL that used to live here was removed on
	// 2026-04-25 because every reintroduction risks a dev process
	// silently serving prod's install link. If you need the prod URL
	// for documentation, build it from the prod client id (set in the
	// prod env as DISCORD_CLIENT_ID_PROD or DISCORD_CLIENT_ID) and the
	// permissions integer 8.
	//
	// Why permissions=8 (Administrator) ships today: the bot creates a
	// private homebase category with @everyone deny ViewChannel on the
	// admin channel and @everyone deny SendMessages on public channels.
	// Discord's `POST /guilds/.../channels` rejects 50013 when the bot
	// tries to grant itself a permission via member overwrite that
	// @everyone denies in the same call (the bot would gain the
	// permission only AFTER its overwrite is applied, but Discord
	// checks BEFORE). Two ship attempts on 2026-04-25 with the
	// minimum-bits integer (268659792) and various overwrite
	// rearrangements both hit this trap. Administrator bypasses every
	// channel-level overwrite check, including the granting one.
	// Tech-debt item: refactor channel creation to use the bot's
	// integration ROLE overwrite (`guild.members.me.roles.botRole`)
	// which sits in a different permission tier and may avoid the
	// catch-22, then drop back to MIN_PERMISSIONS_DOCS as the install
	// surface.
	// ── minimum perms documentation ──────────────────────────────
	// What:  the explicit list of permissions the bot actually uses,
	//        kept here for install-doc honesty. Even though we ship
	//        Administrator, server owners can audit this list to see
	//        what the bot will actually do. This is also the target
	//        set if/when the integration-role refactor lands and we
	//        can drop Administrator.
	// Who:   anyone reading the bot's README or install guide. Not
	//        consumed by code today.
	// How:   bit names match discord.js PermissionFlagsBits. Sum is
	//        268659792 (the integer we'd use without the Discord
	//        enforcement catch-22).
	MIN_PERMISSIONS_DOCS: [
		"View Channel",
		"Manage Channels",
		"Manage Roles",
		"Send Messages",
		"Manage Messages",
		"Embed Links",
		"Read Message History",
		"Add Reactions",
		"Mention Everyone",
	] as const,
} as const; // ← this is important, explained below
