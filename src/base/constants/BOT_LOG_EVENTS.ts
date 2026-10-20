export const BOT_LOG_EVENTS = {
	INTRO_DM_SENT: "intro_dm_sent",
	SEASON_END_ANNOUNCED: "season_end_announced",
	// ── feature announcement idempotency ──────────────────────────
	// What:  per-guild log that a specific version's feature announcement
	//        has already been posted. The log `event` string is composed
	//        at call time as `feature_announced:<version>` so each release
	//        gets its own bucket. Querying botLogStore.has(guildId,
	//        "feature_announced:1.2.4") tells us whether this guild has
	//        already seen the 1.2.4 announcement.
	// Who:   postFeatureAnnouncement reads + writes. No other caller.
	// When:  read once per boot per guild; written once per successful
	//        public + inner-sanctum post pair.
	// Where: lives in the same BotLog collection as INTRO_DM_SENT so
	//        the idempotency model is consistent across features.
	// How:   prefix constant here + template helper below keeps call
	//        sites symmetric and grep-able. Concatenating the version in
	//        the event string avoids adding a new schema field for
	//        lastAnnouncedVersion.
	FEATURE_ANNOUNCED_PREFIX: "feature_announced",
	// ── auto-leave (v1.5.1 item 9, 2026-05-12) ─────────────────────
	// Logged once per guild when the bot decides to leave a guild it
	// cannot serve because category creation kept failing with
	// DiscordAPIError 50013 (Missing Permissions) past the 7-day grace
	// period. Metadata captures the failure-state duration and whether
	// the owner DM landed. Read for audit when an operator wonders
	// why the bot is no longer in a guild they previously invited.
	AUTO_LEFT_GUILD: "auto_left_guild",
	// ── Discord Onboarding compat (FUTURE_PLANS item 35, 2026-05-22) ─
	// One-shot DM to the guild owner when Onboarding is enabled AND the
	// bot's homebase category is not in the server's default channels.
	// Without the heads-up, new members never see the bot's channels
	// because Onboarding hides everything not in the default list until
	// the member opts in via Channels & Roles. Logged once per guild so
	// every restart does not re-nag.
	ONBOARDING_HEADSUP_SENT: "onboarding_headsup_sent",
	// ── pairing code DM (FUTURE_PLANS item 63, 2026-06-10) ─────────
	// Logged each time the guild owner is DM'd a one-time claim code on
	// guildCreate (both the fresh-install and re-install branches). Paired
	// with PAIRING_REDEEMED (added in Phase 2) it yields the activation funnel:
	// redemption rate = redeemed / sent, and time-to-redeem from the row
	// timestamps. Not idempotent on purpose: every invite issues a new code and
	// logs a new row.
	PAIRING_CODE_SENT: "pairing_code_sent",
	// ── pairing code redeemed (FUTURE_PLANS item 63, Phase 2, 2026-06-10) ─
	// Logged once when the platform server successfully redeems a code through
	// POST /api/pairing/redeem. Closes the activation funnel: redemption rate
	// is rows-with-PAIRING_REDEEMED divided by rows-with-PAIRING_CODE_SENT
	// for the same guildId, and time-to-redeem is the createdAt delta between
	// the two. Not idempotent on purpose: every successful redemption logs a
	// fresh row, so a re-invite that issues a new code and gets redeemed
	// again shows up as a second redemption (the funnel measures activation
	// events, not unique guilds). Metadata shape matches PAIRING_CODE_SENT,
	// `{ ownerId }` (sourced from the PendingPairing row's ownerUserId
	// field but keyed `ownerId` for cross-event funnel queries), so the
	// analytics query that joins the two events on guildId can also slice
	// by ownerId without translating field names per event type.
	PAIRING_REDEEMED: "pairing_redeemed",
	// ── audience poll dispatch idempotency (v1.6 Phase 3, item 34a) ─
	// What:  per-guild log that a specific audience poll has already been
	//        broadcast to the guild's announcements channel. The log `event`
	//        string is composed as `poll_sent:<pollId>` so each poll gets its
	//        own bucket and a redeploy does not repost a poll the guild has
	//        already received.
	// Who:   PollDispatcher reads (skip already-sent) and writes (after a
	//        successful post). No other caller.
	// When:  read once per active poll per guild per boot; written once per
	//        successful poll post.
	// How:   prefix constant + template helper below, same pattern as the
	//        feature-announcement key, so call sites stay symmetric and the
	//        pollId rides in the event string without a new schema field.
	POLL_SENT_PREFIX: "poll_sent",
	// ── game room lifecycle (Game Rooms Phase 1) ───────────────────
	// What:  the open and close bookends of one game room. The log `event`
	//        strings are composed as `game_room_created:<roomId>` and
	//        `game_room_archived:<roomId>` so each room gets its own bucket.
	// Who:   RoomProvisioner writes the created row; the archive sweep and
	//        the Archive now button write the archived row through the one
	//        shared delete path. Nothing reads them on the hot path.
	// When:  once per room open, once per room archive. Unlike the
	//        announcement keys these are NOT read for idempotency, because
	//        the partial unique index on GameRoom already guarantees one
	//        live room per host. They exist for AUDIT: paired on roomId they
	//        give room lifetime, archive latency against the 4 hour target,
	//        and how often an admin deleted a room channel early (an
	//        archived row whose channel was already gone).
	// Where: same BotLog collection as every other bot-side event, so the
	//        audit model stays consistent across features.
	// How:   prefix constant + composer below, matching featureAnnouncedEvent,
	//        so the roomId rides in the event string with no new schema field.
	GAME_ROOM_CREATED_PREFIX: "game_room_created",
	GAME_ROOM_ARCHIVED_PREFIX: "game_room_archived",
	// ── leveling introduction notice (leveling Phase 2) ────────────
	// What:  per-guild log that the one time "leveling is now live here" notice
	//        has been posted to the guild's admin channel.
	// Who:   levelUpAnnouncer reads it before the FIRST level up it ever handles
	//        in a guild, and writes it once the notice actually posts.
	// When:  read once per guild per process, on the first crossing only; after
	//        the row exists the read is skipped entirely by an in-memory guard,
	//        so this is not a per level up query.
	// Where: this exists because of the owner's decision that leveling ships ON
	//        in every guild with no opt in. Without it, some admin meets the
	//        feature for the first time when a member asks them what the new
	//        messages in #announcements are. With it, they meet it through a
	//        message that names /setup-level-system and says how to turn it off.
	// How:   a plain per-guild key rather than a prefixed one: unlike the version
	//        and poll keys there is nothing to namespace, the notice fires once
	//        per guild for the life of the feature.
	LEVELING_INTRO_SENT: "leveling_intro_sent",
	// ── Dero brain audit (Dero voice plan, Phase 2a) ───────────────
	// What:  one row per brain job the bot acted on (ACTION), and one row per
	//        brain result the bot threw out whole (REJECTED).
	// Who:   /dero tell writes ACTION after the executor ran; the /brain/result
	//        route writes REJECTED when parseBrainResult refuses a body.
	// When:  ACTION once per answered job, REJECTED once per refused body. Both
	//        are fire and forget: a failed audit write never changes a reply.
	// Where: AUDIT ONLY, never read on a hot path.
	//
	// ⚠️ PRIVACY: metadata carries ids, lengths, outcome codes and durations, and
	// NEVER the member's task text or anything the brain wrote.
	DERO_BRAIN_ACTION: "dero_brain_action",
	DERO_BRAIN_REJECTED: "dero_brain_rejected",
	// ── Dero voice call audit (Dero voice plan, Phase 3a) ──────────
	// What:  the two bookends of one voice session: JOINED when the connection
	//        first reached Ready, LEFT when the session ended for any reason.
	// Who:   voiceSessions writes both through its injected audit dep. Nothing
	//        reads them on a hot path.
	// When:  once per session each. Fire and forget, like the brain rows.
	// Where: paired on guildId and channelId they give time to Ready (the spike's
	//        number), session length, reconnect count and why a session ended.
	//
	// ⚠️ PRIVACY: ids, durations, counts and reason codes only. No row ever
	// carries audio or spoken text.
	DERO_VOICE_JOINED: "dero_voice_joined",
	DERO_VOICE_LEFT: "dero_voice_left",
	// ── Dero voice turn audit (Dero voice plan, Phase 3b) ──────────
	// What:  one row per utterance the turn loop transcribed: its outcome code,
	//        the speaker id, the audio length, the transcript LENGTH, and the
	//        four latency numbers the owner reads at Gate B.
	// Who:   turnLoop, fire and forget. Nothing reads it on a hot path.
	//
	// ⚠️ PRIVACY: ids, milliseconds, byte and character counts and outcome codes
	// only. Never the audio, never the transcript, never what Dero answered.
	DERO_VOICE_TURN: "dero_voice_turn",
	// add more here as needed
} as const;

// Compose the per-version feature-announced event key. Kept next to the
// prefix constant so a future change (eg. adding environment tagging)
// lands in one place.
export const featureAnnouncedEvent = (version: string): string =>
	`${BOT_LOG_EVENTS.FEATURE_ANNOUNCED_PREFIX}:${version}`;

// Compose the per-poll dispatch event key. Mirrors featureAnnouncedEvent so the
// idempotency model stays consistent across broadcast features.
export const pollSentEvent = (pollId: string): string => `${BOT_LOG_EVENTS.POLL_SENT_PREFIX}:${pollId}`;

// Compose the per-room lifecycle event keys. Same shape as the two above, so an audit query
// can slice BotLog by prefix across every feature that logs per-entity events.
export const gameRoomCreatedEvent = (roomId: string): string => `${BOT_LOG_EVENTS.GAME_ROOM_CREATED_PREFIX}:${roomId}`;

export const gameRoomArchivedEvent = (roomId: string): string => `${BOT_LOG_EVENTS.GAME_ROOM_ARCHIVED_PREFIX}:${roomId}`;
