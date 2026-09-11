# ROK Commander bot v1.6 release roadmap

> **Reconciliation owed, added 2026-09-11.** This plan sits in `TODO-PLANS/` because its checklist is not reconciled, not because the work is missing.
> An audit on 2026-09-10 verified **5 of 5 phases** at the live call site rather than from this document.
> It carries **no checklist at all**, so the first unit of work here is writing one, then ticking it against the code.
> A plan is complete only when every box is ticked AND every tick is accurate, at which point it moves to `COMPLETED-PLANS/` (`CLAUDE.md`, "A PLAN LIVES IN EXACTLY ONE OF TWO FOLDERS").

Execution roadmap and handoff for the next bot release. Scoped 2026-06-17. Five features, one per phase, ordered smallest and safest first, biggest last. An implementer should be able to code each phase straight from this.

## What is in this release

1. Phase 1: Configurable leaderboard week start (FUTURE_PLANS item 17).
2. Phase 2: LeaderboardBoard, an auto refreshing leaderboard pinned in the channel (item 13).
3. Phase 3: Audience poll dispatcher (item 34a).
4. Phase 4: Event image rendering in embeds, the bot half of the media attachments feature.
5. Phase 5: Channel power-up pattern, buttons on every homebase channel (item 36).

## What was dropped and why (do not build these)

- Item 35 Discord Onboarding compatibility is ALREADY SHIPPED. `src/features/setup/OnboardingCheck.ts` implements the whole flow (`fetchOnboarding`, the default channels check, the one time owner DM, idempotency via `BOT_LOG_EVENTS.ONBOARDING_HEADSUP_SENT`) and `main.ts` calls `checkOnboardingAndNotifyOwner` at lines 185, 228, and 458. It just needs moving to HISTORICAL in FUTURE_PLANS.
- Item 32 Herald rename is superseded. The bot already presents as "Dero" (embed author) with a "Company Uno" footer, set in `rokCommanderCopy.AUTHOR` and `.FOOTER` in `src/base/copy/packs/rok-commander.pack.ts`. The only literal "ROK Commander" strings left are two outage DM titles in `src/features/observability/outageWatcher.ts` (ops messages to the platform owner), one pairing DM that names the dashboard panel, and one in character line in the ROK pack. The package name and the Discord app display name are the only remaining rename targets, and those are manual portal and Railway steps, not code. "Herald" also now collides with "Dero," so the target is obsolete. Retire item 32.

## Repo and conventions

- Repo: `C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot`. TypeScript, discord.js v14.25.1, Mongoose. Deployed to Railway, manual deploy.
- The `"rok-commander"` string is the copy pack identifier (`PluginId`, `GuildConfig.pluginId`, the packs registry). It names the pack content, not the bot identity. Do NOT rename it.
- Per guild state lives on `GuildConfig` (`src/db/models/GuildConfig.ts`). New message id anchors mirror the existing `scheduleMessageId` and `introMessageIds` patterns.
- One shot actions are made idempotent via `botLogStore` plus a `BOT_LOG_EVENTS` constant (`src/base/constants/BOT_LOG_EVENTS.ts`).
- Buttons route through `interactionRegistry` (`registerButton(prefix, handler)` plus `dispatchButton`), customId format `prefix:arg1:arg2`. The `InteractionCreate` listener and handler registration live in `main.ts` (dispatch around line 250, registration around line 244).
- Owner or admin gating pattern (from `main.ts` lines 319 to 355): `isOwner = interaction.user.id === guild.ownerId`, else check `member.roles.cache.has(config.adminRoleId)`. Reused in `src/features/schedule/ScheduleControls.ts`.
- Pinned board pattern to mirror: `src/features/schedule/ScheduleBoard.ts` (`postOrEdit`, `refreshSchedule`, message id stored in `GuildConfig.scheduleMessageId`, post and pin on first run, edit in place after, repost on 404).
- discord.js gotcha: `message.edit` must pass BOTH `embeds` and `components` or the buttons silently drop.
- No em-dashes anywhere in copy or comments. Both packs (`rok-commander`, `general-events`) need parallel copy for any new user facing string.

---

## Phase 1: Configurable leaderboard week start (item 17)

