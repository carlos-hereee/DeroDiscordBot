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
		// ── leveling ──
		// Both of these ALSO carry .setDefaultMemberPermissions(Administrator) on
		// their builders. The two mechanisms are independent and both are needed:
		// the builder flag is what HIDES a command in a non-admin's picker, and
		// this Set is the runtime gate that catches anyone who reaches it anyway.
		// /account and /levels are deliberately in NEITHER, like /leaderboard and
		// /list-events: members seeing their own standing is the entire point.
		"setup-level-system",
		"xp",
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

	// ── leveling ──────────────────────────────────────────────────
	// What:  every number the leveling system runs on: how often buffered xp is
	//        flushed, how long the in-memory maps may hold an entry, how level up
	//        announcements are coalesced, how often voice is swept, and what each
	//        game pays.
	// Who:   xpWriter (the intervals), levelUpAnnouncer (the coalescing pair),
	//        voiceXp (the sweep), every game's award hook (the amounts),
	//        XpPeriod's TTL index (the retention window).
	// When:  read at boot for the intervals, and per award for the amounts.
	// Where: constants rather than env vars, and rather than GuildConfig, for the
	//        same reason the GAME_ROOM_ numbers above are: these are the knobs an
	//        operator would turn, and a config typo must not be able to silently
	//        reprice a guild's progression. The per-guild knobs that DO belong to
	//        an admin (cooldowns, xp ranges, multipliers, the curve) live on
	//        GuildConfig.leveling instead.
	LEVELING: {
		// How often staged message xp is written. Buffered xp is lost on a hard
		// crash, bounded by this interval, which is acceptable for xp specifically
		// and would not be for anything a member paid for. A graceful Railway
		// redeploy loses nothing: flushNow() runs inside the existing
		// gracefulShutdown before the Mongo disconnect.
		FLUSH_INTERVAL_MS: 10_000,

		// How often the cooldown and pending maps are swept for dead entries. Both
		// are module scoped and grow with unique members, so an unswept map is a
		// slow leak on a busy bot rather than an immediate failure.
		MAP_SWEEP_INTERVAL_MS: 5 * 60_000,

		// The longest cooldown an admin may configure, and therefore the age past
		// which a cooldown entry can no longer block anything and is safe to sweep.
		// /setup-level-system clamps every cooldown input to this ceiling, so the
		// sweep and the config can never disagree about what "expired" means.
		MAX_COOLDOWN_SECONDS: 3600,

		// ── input bounds for /setup-level-system ──
		// Every numeric an admin can type is clamped into these ranges at the
		// COMMAND layer, because guildConfigStore.update runs findOneAndUpdate
		// without runValidators, so the schema's own constraints never see it.
		// They live here rather than in the command file because levelingConfig
		// normalizes against the same bounds when it reads a row back, and two
		// copies of a range is how a value gets written that a reader then
		// silently rejects.
		LIMITS: {
			MIN_COOLDOWN_SECONDS: 5,
			MIN_XP: 1,
			MAX_XP: 1000,
			MIN_CURVE_MULTIPLIER: 0.1,
			MAX_CURVE_MULTIPLIER: 100,
			MIN_VOICE_MEMBERS: 1,
			MAX_VOICE_MEMBERS: 25,
			// A level an admin may write with /xp set-level. Capped well inside
			// levelCurve's own ceiling so nobody can set a level whose cumulative
			// cost was never computed.
			MAX_SETTABLE_LEVEL: 500,
		},

		// Ceiling on how much voice time one sweep tick may pay for. The sweep pays
		// for elapsed minutes rather than per tick, so a process that was paused
		// (a laptop sleeping in dev, a long GC, a Railway restart mid session)
		// would otherwise hand out a lump sum for wall clock nobody was watched
		// through. Capping at a few minutes keeps the award honest without needing
		// the sweep to run on a perfect schedule.
		VOICE_MAX_MINUTES_PER_AWARD: 5,

		// The coalescing window for level up announcements. The FIRST level up
		// schedules a send this far out and later ones inside the window are
		// absorbed into it, with the timer LEFT RUNNING. Deliberately not a
		// reset-on-each-call debounce, which would starve the channel during a
		// busy burst. Same shape as scheduleLeaderboardRefresh.
		ANNOUNCE_COALESCE_MS: 15_000,

		// Above this many level ups in one window, send ONE combined message
		// instead of that many separate ones. This is what keeps a live
		// #announcements channel readable, and it is also the per-channel 429
		// defense, solved once by the same mechanism.
		ANNOUNCE_BURST_THRESHOLD: 3,

		// How often the voice sweep walks cached voice states. Voice xp is a SWEEP
		// rather than an award on VoiceStateUpdate: joining a channel to measure it
		// would limit voice xp to one channel per guild, cost real resources, and
		// be a privacy problem, which is Arcane's own stated reasoning.
		VOICE_SWEEP_INTERVAL_MS: 60_000,

		// How long an XpPeriod row survives. 400 days keeps a full year plus a
		// month of slack, so a "same month last year" comparison stays possible,
		// while bounding a collection that gains a row per member per period
		// forever. Expressed in seconds because that is what Mongo's
		// expireAfterSeconds takes.
		XP_PERIOD_RETENTION_SECONDS: 400 * 24 * 60 * 60,

		// ── what each source pays ──
		// Per game amounts. A game played in its own GAME ROOM pays more than the
		// same game played in a channel, because a match with its own channel is a
		// bigger commitment than a one message duel.
		GAME_PLAY_XP: 25,
		GAME_WIN_XP: 75,
		GAME_TIE_XP: 40,
		GAME_ROOM_PLAY_XP: 40,
		GAME_ROOM_WIN_XP: 120,

		// Fortune is the most farmable award in the feature: it has a 10 second
		// cooldown and no opponent, so its payout is small and flat and it has no
		// win bonus to chase.
		FORTUNE_XP: 10,
	},

	// ── PINGABLE ──────────────────────────────────────────────────
	// What:  the message kinds that are ALLOWED to mention members. Everything
	//        not named here must send with
	//        allowedMentions: { parse: [], roles: [], users: [] }.
	// Who:   levelUpAnnouncer asserts its own kind is absent from this set before
	//        every send; the reminder and go-live paths are the kinds that ARE in
	//        it.
	// When:  checked at send time.
	// Where: this exists because "never ping" is a rule the owner set for the
	//        whole leveling feature (locked decision D3) and rules enforced by
	//        habit decay. A future engineer who wants leveling to ping now has to
	//        add a named kind to a named list, which is a decision somebody can
	//        review, instead of deleting one allowedMentions line, which is an
	//        accident nobody notices until a thousand members get a notification.
	// How:   a frozen Set of stable kind strings. Membership is the ONLY thing
	//        that grants permission to mention.
	PINGABLE: new Set<string>(["reminder.fire", "stream.goLive"]),

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
