# Master Plan: CompanyUno Fortune Teller: `/fortune` on ROK Commander

> **Reconciliation owed, added 2026-09-11.** This plan sits in `TODO-PLANS/` because its checklist is not reconciled, not because the work is missing.
> An audit on 2026-09-10 verified **5 of 5 phases** at the live call site rather than from this document.
> **27 of its 27 boxes are unticked.** What it owes is a tick pass: verify each box at the call site, then tick it.
> A plan is complete only when every box is ticked AND every tick is accurate, at which point it moves to `COMPLETED-PLANS/` (`CLAUDE.md`, "A PLAN LIVES IN EXACTLY ONE OF TWO FOLDERS").

## AMENDMENT LOG

- **2026-07-02 (v7): kill-switch REMOVED.** The `ENABLE_FORTUNE_FEATURE` env flag was removed entirely at owner request ("makes no sense to have"). It was needless ceremony for a low-risk fun command, and its one real cost bit immediately: an easy-to-forget toggle that silently returned "The fortune teller is resting" when unset. `/fortune` and the button are now simply live once the command is deployed and registered, like every other command. Removed across `config.ts` (const + export), `respondWithFortune.ts` (import + guard), `fortuneCopy.ts` (the now-dead `disabledMessage`), and a `PowerUps.ts` comment. `tsc --noEmit` green, fortune tests 9/9. Consequences elsewhere in this doc: ignore every earlier reference to the kill-switch / "dark launch" / `ENABLE_FORTUNE_FEATURE`; the publish sequence no longer has a flag-flip step, and disabling the feature now means unregistering the command or reverting, not flipping an env var.
- **2026-07-02 (v5): command-center button added.** Per owner request, a "🔮 Fortune" button now rides the "Summon Dero" invite card in #command-center, next to the existing "🎲 Icebreaker" button. Implementation: new `powerup:member:fortune` action + `buildFortuneButton()` + `runFortune()` in `src/features/power-ups/PowerUps.ts` (member-usable, not admin-gated), packed onto the `inviteCardComponents` row in `GuildSetupManager.ts`, the `componentsAreEquivalent` boot check re-edits the card on every existing guild's next boot, so the button backfills with no migration. The command and button now share ONE `src/features/fortune/respondWithFortune.ts` (kill-switch + cooldown + roll + embed), so the cooldown is shared and the two entry points cannot drift; the command file was slimmed to a thin caller. The button reading is EPHEMERAL (only the clicker sees it) so it never clutters the read-only guide channel, flip `isPrivate` in `runFortune` to make it public. `tsc --noEmit` green; fortune tests still 9/9. Where Dero responds: the slash command replies inline in whatever channel it is run (public, or private with the toggle); the button replies ephemerally in #command-center.
- **2026-07-02 (v4): BUILT.** All code phases (1-4) implemented and verified in `DeroDiscordBot`. `npx tsc --noEmit` green; the two new colocated test files pass 9/9 (`rollFortune.test.ts`, `cooldownManager.test.ts`). Files shipped: `src/commands/fun/fortune.ts`, `src/features/fortune/{fortunes,rollFortune,rollFortune.test,fortuneCopy,fortuneEmbed}.ts`, `src/utils/cooldownManager.ts` + `.test.ts`; edits to `src/base/copy/brand.ts` (+`FORTUNE`/`FORTUNE_ULTRA` colors) and `src/utils/config.ts` (+`ENABLE_FORTUNE_FEATURE` flag). One deviation from the v2/v3 file plan, for the better: `fortuneEmbed` lives in its own `src/features/fortune/fortuneEmbed.ts` (importing Dero author + colors straight from `brand.ts`) rather than being bolted into `embedBuilder.ts`, this keeps the whole feature self-contained and fully decoupled from the pluginId system, exactly per the v3 "not a plugin" intent, and touches `embedBuilder.ts` not at all. **Phase 5 remaining is owner-gated only:** commit (on `staging`, kept separate from the in-flight v1.6.1 working-tree changes), `npm run deploy` + Railway deploy, flip `ENABLE_FORTUNE_FEATURE=true`, then post the announce copy (drafted at the end of this doc). Manual in-Discord QA also owner-run (checklist below).
- **2026-07-02 (v3).** Scope tightened by owner: `/fortune` is **only a Discord bot slash command, NOT a Company Uno platform plugin**. No entry in the platform's `VALID_PLUGIN_IDS`, no plugin-proxy route, no dashboard plugin module, no access-tier gating. Consequence for the build: the fortune copy does NOT thread through the `pluginId`-aware copy packs (`IPluginCopy`, the `general-events` pack): it lives in a feature-local copy module instead. Strings stay centralized (no hardcoded copy) but decoupled from the plugin machinery. Promotion to a real platform plugin (pack-scoped copy, `copyOverrides` admin editing, a dashboard surface) is an explicit LATER option if the feature earns attention.
- **2026-07-02 (v2).** Open questions resolved against live ROK bot code. Two owner decisions locked: (1) **extend the existing ROK Commander bot**, do NOT ship a standalone bot; (2) resolve open questions before any code. The v1 plan below has been rewritten accordingly. The biggest correction: v1 asserted "no existing randomized-content module exists", that is **false**. ROK Commander already has `getRandom`, a 500-string `icebreakers.ts` pool, a `goLiveGifs` random-picker, a branded embed pipeline, an env-flag pattern, and dead commented-out `eightBall`/`poll`/`rps` stubs. The feature is largely an assembly of patterns that already exist, not a greenfield build. Every claim in this v2 is cited to a real file:line in `DeroDiscordBot/`.