Goal: let each guild anchor the leaderboard "this week" window to Sunday or Monday, and state the boundary in the embed so it is never ambiguous. Smallest phase, ship it first.

Files:

- `src/commands/admin/leaderboard.ts`: `thisWeekRange()` at line 55 is hardcoded Sunday anchored, called at line 138.
- `src/db/models/GuildConfig.ts`: add the preference field.
- `src/utils/embedBuilder.ts`: `leaderboardEmbed` (around line 295) for the title.

Steps:

1. Add `GuildConfig.weekStart: { type: String, enum: ["sunday", "monday"], default: "sunday" }`. Per guild, not per user. The per user preference that FUTURE_PLANS coupled this to (item 16 timezone) does not exist, so do not block on it; per guild is the right scope for a community bot.
2. `thisWeekRange(guildConfig)` reads `weekStart` and computes the window boundary accordingly. Default Sunday keeps current behavior.
3. The leaderboard embed title carries the boundary explicitly: "This week (Sun to Sat)" or "This week (Mon to Sun)".
4. Setting the value: for v1, expose it through the Phase 5 schedule or leaderboard power-up, or a thin `/configure` option. Minimally, default sunday and allow an admin to flip it. Do not over build a settings surface here.

Acceptance: a guild set to monday sees the leaderboard "this week" run Monday to Sunday with a title that says so; default guilds are unchanged.

Estimate: one to two hours.

---

## Phase 2: LeaderboardBoard, auto refreshing leaderboard (item 13)

Goal: a pinned message in the leaderboard channel that shows standings and refreshes itself, so members see the leaderboard without running `/leaderboard`. `leaderboard.ts` already anticipates this ("a LeaderboardBoard module will ... until LeaderboardBoard lands").

Files:

- New `src/features/leaderboard/LeaderboardBoard.ts`, mirroring `src/features/schedule/ScheduleBoard.ts`.
- `src/db/models/GuildConfig.ts`: add `leaderboardMessageId`, mirroring `scheduleMessageId`.
- `src/db/stores/activityStore.ts`: the standings data source.
- `src/commands/admin/leaderboard.ts`: reuse the aggregation and `thisWeekRange` (now weekStart aware from Phase 1).
- `src/utils/embedBuilder.ts`: reuse or extend `leaderboardEmbed`.
- `src/features/reminders/ReminderScheduler.ts` and `ReminderJob.ts`: the post fire refresh trigger.
- `main.ts`: the boot sweep (around lines 430 to 539) where `ScheduleBoard` refreshes on boot.

Steps:

1. Add `GuildConfig.leaderboardMessageId: { type: String, default: null }`.
2. New module exporting `refreshLeaderboard(client, guildId)`: resolve the leaderboard channel via `GuildConfig.leaderboardChannelId`, aggregate `activityStore` standings (honoring Phase 1 weekStart), build the embed, then post and pin on first run or edit in place after via the stored `leaderboardMessageId`. Repost and update the id on a 404. Mirror `ScheduleBoard.postOrEdit`.
3. Refresh triggers (locked design from item 13): after `ReminderScheduler` fires a real reminder; after `activityStore` writes a reaction or voice session row, debounced 60 seconds per guild so a flurry does not produce dozens of edits; once per boot via the ensureHomebase sweep so a long offline bot is not stale.
4. v1 scope: a single all events aggregate board (simplest, right for streamers). Keep showing historical standings even when leaderboard tracking is toggled off, matching how `/leaderboard` behaves.

Acceptance: enabling leaderboard tracking yields a pinned board that updates within about a minute of activity, edits in place rather than spamming, survives a restart, and respects the Phase 1 weekStart.

Estimate: half a day to a day.

---

## Phase 3: Audience poll dispatcher (item 34a)

Goal: a reusable cross guild poll mechanism. First use is the edit in place versus new message intro question, but the dispatcher is built to be reused for future audience questions.

Files:

- New `src/features/polls/PollDispatcher.ts`.
- New `src/db/models/PollResult.ts` plus a store under `src/db/stores/`.
- `src/features/announcements/postFeatureAnnouncement.ts`: the guild iteration pattern to mirror.
- `src/db/models/GuildConfig.ts`: `announcementsChannelId` is where polls post.
- `src/base/constants/BOT_LOG_EVENTS.ts`: add a `POLL_SENT_PREFIX` for idempotency.

