# ROK Commander bot: session handoff (2026-06-18)

> **UPDATE 2026-06-29:** v1.6.0 has SHIPPED to production (Railway) and the v1.6.0 feature announcement fired. Everything below that says "Nothing is deployed" or "package.json 1.5.2" is historical, accurate only as of 2026-06-18; production `package.json` is now 1.6.0 and new bot fixes target **v1.6.1**. A v1.6.0 power-up bug was found and fixed this session: the "Toggle pings" button toggled `config.memberRoleId` (stripping a member's verified-member role) instead of a dedicated role; `runToggleNotificationRole` now resolves or lazily creates `config.notificationsRoleId` and toggles that, leaving `memberRoleId` untouched. Still open (deferred): wire `notificationsRoleId` into `ReminderJob` plus `announce.routes` so opting in actually receives pings (FUTURE_PLANS item 36).

Covers the v1.6 release build plus a batch of post-build refinements and an in-progress copy-pack migration. All work is in the `DeroDiscordBot` repo (its own git repo, separate from the other company-uno packages).

## State at a glance

- **Branch:** `post-launch-backlog` (the bot's active line; it is ~30+ commits ahead of `staging`, which is stale, do NOT commit bot work to `staging`).
- **Pushed:** yes. `origin/post-launch-backlog` is current; 0 unpushed commits.
- **Type-check:** `npx tsc --noEmit` is clean. (As of this session the bot `CLAUDE.md` rule 2 allows `tsc --noEmit` in code mode; `npm run build` and deploys stay owner-run.)
- **Tests:** `npx vitest run` → 15 failed / 97 passed. **The 15 failures are PRE-EXISTING** brittle mocks (verified against the pre-session commit `8dbc0bf`): `GuildSetupManager.test.ts`, `ChannelDeleteWatcher.test.ts`, one `scheduleBoardEmbed` layout test in `embedBuilder.test.ts`. They are unrelated to this session's work, do not chase them as regressions.
- **Nothing is deployed.** Production still runs the pre-session build.

## This session's commits (oldest first, all on `post-launch-backlog`)

v1.6 release roadmap (`TODO-PLANS/bot-v1.6-release-roadmap.md`), five phases:
- `ca9276c` P1, configurable per-guild leaderboard week start + `/configure-leaderboard-week-start`
- `f2539a0` P2, auto-refreshing weekly LeaderboardBoard (+ `leaderboardWindow.test.ts`)
- `067f678` P3, reusable audience poll dispatcher (later parked, see below)
- `4d19eca` P4, event image rendering in embeds (bot half)
- `2a0e5a2` P5, pinned channel power-up panels

Post-build refinements (owner-directed):
- `b46e09d`: power-up redesign: schedule controls moved onto the schedule board as a phase-gated Go Live + Pause/Resume toggle; renamed the next-decree channel to `🔜upcoming-events`; **parked the audience poll** (`ACTIVE_POLLS = []`, dispatcher dormant)
- `13e4b66`: owner-only homebase self-destruct (command + button + confirm)
- `9c74e56`: **auto-heal bug fix**: a missing/deleted schedule message no longer makes `ensureHomebase` rebuild a duplicate homebase (ownership probe is now tri-state owned/foreign/unknown; rebuild only on genuinely foreign)
- `ca76b87`: neutralized the schedule board copy so non-ROK servers see no kingdom voice
- `ed5c6a0`: bot `CLAUDE.md` rule 2: allow `tsc --noEmit` in code mode
- `407f42e`: moved the self-destruct button onto the pinned admin command guide; dropped the separate danger-zone power-up panel
- `de691eb`: announcement-ping opt-in is now a real mentionable `🔔 Announcements` role (toggled in place), replacing the write-only `pingSubscribers` array
- `1dbb2fd`: pack wiring sub-phase 2a (see below)
- `1a9e400`: pack wiring sub-phase 2b (see below)

## IN PROGRESS: plugin-pack wiring migration

**Goal:** route every embed through `getPluginCopy(guildConfig)` so a guild whose `pluginId !== "rok-commander"` renders the neutral `general-events` pack, while ROK guilds keep kingdom voice. This is the migration the bot `CLAUDE.md` explicitly deferred (~96 `embedContent.*` call sites). Owner chose this over a blanket neutralization.

**Phased plan (1, 2a, 2b done; 3, 4, 5 remain):**
1. **DONE**: Complete `general-events`. No work needed: every remaining `STUB` in `general-events.pack.ts` is KvK-only (`seasonEnd`, `seasonEnded`, `configureReminders`, `kvkConfirmation`, `kvkConfigured`), surfaces a non-ROK guild never reaches. Confirmed clean of ROK vocab in live copy.
2a. **DONE `1dbb2fd`**, Every `embedBuilder.ts` function takes an optional `guildConfig` and resolves copy via `getPluginCopy(guildConfig)`; defaults to the rok-commander fallback so untouched callers are unaffected. `base()` is pack-aware too.
2b. **DONE `1a9e400`**, Threaded `guildConfig` into the guild-facing callers: `ScheduleBoard.refreshSchedule`, `LeaderboardBoard.refreshLeaderboard`, `ReminderJob.fireReminder`, `/list-events`, `TestReminderJob`, `/leaderboard` (config load hoisted). `arrivalEmbed`/`pairingCodeEmbed` (fire on guildCreate before `pluginId` is known) and the KvK-only `kvkConfirmationEmbed`/`seasonEndEmbed` intentionally keep the rok-commander default.
3. **TODO**: Handler `embedContent.X` direct reads. Mostly `getPluginCopy(config).responses.*` for ephemeral admin replies. The generic `errorEmbed`/`infoEmbed` calls do NOT leak ROK (they only use `base()` + passed-in strings), so only the calls that pass ROK-voiced `responses.*` strings need threading. Per-handler; config is usually already loaded.
4. **TODO (big, sensitive)**: `ChannelContent.ts` (14 channel-intro methods, all reading `embedContent.channelContent`/`.COLORS`/`.responses`) + ~20 call sites in `GuildSetupManager.ts` (`resolveIntroComponents`/`resolveIntroEmbed`, `populateChannels`, `refreshIntroEmbeds`, `repairOneChannel`, `applyAdminRole`, repair-notice posts). Pattern: each method gains `guildConfig`; `refreshIntroEmbeds`/`repairOneChannel` pass the loaded `stored` config; `populateChannels` (new guild) can pass `undefined` (rok-commander default is correct for a fresh guild). This is the same file where the auto-heal fix and self-destruct landed, do a careful, fresh pass + `tsc` + suite + adversarial review.
5. **TODO**: Retire the `src/base/constants/embed-content.ts` shim once nothing imports it.

**KEY GAP (owner is aware):** there is NO way to set a guild's `pluginId` to `general-events`. The plugin-install flow (Phase 2 of the streamer-plugin spec) was never built, and `pluginId` defaults to `rok-commander`. So the wiring is correct plumbing but **changes nothing in practice until a setter exists**, every guild still renders rok-commander. To TEST the wiring, set a guild's `pluginId` to `general-events` directly in Mongo. Building a real setter (owner/platform-owner command, or wiring it into pairing/install) is a separate later task the owner deferred.

## Open items NOT started

- **Additional v1.6 features** the owner wants to add to this push (scope not yet given, ask).
- **v1.6 release announcement.** A first draft was rejected ("not it"); rewrite from scratch once the full push scope is final. It goes in BOTH packs' `featureAnnouncement` (rok-commander public+inner, general-events public+inner), no em-dashes. Bumping `package.json` 1.5.2 → 1.6.0 fires it once per guild on next boot, owner-driven (do not auto-bump; it broadcasts to every guild).
- **Polls v2:** the boot audience poll is parked. Owner wants a `/poll` slash command instead, possibly with a dedicated polls channel. Not started.
- **FUTURE_PLANS cleanup:** move item 35 (Discord Onboarding compat, already shipped) to HISTORICAL; retire item 32 (Herald rename, superseded by the Dero rebrand).
- **`pluginId` setter** (see KEY GAP above).

## Release / deploy checklist (owner-driven, NONE done)

1. `cd DeroDiscordBot && npm run build` (owner runs; agent only does `tsc --noEmit`).
2. `npm run deploy`: required to register the new slash commands `/configure-leaderboard-week-start` (P1) and `/self-destruct`. Other phases added no commands.
3. Railway deploy is manual/owner-initiated.
4. Verify in the test guild `910668785856413707` before bumping the version: each phase's acceptance, the no-image reminder regression, and a legacy-guild boot sweep.
5. Bump `package.json` to 1.6.0 only when ready (fires the announcement).

## Gotchas for whoever resumes

- Commit bot work on `post-launch-backlog`, never `staging` (stale, 24+ commits behind).
- `npx tsc --noEmit` is the standard verification (allowed in code mode); run it after changes. Do not run `npm run build`/`tsc-alias`/deploys.
- discord.js v14.25.1: a shared-message button label cannot be per-user (this is why announcement-ping state is conveyed via the ephemeral reply, not the label); `message.edit` must pass embeds AND components or buttons drop.
- The self-destruct button appears on an EXISTING guild's admin command guide only after that message's next repost (a copy change or a `/setup` rebuild). New setups get it immediately.
- Memory file `bot-v16-release-progress.md` (in the agent memory dir) has the running detail and mirrors this handoff.
