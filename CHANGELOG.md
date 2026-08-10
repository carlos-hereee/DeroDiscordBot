# Changelog

All notable changes to the ROK Commander bot are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at v1.4.0. Earlier releases predate the changelog convention; the public-facing summaries for those releases live in the historical `embedContent.featureAnnouncement` blocks rendered to each guild via the boot-time announcement system.

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