Steps:

1. New `PollResult` collection: `{ pollId, guildId, userId, choice, createdAt }`, deduped per `(pollId, guildId, userId)`.
2. `PollDispatcher` iterates `GuildConfig` docs with a non null `announcementsChannelId` and posts a Discord native poll (the Poll component added to discord.js in 2024) with the question and options. Idempotent via a `poll_sent:<pollId>` bot log event so a redeploy does not repost.
3. First poll, per item 34a: the behavior attention probe first ("After your server's bot configuration changed, what do you think happened to the intro? A quietly updated, B posted new, C did not notice"), then the tradeoff probe only if awareness is non trivial.
4. Collect votes (via the poll vote gateway events or by reading the poll object), persist to `PollResult`, and add a small admin command or log line to read aggregates.

Gotcha: confirm discord.js v14.25.1 exposes the Poll API and vote collection. If vote collection is awkward, fall back to button voting routed through `interactionRegistry`, storing each press in `PollResult`.

Acceptance: a poll posts once to every eligible guild, votes record and dedupe, results are readable, and the dispatcher is reusable for the next question.

Estimate: half a day.

---

## Phase 4: Event image rendering in embeds (thumbnail, bot half)

Goal: go live, decree, and reminder embeds render the event image so they stop posting as empty text. This is the bot half only. The upload UI, the image whitelist, and the platform card display are the client and server session, tracked in `TODO-PLANS/event-media-attachments-roadmap.md`. The two halves meet at the `imageUrl` field on the event create payload.

Files:

- `src/db/models/Event.ts`: add `imageUrl`.
- `src/features/events/event.types.ts`: `IGameEvent.imageUrl`.
- `src/db/stores/remoteEventStore.ts`: `RemoteEvent.imageUrl` plus hydration.
- The bot event create and update handler that receives the dashboard create through the proxy: accept and persist `imageUrl`, return it on GET.
- `src/db/models/GuildConfig.ts`: `defaultEventImageUrl`, the never empty fallback.
- Embed sites: `src/features/schedule/postGoLiveAnnouncement.ts` (around line 81), `src/features/schedule/NextUpBoard.ts` `tryPostDecree` (around line 190), `src/utils/embedBuilder.ts` `reminderEmbed` (around line 79, fired by `src/features/reminders/ReminderJob.ts` around line 29).

Steps:

1. Event model: `imageUrl: { type: String, default: null }`. `IGameEvent`: `imageUrl?: string | null`. `RemoteEvent`: `imageUrl: string | null`, preserved through hydration.
2. Accept `imageUrl` on event create and update; return it on reads.
3. `GuildConfig.defaultEventImageUrl: { type: String, default: null }`.
4. Resolution at each embed site: `const img = event.imageUrl ?? guildConfig.defaultEventImageUrl ?? null;`.
5. Style by post type (locked): go live and decree use `setImage` (large banner); reminders use `setThumbnail` (small corner). Guard `if (img)` so null is a clean no op and legacy events post unchanged.

Discord notes: image URLs must be public https; gifs animate when the URL ends in `.gif` and S3 serves `Content-Type: image/gif`; `setImage(null)` is safe.

Acceptance: an event created with an image renders a banner on go live and decree and a thumbnail on reminders; a gif animates; an event with no image and no default posts exactly as today.

Estimate: about one session. Depends on the client session sending `imageUrl` on the create payload; the bot phase works the moment that field arrives.

---

## Phase 5: Channel power-up pattern (item 36)

Goal: each homebase channel carries a pinned message with action buttons so the common actions are one click in Discord, no slash command required. The big phase; can land channel by channel.

Files:

- `src/handlers/interactionRegistry.ts`: `registerButton`, `dispatchButton`.
- `src/features/schedule/decreeEditHandlers.ts`: the customId plus handler pattern to mirror.
- `src/features/schedule/ScheduleControls.ts`: the `ActionRowBuilder` plus `ButtonBuilder` pattern, the permission gate, the embeds plus components edit rule.
- `src/features/leaderboard/leaderboardChannelHandlers.ts`: an existing channel button precedent (`lb-ch-del` prefix, Administrator gate).
- `src/db/models/GuildConfig.ts`: channel id fields (`leaderboardChannelId`, `scheduleChannelId`, `introChannelId`, `announcementsChannelId`, and the rest) plus new `powerUpMessageIds` and any new state (a ping subscriber list).
- Mirrored command logic: `src/commands/streamer/pause-schedule.ts`, `continue-schedule.ts`, the Phase 2 `refreshLeaderboard`, plus a new intro template and ping list.
- `main.ts`: the boot sweep and ensureHomebase where pinned messages are posted and repaired; `InteractionCreate` for routing.

Power-ups (per item 36):

- Leaderboard channel: "Refresh standings" calls `refreshLeaderboard` from Phase 2. Complements the auto board with a manual refresh.
- Schedule channel: "Pause" and "Continue" call the same logic as `pause-schedule` and `continue-schedule`, then `refreshSchedule`.
- Introductions channel: "Post intro template" posts a structured self introduction prompt for members.
- Announcements channel: "Subscribe to ping list" adds the member to a ping list (new `GuildConfig.pingSubscribers` array or a small store) so future announcements can mention opted in members.

Steps:

1. Add `GuildConfig.powerUpMessageIds` (nested object keyed by channel kind, mirroring `introMessageIds`) and any new state such as `pingSubscribers`.
2. Build one pinned power-up message per channel, each with an `ActionRow` of buttons. customId scheme `powerup:<channelKind>:<action>`. Register a single `registerButton("powerup", handler)` that routes by channel kind and action.
3. Gate owner or admin only actions (pause, continue, refresh) behind the existing `isOwner` or `hasAdminRole` check. Member facing actions (subscribe, post intro template) are open.
4. Post and repair the power-up messages in the ensureHomebase boot sweep, persisting message ids, mirroring how `ScheduleBoard` and the intro embeds are repaired.
5. Remember `message.edit` must pass embeds AND components or the buttons drop.

Acceptance: each homebase channel shows its pinned power-up message with working buttons; owner only actions deny non admins; the leaderboard refresh button updates the Phase 2 board; subscribe adds the member to the ping list; the messages survive a restart.

Estimate: two to three sessions. Shippable channel by channel if you want to land it incrementally.

---

## Release and ship (not a numbered phase)

1. Bump `package.json` version from 1.5.2 to 1.6.0. On the next boot, `postFeatureAnnouncement` fires the v1.6.0 announcement once per guild, idempotent via `featureAnnouncedEvent(version)`.
2. Write the v1.6.0 `featureAnnouncement` copy in BOTH packs (`rok-commander` public and inner, `general-events` public and inner), per the release announcement flow. Cover the live leaderboard board, channel buttons, event images, and the week start option. No em-dashes.
3. Verify in the test guild (910668785856413707) BEFORE bumping the version: each phase acceptance, plus the no image regression and the legacy guild boot sweep.
4. Typecheck and build the bot. Railway deploy stays manual and owner initiated.
5. This is a feature release, not a rename. Item 32 (Herald) is retired; the bot stays Dero and Company Uno in embeds.

## Gotchas checklist

- discord.js v14.25.1: `ActionRowBuilder` plus `ButtonBuilder`; customId `prefix:arg` routed via `interactionRegistry`; `message.edit` must include embeds AND components; `setImage` and `setThumbnail` need public https URLs; gifs animate via `.gif` plus `Content-Type: image/gif`; `setImage(null)` is safe.
- Idempotency: reuse `botLogStore` plus a `BOT_LOG_EVENTS` constant for one shot actions; the feature announcement is already idempotent per version.
- Per guild state lives on `GuildConfig`; mirror the `scheduleMessageId` and `introMessageIds` patterns for new message id anchors.
- The `"rok-commander"` pluginId string is the pack identifier and must NOT change.
- The boot sweep (ensureHomebase, refreshIntroEmbeds, board refreshes) is where pinned messages get posted and repaired; add the new board and power-up messages there.
- Announcements post new messages, never edit existing ones, except the pinned boards which edit in place by design.
- No em-dashes anywhere in copy.
- FUTURE_PLANS cleanup: move item 35 to HISTORICAL (shipped) and retire item 32 (superseded by the Dero rebrand).
