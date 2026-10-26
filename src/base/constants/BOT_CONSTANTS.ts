// ── the owner's time zone ──
// Every bot clock that means a human calendar (the Monday digest, the daily XP cap's
// day, the monthly arcade post) runs in Central time, the owner's zone, rather than the Railway host's UTC.
// One string so the digest and the cap can never disagree about which day it is.
// The render analytics digest keeps its own copy of the same zone (DIGEST_TIME_ZONE).
const CENTRAL_TIME_ZONE = "America/Chicago";

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
	// ⚠️ THIS SET IS THE ONE GATE ON AN ADMIN COMMAND, AND EVERY ADMIN COMMAND IS IN
	// IT. main.ts checks it on every slash command: the server owner always passes,
	// otherwise the member must hold the role /setup stored as GuildConfig.adminRoleId.
	// No admin command carries a Discord default permission (setDefaultMemberPermissions).
	// That flag only HIDES a command from members without Discord's own Administrator
	// permission, so it hid these from the very /setup admin role this set admits, and
	// it was never a gate anyway: a server can re-grant a command in its Integrations
	// settings. Every admin command therefore shows in every member's picker, and this
	// set refuses everyone who is not an admin. BOT_CONSTANTS.adminCommands.test.ts
	// loads every command and fails when one carries a default without being here.
	//
	// An entry is a command name, which gates every subcommand under it, or a command
	// name and ONE subcommand separated by a space ("events delete"), which gates that
	// subcommand alone. The qualified form exists for /events, whose list is a member
	// view and whose delete is not (2026-10 item 245 Phase 4b merged the two).
	// isAdminCommand in utils/permissions.ts reads both forms, for the slash command
	// gate and the admin buttons alike.
	//
	// Deliberately NOT in the set:
	//   /setup and /self-destruct are server owner only through their own inline checks
	//   (commands/admin/setup.ts, features/setup/selfDestruct.ts) and keep their default
	//   as a picker courtesy; main.ts skips /setup, which runs before an admin role exists.
	//   /render-analytics is platform owner only (its execute checks CREATOR_DISCORD_ID),
	//   and this gate would demand a /setup config in whatever server the owner uses.
	//   /network (2026-10 item 244 Phase 5b) is the same: the owner's network bans,
	//   behind the same CREATOR_DISCORD_ID check.
	//   /events list, /leaderboard, /account, /rating and the games are member commands:
	//   members seeing what is scheduled and where they stand is the whole point.
	ADMIN_COMMANDS: new Set<string>([
		// ── events ──
		"configure-kvk-season",
		"events delete",
		// ── streamer schedules ──
		"schedule",
		"stream",
		// ── channels and server switches ──
		"channels",
		"configure",
		// ── leveling ──
		"setup-level-system",
		"xp",
		// ── dero voice ──
		// /dero-config is the voice kill switch, the monthly speech spend cap and the
		// lists of who may give Dero tasks.
		"dero-config",
		// ── chip economy (2026-10 item 250 Phase 5) ──
		// /economy grants chips from the server vault and switches chips on or off.
		"economy",
	]),

	// ── Discord's component limits ────────────────────────────────
	// Discord's own ceilings, which it enforces by rejecting the whole send, never by
	// trimming: 25 options in a select or an autocomplete answer, 5 buttons in a row,
	// 5 rows in a message and 5 fields in a modal. The admin command launcher and the
	// guide rows (2026-10 item 245 Phase 4b) build to these, and their tests assert them.
	DISCORD_LIMITS: {
		MAX_SELECT_OPTIONS: 25,
		MAX_ROW_BUTTONS: 5,
		MAX_MESSAGE_ROWS: 5,
		MAX_MODAL_FIELDS: 5,
		MAX_CUSTOM_ID_LENGTH: 100,
		MAX_MODAL_TITLE_LENGTH: 45,
		MAX_LABEL_LENGTH: 45,
		MAX_SELECT_LABEL_LENGTH: 100,
		// One reply carries at most 10 embeds (a settings panel's saved answer, post-launch plan item 9).
		MAX_REPLY_EMBEDS: 10,
	},
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

	// ── welcome and rules channel adoption (2026-10 item 247 Phase 2) ──
	// What:  the base names that mark a server's OWN welcome or rules channel, so
	//        setup moves that channel into 🪧 NOTICE BOARD instead of building a
	//        second one beside it.
	// Who:   features/setup/adoption.ts matches against them; GuildSetupManager
	//        picks the list by spec.
	// How:   an EXACT match on the name after it is lowercased and stripped of its
	//        leading emoji and symbols, never a substring, so "📋arcade-rules" and
	//        "rules-lawyering" stay where they are (risk R2 in the plan). The lists
	//        are the owner's, in the owner's order. "spawn-point" joined the welcome
	//        list by the owner's decision (post-launch plan item 2), and Discord's
	//        own system channel is looked at before any name (adoption.findWelcomeChannel).
	WELCOME_ADOPTION_PATTERNS: ["spawn-point", "welcome", "welcomes", "join-log", "joins", "new-members", "arrivals"],
	RULES_ADOPTION_PATTERNS: ["rules", "server-rules", "the-rules", "rulebook", "read-me", "read-this"],
	// How many recent messages decide whether an adopted channel holds the owner's
	// content. One fetch of this many: an empty channel, or one already carrying
	// Dero's own intro, takes Dero's post; anything else is left untouched.
	ADOPTION_CONTENT_SCAN_LIMIT: 10,
	// The Edit rules modal's text box. Discord caps a modal text input at 4000
	// characters and an embed description at 4096, so the input's own cap is the
	// binding one and the saved text always fits the rules embed.
	RULES_MARKDOWN_MAX_LENGTH: 4000,
	// How long the Edit rules button waits for its modal. Longer than the three
	// minute modals elsewhere because rewriting a rules list takes a while, and well
	// inside the 15 minutes an interaction token lives.
	RULES_EDIT_MODAL_TIMEOUT_MS: 10 * 60_000,

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

	// Concurrent non-terminal rooms allowed per guild, BOTH visibilities. This is
	// the hard wall; the tier quota on PRIVATE rooms (server-resolved, up to 50 at
	// Studio) is the softer wall inside it for invite and solo rooms specifically.
	//
	// 30, raised from 20 when the tier quota shipped, and the arithmetic is the
	// point: Discord caps a category at 50 channels, the arcade category holds ~5
	// fixed channels (rules, challenges, leaderboard and kin), so 30 rooms lands at
	// 35/50 with headroom for finished rooms cooling off in their archive window.
	// At 20, a Pro guild (25 private) could never actually REACH its private
	// ceiling; at 30 it can, with a few public rooms alongside. Hitting the cap
	// produces an honest "the arena is full" reply, not a silent no-op.
	GAME_ROOM_MAX_PER_GUILD: 30,

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

	// How long a battleship player has to take their turn before it is forfeited.
	// TWO consecutive expiries forfeit the MATCH, so an abandoned game dies about 20
	// minutes after the last shot rather than sitting open until the archive window.
	//
	// ⚠️ CHECKED ON THE 5 MINUTE ROOM SWEEP, so the real expiry lands somewhere
	// between 10 and 15 minutes. That granularity is deliberate rather than a
	// limitation: a second, faster cron for one game's clock would cost a tick every
	// minute across every guild to save a casual player five minutes, and the number
	// that matters is that a walked-away match terminates at all.
	GAME_ROOM_TURN_TIMEOUT_MS: 10 * 60_000, // 10 minutes

	// ── scheduled party games (post-launch plan item 3) ──
	// The schedule modal's defaults are the owner's (30 minutes, 20 attendees, 0 for no
	// cap). The bounds keep a typo from scheduling a game for a week or a list nobody can
	// read: the RSVP card names every attendee, and Discord caps an embed field at 1024
	// characters, which a mention list of PARTY_GAME_MAX_ATTENDEES still fits beside
	// the "and N more" summary the card falls back to.
	PARTY_GAME_DEFAULT_DURATION_MINUTES: 30,
	PARTY_GAME_MIN_DURATION_MINUTES: 5,
	PARTY_GAME_MAX_DURATION_MINUTES: 240,
	PARTY_GAME_DEFAULT_MAX_ATTENDEES: 20,
	PARTY_GAME_MAX_ATTENDEES: 100,
	// How many attendees the card names before it summarises the rest.
	PARTY_GAME_NAMES_SHOWN: 30,

	// How long a Monopoly seat may sit on the clock before the idle sweep forfeits
	// it (2026-10 item 241). Its own constant rather than the battleship budget
	// above, because a Monopoly match is played across days by people who check in
	// between other things: ten minutes would forfeit every seat that went to
	// sleep. Checked on the same 5 minute room sweep, so the real forfeit lands
	// within five minutes after this.
	GAME_ROOM_MONOPOLY_IDLE_MS: 24 * 60 * 60 * 1000, // 24 hours
	// Any room in a non terminal status with no action for this long is finished as
	// abandoned by sweepIdleRooms, so a forgotten draft or match can never hold its
	// host's one room slot (the partial unique index) for good. 30 minutes is the
	// owner's number from the 1.7.0 test run (test fixes plan, item 13). It sits above
	// every live turn clock here (battleship's 10 minute turn, Hold'em's 60 seconds),
	// so a slow game is never cut off mid turn. Monopoly is exempt: its seats get the
	// day above, which its opener promises, and that sweep already ends every match.
	// A hangman room in play is exempt too (owner decision, 2026-10-23): hangman has no
	// clock, and its host frees the slot with Give up. A hangman draft is still swept.
	// Checked on the same 5 minute room sweep, so the close lands up to 5 minutes later.
	GAME_ROOM_IDLE_ABANDON_MS: 30 * 60_000, // 30 minutes
	// How long a Monopoly auction takes sealed bids, from the pass that opened it
	// (master plan Section 1). Long enough for every seat to see the board and type
	// a number; short enough that the seller's turn is not held for long.
	MONOPOLY_AUCTION_ROUND_MS: 60_000,
	// How often expired auctions are closed. Its own interval for the same reason as
	// the hold em clock below: on the 5 minute room sweep a 60 second round would
	// close anywhere inside five minutes. At 10 seconds a round runs 60 to 70.
	MONOPOLY_AUCTION_TICK_MS: 10_000,
	// The smallest rent the voice referee says out loud (Session 5c, key moments only).
	// $200 is GO's salary and the rent of all four rails, so a rent this big costs a
	// player at least a full lap's pay. Unbuilt lots charge $2 to $100 and utilities at
	// most $120, so a lower bar would have Dero announce routine rent on most turns; a
	// higher one would leave four rails and the second house on most lots unspoken.
	MONOPOLY_REFEREE_BIG_RENT: 200,

	// ── hold em ──────────────────────────────────────────────────
	// ⚠️ CHIPS ARE PER TOURNAMENT AND DIE WITH THE TABLE (A9, R22). There is no
	// persistent balance anywhere, and there must never be one: a balance that
	// survives a table is an economy, and an economy players can accumulate is a
	// gambling moderation surface this bot has no business owning. Everything below
	// is a tournament-local number.
	HOLDEM_STARTING_STACK: 1000,
	HOLDEM_MIN_SEATS: 2,
	// Six is the plan's ceiling and also a readability one: a board naming nine
	// players and their stacks stops being scannable on a phone.
	HOLDEM_MAX_SEATS: 6,

	HOLDEM_SMALL_BLIND: 10,
	HOLDEM_BIG_BLIND: 20,
	// Blinds DOUBLE every this many hands, which is what makes a tournament
	// converge instead of running until everyone gets bored. At 1000 chips and a
	// double every 6 hands, a six player table is usually decided inside 30 hands.
	// Without escalation a short stack can fold forever and nothing ever resolves.
	HOLDEM_BLIND_ESCALATION_HANDS: 6,

	// A player has this long to act before they are FORCE FOLDED, counted from when
	// the board shows them their turn. Never paused for the player: pausing hands one
	// absent player the power to stall five present ones, which is the failure mode a
	// turn clock exists to prevent. Only a board that is drawing holds it (the drawing
	// pause). 60 seconds is the owner's number from the 1.7.0 test run (test fixes
	// plan, item 13).
	HOLDEM_TURN_TIMEOUT_MS: 60_000,
	// How long a settled hand stays on the board before the next one deals itself,
	// counted the same way. The host's Next hand button deals at once instead. Also
	// the owner's number (item 13). Checked on the clock tick below, so the deal lands
	// up to one tick later.
	HOLDEM_NEXT_HAND_DELAY_MS: 10_000,
	// Timeouts in a row that sit a seat out (item 13): it keeps its seat and posts its
	// blinds but is folded each hand until it presses I'm back. Two, so one slow turn
	// is forgiven and a player who has walked away stops costing the table a minute.
	HOLDEM_SIT_OUT_TIMEOUTS: 2,
	// How often the clock is checked. A 60 second budget needs a tick well under
	// it, so this is its own interval rather than a passenger on the 5 minute room
	// sweep, which would make a 60 second clock fire somewhere inside 5 minutes.
	HOLDEM_CLOCK_TICK_MS: 10_000,
	// How many times a buy in re-reads and retries when another player's seat write
	// beat it. Six members can click Buy in at once, and each retry only loses to a
	// DIFFERENT winner, so the attempts need to cover a full table plus headroom
	// rather than the usual one-retry-and-give-up.
	HOLDEM_SEAT_CLAIM_ATTEMPTS: 8,
	// How many times the host's Remove a player re-reads and retries taking the seat
	// out of a live Hold'em table or Monopoly board when a move beat it (2026-10 item
	// 244 Phase 4). The removal from the room row has already landed by then, so a
	// seat left behind would sit in a match its player can no longer press anything
	// in; a few retries cover a burst of moves, and past them the host is told to
	// press again rather than the bot looping against a busy table.
	GAME_ROOM_KICK_ATTEMPTS: 4,
	// The games a network table can seat players from other servers at, through a
	// satellite channel in their own server (2026-10 item 244 Phase 5a). Hold'em only:
	// a satellite mirrors one table message and relays its moves, and Hold'em is the
	// game whose whole state is that one message. Battleship's private boards and
	// Monopoly's several cards would each need their own relay before joining this list.
	NETWORK_GAMES: ["holdem"],
	// ── network tables: consent, the board, server ratings (2026-10 item 244 Phase 5b) ──
	// What:  the numbers the network around a satellite runs on.
	// Who:   game-rooms/networkRules.ts, networkBoard.ts and networkJoin.ts;
	//        ratings/serverRatings.ts and tagNotice.ts; /network and /dero-config arcade.
	NETWORK: {
		// The network notice a member accepts before anything of theirs is shown in another
		// server. Raise it when the notice's wording changes what crosses servers: every row
		// below it then reads as not consented until the member accepts the new notice.
		CONSENT_VERSION: 1,
		// How long the network board waits after a change before redrawing every network
		// server's board, so a burst of seats and hands costs one round of edits, not one
		// per press. Short enough that a table a member just saw open is there to join.
		BOARD_REFRESH_DEBOUNCE_MS: 5_000,
		// How many tables one network board lists. Under a select menu's 25 options, and
		// short enough that the embed stays readable on a phone.
		BOARD_MAX_TABLES: 10,
		// Owner decision 2026-10-23 (2026-10 item 244): the tag notice goes to one player
		// at most once in this window, however many rated games they win.
		TAG_NOTICE_INTERVAL_MS: 30 * 24 * 60 * 60_000,
		// Owner decision 2026-10-23 (2026-10 item 244): a server is on the server board only
		// with at least this many rated, consenting members wearing its tag, and its rating
		// is the mean of that many top display ratings.
		SERVER_BOARD_MIN_MEMBERS: 5,
		// How many servers /rating servers lists, the same ten the member boards show.
		SERVER_BOARD_SIZE: 10,
		// The guild feature Discord sets on a server that can hand out a server tag.
		GUILD_TAGS_FEATURE: "GUILD_TAGS",
		// How many ratings the network scope board reads per page while it looks for
		// consenting players, so a top heavy page of non consenting players costs one more
		// read rather than an unbounded one.
		NETWORK_BOARD_PAGE: 50,
		// A Discord server id as an admin or the owner types it into /network or
		// /dero-config arcade block-server. A snowflake is 17 to 20 digits today.
		SERVER_ID_PATTERN: /^\d{17,20}$/,
		// The longest note the owner may keep on a network ban. Only the owner reads it,
		// and a short cap keeps a pasted wall of text out of the ban list.
		BAN_REASON_MAX_LENGTH: 200,
	},

	// ── dero voice ───────────────────────────────────────────────
	// What:  every number and provider string the voice feature runs on: the
	//        monthly spend cap, the /dero-config input bounds, the speech call's
	//        limits, the Listen cooldowns and the clip cache bounds.
	// Who:   features/voice/* and commands/admin/dero-config.ts. The Mongoose
	//        default on DeroVoiceConfig.monthlyCapUsd reads the cap from here.
	// When:  read at module load (cache bounds, cooldown windows) and per call
	//        (text limits, timeout).
	// Where: constants rather than env vars for the same reason as the blocks
	//        above: a config typo must not be able to reprice speech. The one
	//        per guild knob an admin owns (the cap) lives on DeroVoiceConfig, and
	//        this default only seeds it.
	//
	// The default monthly speech budget per guild, in whole dollars, and the
	// highest value /dero-config cap accepts. 0 is a valid cap and refuses every
	// provider call, which makes it a second kill switch. $5 is the owner's
	// decision (2026-10-21): every guild's speech bills the one ElevenLabs account,
	// so the default is what a guild costs before an admin raises it.
	DERO_VOICE_DEFAULT_CAP_USD: 5,
	DERO_VOICE_MAX_CAP_USD: 500,
	// Dero's one speaking voice, the ElevenLabs premade voice "George". The owner
	// picked it (1.7.0 test fixes plan, item 6) so a guild needs no voice id step
	// before /dero-config enable. DeroVoiceConfig defaults to it, and every reader
	// goes through resolveDeroVoiceId so rows that stored a null get it too.
	DERO_DEFAULT_VOICE_ID: "JBFqnCBsd6RMkjVDRZzb",
	// One speech call waits at most this long, then aborts. Past this the socket
	// is stuck rather than slow, and the member is better served by a plain
	// "try again" than by a reply that never comes.
	DERO_VOICE_TTS_TIMEOUT_MS: 30_000,
	// Input longer than this is refused BEFORE any provider call, so a bug that
	// passes a whole channel history can never become a large bill.
	DERO_VOICE_TTS_MAX_CHARS: 1500,
	// Retries after a 5xx only. Never a loop: a provider outage should cost one
	// extra call, not a stampede.
	DERO_VOICE_TTS_MAX_RETRIES: 1,
	// Listen reads at most this much of a post, cut at a sentence boundary.
	DERO_VOICE_LISTEN_MAX_CHARS: 600,
	// A fresh render costs money, so a member may start one every 15 seconds and a
	// guild one every 3. A cache hit skips both, because a replay costs nothing.
	DERO_VOICE_LISTEN_USER_COOLDOWN_MS: 15_000,
	DERO_VOICE_LISTEN_GUILD_COOLDOWN_MS: 3_000,
	// In memory clip cache bounds, whichever is reached first. A 600 character mp3
	// is well under 1 MB, so 50 clips sit far below the byte bound in practice;
	// the byte bound is the guard against a future long clip format.
	DERO_VOICE_CLIP_CACHE_MAX_ENTRIES: 50,
	DERO_VOICE_CLIP_CACHE_MAX_BYTES: 20 * 1024 * 1024, // 20 MB
	// Provider wire values, confirmed against the ElevenLabs API reference on
	// 2026-10-14: POST /v1/text-to-speech/{voice_id} with the xi-api-key header,
	// the Flash v2.5 model, and output_format as a query parameter.
	// mp3_44100_128 is the documented default and needs no paid tier; pcm_24000
	// is raw 16 bit mono PCM at 24 kHz, the format Phase 3 resamples for a call.
	DERO_VOICE_ELEVENLABS_BASE_URL: "https://api.elevenlabs.io",
	DERO_VOICE_TTS_MODEL_ID: "eleven_flash_v2_5",
	DERO_VOICE_OUTPUT_FORMATS: {
		mp3: "mp3_44100_128",
		pcm24k: "pcm_24000",
	},
	// ── dero voice calls (Phase 3a) ──
	// A join waits this long for the connection to reach Ready, then gives up and
	// tears the attempt down. The plan's budget; a healthy join takes a second or two.
	DERO_VOICE_READY_TIMEOUT_MS: 20_000,
	// After a disconnect, how long the connection gets to re-enter signalling or
	// connecting on its own (a move, a voice server change) before the bot rejoins.
	// The @discordjs/voice documented pattern uses 5 seconds.
	DERO_VOICE_RECOVER_WINDOW_MS: 5_000,
	// Rejoins after that window, then the session is destroyed and the control
	// channel is told. Never a loop: three tries is the whole budget.
	DERO_VOICE_MAX_RECONNECT_ATTEMPTS: 3,
	// The first rejoin waits this long and each later one doubles it (2, 4, 8 s),
	// so a flapping voice server is not hammered with gateway voice updates.
	DERO_VOICE_RECONNECT_BACKOFF_MS: 2_000,
	// A connection that stayed Ready this long earns a fresh reconnect budget.
	// Without it, a link that reaches Ready and drops again every few seconds
	// would rejoin forever, one "successful" attempt at a time.
	DERO_VOICE_RECONNECT_STABLE_MS: 60_000,
	// Clips waiting behind the one playing. Past this a lower priority clip is
	// dropped, so a burst of Listen presses can never stack minutes of audio.
	DERO_VOICE_SPEAKER_MAX_QUEUE: 5,
	// Per guild, counted from every join ATTEMPT (not only a successful one),
	// because each attempt costs gateway voice traffic whether or not it connects.
	DERO_VOICE_JOIN_COOLDOWN_MS: 10_000,
	// Dero leaves this long after the last authorized member left its call (Phase
	// 3a Part B). Long enough to survive a member's reconnect or a quick channel
	// hop, short enough that an empty call does not keep a voice session open.
	DERO_VOICE_IDLE_LEAVE_MS: 120_000,

	// ── dero voice listening (Phase 3b) ──
	// The addressing rule, the two knobs the owner tunes by editing them here. A
	// transcript reaches the brain only when one of these names is among its
	// first DERO_VOICE_NAME_WITHIN_WORDS words, or when the utterance ended
	// within DERO_VOICE_FOLLOW_UP_WINDOW_MS of Dero finishing one of its own
	// lines in that call. The extra spellings are how speech to text tends to
	// hear "Dero"; anything else is transcribed and dropped.
	DERO_VOICE_WAKE_NAMES: ["dero", "derro", "diro"],
	DERO_VOICE_NAME_WITHIN_WORDS: 6,
	DERO_VOICE_FOLLOW_UP_WINDOW_MS: 20_000,
	// An utterance ends after this much silence from its speaker. Long enough to
	// survive a breath mid sentence, short enough that Dero answers promptly.
	DERO_VOICE_UTTERANCE_SILENCE_MS: 800,
	// Audio outside these bounds is discarded before any provider call: under the
	// minimum it is a cough or a click, over the maximum it is a monologue or a
	// stuck microphone, and either way it is not a task.
	DERO_VOICE_UTTERANCE_MIN_MS: 400,
	DERO_VOICE_UTTERANCE_MAX_MS: 20_000,
	// Per guild: at most this many speakers captured at once, one turn running,
	// and this many utterances waiting behind it. Past either bound the newest
	// is dropped, so a crowded call can never stack provider calls.
	DERO_VOICE_MAX_CONCURRENT_CAPTURES: 3,
	DERO_VOICE_MAX_WAITING_TURNS: 2,
	// A positive operator check is trusted this long, so a member who pauses
	// every few words does not cost a config read per phrase. A refusal is never
	// cached: a role added mid call takes effect on the next phrase.
	DERO_VOICE_AUTHORIZED_CACHE_MS: 60_000,
	// One speech to text call waits at most this long. Never retried.
	DERO_VOICE_STT_TIMEOUT_MS: 15_000,
	// Provider wire values, confirmed against the ElevenLabs API reference on
	// 2026-10-20: POST /v1/speech-to-text, multipart, xi-api-key header.
	DERO_VOICE_STT_MODEL_ID: "scribe_v2",
	// A transcript this short ("a", ".") is noise, not a task.
	DERO_VOICE_MIN_TRANSCRIPT_CHARS: 2,
	// Whatever Dero says on its own in a turn (a summary, a canned line) is cut
	// at a sentence to this many characters, the same bound a brain `say` has.
	DERO_VOICE_TURN_SPEECH_MAX_CHARS: 300,
	// A speech provider failure or a spent budget is spoken at most once per
	// guild in this window, so a broken provider is never a stream of apologies.
	DERO_VOICE_TROUBLE_LINE_COOLDOWN_MS: 30_000,
	// /dero status reports the median and the slowest of this many recent turns.
	DERO_VOICE_LATENCY_SAMPLES: 50,
	// The soak sampler (on only when DERO_VOICE_SAMPLER is 1) writes one row this
	// often. A minute gives 30 points over the owner's 30 minute soak, enough to
	// see memory drift, without a row per turn.
	DERO_VOICE_SAMPLER_INTERVAL_MS: 60_000,

	// ── dero brain ───────────────────────────────────────────────
	// What:  the limits of the link between the bot (the body) and the launcher's
	//        local Dero (the brain): how long a job may wait, how long one long
	//        poll may hang, when the brain counts as offline, and the size of
	//        everything that crosses the link in either direction.
	// Who:   features/dero-brain/* (queue, parser, job builder, executor), the
	//        /brain routes and their signature middleware, and /dero.
	// When:  read per call. Never env vars: a typo in Railway must not be able to
	//        widen what the brain may send or how long a member waits.
	// Where: the launcher mirrors the job and result limits in its own contract
	//        file in another repository. Change a limit here and that mirror
	//        changes in the same session, or the launcher sends results the bot
	//        rejects whole.
	//
	// A turn waits this long for the brain's answer, then the member is told it
	// took too long. Twenty seconds is the plan's budget for a local model.
	DERO_BRAIN_TURN_TIMEOUT_MS: 20_000,
	// The longest one GET /brain/next may hang before answering 204. Kept under
	// the usual 30 second proxy idle cut so Railway never kills a healthy poll.
	DERO_BRAIN_MAX_POLL_WAIT_MS: 25_000,
	// The brain counts as online while a poll arrived inside this window. One poll
	// at most every 25 seconds plus reconnect slack, so a single slow round trip
	// does not flap the status.
	DERO_BRAIN_ONLINE_WINDOW_MS: 45_000,
	// DERO_BRAIN_KEY shorter than this disables every /brain route (503). 32
	// characters is the floor for an HMAC secret worth the name.
	DERO_BRAIN_MIN_KEY_LENGTH: 32,
	// A result body over this many bytes is refused before it is parsed. Three
	// actions of at most 1900 characters fit with room to spare.
	DERO_BRAIN_MAX_RESULT_BYTES: 16 * 1024,
	DERO_BRAIN_MAX_TASK_CHARS: 300,
	DERO_BRAIN_MAX_JOB_CHANNELS: 25,
	DERO_BRAIN_MAX_ACTIONS: 3,
	// Discord's message ceiling is 2000; the gap leaves room for mention
	// neutralizing without a send ever failing on length.
	DERO_BRAIN_POST_MAX_CHARS: 1900,
	DERO_BRAIN_SAY_MAX_CHARS: 300,
	// Per member, recorded only after a job the brain answered "ok".
	DERO_BRAIN_TELL_COOLDOWN_MS: 10_000,
	// Hold'em terms a request may carry (enforced from Phase 2 by the parser,
	// used by the table from Phase 4). Seats reuse HOLDEM_MIN_SEATS and
	// HOLDEM_MAX_SEATS; a big blind is at least 2 so the half blind is at least 1,
	// and at most a tenth of the stack so a hand is never decided by the blinds.
	HOLDEM_TERMS_MIN_STACK: 100,
	HOLDEM_TERMS_MAX_STACK: 1_000_000,
	HOLDEM_TERMS_MIN_BIG_BLIND: 2,
	HOLDEM_TERMS_STACK_TO_BIG_BLIND: 10,
	// The rules card (holdemRulesCard). A request lives two minutes, long enough
	// to pick invitees or change the rules, short enough that a stale card cannot
	// open a table nobody is waiting for.
	DERO_HOLDEM_REQUEST_TTL_MS: 2 * 60_000,
	// The dealer (dealerNarration). Text is the hand start and the result, so two
	// lines per hand is the whole of it; speech caps at eight so a six seat hand
	// cannot queue a minute of talking, dropping "your turn" lines first.
	DERO_DEALER_TEXT_LINES_PER_HAND: 2,
	DERO_DEALER_SPOKEN_LINES_PER_HAND: 8,
	// A dealer entry whose table ended some other way (a forfeit, a deleted
	// channel) is dropped after this, so the in memory map cannot grow forever.
	DERO_DEALER_SESSION_MAX_AGE_MS: 12 * 60 * 60_000,

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
	//        an admin (cooldowns, multipliers, the curve) live on
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

		// ── the weekly digest DM (2026-10 item 243 Phase 4) ──
		// Monday at 9 am Central, the owner's chosen slot, so the week it recaps has
		// ended for every guild whatever its weekStart. node-cron reads the timezone,
		// so the send tracks daylight saving rather than drifting an hour twice a year.
		WEEKLY_DIGEST_CRON: "0 9 * * 1",
		WEEKLY_DIGEST_TIMEZONE: CENTRAL_TIME_ZONE,
		// Only the most active members of the week hear from Dero, at most this
		// many per guild. A DM nobody asked for is the fastest way for a bot to be
		// reported as spam, so the digest is a reward for the top of the week rather
		// than a broadcast to everyone who said one word.
		WEEKLY_DIGEST_MAX_MEMBERS: 25,
		// The pause between two digest DMs. Discord rate limits opening DM channels
		// and flags a bot that opens many at once, so the run is paced: 25 members
		// in ten guilds is about six minutes, well inside the hour before the next
		// cron anything could collide with.
		WEEKLY_DIGEST_DM_SPACING_MS: 1_500,

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
		// Messages and reactions pay a flat 1 XP each, the owner's decision of
		// 2026-10-23 (the 1.7.0 test fixes, item 5). The old per guild 15 to 40 and
		// 10 to 25 ranges let a chatty member outpace every game in the arcade, and
		// the four rate options that set them are gone from /setup-level-system.
		// Role and channel multipliers still apply on top, floored, so a 2x role
		// earns 2.
		MESSAGE_XP: 1,
		REACTION_XP: 1,

		// ── the daily cap (2026-10-23, the 1.7.0 test fixes, item 5) ──
		// The most XP one member can earn in one server in one day from the passive
		// and luck sources below combined. 50 is the owner's number: a member who
		// chats all day still levels, but the leaderboard stays a measure of being
		// present rather than of typing fastest.
		DAILY_XP_CAP: 50,
		// The sources the cap covers, and ONLY these. They are the ones a member can
		// repeat without anybody else taking part: a message, a reaction, a solo luck
		// game against Dero. Voice is gated by approved channels and a member count,
		// a game against another member needs that member, and achievement and admin
		// awards are one offs, so all of those pay in full.
		DAILY_CAPPED_SOURCES: ["message", "reaction", "soloLuck"],
		// The cap's day is the calendar day in Central time, so it resets at
		// midnight where the owner lives rather than at UTC midnight, which falls in
		// the early evening in Central time.
		DAILY_CAP_TIME_ZONE: CENTRAL_TIME_ZONE,
		// How long an XpDaily row survives. Only today's row is ever read, so three
		// days covers a day boundary in any zone plus slack for a clock skewed host,
		// while keeping the collection to a few rows per active member.
		XP_DAILY_RETENTION_SECONDS: 3 * 24 * 60 * 60,

		// ── solo luck games against Dero (2026-10-23, the 1.7.0 test fixes, item 14) ──
		// Deliberately tiny next to GAME_WIN_XP: a coin flip against Dero takes a
		// second and needs nobody else, so it pays like a message rather than like a
		// match, and both amounts count toward DAILY_XP_CAP.
		SOLO_LUCK_WIN_XP: 3,
		// A loss or a tie. Paid so trying is never worth nothing, and kept below the
		// win so winning is still the point.
		SOLO_LUCK_OTHER_XP: 1,

		// Per game amounts. A game played in its own GAME ROOM pays more than the
		// same game played in a channel, because a match with its own channel is a
		// bigger commitment than a one message duel.
		GAME_PLAY_XP: 25,
		GAME_WIN_XP: 75,
		GAME_TIE_XP: 40,
		GAME_ROOM_PLAY_XP: 40,
		GAME_ROOM_WIN_XP: 120,

		// ── battleship ──
		// Paid PER SINK, on top of the ordinary play and win amounts, to the player
		// who fired the sinking shot. Small on purpose: a full match sinks five
		// ships, so at 15 the bonus tops out at 75, below GAME_ROOM_WIN_XP. Making
		// it larger would pay a losing player who sank four ships more than the
		// winner who sank five, which inverts the thing being rewarded.
		//
		// It exists at all because battleship is the one game here with meaningful
		// progress BEFORE the result: sinking a carrier is an event, and a match
		// that pays nothing until the final shot feels flat for twenty minutes.
		GAME_SINK_XP: 15,

		// ── hold em ──
		// Paid per HAND won, so a long tournament pays out along the way rather than
		// only at the end, and small because a hand is a minute of play. The
		// placement bonus is the real prize and is multiplied by finishing position
		// (1st takes the full amount, 2nd half, and so on), so winning a tournament
		// is worth roughly a room win plus the hands it took to get there.
		HOLDEM_HAND_WIN_XP: 10,
		HOLDEM_PLACEMENT_XP: 100,

		// ── blackjack ──
		// Blackjack deliberately reuses GAME_PLAY_XP, GAME_WIN_XP and GAME_TIE_XP
		// above (a push is a tie) so it cannot quietly pay differently from its
		// siblings. Only the two genuinely blackjack-shaped rules get their own
		// numbers, and each is awarded PER HAND, because a split seat is playing
		// two independent bets against the dealer.
		//
		// A natural pays a bonus on top of a win because it is the one hand you
		// cannot play your way into: it is dealt or it is not.
		BLACKJACK_NATURAL_XP: 50,
		// ⚠️ Doubling multiplies the WIN BONUS ONLY, and a doubled loss pays ZERO
		// rather than the usual play xp. That asymmetry is the entire point. If
		// doubling multiplied the whole award, a doubled loss would pay MORE than an
		// ordinary loss and the correct play would be to double every single hand,
		// which is not a decision, it is a formality.
		BLACKJACK_DOUBLE_WIN_MULTIPLIER: 2,

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

	// ── render analytics (2026-10 item 244) ───────────────────────
	// Counts every rendered card and avatar cache lookup per UTC month, read by
	// features/renderer/renderAnalytics.ts and /render-analytics. Every number
	// below is an owner decision of 2026-10-23 (2026-10 item 244).
	RENDER_ANALYTICS: {
		// Owner decision 2026-10-23 (2026-10 item 244): at most this many upserts in flight; beyond it an event is dropped and counted, so a slow Mongo cannot grow memory without bound.
		MAX_PENDING_WRITES: 500,
		// Owner decision 2026-10-23 (2026-10 item 244): drops and failures log as one summary line at most this often, never per event.
		SUMMARY_INTERVAL_MS: 60_000,
		// Owner decision 2026-10-23 (2026-10 item 244): a row expires 13 months (395 days) after its last lookup, enough for a year over year view.
		RETENTION_SECONDS: 395 * 24 * 60 * 60,
		// Owner decision 2026-10-23 (2026-10 item 244): how many keys /render-analytics top10 lists.
		TOP_N: 10,
		// Owner decision 2026-10-23 (2026-10 item 244): a surface earns a sizing hint only after this many renders (hits plus draws) in the period.
		SIZING_MIN_RENDERS: 50,
		// Owner decision 2026-10-23 (2026-10 item 244): a surface above this hit rate is "evergreen".
		EVERGREEN_HIT_RATE: 0.9,
		// Owner decision 2026-10-23 (2026-10 item 244): a surface below this hit rate is "long tail".
		LONG_TAIL_HIT_RATE: 0.1,
		// Owner decision 2026-10-23 (2026-10 item 244): suggest growing the memory tier when S3 hits pass this share of all hits.
		GROW_MEMORY_S3_SHARE: 0.3,
		// Owner decision 2026-10-23 (2026-10 item 244): the month to date digest DMs the owner every Monday at 9:15 am.
		DIGEST_CRON: "15 9 * * 1",
		// The digest cron reads in the owner's own zone, not the Railway host clock (UTC), so 9:15 stays 9:15 across daylight saving.
		DIGEST_TIME_ZONE: "America/Chicago",
	},

	// ── arcade ratings (2026-10 item 244) ─────────────────────────
	// OpenSkill ratings for Hold'em, Battleship and Monopoly, luck stats for the
	// three luck games and Hold'em hand counts, read by features/ratings/. Every
	// number below is an owner decision of 2026-10-23 (2026-10 item 244).
	RATINGS: {
		// Owner decision 2026-10-23 (2026-10 item 244): the display rating a brand new player reads, since a fresh OpenSkill ordinal is 0.
		DISPLAY_BASE: 1000,
		// Owner decision 2026-10-23 (2026-10 item 244): display points per ordinal point (ordinal = mu minus 3 sigma).
		DISPLAY_SCALE: 40,
		// Owner decision 2026-10-23 (2026-10 item 244): a rating is marked provisional until the player has this many rated games.
		PROVISIONAL_GAMES: 10,
		// Owner decision 2026-10-23 (2026-10 item 244): a Hold'em session with fewer dealt hands is recorded but never rated, so "deal, bust, repeat" farms nothing.
		HOLDEM_MIN_RATED_HANDS: 10,
		// Owner decision 2026-10-23 (2026-10 item 244): a luck score is shown only from this many decided games, below which it is noise.
		LUCK_MIN_DECIDED: 20,
		// Owner decision 2026-10-23 (2026-10 item 244): the host's Close band admits joiners within this many display points.
		BAND_CLOSE: 150,
		// Owner decision 2026-10-23 (2026-10 item 244): the host's Tight band admits joiners within this many display points.
		BAND_TIGHT: 75,
		// How many players /rating board and /rating luck list, the same ten /account view:levels shows.
		BOARD_SIZE: 10,
		// Owner decision 2026-10-23 (2026-10 item 244): the monthly arcade post names the top three winning Hold'em hands.
		MONTHLY_TOP_HANDS: 3,
		// Owner decision 2026-10-23 (2026-10 item 244): each server's last month posts on the 1st at 9:05 am.
		MONTHLY_POST_CRON: "5 9 1 * *",
		// The post cron reads in the owner's zone, not the Railway host clock (UTC), so 9:05 stays 9:05 across daylight saving.
		MONTHLY_POST_TIME_ZONE: CENTRAL_TIME_ZONE,
		// Owner decision (2026-10 item 244 Phase 5c): Dero's Castle shows each rated game's display ratings in 100 point buckets.
		DISTRIBUTION_BUCKET: 100,
		// How long the platform route waits for the ratings block before answering without it. Under the
		// server's 5 s BOT_FETCH_TIMEOUT_MS in botApiClient.ts, so a slow tag lookup can cost the Castle its
		// ratings widget but never the render analytics beside it.
		PLATFORM_REPORT_TIMEOUT_MS: 3_000,
	},

	// ── chip economy (2026-10 item 250 Phase 5) ───────────────────
	// The per server chips a member claims and buys into Hold'em with, and the server
	// vault admins grant from. Every amount below is an owner decision of 2026-10-24
	// (the plan's chip economy rounds) unless its line says otherwise. Chips are never
	// sold, bought or cashed out of Discord: they are a scorekeeping currency only.
	ECONOMY: {
		// Owner decision 2026-10-24: a member's first ever claim in a server.
		FIRST_CLAIM_CHIPS: 25_000,
		// Owner decision 2026-10-24: every later claim, once per cooldown.
		DAILY_CLAIM_CHIPS: 1_000,
		// Owner decision 2026-10-24: a claim every 24 hours, counted from the last claim.
		CLAIM_COOLDOWN_MS: 24 * 60 * 60 * 1000,
		// Owner decision 2026-10-24: a server's vault starts here the first time anything reads it.
		VAULT_STARTING_CHIPS: 100_000,
		// Owner decision 2026-10-24 (the plan's data model): the vault keeps its 50 most recent grants.
		VAULT_GRANT_HISTORY_LIMIT: 50,
		// How many of those grants /economy status lists; the rest stay on the row for the dashboard.
		VAULT_STATUS_GRANTS_SHOWN: 5,
		// The largest single grant an admin may type. Far above any vault a month of awards
		// builds, so it only refuses a typo (an extra zero), never a real grant.
		MAX_GRANT_CHIPS: 1_000_000,
		// Owner decision 2026-10-24: the monthly vault award by network server rating rank,
		// rank 1 first. Ranks past the list award nothing.
		VAULT_TOP_UP_AWARDS: [100_000, 50_000, 50_000, 50_000, 50_000, 25_000, 25_000, 25_000, 25_000, 25_000] as readonly number[],
		// Owner decision 2026-10-24: the award runs on the 1st at 00:05 UTC.
		VAULT_TOP_UP_CRON: "5 0 1 * *",
		VAULT_TOP_UP_TIME_ZONE: "UTC",
		// Owner decision 2026-10-25 (Phase 5, question 1): the host sets one buy in for the
		// whole table. These are the modal's presets; the host may type any other amount
		// between the two bounds, which keep a table between ten and fifty thousand big
		// blinds of play at the standard 20 chip big blind.
		HOLDEM_BUY_IN_PRESETS: [1_000, 2_500, 5_000, 10_000] as readonly number[],
		HOLDEM_MIN_BUY_IN: 200,
		HOLDEM_MAX_BUY_IN: 1_000_000,
	},

	// ── Dero bot opponents (2026-10 item 250 Phase 5) ─────────────
	// The bot driver (game-rooms/botTurns.ts) wakes every TICK_MS and moves each room's
	// bot at most once per tick, so a bot's turn reads at a human pace: a hold'em bot acts
	// THINK_MS after the board showed it the turn, and a Monopoly or Battleship bot takes
	// one step per tick. Fast enough that a member never waits on a bot, slow enough that
	// the trail can be followed and Discord's rate limits are never close.
	BOT_TURNS: {
		TICK_MS: 3_000,
		THINK_MS: 2_500,
	},

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
	//        268659793 (the integer we'd use without the Discord
	//        enforcement catch-22). Create Invite (bit 1) joined the list
	//        when game rooms started minting a per-room invite link.
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
		"Create Invite",
	] as const,
} as const; // ← this is important, explained below