---

## MISSION BRIEF

- **Goal:** Add a CompanyUno-branded fortune-teller / magic-8-ball `/fortune` slash command to the **existing ROK Commander bot**. Members ask a question, get a randomized on-brand answer voiced by Dero, with a public/private visibility toggle and a rare "ultra" special-tier response. Always carries a "for fun only" disclaimer; nothing reads as real advice.
- **Tier:** Standard, a new command inside a mature, well-patterned bot. Lower risk than v1 assumed, because it reuses existing infrastructure rather than standing up a new process.
- **Scope boundary:** This is a self-contained ROK bot slash command. It is explicitly NOT a Company Uno platform plugin, no `VALID_PLUGIN_IDS` entry, no plugin-proxy, no dashboard module, no beta/exclusive access-tier gating, no `pluginId`-scoped copy pack. If it earns attention it can graduate into a real platform plugin later; until then it is intentionally lightweight.
- **Definition of Done:** `/fortune` is live wherever the ROK bot runs. A member can invoke it, optionally type a question, choose public or private visibility, and receive a randomized Dero-voiced response, including occasional rare ultra-gold hits. The disclaimer is always present. The feature is behind an env kill-switch and can be dark-launched and disabled without a code change.
- **Assumptions (updated):**
  1. Ships as a new command module inside `DeroDiscordBot` (Discord.js v14, TypeScript, pure ESM), following the live `data` + `execute` slash-command contract (`src/commands/utility/suggestion-box.ts:14`).
  2. The "special field" is the rare **ultra** tier: the CompanyUno brand already has a three-rung accent ladder (default indigo → activation teal → **ultra gold**), where gold denotes the rare top tier. The special fortune reuses that meaning (ultra-gold embed). Creative framing recommended below, owner to bless.
  3. No database for MVP, response pool is a static TS const array mirroring `icebreakers.ts`. Per-user cooldown is in-memory. The bot's existing `GuildConfig.copyOverrides` layer makes admin-editable fortunes a later drop-in with no rework.
  4. Hosting = ROK Commander's existing Railway service. No new host, no new token, no new process.
- **Open Questions:** NONE remain. All four v1 questions and the three follow-on decisions are resolved (see the Resolved Open Questions section): extend ROK bot; ultra tier = Dero-the-Oracle gold reading; static const-array pool; ROK's Railway host; global rollout behind a kill-switch; ship on the bot's current manual-verify convention (no new CI). The plan is build-ready; the only content still to author is the fortune copy pools (Phases 2-3).

