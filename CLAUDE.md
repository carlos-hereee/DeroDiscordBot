# Dero Discord Bot

## Owner
qwerty (97hernandez.c@gmail.com)
Portfolio: https://www.companyuno.com

## What this is
A Discord bot for Rise of Kingdoms alliances. TypeScript, ESM only, Discord.js v14, Mongoose on MongoDB Atlas, Express HTTP API for a dashboard.

Key domains under `src/features/`:

| Folder | Purpose |
|--------|---------|
| `setup/` | Auto builds the guild's home base (category + six channels) when the bot joins, then applies admin and member roles when `/setup` runs. |
| `events/` | Event data model, occurrenceCalculator (pure math), GuildEventManager (creates ROK KvK season events). |
| `reminders/` | ReminderScheduler (cron), ReminderJob (fires real reminders), TestReminderJob (dashboard test fires). |
| `schedule/` | ScheduleBoard, keeps a pinned message in the event-schedule channel in sync with active events. |
| `activity-tracking/` | Tracks voice minutes and reaction acks for participation scoring. **Answers "did this warrior show up for this KvK event".** Not to be confused with `leveling/`; see the warning below the table. |
| `leveling/` | XP, levels, prime-numbered milestones, role rewards and achievements. **Answers "how present is this member in this server over time".** `awardXp` is the ONLY public way to grant XP; every listener, game and admin command goes through it. Pure modules (`levelCurve`, `primeLevels`, `xpRules`, `achievementEngine`) carry no discord.js. |
| `university/` | Commander build lookups (talents, tree guides). |
| `game-rooms/` | A per match Discord channel with its own permission matrix, an append only transcript, and an archive clock. **A room is earned by DURATION, not head count**: hangman, coin flip, dice roll and rps get one; a blackjack table does not, because a hand takes a minute and runs in place on one edited message. `⚔️challenges` is where a match starts. |
| `greeter/` | Welcomes new members in the introductions channel on `guildMemberAdd` (a pack-voiced welcome framing + a random icebreaker from a ~500-question bank in `icebreakers.ts`), pinging the member. The intro power-up panel's admin "Say hello" button reuses the same `welcomeNewMember` flow on demand. |

**⚠️ TWO SYSTEMS MEASURE PRESENCE AND THEY ARE NOT THE SAME ONE.** `activity-tracking/` scores KvK EVENT PARTICIPATION into `PlayerActivity`, keyed `{ eventId, eventOccurrence, userId }`, and renders through `/leaderboard` and `LeaderboardBoard`. `leveling/` scores PRESENCE OVER TIME into `MemberLevel`, and renders through `/account`, `/levels` and `LevelsBoard`. Both boards live in the same `#leaderboard` channel and each embed states which question it answers. **Never fold one into the other:** leveling through `PlayerActivity` would need a fake `eventId` for "just chatting", which corrupts the participation score, `/leaderboard`, the dashboard players route and the pinned board simultaneously.

**⚠️ THERE ARE TWO `MessageReactionAdd` LISTENERS, ON PURPOSE.** `activity-tracking/ActivityTracker.ts` filters to ✅ on a stored `ReminderLog` and writes `PlayerActivity`; `leveling/reactionXp.ts` accepts any emoji on any message and writes `MemberLevel`. Both files carry a comment pointing at the other. Two listeners on one event reads as a bug on sight, and it is not one.

`src/api/` has middleware, routes, and the Express server. `src/db/` has Mongoose models and thin store wrappers. `src/base/` has constants and types.

**Introductions channel is member-writable.** Unlike the other homebase channels (members are read-only), the introductions channel lets `@everyone` send, so newcomers can answer the greeter's icebreaker (and satisfy a Discord Onboarding gate that requires posting in a channel before full access). New guilds get this from `GuildSetupManager.createChannels` (`introOverwrites`); guilds set up before the greeter shipped are migrated idempotently on boot by `ensureIntroChannelsWritable`. The welcome embed is pinned (intro added to `refreshIntroEmbeds`' `shouldBePinned`) so member chatter does not bury it.

