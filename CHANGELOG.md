# Changelog

All notable changes to the ROK Commander bot are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at v1.4.0. Earlier releases predate the changelog convention; the public-facing summaries for those releases live in the historical `embedContent.featureAnnouncement` blocks rendered to each guild via the boot-time announcement system.

## [Unreleased]

⚠️ **This file skips from 1.4.0 to here.** Releases 1.5.x and 1.6.x shipped without changelog entries; `package.json` is at 1.6.1. That gap is not filled below, it is only noted so a reader does not mistake this entry for the whole of what changed since April.

### Added

* **Game rooms.** A two-player or cooperative match now plays in its own Discord channel under a second managed category, 🎮 ARCADE GAMES. `⚔️challenges` carries a board where a member starts a challenge, chooses **Invite only** or **Open to all**, gathers who is in, and opens the room. The room's full move list is kept as an append-only transcript that outlives the channel.
* **Hangman with a host-authored word.** The host writes the word behind a modal with a required hint and up to three extra hints, earned by the room at 2, 4 and 5 wrong guesses. Every letter played is its own attributed message. The host cannot guess their own word, and the word appears in exactly one message, the result card.
* **`GET /api/game-rooms`** for the dashboard, behind the existing signature gate. Returns finished matches newest first, excluding the hidden word and the full move list.
* **A room archive sweep** on its own 5 minute cron. A finished room stays readable for four hours, or clears immediately when the host presses **Archive now**.
* **Dero's voice and the Listen button.** An admin sets a voice id and turns voice on with `/dero-config`. A **Listen** button on welcomes, and on fortunes where the member did not type a question, reads the post aloud as a private mp3, or plays it in the voice call when the member pressing it is in the same call as Dero. Voice ships OFF in every server, and every paid speech call is checked first against a monthly budget per server ($5 by default, $0 refuses everything).
* **`/dero tell`.** A member on the server's task list (the server owner, or anyone holding a role an admin added) gives Dero a short task in plain words, for example posting a message in an allowed channel. Dero's brain only proposes; the bot checks the member again, posts only in allowed channels, and never pings anyone.
* **Voice calls: `/dero join`, `/dero leave` and `/dero status`.** Dero joins an allowed voice channel and posts, on every join, that it is listening only to members on its task list, that their speech is sent to ElevenLabs for speech to text, and that the call is not recorded by Dero. It answers aloud, keeps no audio and no transcript, and leaves 2 minutes after the last task list member does, or at once when it is moved, kicked, its channel is deleted, or voice is switched off.
* **Hold'em by request, with Dero as the dealer.** Asked for a table, Dero shows a rules card with the standard rules or the asker's own seats, stack and big blind. The asker picks a public or an invite only table and a real room opens; Dero posts the hand start and the result there and, for a table asked for in a call, speaks the deal, the streets and the result. Hole cards are never spoken or posted, and chips exist only for that table.
* **Monopoly, for 2 to 6 players.** Started from the `⚔️challenges` board or with `/mini-game monopoly`, and played in its own room, a turn at a time, across as many days as the table likes. The full ruleset on Dero's own 40 square board: buying, rent, 16 Chance and 16 Community Chest cards, jail with three ways out (bail, a Get Out of Jail Free card, or doubles), houses and hotels built evenly, private trades of lots, chips and jail cards, mortgages, and selling buildings back to the bank. The host chooses at the challenge card whether a lot a player passes on goes to a 60 second sealed bid auction. A player short of chips for a debt they could cover by mortgaging or selling is held until they raise it and press **Pay**; one who could not cover it is bankrupt at once. A seat that goes 24 hours on its turn without a move is forfeited, and a debtor who never pays is bankrupt to whoever they owed. The board is a picture of the board art with tokens, houses and hotels when the image library loads, and a text map otherwise. The last seat standing wins, and the result shows in `/account`.
* **Dero as the Monopoly voice referee.** A second toggle on the Monopoly challenge card. With it on, and while Dero is in a voice call that a player still in the match is in, Dero speaks the key moments of each move: whose turn it is, doubles rerolls, purchases, rents of $200 or more, going to jail and getting out, the card drawn (its title only), auctions opening and closing, a held debt, a bankruptcy, the winner, and the idle forfeits, with names in place of mentions. It never joins a call on its own, needs voice switched on with `/dero-config`, and every clip it renders counts against the same monthly speech budget. Nothing is posted in text, since the match's own trail already shows every move.
* **`/dero-config`** for administrators: status, enable, disable, voice, listen, cap, and the allowlists of roles, text channels and voice channels.
* **Voice and tasks run through Dero's brain service.** `/dero tell`, spoken answers in a call and new table requests are answered by the brain over a signed link; while the link is not connected, Dero tells the member its brain is offline and nothing runs. Listen, joining a call and the narration of a table already open do not use the brain.
* **An optional soak sampler** for operators: with `DERO_VOICE_SAMPLER` set to `1`, one audit row a minute while a call is open, numbers only (memory, calls, rejoins, queue depth, turns, this month's speech spend, latency median). Off by default.

### Changed

* **`/mini-game coin-flip`, `dice-roll` and `rps` no longer take an `opponent`.** They post a challenge card to `⚔️challenges` instead. A Discord user picker can return a bot, which is why the bot used to carry a "pick a real member" refusal; the two ways into a match are now a bot-populated menu and a button, so the refusal has nothing left to refuse and was removed.
* **`/mini-game hangman` is unchanged outside a room** and is refused inside one, where the room's own controls play the round.

### Removed

* **The old challenge handshake** (`challengeFlow`, and the duel and rps handlers built on it). It kept a match in process memory, so a Railway deploy mid-handshake lost it; a room row survives the deploy.

## [1.4.0]: 2026-04-27

### Fixed

* **Ancient Ruins cadence** corrected from 36h to 40h. Previously the bot's pinned next-occurrence walked earlier than the canonical ROK schedule by 4 hours every cycle, accumulating into multi-day drift over a season.
* **Altar of Darkness cadence** corrected from 84h to 86h. Same drift pattern as Ruins, 2 hours per cycle.
* **Confirmation embed strings** in `embed-content.ts` updated to match the new cadences, so the `/configure-kvk-season` preview and the post-confirm response no longer announce a cadence the bot will not actually use.
* **Season-end announcement spam.** The dedup record in `ReminderLog` is now keyed on a synthetic `season-end:<guildId>` instead of the per-event `eventId`. A guild with N expired events in a single cron tick now receives one season-end embed instead of N. Reproduces the 4/24 incident in a unit test so it cannot regress.
* **Season-end embed copy** rewritten from a transactional "kingdom stands down, run `/configure-kvk-season`" to a kingdom-voiced thank-you that acknowledges members' participation through the season. The admin instruction is demoted to a closing line.

### Added

* **Schedule board redesign.** The pinned decree calendar now renders a single bolded `Season ends` line at the top of the embed, partitions events into Active and Completed This Season blocks, and hides the Completed heading when no events have concluded yet. New `IScheduleField.isCompleted` boolean plus matching population in `ScheduleBoard.toField` drives the partition.
* **Decree editing UI.** Every post in the next-decree channel now carries an Edit button. Authorized users (server owner plus the guild's configured admin role) can adjust a decree's title, description, or fire time on a single occurrence (`Apply to this fire only`) or as a permanent shift to the recurring anchor (`Apply to all future fires`).
* **EventOverride model** with a compound unique index on `(eventId, originalOccurrence)`. Single-occurrence edits write here without mutating the underlying Event document. Read at fire time by `ReminderJob` and at render time by the next-decree post builder.
* **Timezone select dropdown.** Time edits surface a 25-option `StringSelectMenu` of curated IANA zones (UTC plus 24 high-traffic regional names) after modal submit. Discord modals cannot host select menus, so the timezone collection moved out of the modal into a follow-up ephemeral. The collector uses `createMessageComponentCollector` with explicit `ComponentType.StringSelect` to work around a discord.js 14.25 silent-drop when a select and a button share an ephemeral message.
* **Audit log.** Every edit writes a row to the `AuditLog` collection via `botLogStore.logAudit` with `actorId`, `eventId`, `guildId`, `action` (`decree_edit_once` or `decree_edit_permanent`), `before`, `after`, and `originalOccurrence`. Auditability is required for any feature that lets non-owners mutate scheduled events.
* **Boot announcement system content.** `embedContent.featureAnnouncement` rewritten for v1.4.0. Public embed in `#announcements` apologizes for the dissonance and walks through the four user-visible changes; admin embed in `#inner-sanctum` is the plain changelog plus the migration note. Idempotent via `botLogStore` keyed on `featureAnnouncedEvent("1.4.0")`.

### Changed

* **`parseModalValues` split** into `extractAndValidate` plus `resolveOverrideTime` so the structural validation can run before the timezone is collected, and the time resolution can run after. Original `parseModalValues` signature kept as a backward-compat wrapper for the unit tests that exercise the full pipeline.
* **`vitest.config.ts` resolve.alias** added explicitly. The bot's `tsconfig.json` excludes `**/*.test.ts`, and `vite-tsconfig-paths` honors that exclude; the result was that direct `@base/...` imports in test files failed to resolve while transitive imports through production files worked. The explicit alias map mirrors the tsconfig paths block and covers the test surface.
* **`package.json` test script** changed from a placeholder echo to `vitest run`. Added `test:watch` for development. Bumped version from 1.3.0 to 1.4.0, which keys the boot announcement.
* **devDependencies** gained `vitest`, `vite-tsconfig-paths`, `@vitest/coverage-v8`, `supertest`, and `@types/supertest`. None were in the lockfile despite the test files importing them.

### Migration required

After deploying this release, run the cadence migration once against the production MongoDB:

```
DRY_RUN=1 LIMIT_GUILD=<test-guild-id> node scripts/fix-event-cadences.mjs
LIMIT_GUILD=<test-guild-id> node scripts/fix-event-cadences.mjs
DRY_RUN=1 node scripts/fix-event-cadences.mjs
node scripts/fix-event-cadences.mjs
```

The script is idempotent: it filters by name plus the **old** `intervalHours` value (36 for Ruins, 84 for Altar), so re-running finds nothing to update. Without the migration, existing event documents keep their old `intervalHours` and the cadence drift continues for any guild that ran `/configure-kvk-season` before this release.

`scripts/fix-event-cadences.mjs` lives in `.gitignore` historically (the `scripts/*` line was added defensively), so it ships from local checkouts only, not from Railway. Run it from a developer machine pointed at the production `MONGOOSE_URI`.

### Tests added

* `occurrenceCalculator.test.ts` pins the JSON cadence values (Ruins 40, Altar 86, Kau Karuak 0) and reproduces four canonical schedule rows for both recurring events to verify cadence + calculator together produce the right dates.
* `ReminderScheduler.test.ts` covers the new guild-scoped dedup contract (one announcement per guild per season) and the cross-season replay case (a fresh `seasonEnd` opens a new dedup slot).
* `embedBuilder.test.ts` covers the schedule board redesign branches: bolded season-end line at top, active and completed partitioning, completed heading hidden when empty.
* `decreeEditHandlers.test.ts` covers the split helpers (`extractAndValidate`, `resolveOverrideTime`) directly plus the legacy `parseModalValues` wrapper for backward compat.
* `permissions.test.ts` covers `canEditDecree` (owner returns true, admin role match returns true, no role and not owner returns false).

### Known follow-ups (deferred to v1.4.1)

* `GuildSetupManager.test.ts` and `ChannelDeleteWatcher.test.ts` have 13 stale assertions that never accounted for the `nextDecreeChannelId` channel addition. Production code in those paths is exercised by every real guild boot and is verified working; the tests need fixture updates.
* `verifySignature.test.ts` has 4 assertion failures in the HMAC middleware tests. The middleware is only on the plugin-proxy path, which is gated behind `USE_REMOTE_EVENTS=true` (currently off in production). Not a release blocker; defer until the F4 cutover work resumes.
* Decree edit permission gate currently uses the single `adminRoleId` field on `GuildConfig`. The original Phase 4 design called for `authorizedRoleIds: string[]` on `GuildConfig` for multi-role authorization. If multi-role gating becomes a requested feature, widen the schema and migrate existing `adminRoleId` values into the array.