---

## RESOLVED OPEN QUESTIONS

| # (v1) | Question | Resolution | Basis in live code |
|---|---|---|---|
| 1 | Standalone bot vs extend ROK Bot? | **Extend ROK Bot** (owner decision). Cheaper than v1 assumed: the bot's embed chrome is ALREADY CompanyUno-branded. | `FOOTER = "Company Uno"`, `AUTHOR = Dero`, `DERO: "#4f46e5"` all in `src/base/copy/brand.ts:23,35,95` |
| 2 | What is the "special" tier? | **The ultra rung.** Common = indigo Dero reading; special (~6% roll) = ultra-gold "Dero the Oracle" reading. Owner to bless the exact voice. | Web brand token `--dero-ultra-halo: #ffd23a` (`nexious-client/.../vars.css:48`); `COLORS` dict extend point at `brand.ts:75` |
| 3 | Editable without redeploy, or static array? | **Static TS const array**, mirroring the icebreaker pool. Admin-editable fortunes are deferred to the "graduate into a real plugin" path (v3 scope): if it becomes a platform plugin later, the pool moves into the pack + `copyOverrides` system then. Not free-by-construction while it stays a plain command, and that is fine. | `src/features/greeter/icebreakers.ts` (500+ pool); the `copyOverrides` path exists at `getCopy.ts` for the later graduation |
| 4 | Hosting target? | **ROK's existing Railway service.** Graceful SIGTERM shutdown already handled; no new infra. | `src/main.ts:88` SIGTERM handler; `src/utils/config.ts` env loading |

### Three follow-on decisions: RESOLVED 2026-07-02

1. **Ultra-tier creative framing → Dero the Oracle.** Common tier = Dero speaking plainly in an indigo embed. Ultra tier (~6% roll) = a gold embed reframed as "Dero sets down his mug and delivers an ultra reading," using the bundled `assets/dero/dero-avatar-512.png` as the thumbnail (renders without waiting on the web deploy, see `brand.ts:53`). Founder-wink lines were NOT selected as the primary voice; keep the ultra pool mascot-driven. Full common + ultra copy to be drafted in Phases 2-3.
2. **Rollout scope → global, behind the kill-switch.** `/fortune` registers globally (`src/deploy-commands.ts:48-54`) and appears in every guild the ROK bot is in, gated by `ENABLE_FORTUNE_FEATURE`. This is a superset of the v1 DoD ("live in the CompanyUno server") at zero extra cost; every alliance gets the toy. No guild-scoping or allowlist mechanism is built.
3. **CI → ship on the bot's current convention.** No CI pipeline is stood up for this feature. Verification = colocated `rollFortune.test.ts` + manual `npx tsc --noEmit` + `npm run test:run`, matching how the bot ships today (ROK `CLAUDE.md` rule 2). Standing up a lint + typecheck + test GitHub Actions workflow for the bot is explicitly OUT of scope for this feature and left as a separate, optional follow-up so whole-repo CI setup does not get dragged into a fun-command task.

---

## 1. GOAL ANALYSIS

**Functional requirements**
- `/fortune` slash command, open to all members (NOT admin-gated, like `/suggestion-box`).
- Optional question text. Modal input is the live pattern (`suggestion-box.ts:19` uses `interaction.showModal`); a string command option is the simpler alternative. Recommendation below.
- Public vs private (ephemeral) visibility toggle via a boolean/choice command option.
- Weighted tier selection: common pool + rare ultra pool.
- Dero-branded embed via the existing `base()` builder + a new `FORTUNE`/`FORTUNE_ULTRA` color.

**Non-functional requirements**
- Acknowledge within Discord's 3s window (`deferReply` if any async work; a pure in-memory pick can `reply` directly).
- Response pool extends without touching selector logic (const array).
- No PII stored; in-memory cooldown only.
- Abuse-resistant: per-user cooldown (net-new util, see gaps).