## Game rooms

**Two managed categories, not one.** `/setup` builds 🪧 NOTICE BOARD with eight homebase channels and 🎮 ARCADE GAMES with `📋arcade-rules` and `⚔️challenges`. Every consumer that builds or repairs a channel resolves its parent from the spec's REQUIRED `categoryField`; an optional field with a `categoryId` default would let a games spec silently inherit the homebase category, which is risk R2 and produces duplicate channels with nothing thrown.

**A room is a per-match channel inside the arcade category**, created by `RoomProvisioner.open` and destroyed by the archive sweep. Its GameRoom row OUTLIVES it: the transcript is the product, the channel is only where it was played.

Invariants worth knowing before touching any of it:

- **`archiveAt` is written by `roomLifecycle.finish` and by nothing else.** That single-writer property is what makes the 5 minute sweep safe: a live match has a null `archiveAt` and is unreachable from the sweep's query however the clock behaves.
- **`roomLifecycle.finish` PERSISTS BEFORE IT LOCKS.** A crash between the two this way leaves a finished row and a still-writable channel, which the sweep cleans on schedule. The reverse would leave a locked channel on a row still marked playing, which the finished-only sweep never touches and no recovery path finds.
- **The lock is an `@everyone` SendMessages DENY, not the removal of a player's allow.** With no explicit deny, players fall through to the guild-wide base permission, which grants SendMessages in almost every server.
- **A public room spends exactly ONE `@everyone` overwrite**, never one per member. That is the difference between a room that works in a 5000 member guild and one that does not.
- **`roomTrail.postMove` sends FIRST, then appends.** A transcript row for a move nobody saw is unrecoverable; a missing row after a successful send is merely a gap.
- **One open room per host, enforced by a PARTIAL UNIQUE INDEX** over the non-terminal statuses, not by a Map. A Map dies on every Railway deploy; the index does not. A dead row therefore holds its host's one slot forever, which is why `ChannelDeleteWatcher` and the boot sweep both close abandoned rooms.
- **`secret.word` is server side only.** It reaches Discord in exactly one place, hangman's result line, after the round is over, and the dashboard route projects it away at the database.
- **The host does not guess their own hangman word.** Refused in both the button and the modal submit, because a modal is reachable without the button that opened it.
- **No bot can be an opponent, structurally.** The two ways into a match are a StringSelect the BOT populates and a Join button a bot cannot click. Do not add an `addUserOption` to a game: that is what made the old rejection string necessary, and the string is gone.

## Commands and scripts

```
npm install         # triggers postinstall (tsc + tsc-alias)
npm run build       # clean + tsc + tsc-alias
npm run development # nodemon on dist/, NODE_ENV=development
npm run deploy      # registers slash commands with Discord
npm test            # vitest, SINGLE run (this is `vitest run`)
npm run test:watch  # vitest in watch mode
npm run lint        # eslint over ./src, tests included
```

**Corrected 2026-08-08, verified against `package.json`.** This block previously listed `npm run test:run` and `npm run test:coverage`; NEITHER script exists, and it had `npm test` backwards as watch mode. The wrong name had already been copied into a spec doc before anyone ran it.

## Path aliases (tsconfig)

```
@utils/*     -> ./src/utils/*
@base/*      -> ./src/base/*
@api/*       -> ./src/api/*
@features/*  -> ./src/features/*
@commands/*  -> ./src/commands/*
@db/*        -> ./src/db/*
@handlers/*  -> ./src/handlers/*
```

`@handlers/*` was missing from this list until 2026-08-11 while being live in `tsconfig.json` the whole time and imported by `main.ts` (`@handlers/interactionRegistry.js`). A doc gap rather than a code one, but the kind that makes a reader invent a relative import.

`baseUrl` was deprecated in TypeScript 6.0; paths are declared relative to `tsconfig.json` directly.

