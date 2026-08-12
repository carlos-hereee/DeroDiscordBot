// ── LOG_MESSAGES ──────────────────────────────────────────────────────
// What:  single source of truth for every console.log / console.warn /
//        console.error string the bot emits.
// Who:   every feature module, every route handler, the bot entry point.
// When:  caller imports LOG_MESSAGES and passes the function result or
//        constant to console.*.
// Where: paired with the copy packs for user-facing copy. console output
//        lives here; Discord-rendered copy lives in the copy packs
//        (@base/copy/packs), resolved per guild via getPluginCopy
//        (@base/copy/getCopy).
// How:   strings with no interpolation are exported as string constants.
//        strings that take runtime values are exported as arrow functions
//        so the tag prefix and phrasing stay consistent per namespace.
//        error objects are still passed as a second argument to console
//        so stack traces survive.
//
// Usage:
//   import { LOG_MESSAGES } from "@base/constants/log-messages.js";
//   console.error(LOG_MESSAGES.schedule.editFailed(id, guildId), error);
export const LOG_MESSAGES = {
	// ── schedule board ─────────────────────────────────────────────────
	schedule: {
		channelMissing: (channelId: string, guildId: string) =>
			`[schedule] schedule channel ${channelId} not found or not a TextChannel for guild ${guildId}`,
		unexpectedError: (guildId: string) => `[schedule] unexpected error refreshing guild ${guildId}:`,
		storedMessageDeleted: (messageId: string, guildId: string) =>
			`[schedule] stored scheduleMessageId ${messageId} was deleted for guild ${guildId}. reposting.`,
		editFailed: (messageId: string, guildId: string) =>
			`[schedule] failed to edit scheduleMessageId ${messageId} for guild ${guildId}:`,
		staleAuthor: (messageId: string, guildId: string) =>
			`[schedule] scheduleMessageId ${messageId} in guild ${guildId} is not authored by this bot. treating the whole homebase as stale.`,
		rebuildingHomebase: (guildId: string) =>
			`[schedule] rebuilding homebase for guild ${guildId}, deleting stale GuildConfig and running autoSetup to create fresh channels this bot owns.`,
		rebuildHomebaseFailed: (guildId: string) =>
			`[schedule] homebase rebuild for guild ${guildId} failed. bot will retry on the next refresh trigger.`,
		postFailed: (guildId: string) => `[schedule] failed to post schedule message for guild ${guildId}:`,
		pinFailed: (guildId: string) => `[schedule] pin failed for guild ${guildId} (likely missing ManageMessages):`,
		refreshAfterConfigureFailed: "[schedule] refresh after configureKvKSeason failed:",
		refreshAfterRouteFailed: (trigger: string) => `[schedule] refresh after ${trigger} failed:`,
		refreshAfterReminderFailed: "[schedule] refresh after fireReminder failed:",
		refreshAfterSeasonEndFailed: "[schedule] refresh after announceSeasonEnd failed:",
		hourlyRefreshFailed: "[schedule] hourly refreshAllSchedules failed:",
	},

	// ── leaderboard board ──────────────────────────────────────────────
	leaderboard: {
		channelMissing: (channelId: string, guildId: string) =>
			`[leaderboard] leaderboard channel ${channelId} not found or not a TextChannel for guild ${guildId}`,
		unexpectedError: (guildId: string) => `[leaderboard] unexpected error refreshing guild ${guildId}:`,
		storedMessageDeleted: (messageId: string, guildId: string) =>
			`[leaderboard] stored leaderboardMessageId ${messageId} was deleted for guild ${guildId}. reposting.`,
		editFailed: (messageId: string, guildId: string) =>
			`[leaderboard] failed to edit leaderboardMessageId ${messageId} for guild ${guildId}:`,
		staleAuthor: (messageId: string, guildId: string) =>
			`[leaderboard] leaderboardMessageId ${messageId} in guild ${guildId} is not authored by this bot. skipping, ScheduleBoard owns homebase recovery.`,
		postFailed: (guildId: string) => `[leaderboard] failed to post leaderboard message for guild ${guildId}:`,
		pinFailed: (guildId: string) => `[leaderboard] pin failed for guild ${guildId} (likely missing ManageMessages):`,
		refreshAfterReminderFailed: "[leaderboard] refresh after fireReminder failed:",
		refreshAfterActivityFailed: "[leaderboard] debounced refresh after activity failed:",
		hourlyRefreshFailed: "[leaderboard] hourly refreshAllLeaderboards failed:",
	},

	// ── reminder firing ────────────────────────────────────────────────
	reminder: {
		noAnnouncementsChannel: (guildId: string) =>
			`[reminder] no announcements channel configured for guild ${guildId}, skipping fire`,
		channelNotFound: (channelId: string) => `Channel ${channelId} not found or not a text channel`,
	},

	// ── test reminder firing ───────────────────────────────────────────
	testReminder: {
		fetchChannelFailed: (channelId: string) => `[test-reminder] failed to fetch channel ${channelId}:`,
		postFailed: (channelId: string) => `[test-reminder] failed to post to channel ${channelId}:`,
		logWriteFailedAfterPost: "[test-reminder] embed posted but log write failed:",
	},

	// ── reminder scheduler ─────────────────────────────────────────────
	scheduler: {
		tickError: "Scheduler error:",
		// Emitted when a cron tick fires while the previous minute's tick is
		// still running. node-cron does not skip overlapping runs, so without
		// the in-process guard two concurrent ticks could both pass the
		// reminderStore.exists() dedup check and double-fire the same reminder.
		// Warn-level: a single skipped tick is self-correcting (the next minute
		// catches up), but a sustained stream of these means the tick is
		// overrunning its 60s budget and needs investigation (large guild
		// fan-out, slow remote-event calls, or a missing DB index).
		tickOverlapSkipped: "[scheduler] previous tick still running, skipping this minute to avoid duplicate fires",
		seasonEndNoChannel: (guildId: string) => `[season-end] no channel available for guild ${guildId}`,
		seasonEndFailed: "Failed to announce season end:",
		// Defensive: announceSeasonEnd should never be reached for an event
		// without a seasonEnd Date, the cron tick already gates on that.
		// If this fires, the scheduler called the announce path with a
		// regular event, which would have written reminder log rows keyed
		// off the unix epoch. Investigate the upstream caller.
		seasonEndCalledWithoutDate: (guildId: string, eventId: string) =>
			`[season-end] guard fired: event ${eventId} in guild ${guildId} has no seasonEnd; skipping announce`,
	},

	// ── setup ──────────────────────────────────────────────────────────
	setup: {
		pinScheduleIntroFailed: (guildId: string) => `[setup] failed to pin schedule intro message for guild ${guildId}:`,
		commandFailed: "Setup failed:",
		// ensureHomebase self heal path on wake up. emitted from
		// GuildSetupManager.ensureHomebase when the stored category cannot be
		// fetched (deleted, moved, or never existed on this Discord side).
		homebaseCategoryMissing: (categoryId: string, guildId: string) =>
			`[setup] stored categoryId ${categoryId} missing for guild ${guildId}. rebuilding homebase.`,
		// emitted when the stored scheduleMessageId is authored by a different
		// bot or cannot be resolved. tells the operator we are NOT going to
		// touch the existing channels, we will build a parallel homebase
		// this bot owns.
		homebaseNotOwned: (guildId: string) =>
			`[setup] homebase for guild ${guildId} is not owned by this bot. rebuilding instead of adopting.`,
		// probe failures during ownership check. Discord error code (number)
		// or "unknown" for non DiscordAPIError throws.
		homebaseOwnershipProbeFailed: (guildId: string, code: number | string) =>
			`[setup] ownership probe failed for guild ${guildId} (code ${code}). treating homebase as not owned.`,
		// emitted from repairMissingChannels when a single channel was deleted
		// while the bot was offline and had to be reconstructed.
		channelRepaired: (channelName: string, guildId: string) =>
			`[setup] rebuilt missing channel ${channelName} for guild ${guildId}.`,
		// single channel rebuild threw. autoSetup is NOT triggered in this
		// path, only the failing channel is skipped so the other repairs can
		// still land. next wake up will retry.
		channelRepairFailed: (channelName: string, guildId: string) =>
			`[setup] failed to rebuild channel ${channelName} for guild ${guildId}:`,
		// repair adopted an existing same-name channel instead of creating
		// a duplicate. Fires when a previous deploy created the channel in
		// Discord but never persisted the id to GuildConfig (eg. seventh
		// channel migration race). Warn-level so it shows up in logs but
		// does not read as a failure.
		channelAdopted: (channelName: string, guildId: string) =>
			`[setup] adopted existing ${channelName} under category for guild ${guildId} (id was null, channel present)`,
		// posting the inner sanctum audit notice threw (channel gone, missing
		// perms, Discord outage). repair already succeeded; this is the tail
		// end "hey admin, fyi" step that failed.
		repairNoticePostFailed: (guildId: string) =>
			`[setup] failed to post repair notice to inner sanctum for guild ${guildId}:`,
		// full category rebuild succeeded and we tried to post the "castle
		// rebuilt" announcement in the new inner sanctum. logged separately
		// from the single channel notice path so the operator can tell them
		// apart in production logs.
		castleRebuiltNoticePostFailed: (guildId: string) =>
			`[setup] failed to post castle rebuilt notice for guild ${guildId}:`,
		// MongoDB duplicate key (error code 11000) on the GuildConfig insert.
		// Almost always indicates a shared cluster between dev and prod: a
		// foreign row for this guildId already occupies the slot, and the
		// unique index on guildId refuses the insert. Bot built the Discord
		// side but cannot persist its config until the operator splits the
		// clusters. Loud on purpose so the smell is impossible to miss.
		guildConfigDuplicateKey: (guildId: string) =>
			`[setup] refusing to overwrite existing GuildConfig for guild ${guildId}, duplicate key (code 11000). ` +
			`This usually means dev and prod bots share a MongoDB cluster. Split the clusters before running further setup.`,
		// Emitted when ensureHomebase begins its sweep for a guild. Visible
		// marker at boot so the operator can tell the self heal pass actually
		// ran (vs. being masked by an early return or crash).
		ensureHomebaseStart: (guildId: string) => `[setup] ensureHomebase sweep starting for guild ${guildId}`,
		// Emitted when ensureHomebase finishes, including the action taken
		// so the operator can correlate with any Discord side posts.
		ensureHomebaseDone: (guildId: string, action: string) =>
			`[setup] ensureHomebase sweep complete for guild ${guildId}, action: ${action}`,
		// ── realtime ChannelDelete self heal ───────────────────────────
		// Emitted by ChannelDeleteWatcher. Kept under the setup namespace
		// because the self heal logic lives in GuildSetupManager and the
		// operator reads these alongside the boot sweep entries.
		realtimeRepairStarted: (channelName: string, guildId: string) =>
			`[setup] realtime repair starting for channel ${channelName} in guild ${guildId}`,
		// Fired when a second ChannelDelete event for the same channel
		// lands within the 60s cooldown window. Signals either a thrash
		// attack or an admin repeatedly tearing down the bot. Either way
		// we bail so the system does not fight the admin.
		realtimeRepairCooldownHit: (channelName: string, guildId: string) =>
			`[setup] realtime repair skipped for channel ${channelName} in guild ${guildId}, cooldown active`,
		// Fired when the deleted channel's parent category is also gone.
		// Realtime path intentionally does nothing here; boot sweep owns
		// full category rebuilds.
		realtimeRepairCategoryGone: (guildId: string) =>
			`[setup] realtime repair skipped for guild ${guildId}, parent category is gone. Deferring to next ensureHomebase pass.`,
		// Fired when the deleted channel belongs to a homebase this bot
		// does not own. We refuse to post into a foreign bot's category.
		realtimeRepairForeignHomebase: (guildId: string) =>
			`[setup] realtime repair skipped for guild ${guildId}, homebase is not owned by this bot.`,
		// Successful end of a realtime repair. Pairs with
		// realtimeRepairStarted so the operator can see the full lifecycle.
		realtimeRepairCompleted: (channelName: string, guildId: string) =>
			`[setup] realtime repair completed for channel ${channelName} in guild ${guildId}`,
		// Fired when the realtime repair threw after the cooldown gate. the
		// listener swallows the error (it must never crash the gateway
		// connection) but the operator needs a signal.
		realtimeRepairFailed: (channelName: string, guildId: string) =>
			`[setup] realtime repair failed for channel ${channelName} in guild ${guildId}:`,
		// ── intro embed refresh (boot) ─────────────────────────────────
		// What: GuildSetupManager.refreshIntroEmbeds sweeps the six stored
		//       intro messages per guild on boot and edits them in place to
		//       reflect the current copy from the copy packs
		//       (@base/copy/packs). Ships new wording
		//       without forcing admins to nuke and rebuild the homebase.
		// Why separate namespace from ensureHomebase? the refresh runs after
		//       the sweep and can fail independently of channel integrity,
		//       an edit-in-place failure still leaves the old intro showing,
		//       which is harmless, so we log warn (not error).
		introRefreshStarted: (guildId: string) => `[setup] intro embed refresh starting for guild ${guildId}`,
		// Fired when a stored intro message id resolves but the Discord
		// message has since been deleted. We respond by reposting a fresh
		// intro and persisting the new id so the next boot edits in place.
		introRefreshReposting: (channelName: string, guildId: string) =>
			`[setup] stored intro message for ${channelName} in guild ${guildId} is gone, reposting a fresh intro.`,
		// Channel id was missing from the config. should not happen after
		// a successful build but keeps the refresh loop defensive across
		// migrations and partial repairs.
		introRefreshChannelMissing: (channelName: string, guildId: string) =>
			`[setup] intro refresh skipped for ${channelName} in guild ${guildId}, channel not found.`,
		// Channel resolved but is not a TextChannel (e.g. forum, voice).
		// Legacy migration safety: if a future spec changes channel type we
		// do not want this loop to crash.
		introRefreshChannelWrongType: (channelName: string, guildId: string) =>
			`[setup] intro refresh skipped for ${channelName} in guild ${guildId}, channel is not a TextChannel.`,
		// Edit call failed. Most common causes: rate limit, transient
		// Discord outage, or bot lost Manage Messages on the channel. The
		// old intro stays visible so this is a visibility issue, not a
		// correctness one.
		introRefreshEditFailed: (channelName: string, guildId: string) =>
			`[setup] intro refresh edit failed for ${channelName} in guild ${guildId}:`,
		// Pair with introRefreshStarted so the operator can confirm the
		// sweep completed for each guild.
		introRefreshDone: (guildId: string, edited: number, reposted: number) =>
			`[setup] intro embed refresh complete for guild ${guildId}, edited: ${edited}, reposted: ${reposted}`,
	},

	// ── guild event manager ────────────────────────────────────────────
	guildEvent: {
		configureKvkFailed: "Failed to configure KvK season:",
		// Logged when /configure-kvk-season runs against a guild with no
		// GuildConfig row, events still get created but kvkSeasonEnd cannot
		// be persisted, so the dashboard's KvK toggle will read as
		// "no active season" until /setup populates the config.
		configureKvkNoConfig: (guildId: string) =>
			`[guild-event] no GuildConfig found for guild ${guildId}, kvkSeasonEnd not persisted; run /setup first`,
		// Logged when the prior-season soft-delete pass in configureKvKSeason
		// fails for a specific event. Does not abort the season setup,
		// leaving one stale duplicate is less harmful than failing to
		// configure the new season at all.
		priorKvkDeleteFailed: (guildId: string, eventId: string) =>
			`[guild-event] failed to soft-delete prior KvK event ${eventId} for guild ${guildId}; leaving it active and continuing with new season setup`,
	},

	// ── main / entry point ─────────────────────────────────────────────
	main: {
		commandLoadWarning: (filePath: string) =>
			`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`,
		autoSetupFailed: (guildId: string) => `Auto-setup failed for guild ${guildId}:`,
		noCommandMatch: (commandName: string) => `No command matching ${commandName} was found.`,
		commandExecuteError: (commandName: string) => `Error executing ${commandName}:`,
		autoSetupFailedSkipping: (guildId: string) => `Auto-setup failed for guild ${guildId}, skipping:`,
		readyBanner: (tag: string) =>
			"====================================\n" + `🤖 ${tag} is online and operational!\n` + "====================================",
	},

	// ── db ─────────────────────────────────────────────────────────────
	db: {
		missingUri: "[ERROR] MONGOOSE_URI environment variable is not set.",
		connected: "\n\n✅ Connected to MongoDB",
		// Connection lifecycle. Mongoose auto-reconnects by default; these just
		// make the transitions visible in Railway logs so a flaky Atlas link is
		// diagnosable instead of manifesting only as silent query timeouts.
		disconnected: "[db] ⚠️ MongoDB connection lost, Mongoose will attempt to reconnect",
		reconnected: "[db] ✅ MongoDB reconnected",
		connectionError: "[db] MongoDB connection error:",
		disconnecting: "[db] closing MongoDB connection",
	},

	// ── api ────────────────────────────────────────────────────────────
	api: {
		// port is typed as `string | number` upstream (env var may be a string literal,
		// config fallback is a numeric literal), so both are accepted here. template
		// interpolation coerces either into the rendered output cleanly.
		serverRunning: (port: number | string) => `API server running on port ${port}`,
		errorFindingEvents: "\n\nerror occurred finding events ==>",
		errorFindingEvent: "\n\nerror occurred finding event ==>",
		errorCreatingEvent: "\n\nerror occurred creating event ==>",
		errorUpdatingEvent: "\n\nerror occurred updating event ==>",
		errorDeletingEvent: "\n\nerror occurred deleting event ==>",
		errorTestReminder: "\n\nerror occurred firing test reminder ==>",
		errorFindingLeaderboard: "\n\nerror occurred finding leaderboard ==>",
		errorFindingReminders: "\n\nerror occurred finding reminders ==>",
		errorFindingPlayers: "\n\nerror occurred finding players ==>",
		errorFindingPlayerActivity: "\n\nerror occurred finding player activity ==>",
		// callers append this to the error log so the original \n\nerror X ==> ... \n\n wrap is preserved.
		errorSuffix: "\n\n",
	},

	// ── deploy commands script ─────────────────────────────────────────
	deploy: {
		commandLoadWarning: (filePath: string) =>
			`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`,
		missingCredentials: "[ERROR] Missing required environment variables: DISCORD_CLIENT_ID or DISCORD_TOKEN.",
		missingGuildId: "[ERROR] Missing DISCORD_GUILD_ID, required for development guild-scoped deployment.",
		refreshing: (count: number, scope: "GLOBAL" | "GUILD") => `Refreshing ${count} application (/) commands [${scope}]...`,
		globalSuccess: (count: number) => `Successfully reloaded ${count} global application (/) commands.`,
		globalPropagationNote: "Note: global commands can take up to 1 hour to propagate across all servers.",
		guildSuccess: (count: number) => `Successfully reloaded ${count} guild application (/) commands.`,
	},

	// ── activity tracking ──────────────────────────────────────────────
	activity: {
		reactionError: "Reaction tracking error:",
		voiceError: "Voice tracking error:",
		presenceError: "Presence tracking error:",
	},

	// ── leveling ───────────────────────────────────────────────────────
	// Every console line the leveling system emits. Note what is NOT here and
	// never will be: any message content, any word count, any per message log at
	// all. Message xp is awarded WITHOUT reading message text, and a log line
	// that quoted one would reintroduce the privacy surface the whole design
	// avoids by not requesting the MessageContent intent.
	leveling: {
		// ── the write path ──
		flushFailed: (guildCount: number) => `[leveling] flush of ${guildCount} pending member(s) failed:`,
		// Buffered xp lost on a hard crash is bounded by the flush interval and is
		// accepted. This fires only when the graceful path itself failed, which
		// means a redeploy really did drop awards and an operator should see it.
		shutdownFlushFailed: "[leveling] flushNow during graceful shutdown failed, buffered xp for this window is lost:",
		awardFailed: (source: string, guildId: string) =>
			`[leveling] award from source ${source} failed for guild ${guildId}, swallowed:`,
		// Two concurrent upserts on a missing row race and one loses. Expected and
		// recovered by a single retry, so this is a debug-level breadcrumb rather
		// than a problem, and it only becomes interesting if it repeats.
		upsertRaced: (guildId: string, userId: string) =>
			`[leveling] duplicate key upserting ${userId} in guild ${guildId}, retrying once`,
		upsertRetryFailed: (guildId: string, userId: string) =>
			`[leveling] retry after duplicate key still failed for ${userId} in guild ${guildId}:`,

		// ── announcements ──
		announceChannelMissing: (channelId: string, guildId: string) =>
			`[leveling] announce channel ${channelId} not found or not a TextChannel for guild ${guildId}`,
		// The failure that is otherwise INVISIBLE to an admin: the bot is in the
		// channel, the feature is on, and nothing ever posts. Named permissions so
		// the fix is in the log line rather than a support conversation.
		announceMissingPermissions: (channelId: string, guildId: string, missing: string) =>
			`[leveling] cannot announce in ${channelId} for guild ${guildId}, missing: ${missing}`,
		announceFailed: (guildId: string) => `[leveling] level up announcement failed for guild ${guildId}:`,
		reactionFailed: (guildId: string) =>
			`[leveling] could not add the congratulations reaction for guild ${guildId} (likely missing AddReactions):`,
		adminNoticeFailed: (guildId: string) => `[leveling] first level up admin notice failed for guild ${guildId}:`,

		// ── role rewards ──
		// Logged ONCE per guild plus role, never once per member: a large guild
		// crossing a broken reward would otherwise write the same line thousands of
		// times into Railway's log and bury everything else.
		rewardHierarchy: (roleId: string, guildId: string) =>
			`[leveling] cannot grant reward role ${roleId} in guild ${guildId}: it sits at or above the bot's highest role. Administrator does NOT bypass role hierarchy. Not retrying.`,
		rewardManaged: (roleId: string, guildId: string) =>
			`[leveling] reward role ${roleId} in guild ${guildId} is managed by an integration and can never be assigned by a bot. Not retrying.`,
		rewardRefusedPrivileged: (roleId: string, guildId: string) =>
			`[leveling] REFUSING reward role ${roleId} in guild ${guildId}: it carries Administrator or Manage Server. A leveling bot handing out admin because someone chatted a lot is a security incident, not a bug.`,
		rewardRoleDeleted: (roleId: string, guildId: string) =>
			`[leveling] reward role ${roleId} no longer exists in guild ${guildId}, removing it from the config`,
		rewardFailed: (guildId: string) => `[leveling] role reconcile failed for guild ${guildId}:`,

		// ── boards, sweeps and achievements ──
		boardChannelMissing: (channelId: string, guildId: string) =>
			`[leveling] leaderboard channel ${channelId} not found or not a TextChannel for guild ${guildId}`,
		boardStoredMessageDeleted: (messageId: string, guildId: string) =>
			`[leveling] stored levelsMessageId ${messageId} was deleted for guild ${guildId}. reposting.`,
		boardEditFailed: (messageId: string, guildId: string) =>
			`[leveling] failed to edit levelsMessageId ${messageId} for guild ${guildId}:`,
		boardStaleAuthor: (messageId: string, guildId: string) =>
			`[leveling] levelsMessageId ${messageId} in guild ${guildId} is not authored by this bot. skipping, ScheduleBoard owns homebase recovery.`,
		boardPostFailed: (guildId: string) => `[leveling] failed to post the levels board for guild ${guildId}:`,
		hourlyRefreshFailed: "[leveling] hourly refreshAllLevelsBoards failed:",
		voiceSweepFailed: (guildId: string) => `[leveling] voice sweep failed for guild ${guildId}:`,
		achievementFailed: (guildId: string, userId: string) =>
			`[leveling] achievement evaluation failed for ${userId} in guild ${guildId}, swallowed:`,
	},

	// ── ready / startup ────────────────────────────────────────────────
	ready: {
		loggedInAs: (tag: string) => `\n\nReady! Logged in as ${tag}\n`,
	},
} as const;