**Constraints**
- Follows the bot's real security posture: env-only token, guild-scoped boundaries, mention-safe echoing, permission gating where relevant (`src/utils/config.ts`, `src/utils/mentions.ts:21`, `src/utils/permissions.ts`).
- CI: see decision 3 above (reality: none exists today).

**Acceptance criteria**
- Completes within the interaction deadline every time.
- Ultra tier appears at a low, consistent rate (unit-tested distribution).
- No literal decision-making language; disclaimer always visible.
- Malformed / oversized / mention-laden question input never crashes the handler and can never smuggle `@everyone`.

---

## 2. CODEBASE DISCOVERY (grounded, corrects v1)

v1 said the randomized-content module was new. It is not. What already exists in `DeroDiscordBot`:

- **Random picker util:** `src/utils/getRandom.ts:1`: `getRandom(array)`. Reuse for the within-tier uniform pick; do NOT fork a new picker.
- **Static pool precedent:** `src/features/greeter/icebreakers.ts`: a ~500-string const array read by the greeter. Exact template for `fortunes.ts`.
- **Random-picker-over-pool precedent:** `src/base/constants/goLiveGifs.ts`: `GO_LIVE_GIF_URLS` const + `pickRandomGoLiveGif()`.
- **Branded embed pipeline:** `src/utils/embedBuilder.ts` `base(guildConfig)` injects Dero author + "Company Uno" footer; colors in `src/base/copy/brand.ts:75` (`COLORS`, incl. `DERO: "#4f46e5"`).
- **Centralized copy:** `src/base/copy/packs/rok-commander.pack.ts` + `getPluginCopy(guildConfig)` (`getCopy.ts:51`). All user-facing strings live here, satisfying the no-hardcoded-strings rule. `IPluginCopy` in `src/base/copy/types.ts` enforces the shape across packs.
- **Env-flag kill-switch pattern:** `src/utils/config.ts` (e.g. `useRemoteEvents`): truthy-string env flag, off by default.
- **Live slash-command contract:** `src/commands/utility/suggestion-box.ts`: `export const data = new SlashCommandBuilder()` + `export async function execute(interaction)`, auto-loaded by the loader in `src/main.ts:144-159`, dispatched at `src/main.ts:336-399`.
- **Vestigial 8-ball:** `src/commands/events/eightBall.ts`, `poll.ts`, `rps.ts`, `sun-qoute.ts` are ALL fully commented-out relics of the pre-slash message-command era. They are dead code, not working features, but they confirm the intent has precedent. `/fortune` should live as a live module (a new `src/commands/fun/fortune.ts`, or reclaim the `events/` slot) and the dead stubs can be deleted in the same change or left alone (flag as debt, do not expand scope).

**Genuine gaps (net-new work):**
- **Per-user cooldown util does not exist.** Today cooldowns are per-guild (`announce.routes.ts:32`) and per-guild+event (`events.routes.ts:22`) in-memory Maps. `/fortune` needs a small reusable `Map<`${guildId}:${userId}`, timestamp>` cooldown helper, record only AFTER a successful reply.
- **Input-sanitizer util does not exist.** Validation is inline `trim().slice(0, N)` (`announce.routes.ts:122`). If we echo the question back, sanitize inline or extract a tiny `sanitizeInput.ts`; pair any echoed content with `allowedMentions` (`buildAudienceMention`, `mentions.ts:21`) so a question containing `@everyone` cannot ping.
- **No CI** (see decision 3).

`nexious-library` is web-only and irrelevant here, v1 was right on that point.

---

## 3. SOLUTION BRAINSTORMING

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Extend ROK Bot** with a `/fortune` module | Reuses token, hosting, CI-convention, embed pipeline, random util, copy packs, env-flag pattern. Embed chrome is already CompanyUno-branded. Fastest, lowest-risk. | `/fortune` deploys wherever the bot runs (global) unless scoped. Mixes a community-fun command into an alliance ops bot. | **SELECTED (owner)** |
| B. New standalone CompanyUno Bot | Clean brand separation; foundation for future community features. | New hosting, CI, token, and process to babysit; re-implements everything ROK already has. The branding it would "gain" already exists in ROK. | Rejected |
| C. No-code builder | Fastest possible MVP | No control over weighted ultra logic or brand; no reusable infra. | Rejected |