Source files import with the `.js` suffix (`import { X } from "@features/foo/bar.js"`) because the bot is pure ESM with `moduleResolution: "bundler"`. Vitest resolves the suffix back to `.ts` via `vite-tsconfig-paths`.

## Critical invariants

1. Channel resolution is guild wide. Reminders post to `guildConfig.announcementsChannelId`. There is no per event channel override and the dashboard form must not reintroduce one.
2. Guild scoping is a security boundary. Missing `guildId` returns 400. A resource that exists but belongs to another guild returns 404, never 403 (prevents existence leakage).
3. Test reminder fires use `offsetMinutes: BOT_CONSTANTS.REMINDER_LOG_OFFSETS.TEST` (-2) as the sentinel so they do not collide with the compound unique index on real fires. They also use `allowedMentions: { parse: [], roles: [], users: [] }` so the role mention renders but does not actually ping.
4. The test fire route has a 60 second per event per guild cooldown enforced in memory in the route handler.
5. `fireReminder` pings `config.memberRoleId`. Fallback to `@here` only when the guild is a legacy config without a member role assigned.

## Schedule board

A pinned message in the `📅event-schedule` channel that reflects the live state of active events. One message per guild, anchored by `GuildConfig.scheduleMessageId`, edited in place.

Refresh triggers:

Event CRUD (`POST/PATCH/DELETE /api/events`), `GuildEventManager.configureKvKSeason`, every `fireReminder` call so "next occurrence" advances visibly, `announceSeasonEnd` to swap to the ended state, bot startup via `refreshAllSchedules(client)` in `main.ts`, and an hourly cron tick in `ReminderScheduler.startScheduler`.

Recovery: if the stored message was deleted by an admin, the next refresh reposts and updates the stored id. Pinning is best effort; a missing pin does not break the feature.

## Conventions and rules for working on this codebase

