import mongoose from "mongoose";
import { v4 } from "uuid";

const Schema = mongoose.Schema;

const guildConfigSchema = new Schema(
	{
		configId: { type: String, required: true, unique: true, default: v4 },
		guildId: { type: String, required: true, unique: true },
		adminRoleId: { type: String, required: false, default: null }, // role that can configure the bot

		// category
		categoryId: { type: String, required: true },
		// member role assigned to verified users during onboarding, stored here for easy access when assigning during onboarding
		memberRoleId: { type: String, required: false, default: null },
		// channel IDs, stored so bot always knows where to post.
		// All channels stay required because v1.5.1 ships the visibility-
		// toggle approach (channels always exist, /setup hide/show controls
		// @everyone ViewChannel overwrites). A future create-or-delete
		// redesign would re-revisit nullability.
		introChannelId: { type: String, required: true },
		commandsChannelId: { type: String, required: true },
		leaderboardChannelId: { type: String, required: true },
		scheduleChannelId: { type: String, required: true },
		announcementsChannelId: { type: String, required: true },
		adminChannelId: { type: String, required: true },
		// ── next decree channel ───────────────────────────────────────
		// What:  id of the 🛡️next-decree channel where NextUpBoard posts
		//        a fresh embed for each upcoming event (24h rolling
		//        horizon). NEW posts, never edits, each post is an audit
		//        trail entry leaders can scroll back through.
		// Who:   NextUpBoard (post creation), GuildSetupManager
		//        (channel provisioning + self heal).
		// When:  populated by the first /setup or autoSetup pass that runs
		//        AFTER this field is merged. Legacy rows load with null
		//        until the boot sweep's repairMissingChannels fills it in.
		// Where: read by NextUpBoard at post time; written by
		//        populateChannels and repairOneChannel.
		// How:   nullable so existing guilds (pre this migration) still
		//        load cleanly. The boot sweep's CHANNEL_SPECS walk treats
		//        null as "missing" and rebuilds the channel on next tick.
		nextDecreeChannelId: { type: String, required: false, default: null },

		// ── admin command center channel (2026-06-19) ──
		// Admin-only command channel: holds the relocated admin command guide (out
		// of inner-sanctum) + the admin power-up panel. Same overwrites as
		// adminChannelId; nullable so existing rows load before the boot sweep
		// creates it (repairMissingChannels treats null as "missing, build it").
		adminCommandsChannelId: { type: String, required: false, default: null },

		// ── ARCADE GAMES: the guild's SECOND managed category (2026-08-10) ──
		// What:  ids of the 🎮 ARCADE GAMES category and the two managed channels
		//        inside it, 📋game-rules and ⚔️challenges. Per match game rooms
		//        are created as further children of this category and are NOT
		//        tracked here, they live on their own GameRoom rows.
		// Who:   GuildSetupManager (create + self heal), ChannelDeleteWatcher
		//        (realtime rebuild), selfDestruct (teardown), OnboardingCheck,
		//        and RoomProvisioner, which parents every new room channel to
		//        gamesCategoryId.
		// When:  populated by the first /setup or boot sweep that runs AFTER
		//        this field is merged. Legacy rows load null until then.
		// Where: ⚠️ categoryId above is `required: true` and SINGULAR, and every
		//        consumer written before today reads it as "the" category. These
		//        are the first fields to break that assumption, which is why a
		//        channel spec must now name WHICH category it belongs to rather
		//        than inheriting the only one that used to exist.
		// How:   nullable, following nextDecreeChannelId exactly, so existing
		//        guilds load cleanly and the boot sweep treats null as "missing,
		//        build it". Deliberately NOT required: making gamesCategoryId
		//        required would fail validation on every legacy row in the
		//        collection the moment this ships.
		gamesCategoryId: { type: String, required: false, default: null },
		gamesRulesChannelId: { type: String, required: false, default: null },
		gamesChallengesChannelId: { type: String, required: false, default: null },

		// id of the pinned message inside scheduleChannelId that ScheduleBoard
		// keeps up to date. null until autoSetup finishes posting the intro,
		// at which point this is populated and every subsequent refresh edits
		// that one message in place so the channel never accumulates clutter.
		// As of v1.6 (item 36) this same message also hosts the schedule control
		// row: Go Live Now plus a phase-gated Set up / Pause / Resume button.
		// ScheduleBoard attaches the components on send + edit via
		// buildScheduleControlRow in ScheduleControls.
		scheduleMessageId: { type: String, required: false, default: null },

		// ── leaderboard board message id (v1.6 Phase 2, item 13, added 2026-06-17) ─
		// What:  id of the pinned message inside leaderboardChannelId that
		//        LeaderboardBoard keeps up to date with the week's standings.
		// Who:   written by LeaderboardBoard.postOrEdit on first post; read on
		//        every refresh so subsequent updates edit that one message in
		//        place rather than spamming the channel. Mirrors scheduleMessageId.
		// When:  null until the first refresh posts the board (boot sweep, a
		//        reminder fire, or debounced activity). Repopulated when an admin
		//        deletes the message and the next refresh reposts.
		// How:   nullable so legacy guilds load cleanly; the post path treats
		//        null as "never posted, send a fresh one and persist the id".
		leaderboardMessageId: { type: String, required: false, default: null },

		// ── levels board message id (leveling, added 2026-08-11) ────────
		// What:  id of the SECOND bot message inside leaderboardChannelId, the one
		//        LevelsBoard keeps up to date with the guild's xp standings.
		//        Deliberately a sibling of leaderboardMessageId and never a
		//        replacement for it: the two boards live in the same channel and
		//        answer different questions, so each owns its own anchor.
		// Who:   written by LevelsBoard.postOrEdit on first post; read on every
		//        refresh so later updates edit that one message in place.
		// When:  null until the first refresh posts the board. Repopulated when an
		//        admin deletes the message and the next refresh reposts.
		// Where: reusing leaderboardChannelId rather than provisioning a levels
		//        channel is a deliberate cost decision: a new channel means a
		//        CHANNEL_SPECS entry, a SLOT_LABELS entry, a rename path and a
		//        backfill for every existing guild, and GuildSetupManager.
		//        createChannels has ZERO test coverage today.
		// How:   nullable so legacy rows load cleanly; the post path treats null as
		//        "never posted, send a fresh one and persist the id".
		levelsMessageId: { type: String, required: false, default: null },

		// ── leveling (added 2026-08-11) ────────────────────────────────
		// What:  every per-guild knob of the leveling system. The numbers an
		//        OPERATOR would turn (flush intervals, xp amounts per game) live in
		//        BOT_CONSTANTS.LEVELING instead; what lives here is what an ADMIN
		//        configures through /setup-level-system.
		// Who:   messageXp, reactionXp and voiceXp (the earn rules), awardXp (the
		//        curve), levelUpAnnouncer (where and how loudly), roleRewards.
		// When:  read from a TTL cache on the message path, so this subtree is hit
		//        constantly and must never be fetched fresh per message.
		// Where: a nested subtree rather than fifteen sibling fields, so the whole
		//        feature is one path to read, one path to reset, and one path to
		//        ignore entirely when leveling is off.
		// How:   nullable-by-default shape with every leaf carrying a default, so
		//        every legacy row in the collection loads with a complete, working
		//        configuration and no backfill runs.
		//
		// ⚠️ THREE DEFAULTS BELOW ARE COUNTERINTUITIVE ON PURPOSE. Each carries its
		// reasoning inline. Do not "correct" any of them without reading it.
		leveling: {
			type: {
				// ⚠️ TRUE. The owner decided leveling ships ON in every guild
				// immediately, with no opt in (locked decision D4). Do not helpfully
				// default this to false. The mitigations that make it safe are: no
				// leveling message ever pings, the announce channel falls back to the
				// announcements channel every set up guild already has, restrictions
				// exclude nothing by default so nothing silently earns zero, and the
				// first level up in a guild posts a one time notice to the admin
				// channel naming /setup-level-system and how to turn this off.
				enabled: { type: Boolean, required: false, default: true },

				// The xp curve. "dero" is 3n^2 + 47n + 101, all three coefficients
				// prime, sitting between Arcane's linear and the steeper exponentials.
				// See @features/leveling/levelCurve.ts.
				curve: { type: String, enum: ["dero", "linear", "exponential", "flat"], default: "dero" },
				curveMultiplier: { type: Number, required: false, default: 1 },
				// null means uncapped. A cap clamps without erroring.
				maxLevel: { type: Number, required: false, default: null },

				// PRIME LEVELS ARE THE MILESTONE LEVELS. "everyN" survives only as an
				// opt out for a guild that wants the ordinary thing; milestoneEveryN
				// is read ONLY when milestoneMode is "everyN".
				milestoneMode: { type: String, enum: ["prime", "everyN"], default: "prime" },
				milestoneEveryN: { type: Number, required: false, default: 5 },

				message: {
					type: {
						enabled: { type: Boolean, required: false, default: true },
						min: { type: Number, required: false, default: 15 },
						max: { type: Number, required: false, default: 40 },
						// 60 seconds is the category's floor and the single most
						// effective anti farm measure in the feature. There is
						// deliberately no length or per word bonus anywhere, which is
						// both the most gameable mode in this category and the only
						// thing that would require the MessageContent intent.
						cooldownSeconds: { type: Number, required: false, default: 60 },
					},
					required: false,
					default: () => ({}),
				},

				reaction: {
					type: {
						enabled: { type: Boolean, required: false, default: true },
						min: { type: Number, required: false, default: 10 },
						max: { type: Number, required: false, default: 25 },
						cooldownSeconds: { type: Number, required: false, default: 300 },
						// Who gets paid for a reaction. Never both ends of a member
						// reacting to their own message, whatever this says.
						awards: { type: String, enum: ["reactor", "author", "both"], default: "reactor" },
					},
					required: false,
					default: () => ({}),
				},

				voice: {
					type: {
						enabled: { type: Boolean, required: false, default: true },
						perMinute: { type: Number, required: false, default: 5 },
						cooldownSeconds: { type: Number, required: false, default: 180 },

						// ⚠️ EMPTY MEANS NOBODY EARNS VOICE XP. This is the OPPOSITE
						// polarity from every other list in this subtree and it is
						// deliberate: the owner asked for "approved voice calls", so
						// voice xp is opt in PER CHANNEL by construction and a guild
						// that never configures it never has a voice farming surface at
						// all. An empty array that means "none" rather than "all" is
						// exactly the kind of thing a later reader inverts, so it is
						// said loudly here and again in voiceXp.
						approvedChannels: { type: [String], required: false, default: () => [] as string[] },

						// Arcane's anti farm set, copied wholesale, because a 24/7 voice
						// self bot is a real, public, mature tool: a minimum headcount so
						// sitting alone pays nothing, a mute and deafen check, and a
						// decay that cuts the award once a session runs long.
						minMembers: { type: Number, required: false, default: 2 },
						decayAfterMinutes: { type: Number, required: false, default: 120 },
						decayFactor: { type: Number, required: false, default: 0.25 },
					},
					required: false,
					default: () => ({}),
				},

				// Where a level up posts. "announcements" uses announceChannelId and
				// falls back to the guild's announcementsChannelId, which every set
				// up guild has; "current" posts wherever the xp was earned;
				// "milestone" posts prime levels only; "off" posts nothing.
				announceMode: {
					type: String,
					enum: ["announcements", "current", "milestone", "off"],
					default: "announcements",
				},
				announceChannelId: { type: String, required: false, default: null },
				// The bot adds this to its OWN level up message so members can pile
				// on. On its own post, not the member's, because a level up can come
				// from a voice sweep where there is no message to react to.
				reactionEmoji: { type: String, required: false, default: "🎉" },

				// ⚠️ ONE MODE PLUS ONE LIST, never a blacklist and a whitelist as
				// siblings. Arcane ships both as adjacent settings with inverted
				// semantics and their own restrictions page opens with a DANGER
				// banner calling that misconfiguration their largest support item,
				// because adding one channel to the whitelist silently kills xp
				// everywhere else. One mode plus one list makes that unrepresentable.
				restrictionMode: { type: String, enum: ["exclude", "only"], default: "exclude" },
				restrictedChannels: { type: [String], required: false, default: () => [] as string[] },
				restrictedRoles: { type: [String], required: false, default: () => [] as string[] },

				// true keeps every reward role earned; false keeps only the highest
				// and removes the rest. Either way the full desired set is computed
				// and applied in ONE roles.set call, never add then remove.
				stackRewards: { type: Boolean, required: false, default: true },
				rewards: {
					type: [{ level: { type: Number }, roleId: { type: String } }],
					required: false,
					default: () => [],
				},

				roleMultipliers: {
					type: [{ roleId: { type: String }, multiplier: { type: Number } }],
					required: false,
					default: () => [],
				},
				channelMultipliers: {
					type: [{ channelId: { type: String }, multiplier: { type: Number } }],
					required: false,
					default: () => [],
				},
				// false means the HIGHEST applicable multiplier wins; true means they
				// combine. Defaulting to false keeps a member holding three boosted
				// roles from earning a surprising multiple of everyone else.
				stackMultipliers: { type: Boolean, required: false, default: false },
			},
			required: false,
			default: () => ({}),
		},

		// ── KvK season end ─────────────────────────────────────────────
		// What:  the configured end date of the guild's current KvK season.
		//        Single canonical date per guild. Events created with
		//        announcementType "kvk" inherit this value at the events
		//        route, so admins never type the same date twice.
		// Who:   written by GuildEventManager.configureKvKSeason when the
		//        owner runs /configure-kvk-season. Read by the events route
		//        when a new event opts into KvK mode, and by the dashboard
		//        health endpoint so the EventCreatePage can disable the
		//        KvK toggle when no season is configured yet.
		// When:  written once per season at /configure-kvk-season time.
		//        Cleared (back to null) when ReminderScheduler.announceSeasonEnd
		//        flips the last KvK event inactive, but ONLY if no other
		//        active KvK events still reference a future date. For v1
		//        we leave the cleanup to the next /configure-kvk-season run
		//        which overwrites the field; this avoids a multi guild race
		//        where season end rolls over while events are still firing.
		// Where: nullable so legacy guilds (any guild that has not run
		//        /configure-kvk-season since this field was added) load
		//        cleanly. The dashboard treats null as "no active season"
		//        and disables the KvK toggle on the event create form.
		// How:   stored as a Date object so the date math at the events
		//        route is symmetric with how IKvKSeasonInput already passes
		//        it around in GuildEventManager.
		kvkSeasonEnd: { type: Date, required: false, default: null },

		// ── intro message ids ──────────────────────────────────────────
		// What:  per channel id of the bot's intro embed message. Populated
		//        when populateChannels (or repairOneChannel) posts an intro,
		//        consumed by GuildSetupManager.refreshIntroEmbeds at boot to
		//        edit the existing message in place rather than reposting.
		// Who:   GuildSetupManager.populateChannels (initial), repairOneChannel
		//        (per channel rebuild), refreshIntroEmbeds (boot refresh).
		// When:  initial: set during the first /setup or autoSetup pass.
		//        rebuild: overwritten when a channel is healed.
		//        boot: read but only written if the stored message went
		//        missing and a fresh intro had to be posted.
		// Where: nested object so adding a seventh homebase channel later is
		//        a one line schema bump instead of a sibling field per slot.
		// How:   nullable per field so legacy rows that predate this change
		//        still load. refreshIntroEmbeds treats null as "no anchor,
		//        repost a fresh intro" which doubles as the migration path.
		introMessageIds: {
			type: {
				introChannelId: { type: String, required: false, default: null },
				commandsChannelId: { type: String, required: false, default: null },
				leaderboardChannelId: { type: String, required: false, default: null },
				scheduleChannelId: { type: String, required: false, default: null },
				announcementsChannelId: { type: String, required: false, default: null },
				adminChannelId: { type: String, required: false, default: null },
				// paired with nextDecreeChannelId above. tracks the intro
				// embed sitting above the NextUpBoard posts so
				// refreshIntroEmbeds edits it in place on boot.
				nextDecreeChannelId: { type: String, required: false, default: null },
				// ── admin command guide (2026-04-24) ───────────────────
				// What:  the SECOND pinned message in adminChannelId. The
				//        admin welcome embed keeps adminChannelId above;
				//        this field tracks the admin-only command guide
				//        which mortals never see because inner-sanctum is
				//        role-gated. Public #command-center now only
				//        lists /leaderboard + /list-events; every other
				//        command lives behind this guide.
				// Who:   GuildSetupManager.populateChannels (initial post),
				//        refreshIntroEmbeds (edit in place on every boot).
				// When:  populated on fresh setups shipped after this
				//        migration. Legacy rows load as null, and the
				//        refresh sweep treats null as "no anchor, post
				//        a fresh admin command guide and persist the id,"
				//        which doubles as the migration path.
				// Where: breaks the one-key-per-channel invariant of this
				//        sub-doc. Accepted as tech debt: the alternative
				//        (restructuring adminChannelId to a sub-object)
				//        would require a breaking migration touching
				//        every live row. Flat keys scale, add another
				//        for the next second-message-in-a-channel use
				//        case and move on.
				// How:   nullable string, same contract as every sibling.
				adminCommandGuideId: { type: String, required: false, default: null },
				// Pinned intro anchor for the new admin command channel (the relocated
				// command guide). Tracked like every other channel intro.
				adminCommandsChannelId: { type: String, required: false, default: null },
				// ── invite card (2026-06) ──────────────────────────────
				// Flat key (like adminCommandGuideId): the SECOND pinned message in
				// #command-center, the standalone "summon Dero" card (pitch + gif +
				// Summon button), separate from commandsChannelId (the command guide).
				// refreshIntroEmbeds maintains it; null on legacy rows until the first
				// boot posts it.
				inviteCardId: { type: String, required: false, default: null },
				// ── ARCADE GAMES intro anchors (2026-08-10) ──────────────
				// Paired with gamesRulesChannelId and gamesChallengesChannelId
				// above. ⚠️ THESE TWO KEYS ARE THE WHOLE REASON THE POST MORTEM
				// FURTHER DOWN THIS FILE EXISTS. Mongoose runs strict, so a write
				// to an UNDECLARED key inside this subdocument is dropped in
				// silence, the read comes back undefined, and refreshIntroEmbeds
				// reads undefined as "no anchor yet, post a fresh intro and
				// persist the id". It would then repost both cards on EVERY BOOT,
				// forever, with nothing failing anywhere. Declaring them here is
				// not bookkeeping, it is the fix for a bug that would otherwise
				// ship looking like it worked.
				gamesRulesChannelId: { type: String, required: false, default: null },
				gamesChallengesChannelId: { type: String, required: false, default: null },
			},
			required: false,
			default: () => ({}),
		},

		setupComplete: { type: Boolean, default: false },

		// ── plugin id (streamer-plugin spec Phase 1) ───────────────────
		// What:  which copy/voice pack the bot renders for this guild.
		//        Today the registry knows two ids: "rok-commander" (the
		//        kingdom-voice pack used by the original alliance bot) and
		//        "general-events" (the streamer-tone pack scheduled to land
		//        in Phase 2). Unset rows fall back to "rok-commander" via
		//        the `default` here AND via the registry fallback in
		//        `getPluginCopy`, so the field is purely additive on
		//        legacy data.
		// Who:   every embed builder that calls `getPluginCopy(guildConfig)`
		//        reads this field to pick the right pack. Phase 1 ships
		//        the schema, registry, and lookup helpers; the embed
		//        builders themselves migrate to plugin-aware lookups in
		//        the follow-up phase that lands the streamer pack content.
		// When:  set when a guild installs a non-default plugin (Phase 2's
		//        general-events install flow). Existing rows continue to
		//        load as "rok-commander" without any data backfill.
		// Where: read by `getPluginCopy` at every render. Written by the
		//        plugin-install slash command (Phase 2) and never mutated
		//        at runtime, switching plugins after install is an admin
		//        action that requires re-running setup so the home base
		//        category and channels match the new pack's expectations.
		// How:   loose `String` validator (not an enum) so adding a third
		//        plugin pack later is a code-only change without a schema
		//        migration. The `PluginId` TypeScript union in
		//        `@base/copy/types` is the canonical authority on which
		//        ids are valid; Mongoose accepts any string and the
		//        runtime resolver handles unknown ids by falling back.
		pluginId: { type: String, required: false, default: "rok-commander" },

		// ── per-guild copy overrides (streamer-plugin spec Phase 1) ────
		// What:  owner-authored replacements for individual copy strings.
		//        A map from dotted-path keys (e.g. "responses.setupFailed",
		//        "scheduleBoard.title") to the override string the owner
		//        wants the bot to use instead of the pack default.
		// Who:   read by `getCopyOverride` ahead of every pack lookup so
		//        an override wins over the pack default. Written by the
		//        Phase 3 dashboard editor UI ("Voice & Copy" tab under
		//        plugin settings).
		// When:  Phase 1 ships the data plumbing only, the schema field
		//        and the resolver function. Call sites do not honor the
		//        override layer until they migrate to `getCopyOverride`,
		//        which happens incrementally as Phase 2 / Phase 3 deliver
		//        the streamer plugin and the editor UI. New rows get an
		//        empty Map; legacy rows load Map() lazily on first read.
		// Where: stored as a Mongoose Map so adding new overridable keys
		//        requires no schema migration, every key the bot reads
		//        through `getCopyOverride` is overridable for free.
		// How:   `default: () => new Map()` rather than a static literal
		//        so each document gets its own Map instance instead of
		//        sharing a reference. Values are constrained to strings;
		//        function-template copy (e.g. `intervalLabel(hours)`) is
		//        intentionally NOT overridable in v1 because it would
		//        require a templating engine and the audit surface gets
		//        complicated fast. v2 can revisit if real demand shows up.
		copyOverrides: { type: Map, of: String, required: false, default: () => new Map<string, string>() },

		// ── auto-heal toggle (streamer feedback 2026-05-11) ───────────────
		// What:  master switch for the bot's channel auto-repair behavior.
		//        When true (default), the boot sweep's repairMissingChannels
		//        and the realtime ChannelDeleteWatcher rebuild any homebase
		//        channel that goes missing. When false, both paths early-
		//        return after logging a single summary line per boot so the
		//        streamer can see in Railway logs that repairs were skipped
		//        without filling the log with one entry per channel.
		// Who:   admins who deliberately deleted/renamed channels and do not
		//        want the bot reconstituting them. Asked for in 2026-05-11
		//        streamer feedback.
		// When:  read by ChannelDeleteWatcher and by GuildSetupManager.autoSetup
		//        before the repair sweep. Toggled by /configure-auto-heal.
		// Where: nullable so legacy rows load cleanly. Default true preserves
		//        existing behavior, no data migration needed.
		// How:   plain Boolean. Schema bumps for additional repair-related
		//        flags can sibling this field; no need to nest yet.
		autoHealEnabled: { type: Boolean, required: false, default: true },

		// ── custom channel names (streamer feedback 2026-05-11) ───────────
		// What:  per-slot custom name overrides set by /rename-channel.
		//        Keyed by configField name (e.g., "leaderboardChannelId")
		//        with the value being the admin's chosen channel name.
		//        repairOneChannel reads this map before falling back to
		//        spec.displayName so a rebuild after channel deletion
		//        preserves whatever name the admin had chosen.
		// Who:   written by /rename-channel slash command (renames the
		//        live Discord channel AND persists the override here).
		//        Read by GuildSetupManager.repairOneChannel and by any
		//        future rebuild path that builds a channel from a spec.
		// When:  written on every /rename-channel invocation. Read at
		//        rebuild time. Cleared by /rename-channel if the admin
		//        sets the name back to the pack default (which is the
		//        existing spec.displayName).
		// Where: a Mongoose Map so adding a new slot in the future is a
		//        zero-migration write. Direct Discord-side renames do
		//        NOT update this map by design, the announcement copy
		//        explains the rule so admins understand "to persist
		//        across rebuilds, use the slash command."
		// How:   default empty Map. Legacy rows load with no overrides
		//        and repair behavior is identical to pre-flag behavior
		//        (use spec.displayName).
		channelNames: { type: Map, of: String, required: false, default: () => new Map<string, string>() },

		// ── user-removed channels (streamer feedback 2026-05-11) ──────────
		// What:  array of GuildConfig configField names (e.g.
		//        "leaderboardChannelId", "announcementsChannelId") that the
		//        admin has explicitly removed via the dashboard or via a
		//        slash command's follow-up button. repairMissingChannels
		//        consults this array per spec and SKIPS rebuilding any
		//        entry whose configField is listed here, even when
		//        autoHealEnabled is true. This is how a user-initiated
		//        removal supersedes the global auto-heal default, without
		//        this flag the boot sweep treats null storedId as
		//        "legacy row missing the new channel, rebuild it," which
		//        is the wrong semantics for "the admin deleted this on
		//        purpose."
		// Who:   written by the per-channel deletion handlers (today only
		//        leaderboardChannelHandlers.ts; future channel-lifecycle
		//        work will add more). Cleared by the corresponding
		//        toggle-back-on path on the related /configure-* command
		//        so the channel rebuilds on the next sweep.
		// When:  pushed when the admin clicks "Remove <channel>" on the
		//        slash command's follow-up button. Pulled when the admin
		//        re-enables the related feature toggle.
		// Where: stored as a flat string array (configField names) rather
		//        than nesting per-channel objects. Adding a new
		//        removable channel later requires no schema migration,
		//        just push its configField name from the new handler.
		// How:   default empty array so legacy rows load cleanly. The
		//        repair sweep treats absence-from-array as "not removed"
		//        which is the same as the pre-flag behavior.
		userRemovedChannels: { type: [String], required: false, default: () => [] as string[] },

		// ── leaderboard tracking toggle (streamer feedback 2026-05-11) ────
		// What:  master switch for participation tracking. When true (default),
		//        ActivityTracker writes PlayerActivity rows on ✅ reactions and
		//        voice-channel joins. When false, both listener handlers
		//        early-return so no new rows are written. Existing rows stay
		//        in the DB; /leaderboard continues to render historical data
		//        because the toggle is about new tracking, not destruction.
		// Who:   streamers who do not want participation tracked, or who want
		//        to pause tracking during a hiatus without losing prior data.
		// When:  read at the top of every MessageReactionAdd and voiceStateUpdate
		//        handler in ActivityTracker. Toggled by /configure-leaderboard-tracking.
		// Where: same row as autoHealEnabled. Both are global per-guild
		//        switches, not per-event or per-channel.
		// How:   plain Boolean. Hide-history-on-disable was rejected as MVP
		//        scope creep: data deletion (or visibility flip) is a separate
		//        admin action and should be its own command if/when needed.
		leaderboardTrackingEnabled: { type: Boolean, required: false, default: true },

		// ── leaderboard week start (v1.6 Phase 1, item 17, added 2026-06-17) ─
		// What:  which weekday anchors the leaderboard's "this week" window.
		//        "sunday" (default) runs Sun to Sat; "monday" runs Mon to Sun.
		// Who:   read by /leaderboard's thisWeekRange to compute the [from, to]
		//        window and by its embed title so the boundary is explicit, and
		//        by Phase 2's LeaderboardBoard which reuses the same window math.
		// When:  read on every "This week" leaderboard render. Written when an
		//        admin changes the preference.
		// Where: per guild, not per user. The per-user timezone preference this
		//        was once coupled to (FUTURE_PLANS item 16) does not exist, and
		//        per guild is the right scope for a community bot.
		// How:   enum-constrained string. Default "sunday" preserves the prior
		//        hardcoded behavior so legacy rows render identically with no
		//        backfill.
		weekStart: { type: String, enum: ["sunday", "monday"], default: "sunday" },

		// ── default event image (v1.6 Phase 4, media attachments) ───────
		// What:  per-guild fallback image URL used by event embeds when an
		//        event has no imageUrl of its own. Resolution at each embed site
		//        is `event.imageUrl ?? guildConfig.defaultEventImageUrl ?? null`,
		//        so a guild can give every event a house banner without setting
		//        one per event. The go-live announcement (not tied to a single
		//        event) uses this value directly.
		// Who:   read by ReminderJob, NextUpBoard, and postGoLiveAnnouncement at
		//        embed-build time. Set by the dashboard (server/client half).
		// When:  optional. null on legacy rows, so embeds stay text-only until a
		//        guild opts in. Never empty by contract once set, it is the
		//        last-resort image so the embed always has something to render.
		// How:   plain nullable String, same trust model as Event.imageUrl.
		defaultEventImageUrl: { type: String, required: false, default: null },

		// ── hidden channels (v1.5.1 item 4, added 2026-05-12) ──────────
		// Tracks which optional bot-managed channels the admin has chosen
		// to hide from members. Hiding applies @everyone deny ViewChannel
		// on the channel; showing removes the deny. The channel itself
		// always exists; the bot still posts to it; only member visibility
		// changes. Solves the streamer feedback "many channels go unused"
		// without the heavier create-or-delete refactor.
		// Values are channel-kind names like "commandsChannelId",
		// "leaderboardChannelId", etc, matching the GuildConfig field
		// names. Empty array means all channels are visible (default).
		// adminChannelId and introChannelId are NEVER added to this list
		// because they are the bot's primary admin surface and marketing
		// surface respectively. /setup hide refuses to accept them.
		hiddenChannels: { type: [String], required: false, default: () => [] as string[] },

		// ── auto-leave grace period (v1.5.1 item 9, added 2026-05-12) ──
		// Timestamp of the first permission failure on category creation.
		// Set when autoSetup catches DiscordAPIError 50013 on the category
		// create call (the entry point that proves the bot does not have
		// enough permissions to operate). Cleared on successful autoSetup.
		// When this value is older than 7 days, the auto-leave flow fires:
		// DM the owner with the Administrator-invite explanation, log the
		// leave to botLogs, then call guild.leave(). Grace period prevents
		// the bot from leaving guilds where an admin is mid-installation
		// and still wiring permissions. Field is nullable so legacy rows
		// load cleanly and rows that have never seen a failure stay
		// unmarked. The 7-day threshold is chosen because real installs
		// resolve within 24 hours and a week is a comfortable buffer for
		// admins on vacation or in slow-response timezones.
		firstPermissionFailureAt: { type: Date, required: false, default: null },
		// ── schedule pause/resume (added 2026-05-12 to fix silent-drop bug) ─
		// Holds the global schedule pause state for the guild. Written by
		// the /api/schedule/pause and /resume HTTP routes; read by
		// ReminderScheduler at every tick to decide whether to fire
		// reminders for events on this guild's schedule. Previously written
		// by the routes without being declared here, which meant Mongoose
		// strict mode silently dropped every write and reads always returned
		// undefined. The pause/resume feature looked functional in the
		// dashboard (route returned 200) but did nothing in production
		// because the data never persisted. The consumer-side
		// `as unknown as { schedulePaused?: ... }` casts in schedule.routes,
		// ReminderScheduler, and health.routes were the TypeScript workaround
		// pattern that hid the schema gap. Default shape is
		// { paused: false, pausedUntil: null } so existing rows load without
		// a migration; the field appears on first write.
		schedulePaused: {
			type: {
				paused: { type: Boolean, required: false, default: false },
				pausedUntil: { type: Date, required: false, default: null },
			},
			required: false,
			default: () => ({ paused: false, pausedUntil: null }),
		},

		// ── power-up message ids (v1.6 item 36; RETIRED 2026-06) ────────
		// What:  LEGACY. Per-channel id of a pinned standalone "power-up" panel
		//        message. The controls (toggle pings, say hello, refresh) no
		//        longer live on standalone panels, they are buttons folded into
		//        the pinned intro guides now (see resolveIntroComponents). This
		//        field is kept only so the one-time cleanup can find + delete the
		//        old panels on guilds set up before the fold-in.
		// Who:   read + cleared by PowerUps.removeAllPowerUpPanels (the boot-time
		//        cleanup sweep). Nothing writes a non-null value anymore. The
		//        button handler never read these, it routes purely on customId.
		// When:  legacy rows carry the old panel ids until the cleanup runs once,
		//        after which every slot is null and the sweep is a no-op.
		// How:   nullable per slot. Safe to drop this field entirely once every
		//        live guild has booted past the cleanup.
		powerUpMessageIds: {
			type: {
				// All slots are now legacy: each tracked the standalone panel that
				// used to sit in that channel. The boot cleanup deletes the message
				// and nulls the slot; nothing posts a new panel.
				adminChannelId: { type: String, required: false, default: null },
				commandsChannelId: { type: String, required: false, default: null },
				adminCommandsChannelId: { type: String, required: false, default: null },
				leaderboardChannelId: { type: String, required: false, default: null },
				introChannelId: { type: String, required: false, default: null },
				announcementsChannelId: { type: String, required: false, default: null },
			},
			required: false,
			default: () => ({}),
		},

		// ── announcement notifications role (v1.6, 2026-06-18) ──────────
		// What:  id of a mentionable role members self-assign via the
		//        announcements power-up to opt into announcement pings. Replaces
		//        the old pingSubscribers array: a real role can actually be
		//        @mentioned by a future announcement flow, and Discord shows who
		//        holds it. A Discord button label cannot be per-user, so the
		//        toggle conveys state through its ephemeral reply, not its label.
		// Who:   written by the announcements power-up toggle handler, which
		//        lazily creates the role on first use (and recreates it if an
		//        admin deletes it) and stores the id here.
		// When:  set on first opt-in toggle in a guild. null until then.
		// How:   nullable string. null means the role has not been created yet;
		//        the toggle handler creates it on demand.
		notificationsRoleId: { type: String, required: false, default: null },

		// ── homebase self-destruct flag (v1.6, 2026-06-18) ─────────────
		// What:  set true when the server owner runs /self-destruct (or the
		//        danger-zone panel button). While true, the homebase has been
		//        demolished and MUST stay gone: ensureHomebase (boot sweep) and
		//        ChannelDeleteWatcher (realtime repair) both short-circuit on it
		//        so nothing rebuilds the category/channels.
		// Who:   written true by selfDestruct.demolishHomebase BEFORE it deletes
		//        any channel (so the realtime watcher does not race the teardown
		//        and resurrect channels); cleared (false) by /setup, which
		//        rebuilds the homebase and re-assigns roles.
		// When:  read on every ensureHomebase pass and every channelDelete event.
		// How:   plain Boolean, default false so every existing/legacy row loads
		//        as "not destroyed" and behaves exactly as before.
		homebaseDestroyed: { type: Boolean, required: false, default: false },
	},
	{ timestamps: true }
);

const GuildConfigModel = mongoose.model("GuildConfig", guildConfigSchema);
export default GuildConfigModel;