**Selected: A.** The one real cost of A (a fun command living in the ops bot, deployed globally) is contained by the env kill-switch and is arguably a feature, not a bug. See rollout-scope decision.

---

## 4. IMPACT ANALYSIS (real change set for Approach A)

**Files to create**
- `src/commands/fun/fortune.ts`: the live slash command (`data` + `execute`). New `fun/` folder is auto-picked-up by the loader (`main.ts:154`); no registry edit needed.
- `src/features/fortune/fortunes.ts`: tiered response pools as const arrays (`COMMON_FORTUNES`, `ULTRA_FORTUNES`), mirroring `icebreakers.ts`.
- `src/features/fortune/rollFortune.ts`: weighted TIER selector (ultra vs common), then `getRandom` for the within-tier pick. Reuses `getRandom`; the only new logic is the weighting.
- `src/features/fortune/rollFortune.test.ts`: colocated vitest distribution + boundary test (the v1 "unit test").
- `src/features/fortune/fortuneCopy.ts`: feature-local copy module (title, disclaimer footer text, cooldown message, disabled message, echo templates). Deliberately NOT threaded through the `pluginId`-aware copy packs / `IPluginCopy`, the fortune command is not a platform plugin (v3 scope), so its strings stay decoupled from the pack machinery while still being centralized in one place (no hardcoded copy in the handler).
- `src/utils/cooldownManager.ts`: reusable per-user cooldown (net-new, see gaps).
- (Optional) `src/utils/sanitizeInput.ts`: only if question echo needs more than inline trim/slice.

**Files to edit**
- `src/base/copy/brand.ts`: add `FORTUNE: "#4f46e5"` (reuse the Dero indigo) and `FORTUNE_ULTRA: "#ffd23a"` (Dero ultra-gold) to `COLORS` (line 75). brand.ts is pack-independent (its own comment says non pack-aware call sites import colors directly), so this is the right home for fortune colors WITHOUT touching the packs.
- `src/utils/embedBuilder.ts`: add a `fortuneEmbed(...)` builder. Reuse `base()` (called with NO `guildConfig`, so it stays pluginId-agnostic while still getting the shared Dero author + "Company Uno" footer), then set the fortune color from `brand.ts` and the strings from `fortuneCopy.ts`.
- `src/utils/config.ts`: add the `ENABLE_FORTUNE_FEATURE` env flag (off by default).

**NOT touched (v3 scope):** `src/base/copy/types.ts` (`IPluginCopy`), `rok-commander.pack.ts`, the `general-events` pack, the platform's `VALID_PLUGIN_IDS` / plugin-proxy / dashboard modules. None of these are in play for a plain bot command.