1. Never use dashes in chat replies (the owner's preference).
2. `npx tsc --noEmit` (type-check only, no emit) IS the standard verification in code mode: run it to catch compile errors before ending a session and fix what it reports. Do NOT run `npm run build`, `tsc-alias`, or anything that EMITS a build artifact or deploys (Railway, `npm run deploy`): the owner does those manually before deploy. `npm install` runs `tsc` via postinstall, so prefer writing files and asking the owner to install rather than running install yourself.
3. Comment complicated logic. Every non trivial branch, algorithm, invariant, or workaround should have an inline comment. Complex comments must answer the relevant 5Ws (Who, What, When, Where, How) adapted to code:
   - What: what this block does in one line
   - Who: which callers or downstream consumers are affected
   - When: the runtime conditions that make this branch execute (timing, state, inputs)
   - Where: how this piece fits into the surrounding system (upstream caller, downstream effect)
   - How: the mechanism or algorithm, especially when non obvious
   Not every comment needs all five. Function or module level comments should cover most of them. Inline comments on a single line can focus on the one or two that matter. Trivial wiring does not need comments; anything requiring a second read does. Match the existing voice: prose explanations, numbered steps (①②③) for multi phase functions, section markers (// ── Section ──) for major groups.
4. Tests live colocated next to the module (`src/features/events/occurrenceCalculator.test.ts` next to `occurrenceCalculator.ts`). Vitest picks them up via `src/**/*.test.ts`, and `tsconfig.json` excludes them so they never compile into `dist/`. **Eslint reads `tsconfig.eslint.json` instead** (same options, minus that exclusion) so tests are linted with the same rules as the code they cover. Do NOT merge the two: putting tests in `tsconfig.json` would ship test code to Railway. A helper deliberately kept but not yet used takes a leading underscore, which is what `no-unused-vars` is configured to treat as intentional.
5. When adding user facing copy that warriors see in Discord, route it through the rok-commander pack at `src/base/copy/packs/rok-commander.pack.ts`. Keep the medieval kingdom voice (castle, scroll, shield, "Summon New Event", "The kingdom rests"). Admin facing ephemeral copy can be more practical. New copy edits land in the pack file directly so they apply to anything reading via `getPluginCopy(guildConfig)`. (The legacy `embed-content.ts` back-compat shim was retired in Phase 5; brand-level constants, colors, footer, the Dero author, now live in `src/base/copy/brand.ts`.)
6. Stores (`src/db/stores/*`) are thin Mongoose wrappers. Business logic belongs in feature modules, not in stores. Do not test store methods.
7. Discord side effects in a feature should be fire and forget when they follow a successful primary action (for example, schedule refreshes after reminder fires). Log errors, never throw back into the caller.
8. The bot is ESM. All local imports must carry the `.js` suffix even though the source is `.ts`.

## Plugin copy packs (streamer-plugin spec Phase 1)

The bot's user-facing strings live in plugin-scoped packs under `src/base/copy/`. Two ids are reserved today: `rok-commander` (the kingdom-voice pack used by every existing guild) and `general-events` (the streamer-tone pack, content lands in Phase 2, registry slot reserved, lookup falls back to rok-commander when the guild's pluginId points at an unregistered pack).

Module layout:
- `src/base/copy/packs/rok-commander.pack.ts`: the canonical pack. New copy edits land here.
- `src/base/copy/brand.ts`: shared brand identity (`FOOTER`, `AUTHOR`, `COLORS`). Pack-independent and identical across packs; both packs reference it, and non pack-aware call sites (no guildConfig in scope) import colors/footer from here directly.
- `src/base/copy/types.ts`: `IEmbedField`, `IPluginCopy` (derived from the rok-commander pack), `PluginId` union.
- `src/base/copy/packs.ts`: `COPY_PACKS` registry plus `DEFAULT_PLUGIN_ID`.
- `src/base/copy/getCopy.ts`: `getPluginCopy(guildConfig)` resolves the active pack; `getCopyOverride(key, guildConfig)` resolves the per-guild owner-authored override (Phase 3 editor UI writes these).
- `src/base/copy/index.ts`: barrel export (`@base/copy`).
- `src/base/constants/embed-content.ts`: REMOVED (Phase 5). This was the back-compat shim re-exporting `rokCommanderCopy` as `embedContent`. All call sites now read `getPluginCopy(guildConfig)` (pack-aware), or import `rokCommanderCopy` / the `@base/copy/brand` constants directly where the default pack is correct (KvK-only, no-config, guild-create-time).

`GuildConfig` carries the per-guild pluginId and copyOverrides Map. Both fields default to "rok-commander" / empty Map respectively, so legacy rows load cleanly without a backfill.

Phase 1 shipped the pack architecture, schema fields, and lookup helpers. The follow-on migration is now COMPLETE: embed builders + their callers (Phase 2), the divergent handler reads (Phase 3), the channel intros + repair notices (Phase 4), and the shim retirement + brand extraction (Phase 5) all landed, so pack-aware code resolves voice via `getPluginCopy(guildConfig)`. KEY GAP: there is still no setter for `pluginId = "general-events"` (the plugin-install flow is unbuilt), so every guild defaults to rok-commander and the neutral pack is unreachable in production until a setter ships. To exercise general-events today, set a guild's `pluginId` directly in Mongo. Two voice surfaces are intentionally still hardcoded to the kingdom default and not yet pack-driven: the `introductionComponents` invite-button label (no pack field exists for it) and the `setup.channels.admin` channel NAME (`🔒inner-sanctum` vs `🔒admin`; channel-name resolution is deferred as risky).

## Tech debt

- `TestReminderJob.ts` uses `Object.create(TextChannel.prototype)` inside tests to fake a TextChannel. If discord.js tightens its class internals this will need a `vi.mock("discord.js", ...)` swap.
- The `_moduleAliases` block in `package.json` is runtime alias mapping for compiled JS. tsc-alias already rewrites aliases at build time, so the runtime mapping is likely redundant now. Low priority cleanup.

## Platform to bot contract

**A byte identical copy of this section lives in the other repository:** `company-uno/nexious-server/CLAUDE.md` and `DeroDiscordBot/CLAUDE.md`. Neither copy is the original. A change to this contract changes code on both sides, both copies of this section, and the three format-pinning tests, in ONE session. A session that edits one side and stops has already broken the pair, and nothing in either repo will fail to compile to tell you.

### Direction A: dashboard to bot

`nexious-server/src/features/plugin-proxy/forwardToBot.ts` forwards dashboard traffic for the two PROXY plugins, `rok-commander` and `general-events`, to `ROK_BOT_BASE_URL` + `/api/<path>`. Both entries point at the same bot process.

**`ROK_BOT_PATH_PREFIXES` is the allowlist of FIRST path segments.** An unlisted segment is refused before any request leaves the server:

```
events · leaderboard · players · reminders · reminder-logs · schedule
go-live-now · leaderboard-tracking · auto-heal · pairing · game-rooms
```

`general-events` allows those plus `streamer`. The two plugins share one bot process, so that one extra prefix is the whole difference between them.

**⚠️ This is the failure mode that hides.** A route the bot serves but this list omits is simply unreachable, and it presents as a plugin feature that silently does nothing rather than as an error. `game-rooms` sat in exactly that state: the bot mounted `/api/game-rooms` and its CHANGELOG advertised it while the allowlist did not carry it, so the bot half looked finished on its own.

**`ROK_BOT_PUBLIC_READ_PREFIXES`** is `events`, `leaderboard`, `leaderboard-tracking` and `schedule`: the subset a logged-out visitor may read by `appUid` alone. An entry here widens public access, so GUILD DATA NEVER GOES ON IT. `game-rooms` is deliberately excluded because room transcripts are guild data.

**Two path rewrites**, applied in order, first match wins:

| The client sends | The bot receives | Why |
|---|---|---|
| `PATCH events/:id/retire` | `DELETE events/:id` | The client keeps stable "retire" semantics while the bot soft deletes with `active: false`. **`fromMethod` pins it to PATCH**, and that pin is load bearing: without it any verb reached the DELETE, and GET was the dangerous one, because GET skips `requireUser` and `events` is a public-read prefix so the ownership check was skipped too. |
| `reminder-logs/:id` | `reminders/:id` | A pure rename with no verb change, so no `fromMethod`. `reminder-logs` is not a public-read prefix, so the ownership check runs either way. |

**`PLUGIN_REGISTRY` in `forwardToBot.ts` is hand mirrored** against `PROXY_PLUGIN_IDS` in `nexious-server/src/features/plugins/registry.ts`, `COPY_PACKS` in the bot (`DeroDiscordBot/src/base/copy/packs/`), and the client manifests in `nexious-client/src/features/plugin-modules/manifests/registry.ts`. The cross-import is deliberately not wired: `forwardToBot.ts` already imports `VALID_PLUGIN_IDS` from `registry.ts`, so the reverse edge would be a cycle. Nothing fails to compile when one of the four drifts.

The bot mounts those routers in `DeroDiscordBot/src/api/server.ts` behind `verifySignature`. `/health` and `/api/health` are mounted BEFORE it and stay public for the Railway liveness probe and the dashboard's Test Connection. `/api/health/guild` sits AFTER it on purpose, so a prober cannot enumerate which guilds the bot holds configs for.

### Direction B: bot to server

The bot signs outbound calls in `DeroDiscordBot/src/utils/serverApi.ts`. The server verifies them in `nexious-server/src/api/middleware/auth/verifyBotSignature.ts`, which **never rejects on its own**: it sets `req.botVerified` to true or false and calls `next()` either way, and the ROUTE decides what that means.

Bot callable server routes, with their mounts from `nexious-server/src/api/routes/index.ts`:

| Mount | Routes | Gate |
|---|---|---|
| `/api/events/` | GET `/`, GET `/:eventId`, POST `/`, PATCH `/:eventId`, DELETE `/:eventId` | `verifyBotSignature` then `allowBotOrUser` |
| `/api/plugin-access/` | GET `/guild`, GET `/game-rooms` | `verifyBotSignature` |
| `/api/suggestion-box/` | POST `/` | `verifyBotSignature` then `requireBotVerified` |

### Signing, both directions

Headers: `x-api-key` (the legacy shared key, still sent and still checked), `x-timestamp` (epoch MILLISECONDS as a string), `x-signature` (lowercase hex HMAC-SHA256).

The canonical string is four lines joined by `\n`:

```
<METHOD, uppercased>
<path>?<query, keys sorted>     no "?" and no query at all when the query is empty
<timestamp>
<sha256 hex of the RAW body bytes>     the empty string when there is no body
```

**Hash the RAW bytes, never a re-stringified parse.** `nexious-server/src/server.ts` captures them with `express.json`'s `verify` hook onto `req.rawBody`, and the bot does the same. `JSON.parse` followed by `JSON.stringify` reorders keys and drops whitespace, which changes the hash and 401s every request. Note also that the body hash is a plain `sha256`, NOT an HMAC; only the finished canonical string is HMAC'd.

**Replay window: 5 minutes**, on both sides and in both directions (`FIVE_MINUTES_MS` in `verifyBotSignature.ts`, `MAX_TIMESTAMP_SKEW_MS` in the bot's `verifySignature.ts`). The check is on the ABSOLUTE drift, so a timestamp implausibly far in the future is rejected too, not just a stale one.

The canonicalization exists in three call sites rather than one, and they must agree byte for byte:

- `nexious-server/src/features/plugin-proxy/signRequest.ts` exports `canonicalizeQuery`, `buildCanonicalString` and `signRequest`. `verifyBotSignature.ts` imports `buildCanonicalString` from it rather than keeping a fourth copy.
- `DeroDiscordBot/src/utils/canonicalRequest.ts` exports `canonicalizeQuery`, `hashBody` and `buildCanonicalString`, shared by the bot's inbound `verifySignature` and its outbound `serverApi`.

**Keep the bot's `canonicalizeQuery` in lockstep with the server's copy or every proxied request 401s.** Change one and you change all three call sites (bot inbound, bot outbound, server inbound), then re-run the three tests that pin the wire format:

- `nexious-server/src/__tests__/features/signRequest.test.ts`
- `nexious-server/src/__tests__/security/pluginProxy.verification.test.ts`
- `DeroDiscordBot/src/api/middleware/verifySignature.test.ts`

### Env pairs

The same value under two different names on two different hosts. A mismatch is not a compile error anywhere, and the symptom is a 401 on every call.

| Heroku (`nex-db`) | Railway (bot) | What it is |
|---|---|---|
| `ROK_BOT_API_KEY` | `DASHBOARD_API_KEY` | The legacy shared key, sent as `x-api-key`. |
| `ROK_BOT_SIGNING_SECRET` | `DASHBOARD_SIGNING_SECRET` | The HMAC secret, used in BOTH directions. |
| `ROK_BOT_BASE_URL` | | Points at the bot. |
| | `SERVER_BASE_URL` (alias `NEXIOUS_BASE_URL`) | Points at the server. Required when `USE_REMOTE_EVENTS` is on. `serverApi` reads `SERVER_BASE_URL` first and falls back to the alias, so either name works; set one. |

When the secret is unset each side DEGRADES rather than failing loudly, deliberately, so the rollout can land one side at a time: the proxy forwards with the api key alone and logs a warn per request, the bot's inbound verification falls back to plain api-key auth, and the bot's outbound calls throw `ServerNotConfiguredError`.

**⚠️ The header comment in `verifyBotSignature.ts` says `BOT_SIGNING_SECRET`. The code reads `ROK_BOT_SIGNING_SECRET`. The code wins.**

Two switches exist only on the bot:

- `REQUIRE_SIGNED_REQUESTS`: strict mode. When true, `verifySignature` rejects any unsigned `/api/*` request with no fallback to plain api-key auth. Off by default. Flip it on only AFTER both sides sign every request; it closes the last path by which a caller holding only the shared api key could pass an arbitrary `?guildId=`.
- `USE_REMOTE_EVENTS`: when true, `eventStore` routes reads and writes through `serverApi` instead of local Mongo. Off by default; flip it on only after the migration has copied existing events into the platform DB.

### Change protocol

- **A new bot route.** Ship the bot route and deploy Railway FIRST, then add its first path segment to `ROK_BOT_PATH_PREFIXES` and deploy the server. In that order the allowlist never points at a route that does not exist yet, and the bot is never serving a route nothing can reach.
- **Secrets, verification or canonical format.** Follow `company-uno/TODO-PLANS/rok-commander-signing-rollout.md`, bot first.
- **Any contract change is ONE session across both repos.** Code on both sides, both copies of this section, and all three tests green before the session ends.

## Operational Dependencies (Future A)

When `USE_REMOTE_EVENTS=true` the bot has a HARD dependency on `nexious-server` (Heroku) for every event read and write. Outage behavior:

- **Read path (cron tick, ActivityTracker)**: `remoteEventStore` falls back to its 60-second in-process cache during brief outages. If the outage exceeds the cache TTL the bot returns empty arrays and reminders stop firing. Pre-existing reminder fires already in flight are unaffected.
- **Write path (slash commands)**: a server outage surfaces to the user as "the platform is unreachable, try again in a moment." No retry loop; the bot does not buffer writes for replay.
- **Schedule board refreshes**: degrade silently. The hourly safety tick will reconverge once the server is reachable again.
- **Health metrics**: `ReminderScheduler` emits an hourly `[metrics]` log line with bot→server p50/p95/p99 latency. Watch for warnings about `outbound_p99 > 500ms` or `failure_rate > 1%`: the cron tick has a 60-second budget and a stuck server can blow it.

If the platform server is down, the safest user-visible posture is to communicate the outage. The owner-notice mechanism is implemented in `src/features/observability/outageWatcher.ts`, DMs the platform owner (env `CREATOR_DISCORD_ID`) once after 5 minutes of continuous unreachability, again on recovery. Idempotent across an outage; resets on bot restart.

## Current rollout state

**Code:** Future-A complete. `eventStore` flag-delegates between local Mongo and `remoteEventStore`. Slash commands all use the in-guild variants (`findByIdInGuild`, `updateInGuild`, `deleteInGuild`). The legacy `findById`/`update`/`delete` methods throw under `USE_REMOTE_EVENTS=true` so any missed call site fails loudly.

**Production:** `USE_REMOTE_EVENTS=false` on Railway. Bot reads from local Mongo. Safe rollback path is to leave it off.

**Cutover:** follow `../company-uno/roadmaps/audits/cutover-smoke-test.md` for the staged sequence. Run `npm run smoke-test` against staging before each flag flip. The smoke test creates a canary event, exercises pause/PATCH/DELETE, and cleans up after itself.

**Rollback:** flip `USE_REMOTE_EVENTS=false` and redeploy. Bot reverts to local Mongo on next boot. Migrated events in the server DB are not destroyed by rollback.

## Session continuity checklist
1. Read this file.
2. Read the testing strategy in the sibling `company-uno` repo at `../company-uno/roadmaps/specs/rok-commander-testing-strategy.md` if test work is on the table.
3. Remember that the dashboard lives in `../company-uno/nexious-client/src/features/plugin-modules/` and has its own CLAUDE.md at `../company-uno/nexious-client/CLAUDE.md`.
4. If touching API auth, read `../company-uno/TODO-PLANS/rok-commander-signing-rollout.md` first. The canonical string format must match the server byte for byte.