**No longer needed (delete from v1's list):** `src/index.ts` bootstrap, `.env.example`, standalone `ci.yml`, separate deploy config, all N/A when extending ROK.

**Verified integration points (confirmed against live code 2026-07-02):**
- Config flag: add `enableFortuneFeature` to `src/utils/config.ts` using the exact `const x = (() => { const raw = (process.env.ENABLE_FORTUNE_FEATURE ?? "").toLowerCase().trim(); return raw === "1" || raw === "true" || raw === "yes"; })();` idiom (matches `useRemoteEvents` at `config.ts:133`), then add it to the single `export { ... }` block at `config.ts:168`.
- Command idiom (from `configure-leaderboard-week-start.ts`): `export const data = new SlashCommandBuilder().setName("fortune")...` with `.addStringOption(o => o.setName("question").setMaxLength(200).setRequired(false))` and `.addBooleanOption(o => o.setName("private"))`. Do NOT call `.setDefaultMemberPermissions(Administrator)`: that is for admin commands only; `/fortune` is open to all.
- Do NOT add `"fortune"` to `BOT_CONSTANTS.ADMIN_COMMANDS` (`src/base/constants/BOT_CONSTANTS.ts:32`): that Set is the admin gate in `main.ts:349`; omission = open to every member, which is what we want.
- Embed helpers exist: `base()`, `errorEmbed(message, guildConfig?)`, `infoEmbed(title, desc, color?, guildConfig?)` in `embedBuilder.ts`. The new `fortuneEmbed()` slots in beside them, over `base(guildConfig)`.
- Ephemeral form: `flags: MessageFlags.Ephemeral` (from `discord.js`), never `ephemeral: true`.

**Dependency graph:** interaction → `fortune.execute` → cooldown check → (optional) sanitize question → `rollFortune()` → `fortuneEmbed()` → `reply`/`editReply` (ephemeral per toggle).

**Risk Register (updated)**
| Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|
| 3s ack timeout | Low | Pure in-memory pick can `reply` directly; `deferReply` only if async work added | N/A |
| Global deploy surprises alliance guilds | Medium | Kill-switch off by default; dark-launch, then flip | Flip `ENABLE_FORTUNE_FEATURE=false`, redeploy |
| `@everyone` smuggling via echoed question | Low | `allowedMentions` whitelist + length cap; never build content string apart from its whitelist | N/A, safe default |
| Command spam | Medium | Per-user cooldown (~10s) | Kill-switch |
| Pool feels stale | Medium | Ship 25-30 common + 6-8 ultra at launch | Iterate content in the const array |
| Scope creep (whole-repo CI, deleting dead stubs, dashboard editor) | Medium | Hard phase boundaries; CI and admin-edit are explicit follow-ups | Defer to backlog |

---

## 5. TECHNICAL DESIGN

**Data model**
```ts
type FortuneTier = "common" | "ultra";
// Pools are plain string arrays per tier (mirrors icebreakers.ts). No id/text
// object needed for MVP; add structure only if metadata (image per fortune) lands.
```

**Command shape:** `/fortune [question?] [private?]`. Recommend a **string option** for the question (`.addStringOption(o => o.setName("question").setMaxLength(200))`) over a modal, Discord enforces the length cap for free and it is one fewer interaction hop than `showModal`. Use a boolean option `private` (default false) for visibility.

**Selection:** `rollFortune()` → roll ultra at the configured weight (start ~6%), else common; then `getRandom(pool)`. Weight is a named constant, not a magic number.

**Reply:** `interaction.reply({ embeds: [fortuneEmbed(...)], flags: private ? MessageFlags.Ephemeral : undefined })`. Note the live codebase uses `flags: MessageFlags.Ephemeral` (`main.ts:354`), NOT the deprecated `ephemeral: true`.

**Embed:** `base()` (no `guildConfig`, so it stays pluginId-agnostic) → `.setColor(tier === "ultra" ? COLORS.FORTUNE_ULTRA : COLORS.FORTUNE)` → title from `fortuneCopy.ts` → description = the answer (+ echoed question if provided) → footer already carries "Company Uno"; append the "🔮 for fun only" disclaimer from `fortuneCopy.ts`. Ultra tier may `.setThumbnail(DERO_IMAGE_REF)` using the bundled avatar attachment (`brand.ts:53`).

**Validation:** cap question at ~200 chars (option maxLength); if echoed, pass through `allowedMentions: { parse: [] }` so no mention in user text ever pings.

**Error handling:** the router already wraps `execute` in try/catch with an ephemeral error embed (`main.ts:382-398`). Keep handler logic total; no stack traces to users.

**Illustrative voice (for owner to bless, NOT final copy):**
- Common: "🔮 Dero consults the ledger… signs point to yes.", "The spreadsheet is unclear. Ask again after coffee.", "Company Uno says: ship it."
- Ultra (gold): "✨ AN ULTRA READING ✨ Dero sets down his mug. The founder himself would call this one."
- Disclaimer footer: "Company Uno • for fun only, not actual advice"

---

## 6. IMPLEMENTATION ROADMAP (rewritten for Approach A)

```
PHASE 1, Slot into ROK, placeholder /fortune
  Macro milestone: /fortune loads, registers, and returns a placeholder ephemeral reply
  Micro tasks:
    - [ ] Create src/commands/fun/fortune.ts (data + execute), placeholder reply
    - [ ] Add ENABLE_FORTUNE_FEATURE flag to config.ts (off by default); guard execute early-returns when off
    - [ ] Confirm loader picks up the new fun/ folder (main.ts:154) and dispatch works (main.ts:338)
    - [ ] Do NOT add to ADMIN_COMMANDS (open to all members)
  Completion: locally, /fortune returns the placeholder; with the flag off it returns the "not enabled" reply
  Depends on: none. (No scaffolding, no token, no hosting, reused from ROK.)

PHASE 2, Response pool + weighted tier engine
  Macro milestone: /fortune returns varied Dero-voiced common answers at the expected distribution
  Micro tasks:
    - [ ] Draft 25-30 common responses in src/features/fortune/fortunes.ts (light, non-advice)
    - [ ] Implement rollFortune.ts (weighted tier + getRandom within tier)
    - [ ] Colocated rollFortune.test.ts (distribution sanity + boundary)
    - [ ] Add the feature-local src/features/fortune/fortuneCopy.ts (title, disclaimer, cooldown/disabled messages): NOT the pluginId packs
  Completion: repeated calls return varied common answers; test confirms ultra rate; tsc --noEmit green
  Depends on: Phase 1

PHASE 3, Ultra tier + question input
  Macro milestone: rare ultra hits live; members can attach a question
  Micro tasks:
    - [ ] Draft 6-8 ultra responses (gold voice), owner-blessed direction
    - [ ] Add FORTUNE + FORTUNE_ULTRA to brand.ts COLORS
    - [ ] Add string question option (maxLength 200); echo safely (allowedMentions parse: [])
    - [ ] fortuneEmbed() over base(); ultra uses gold + optional Dero thumbnail
  Completion: ultra appears at the intended low rate; mention-laden/oversized input handled with no crash or ping
  Depends on: Phase 2

PHASE 4, Visibility toggle + cooldown + disclaimer
  Macro milestone: public/private toggle, per-user cooldown, disclaimer complete
  Micro tasks:
    - [ ] Add private boolean option; route reply flags accordingly
    - [ ] Implement src/utils/cooldownManager.ts (per-user); friendly cooldown message from the pack
    - [ ] Ensure disclaimer footer always present on both tiers
  Completion: toggle changes visibility; rapid repeats hit the cooldown message; disclaimer always visible
  Depends on: Phase 3

PHASE 5, Verify, decide rollout scope, deploy, announce
  Macro milestone: feature live and announced
  Micro tasks:
    - [ ] npx tsc --noEmit + npm run test:run green (per bot CLAUDE.md rule 2)
    - [ ] Owner decides rollout scope (global vs server-only) and CI (ship-as-is vs stand up GHA): decisions 2 & 3
    - [ ] Manual QA: common, forced-ultra, both visibility modes, cooldown, empty/long/mention question
    - [ ] Owner runs npm run deploy + Railway deploy; flip ENABLE_FORTUNE_FEATURE on
    - [ ] Pin a usage note + soft-announce in Discord
  Completion: feature live, checks green, announcement posted
  Depends on: Phase 4
```

---

## 7. TESTING & CI/CD STRATEGY (reality-based)

- **Unit:** `rollFortune.test.ts`: weighted-tier distribution over N runs (ultra within tolerance of its weight) + within-tier pick returns a pool member. Sanitizer test if `sanitizeInput.ts` is extracted. Colocated per bot convention (rule 4).
- **Integration:** command round-trip against a mocked `ChatInputCommandInteraction` (pattern exists in the suite, e.g. `events.routes.test.ts`).
- **E2E (manual):** public path, private path, forced-ultra, cooldown, `@everyone`-in-question (must not ping), oversized question, restart mid-interaction.
- **Regression:** confirm the new `fun/` folder does not disturb the loader or other commands; run the full `npm run test:run` (14 files) once.
- **CI:** none today (decision 3). MVP verification = `npx tsc --noEmit` + `npm run test:run` locally, matching how the bot ships. Standing up a lint+typecheck+test GitHub Actions workflow is offered as a separate scoped follow-up.
- **Rollback:** flip `ENABLE_FORTUNE_FEATURE=false` and redeploy; the command stays registered but no-ops. No other bot behavior touched.

---

## 8. FINAL REVIEW

- Requirements map to Phases 1-4; Phase 5 is verify/decide/ship.
- Internally consistent: one existing bot process, no DB, no new infra, reuses the branded embed + copy-pack + random-util stack.
- Scalability: pool grows via the const array; the `copyOverrides` layer already exists if per-guild admin-editable fortunes are ever wanted (drop-in, no rework). Cooldown Map is fine at single-process scale; Redis only if the bot ever multi-processes (not now).
- DRY posture honored: reuse `getRandom`, `base()`, `getPluginCopy`, the env-flag pattern; the only net-new utils are the per-user cooldown and (maybe) the input sanitizer, both genuinely absent today.
- Remaining owner decisions (ultra creative framing, rollout scope, CI-now-vs-later) are surfaced, not silently chosen.

---

## EXECUTION PROTOCOL

- Execute one phase at a time, in order; re-validate each phase's Completion Criteria before advancing.
- No code until the owner blesses the ultra creative direction (or explicitly defers it to Phase 3 drafting): that is the only content blocker.
- Bot ships via the owner's manual verify + deploy convention (`npx tsc --noEmit`, `npm run test:run`, then `npm run deploy` + Railway): no automated deploy is introduced by this feature unless decision 3 chooses to.
- If new information emerges, update this plan and the Amendment Log rather than improvising silently.

---

## PHASE 5 DELIVERABLES (drafted, owner to post)

**Owner deploy sequence:**
1. Commit the fortune files on `staging` (keep separate from the in-flight v1.6.1 working-tree changes on `master`). Fortune changeset: `src/commands/fun/fortune.ts`, `src/features/fortune/*`, `src/utils/cooldownManager.ts` + `.test.ts`, and the edits to `src/base/copy/brand.ts` + `src/utils/config.ts`.
2. `npm run deploy` to register the command (global registration, every ROK guild gets it).
3. Deploy to Railway.
4. (Removed in v7.) There is no env flag to flip: the command is live as soon as it is deployed and registered.

**Manual QA checklist (in a test guild):**
- [ ] `/fortune` with no options posts a public common reading with the disclaimer footer.
- [ ] `/fortune private:true` posts an ephemeral reading only you see.
- [ ] `/fortune question:"will it rain"` echoes the question above the answer.
- [ ] `/fortune question:"@everyone"` does NOT ping the server (mention parsing disabled).
- [ ] Rapid repeat within 10s shows the cooldown message.
- [ ] Force an ultra hit (temporarily raise `ULTRA_WEIGHT` locally, or roll enough): gold embed + Dero thumbnail render on mobile and desktop.
- [ ] (Kill-switch removed in v7; no "disabled" state to test.)

**Pinned usage note (for the channel):**
> 🔮 **Ask Dero the Oracle**
> Type `/fortune` and Dero will read your future. Add a `question` if you like, or set `private` to keep the reading to yourself. Purely for fun, never real advice. Every so often the crystal ball glows gold for a rare ✨ ultra reading.

**Soft announcement:**
> **New: `/fortune`** 🔮 Dero has taken up fortune telling. Ask him anything with `/fortune` (bring your own question, or keep it private). Most readings are the usual mystical nonsense, but every so often you will hit a rare ✨ ultra reading. All for fun, none of it real advice. Go bother the Oracle.
