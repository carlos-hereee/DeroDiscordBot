# Dero Bot Minigames: Master Plan

> **Reconciliation owed, added 2026-09-11.** This plan sits in `TODO-PLANS/` because its checklist is not reconciled, not because the work is missing.
> An audit on 2026-09-10 verified **5 of 5 phases** at the live call site rather than from this document.
> **41 of its 41 boxes are unticked.** What it owes is a tick pass: verify each box at the call site, then tick it.
> A plan is complete only when every box is ticked AND every tick is accurate, at which point it moves to `COMPLETED-PLANS/` (`CLAUDE.md`, "A PLAN LIVES IN EXACTLY ONE OF TWO FOLDERS").

Drafted 2026-08-07 for silent. Revised 2026-08-07 after silent's command topology decision: the three games no longer ship as three separate slash commands, they ship as native subcommands of ONE command named `/mini-game`, and the already live `/fortune` folds in with them as a fourth subcommand. Covers engineering delivery only, a dice or coin flip duel, a Rock Paper Scissors player challenge, a hangman word game, and the absorbed fortune reading, all shipping on the Dero Discord Bot (`C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot`). The announcement copy itself is a separate, later step, gated by the locked bot release announcement flow, and is deliberately not part of this plan.

## MISSION BRIEF

**Goal:** ship ONE new public, non admin slash command on the Dero Discord Bot, `/mini-game`, carrying four native subcommands (duel, rps, hangman, fortune), so the feature set is real, discoverable, and ready to enter the locked announcement flow. The driving product decision, made by silent on 2026-08-07, is that too many slash commands is itself a usability problem: four separate fun commands crowd a member's picker, while one command with four subcommands lets Discord's own command picker do the menu work for free.

**Target command shape:**

    /mini-game duel      opponent:<user> flip:<dice|coin>
    /mini-game rps       opponent:<user>
    /mini-game hangman
    /mini-game fortune   question:<text optional> private:<true|false optional>

**Tier:** Standard (Tier 2). Four features built almost entirely from existing, well established conventions in an existing codebase. The one genuinely novel design problem, Rock Paper Scissors needing two players to make a secret simultaneous choice, is scoped and resolved inside Technical Design below rather than requiring new platform architecture, so this does not rise to a Tier 3 (new system) plan. The merge itself is a topology change, not a new system: the builder API and the deploy path both already support it.

**Definition of Done:** one command file exists at `src/commands/fun/mini-game.ts`, exports `data` and `execute`, routes all four subcommands through a dispatch table, and is ready for silent's manual `npm run deploy`. The old `src/commands/fun/fortune.ts` is deleted and `/fortune` is gone from the registered command set. `npx tsc --noEmit` and `npm run test` both pass clean. Each game's pure logic module has colocated unit tests, and subcommand routing has its own test. Both copy packs' `commandGuide` name the new command so members can find it. `SACRED_FILES/STATE.md`, the current month's `WIP.md`, and `FUTURE_PLANS.md` or `HISTORICAL.md` reflect the shipped state. The feature set is confirmed playable end to end in the test guild, global propagation is confirmed in a real guild, and the work is explicitly handed off as ready for the announcement flow, a separate initiative this plan does not cover.

**Assumptions (log grows through the plan, nothing buried in prose):**

1. Games follow the `/fortune` and `/secret-code` precedent, feature local copy and embeds, NOT the two voice copy pack system (`rok-commander.pack.ts` / `general-events.pack.ts`). This reverses the pack based assumption this plan started from before verification. The reversal is backed by an explicit comment already in the repo, see Codebase Discovery below, not a guess. The ONE exception this revision introduces is a single `commandGuide` field in both packs, which is a command listing, not game content, see the Phase 5 discoverability task.
2. In memory (process scoped) state for every in progress game, matching the precedent already set by `ActivityTracker`'s voice session cache and `PowerUps`' in flight role resolve map. An in progress game is lost if Railway redeploys mid round. Accepted tradeoff for low stakes, short lived fun, not an oversight.
3. All new files live inside the existing `src/commands/fun/` and a new `src/features/games/` folder, alongside `secret-code.ts`, not a new top level command category. After this revision there is exactly ONE new file under `src/commands/fun/`, not three.
4. No wagering, currency, or persistent win and loss tracking in v1. That would pull in the leaderboard system or a new Mongo model. Out of scope unless silent asks for it as a fast follow. Note that fortune already has persistence (`FortuneBuff`) and keeps it unchanged, this assumption governs the three NEW games only.
5. The challenge and accept step (duel, Rock Paper Scissors) uses an inline component collector scoped to the challenge message, not the persistent `interactionRegistry`. See Solution Brainstorming for the reasoning.
6. `/fortune` IS absorbed. It becomes `/mini-game fortune` and its old command file is deleted. This is a user facing RENAME of one already shipped, generally available command, the only non additive change in this plan. Its options (`question`, `private`), its handler (`respondWithFortune`), its cooldown, its embeds, its orb assets, and its `FortuneBuff` data are all carried over untouched.
7. `/secret-code` is NOT absorbed and stays exactly where it is, as its own top level slash command. Redeeming a code is not a game, it is a persistent account action that happens to buff one of the games. `src/commands/fun/secret-code.ts` is not edited, moved, or deleted by any phase of this plan.
8. The parent `/mini-game` command is a pure CONTAINER. It declares no top level options of its own, because Discord forbids a command from carrying both subcommands and top level options. Every option (`opponent`, `flip`, `question`, `private`) is declared inside its own `addSubcommand` callback. There is no shared `/mini-game` option, and specifically no shared `private` toggle, that flag belongs to the fortune subcommand alone.
9. Every subcommand is open to every member. No admin gate, no Studio early access gate, no tier gate. Silent decided on 2026-08-07 to ship all four games open and tighten later only if real usage justifies it. This is a deliberate choice, not an oversight, and it carries a documented consequence about gate granularity recorded in Technical Design.

**Open Questions (flagged, not silently resolved):**

1. Should finished games ever feed a leaderboard or stat line, or stay one off fun with zero persistence. Recommendation: zero persistence for v1 for the three new games. If silent wants this later, it is a clean fast follow, not a rework, because the pure logic modules already return a structured result.
2. Hangman, public channel game or private ephemeral game. Recommendation: public, channel visible board, anyone in the channel can guess. Reasoning and research are in the Phase 4 spell. This is a real product call, confirm or override before Phase 4 starts.
3. Hangman word list, one general purpose list vs a rok themed and a general themed pair. Recommendation: one general list, consistent with assumption 1 (no two voice split for this feature). Confirm before Phase 4.

Gating is NOT an open question. Assumption 9 records it as a made decision.

---

## 1. GOAL ANALYSIS

**Functional requirements**

- `/mini-game duel opponent:<user> flip:<dice|coin>`, opponent accepts or declines via button, bot resolves immediately by RNG once accepted, embed shows the result.
- `/mini-game rps opponent:<user>`, opponent accepts or declines via button, both players then pick rock, paper, or scissors in secret, bot reveals the result once both picks are in.
- `/mini-game hangman`, posts a public board in the channel, any member can guess a letter through a modal, board updates per guess, round ends in a win or a loss.
- `/mini-game fortune question:<text optional> private:<true|false optional>`, behaves EXACTLY as `/fortune` does today: same option names, same option types, same 200 character cap on `question`, same handler, same cooldown, same embeds. A member who used `/fortune` yesterday must get a byte identical experience under the new path.
- All four subcommands are open to every member, no admin gate and no early access gate, matching the `/fortune` and `/secret-code` precedent and per assumption 9.
- Typing `/mini-game` in Discord's picker lists the four games as a native dropdown, with each game's own description, with no extra bot round trip.
- `/mini-game` with NO subcommand is impossible to invoke. Discord does not let a user submit the bare parent of a subcommand bearing command, the picker forces a subcommand selection before the command can be sent. This is Discord's own behavior, not a gap in this plan, so there is deliberately no "bare command" branch to design, no help embed for it, and no fallback path in `execute`. The dispatch table's unknown subcommand branch exists to catch a coding mistake (a subcommand declared in the builder with no handler registered), not a user reachable state.
- Per user cooldown on each game independently. There is deliberately NO single `/mini-game` cooldown, see the non goal below.
- `/secret-code` continues to work unchanged and continues to buff the fortune subcommand, from outside the `/mini-game` command.

**Explicit non goal: do not collapse the cooldowns.** Each feature owns its own `CooldownManager` instance. `respondWithFortune`'s ten second window is deliberately SHARED between the slash command path and the `#command-center` power up button so a member cannot alternate between the two entry points to bypass the gate. Merging four games under one command must NOT introduce one cooldown for all of `/mini-game`, because playing a round of hangman would then block a fortune reading, which is a behavior regression for a shipped feature. One cooldown per game, keyed the same way `respondWithFortune` already keys its own.

**Non functional requirements**

- No blocking work in the event loop. Discord side effects that follow a successful primary action are fire and forget, logged and swallowed, never thrown back to the caller, matching this codebase's existing convention.
- No memory leak. Every entry written into an in memory game state map is removed on completion, decline, or timeout, no path left behind that leaks.
- Works identically in every guild regardless of the guild's `pluginId` (ROK vs streamer), since these are plain commands, not plugin surfaces.
- The command file itself stays thin. Routing only, zero business logic, per this repo's own convention.

**Constraints**

- **Discord subcommand limits, confirmed against current Discord developer documentation, all four load bearing for this plan:**
  1. A command supports at most **25 options total**, and subcommands count against that same ceiling. Four subcommands is comfortable, with room for a fifth and sixth game before this is worth a second thought.
  2. Nesting is **one level deep only**. A command may hold subcommands, or subcommand groups that hold subcommands, and nothing deeper. `/mini-game duel` is legal. `/mini-game duel dice` as a third level is not.
  3. A command that has subcommands **cannot also carry top level options**, and its bare form becomes unusable. This is why assumption 8 exists and why there is no shared `private` toggle: `private` is declared on the fortune subcommand itself.
  4. There is a combined **8000 character budget** across every name, description, and choice value on the command. Four subcommands with short descriptions sits nowhere near it, but it is a real ceiling and it is shared, so a future session adding a tenth game with a long description should count.
- Discord component limits: 25 buttons max per message (5 rows times 5), 25 options max per select menu, 5 components max per modal. None of these are close to being hit by any single component set in this plan, but the alphabet (26 letters) is why hangman needs a modal rather than a button or select grid.
- A modal cannot be deferred. It must be the first response to whatever interaction opens it.
- An interaction token stays valid for `followUp()` calls for up to 15 minutes. Long enough for any reasonable challenge or accept window in this plan, with margin.
- Production registers GLOBAL application commands, which can take up to an hour to propagate to every user. See Codebase Discovery and the Phase 5 sequencing rule.
- Pure ESM. Every local import needs the `.js` suffix even though the source is `.ts`.
- No dashes anywhere in code comments or copy strings, not even compound words. Hyphens inside identifiers (`secret-code`, `mini-game`, `rok-commander.pack.ts`) are identifiers, not dashes, and stay.
- The owner runs `npm run build`, `npm run deploy`, and any git push manually. This plan writes files only.

**Unknowns:** pushed to Open Questions in the Mission Brief.

**Acceptance criteria**

- Typing `/mini-game` in a real guild lists four subcommands in Discord's own picker, each with its own description.
- Two real Discord accounts can play a full `/mini-game duel` and a full `/mini-game rps` against each other in the test guild, with an accurate, non leaking result.
- One real Discord account can start and finish a `/mini-game hangman` round, win and lose paths both verified.
- `/mini-game fortune` produces the same reading experience `/fortune` produced, including the private flag, the question echo, the cooldown message, and the ultra orb path.
- `/fortune` no longer appears in the picker after `npm run deploy`, with no manual deregistration step performed.
- The `#command-center` Summon Dero card's Fortune button still works, unchanged.
- `/secret-code` still works and still buffs the fortune subcommand.
- `npx tsc --noEmit` and `npm run test` pass clean, and `npm run lint` reports no NEW error in any file this plan writes (see the lint baseline note in Codebase Discovery; the bot's lint is already red, so "clean" is not an honest bar here).
- Both packs' `commandGuide` list `/mini-game` and `/secret-code`.
- SACRED_FILES ledgers updated in the same session the work ships.

---

## 2. CODEBASE DISCOVERY

Everything in this section was confirmed against live code on 2026-08-07. Where a claim in an earlier draft turned out to be wrong, the correction is stated inline rather than quietly dropped.

**Command contract, and the fact that it is documentary rather than enforced.** `src/base/interfaces/ICommand.ts` declares `data: SlashCommandBuilder` and `execute: (interaction: ChatInputCommandInteraction) => Promise<void>`. **No command file in this repo actually annotates its export against that interface.** `src/commands/fun/fortune.ts` writes `export const data = new SlashCommandBuilder()...` with no type annotation at all, and it already relies on that: calling `.addStringOption()` narrows the builder's TypeScript type AWAY from `SlashCommandBuilder`, so an explicit `: SlashCommandBuilder` annotation on that file would not compile today either. Both loaders confirm the contract is structural, not nominal: `src/main.ts`'s boot loop and `src/deploy-commands.ts` each `await import(...)` the module dynamically and check only `if ("data" in command && "execute" in command)`. **This matters for the merge**, because `.addSubcommand()` narrows the builder the same way, to a subcommands only builder type. **The new `mini-game.ts` must therefore NOT annotate its `data` export**, letting inference carry the narrowed type exactly as every existing command file does. If `ICommand` is updated for accuracy, widen its `data` field to a union that admits the subcommand builder type. **Never resolve this with a cast to `any`.**

**Both runtime gates key on the command NAME only.** In `src/main.ts` the admin guard reads `ADMIN_COMMANDS.has(interaction.commandName)` and the early access gate reads `checkEarlyAccess(interaction.commandName, interaction.guildId)`. `src/features/early-access/earlyAccess.ts` keys `EARLY_ACCESS_FEATURES` by slash command name, and its own header documents the purpose as shipping new Dero powers to Studio guilds first, "a ONE-LINE entry here plus the command itself." `interaction.commandName` for a subcommand invocation is the PARENT name, `mini-game`, with the subcommand available only via `interaction.options.getSubcommand()`. So once every game is a subcommand, neither gate can address a single game: listing `mini-game` would gate all four at once, including fortune, which is already live and generally available to everyone. Per assumption 9 no gating work ships in this plan. The consequence is recorded in Technical Design with the fix a future session would apply.

**The deploy script replaces the whole command set, so old names retire automatically.** `src/deploy-commands.ts` issues `rest.put(Routes.applicationCommands(clientId), { body: commands })` in production. A `PUT` overwrites the ENTIRE registered command set with the body, it does not merge. So deleting `src/commands/fun/fortune.ts` and adding `mini-game.ts` deregisters `/fortune` with no extra step. **Nobody should write a manual cleanup task, a delete call, or a one off script for this.** The dev branch does the same `PUT` against `Routes.applicationGuildCommands` per guild id, with the same replace semantics.

**Production registers GLOBAL commands, which propagate slowly.** The same script branches on `isProduction`: production hits `Routes.applicationCommands` (global) and logs `LOG_MESSAGES.deploy.globalPropagationNote`, dev hits `Routes.applicationGuildCommands` per guild (effectively instant). Global application command updates can take up to an hour to reach every user. This is a hard sequencing constraint on Phase 5, see that phase's propagation gate.

**The release announcement fires on the package.json version bump.** `src/features/announcements/postFeatureAnnouncement.ts` resolves `BOT_VERSION` from `package.json` at module load, keys idempotency with `featureAnnouncedEvent(BOT_VERSION)` in `botLogStore`, and posts each pack's `featureAnnouncement` block to `#announcements` and `#inner-sanctum` on the first boot after a deploy that carries a new version. Current version is `1.6.1`. This is the mechanical reason the propagation gate must sit BEFORE the version bump: bumping the version is what fires the announcement, and announcing a command members cannot yet see is worse than announcing late. It also means `VERSION_SHIPPED_AT` in that file wants an entry for whatever version ships this work, which belongs to the announcement flow, not to this plan.

**Old command name blast radius, re run this session across all of `DeroDiscordBot/src`. An earlier claim was WRONG and is corrected here.** The earlier claim was that `/fortune` appears only inside code comments and never inside a copy string. That is not true. The grep result:

- Code comments only, no action needed: `src/base/copy/brand.ts`, `src/commands/fun/fortune.ts`, `src/commands/fun/secret-code.ts`, `src/db/models/FortuneBuff.ts`, `src/db/stores/fortuneBuffStore.ts`, `src/features/fortune/*`, `src/features/power-ups/PowerUps.ts`, `src/utils/cooldownManager.ts`.
- **Live copy strings, two per pack, four total:** `featureAnnouncement.public.description` and `featureAnnouncement.innerSanctum.description` in BOTH `rok-commander.pack.ts` and `general-events.pack.ts` each name `` `/fortune` `` inside the launch release announcement prose.
- **Not present** in either pack's `commandGuide`, in `adminCommandGuide`, in `src/features/setup/ChannelContent.ts`, in `src/utils/embedBuilder.ts`, in `src/base/constants/log-messages.ts`, or in any embed or button label. Both packs' `commandGuide.fields` list exactly `/leaderboard`, `/list-events`, and `/suggestion-box`, and neither mentions any fun command.

**So the corrected conclusion:** the code blast radius of the rename is still small, one command file deleted and nothing else in the running surfaces, but it is not zero copy. The four `featureAnnouncement` strings are the launch release's own historical prose and they are LIVE in the sense that `postFeatureAnnouncements` broadcasts whatever sits in that block on the next version bump. Rewriting those blocks is what the announcement flow does for every release anyway, so the fix lands there, not here. It is recorded in the Risk Register so nobody ships a version bump with launch era copy still pointing members at a command that no longer exists.

**The fortune power up button is unaffected and must stay that way.** `src/features/power-ups/PowerUps.ts` routes its `powerup:member:fortune` button straight into `respondWithFortune`, never through the slash command, gated only by the `POWERUP_ACTIONS` table (`"member:fortune": { adminOnly: false }`). That button rides the Summon Dero invite card built in `GuildSetupManager.inviteCardComponents()`, alongside the invite link and the Icebreaker button. **The button, its `customId`, `POWERUP_ACTIONS`, `buildFortuneButton()`, `inviteCardComponents()`, and the module scope cooldown `Map` that `respondWithFortune` owns are ALL untouched by this plan.** The merge deletes only the thin command file at `src/commands/fun/fortune.ts`, never anything under `src/features/fortune/`.

**Stored fortune data is untouched, no migration exists to write.** `src/db/models/FortuneBuff.ts` keys rows by `userId` with `unique: true` and carries `weight`, `dryStreak`, and `code`. There is no command name anywhere in the schema, the store, or the indexes, so a command rename cannot orphan a redeemed buff or reset a pity streak. `/secret-code` writes through `fortuneBuffStore.grantIfHigher` exactly as before. **Do not write a migration. There is nothing to migrate.**

**Cooldowns are per feature, and one of them is deliberately shared across entry points.** `src/utils/cooldownManager.ts`'s `CooldownManager` is a generic in memory per key window, `check()` before acting, `record()` only after success. `respondWithFortune.ts` shows the house pattern: `const cooldown = new CooldownManager(FORTUNE_COOLDOWN_MS)` at module scope with `FORTUNE_COOLDOWN_MS = 10_000`, keyed `` `${interaction.guildId ?? "dm"}:${interaction.user.id}` ``, shared by BOTH the slash command and the invite card button so alternating between them cannot bypass the gate. Because the fortune subcommand calls the same `respondWithFortune`, it inherits that cooldown with zero work and the shared gate keeps holding. Each new game gets its OWN instance, see the non goal in Goal Analysis.

**A dispatch table precedent already exists in this repo.** `src/features/power-ups/PowerUps.ts` declares `const POWERUP_ACTIONS = { "member:subscribe": {...}, "member:greet": {...}, "member:fortune": {...}, "admin:refresh": {...} } as const satisfies Record<string, { adminOnly: boolean }>`, and `handlePowerUpButton` reads that table to (a) reject an unknown or retired key and (b) decide whether to gate the click. The merged command file should mirror this exact shape, so adding a fifth game is one table entry rather than a new `switch` arm. Note the pattern the table also gives for free: an unrecognized key is an explicit, handled branch, not a silent fall through.

**Admin gating.** `BOT_CONSTANTS.ADMIN_COMMANDS` in `src/base/constants/BOT_CONSTANTS.ts` is the admin command allowlist and currently holds seven entries, all schedule and event admin commands. `/fortune` and `/secret-code` are deliberately excluded. `mini-game` must be excluded too, per assumption 9.

**Verification commands, and the lint baseline. Corrected during Phase 1 execution on 2026-08-08.** Two things this plan asserted before Phase 1 ran turned out to be wrong about the repo, and both are corrected here rather than left to mislead a later phase.

- **There is no `npm run test:run` script.** `package.json` declares `"test": "vitest run"` and `"test:watch": "vitest"`. The verification command is `npm run test`. Every reference in this plan has been corrected.
- **`npm run lint` is ALREADY RED on this repo, and "clean" was never an achievable gate.** Baseline measured on 2026-08-08 before any Phase 1 file was written: **19 errors, all of them the same one.** `tsconfig.json` excludes `**/*.test.ts` while `eslint.config.js` ignores only `dist/`, `node_modules/`, and `scripts/`, so every single test file in the repo fails to parse with `"parserOptions.project" has been provided ... The file was not found in any of the provided project(s)`. On top of that, `src/features/events/GuildEventManager.ts` carries 2 real `no-shadow` errors on a `config` binding. Phase 1 added its two test files, so the count is now 21, and **every one of the 21 is one of those two pre-existing conditions**. Zero lint errors come from any non test source file this plan writes.

**So the honest gate for every phase is: `npx tsc --noEmit` clean, `npm run test` clean, and `npm run lint` producing no NEW error in a file this plan touched.** Do not chase "lint clean" on the bot; it is not reachable without a separate eslint config change (adding a test-file override or a second tsconfig that includes them), which is real, worth doing, and deliberately OUT of this plan's scope. Flagged for silent as its own decision, not folded into feature work.

**The corrected copy and embed precedent.** This was the single most important discovery in the first pass and it still holds. `src/features/fortune/fortuneCopy.ts` carries this comment verbatim: "Feature local copy module. Centralizes every string the command shows so none is hardcoded in the handler, WITHOUT threading through the pluginId copy packs (the fortune command is not a platform plugin). If it ever graduates into a real plugin, this content moves into the pack and copyOverrides system." `src/features/fortune/fortuneEmbed.ts` carries a matching comment: it does NOT reuse `embedBuilder.base()` on purpose, because `base()` resolves branding through `getPluginCopy(guildConfig)`, which couples a caller to the pluginId copy pack system, and `/fortune` is "a plain command, not a plugin." `src/base/copy/brand.ts`'s `COLORS` object already carries `FORTUNE` and `FORTUNE_ULTRA` keys, living directly in the shared, pack agnostic brand file, with a comment stating the palette is "neutral by design, the kingdom vs streamer split happens in words, not in chrome." Rock Paper Scissors, a dice duel, and hangman are exactly as guild agnostic as a fortune reading, arguably more so. They follow the same pattern: feature local copy files, embeds that pull `AUTHOR` and `COLORS` straight from `brand.ts`, new color keys added to `brand.ts` directly. They do NOT touch `rok-commander.pack.ts`, `general-events.pack.ts`, or `IPluginCopy`, with the single `commandGuide` exception noted in assumption 1.

**Two interaction patterns already in production.** Persistent, globally registered handlers via `src/handlers/interactionRegistry.ts` (`registerButton(prefix, handler)`, customIds shaped `` `<prefix>:<arg1>:<arg2>` ``, throws on a duplicate prefix), used for UI meant to keep working indefinitely and survive a restart (decree edit buttons, poll buttons, power up buttons). Inline collectors (`awaitMessageComponent` / `createMessageComponentCollector`) scoped to one command's own execution, used for short lived flows (the KvK season config checklist, the decree edit apply once vs apply permanent branch). A challenge is the second kind: one shot, tied to a single message, does not need to survive a restart.

**A real, already hit Discord.js gotcha.** `CHANGELOG.md` documents a discord.js 14.25 bug this codebase already ran into: a `StringSelectMenu` and a button silently drop input when they share ONE ephemeral message. The fix was moving the select to its own follow up ephemeral and using `createMessageComponentCollector` with an explicit `ComponentType` filter instead of `awaitMessageComponent`. Directly relevant to Rock Paper Scissors's two secret choice prompts, each player needs their own separate ephemeral message.

**The modal precedent.** `src/features/schedule/decreeEditHandlers.ts` is this codebase's one existing modal (three text inputs, validated on submit). The official discord.js guide (fetched during the first pass) confirms `TextInputBuilder` supports `setMaxLength()` and `setMinLength()`, that a modal cannot be deferred (must be the first response to its triggering interaction), and that a modal supports at most five top level components.

**The pinned guide edits itself in place on boot.** `GuildSetupManager.refreshIntroEmbeds` sweeps the stored intro message ids on every boot and edits each pinned embed in place when its generated content differs from what is posted, guarded by an embed equivalence check so an unchanged embed is not rewritten. The packs' own comments name this as the ONLY sanctioned anchor edit path ("Never edit this by tweaking past messages, refreshIntroEmbeds is the only safe place to anchor-edit; one-shot announcements like this one stand as posted"). That is what makes the Phase 5 `commandGuide` edit land on every existing guild with no re run of `/setup`, and it is also why that edit does NOT substitute for a fresh announcement post.

**What NOT to copy.** `src/commands/events/rps.ts`, `eightBall.ts`, `sun-qoute.ts`, and `poll.ts` are fully commented out, pre slash command stub files. They export nothing a loader can use. Reference only as an example of the old prefix command pattern to avoid, never revive them. Note especially that a dead `rps.ts` already exists under `src/commands/events/`, which is one more reason the live Rock Paper Scissors implementation belongs inside `mini-game.ts` and `src/features/games/`, not in a new file with a colliding basename.

**`main.ts`'s command pipeline**, relevant so nothing in this plan fights it: the boot time loader builds `client.commands` keyed by `command.data.name`, the `InteractionCreate` listener checks autocomplete, then persistent buttons via `dispatchButton`, then persistent modals via `dispatchModal`, then chat input commands, gated by `ADMIN_COMMANDS` (skipped here) and the early access check (skipped here). None of this needs to change for one new public command in an existing folder. The `client.commands` key becomes `mini-game`, and `fortune` drops out of the collection the moment its file is deleted.

---

## 3. SOLUTION BRAINSTORMING

Blocks A through D were settled in the first pass and are unchanged. Block E is new and is the load bearing decision of this revision.

**A. Copy and embed home.**
Option A, thread through the two voice copy packs, was this plan's starting assumption. Rejected on verification: it would double the authoring work for content with no natural kingdom vs streamer split ("rock beats scissors" has no kingdom voice), and it directly contradicts the documented, shipped precedent in `fortuneCopy.ts`.
Option B (recommended), feature local copy in a new `src/features/games/gamesCopy.ts`, embeds pulling `AUTHOR` / `COLORS` from `brand.ts` directly, new `COLORS` keys added there. Matches the closest real precedent in this exact codebase, half the authoring work, and is the pattern silent already approved once for `/fortune`.

**B. Challenge and accept mechanism.**
Option A, register accept and decline as persistent `interactionRegistry` handlers. Works, but a challenge is not the kind of control that needs to outlive its own message or survive a restart, and a persistent handler has to defend its customId space forever.
Option B (recommended), an inline `createMessageComponentCollector` scoped to the challenge message, mirroring the KvK checklist and decree edit apply scope patterns already in this codebase. Simpler lifecycle, no growth of the persistent registry's surface area, matches the existing distinction this codebase already draws between the two patterns.

**C. Rock Paper Scissors secret choice delivery.**
Option A, DM each player their choice buttons. Rejected: many members block DMs from strangers or have them off by default, and this bot already treats blocked or restricted DMs as a real failure mode elsewhere (see the auto leave on Missing Permissions handling in `main.ts`), no reason to introduce a new DM dependency for a fun feature.
Option B (recommended), reply ephemerally to the opponent's own Accept button interaction with their choice prompt, and use `followUp()` on the ORIGINAL challenger interaction (held in the challenge state) to deliver the challenger's own separate ephemeral prompt at the same moment. No DMs, both comfortably inside the 15 minute interaction token window. Public research (the Discord Mini Games JS library's Rock Paper Scissors module) confirms the challenge and accept shape but does not document a specific secret choice mechanism, so there is no single established pattern to defer to, this is this plan's own reasoned design.

**D. Game state storage.**
Option A, MongoDB, a new model and store. Rejected for v1: real overhead (schema, store, migration discipline) for state that lives seconds to a few minutes.
Option B (recommended), in memory `Map`s, matching `ActivityTracker`'s voice session cache and `PowerUps`' in flight role resolve map. Explicit tradeoff: an in progress game is lost on a Railway redeploy. Acceptable for low stakes fun, revisit only if usage data says otherwise.

**E. Command topology, one command or four.**
The problem silent named: four separate fun slash commands (`/duel`, `/rps`, `/hangman`, `/fortune`) crowd a member's picker, and a picker crowded with one off fun commands makes the bot's real work harder to find. Three real alternatives were weighed.

Option A (CHOSEN), **native Discord subcommands** on a single `/mini-game` command. Discord's own command picker renders the four games as a dropdown the moment a member types `/mini-game`, with each subcommand's own description shown inline, at zero cost in bot code and zero extra round trips. Each game keeps its OWN typed options declared inside its own `addSubcommand` callback, so `opponent` can be `required` on duel and rps and simply not exist on hangman, and `question` and `private` can stay exactly the optional pair fortune already ships. Discord validates all of it before the interaction reaches the bot. The costs are honest and small: the parent command cannot carry top level options (constraint 3), and both runtime gates lose per game granularity (recorded in Technical Design). Neither cost is paid by this plan's feature set.

Option B (rejected), **one command with a `game` choice option**, for example `/mini-game game:<duel|rps|hangman|fortune> opponent:<user> question:<text>`. Rejected because every game would share ONE option set. `opponent` would have to be declared optional so hangman and fortune can run without it, which means the bot has to hand validate "duel without an opponent" at runtime and reject it with an error a member never should have been able to trigger. Worse, invalid combinations become EXPRESSIBLE: `/mini-game game:hangman opponent:@someone question:"will I win"` is a syntactically valid invocation of a meaningless command. Discord's own picker also shows a flat option list rather than a game menu, so this loses the discoverability that motivated the merge in the first place.

Option C (rejected), **a select menu component posted by a bare command**, where `/mini-game` replies with a game picker the member clicks. Rejected on two counts. It costs an extra round trip before any game starts, turning a one step invocation into two. And it cannot collect a target user: choosing an opponent through a component means posting a SECOND picker (a user select menu) after the game choice, which is a third round trip for duel and rps, on top of the discord.js 14.25 bug this codebase already hit where a select and a button on one shared ephemeral message silently drop input. More moving parts, more known failure surface, worse ergonomics.

**Why A wins:** it is the only option where Discord does the menu rendering, the per game option typing, and the invalid combination rejection for free, and it is the only one that preserves the existing `/fortune` option contract exactly, which matters because fortune is a shipped command with members already using it.

---

## 4. IMPACT ANALYSIS

**Files to create**

- `src/commands/fun/mini-game.ts`, the ONE new command file. Builder with four `addSubcommand` callbacks, plus the dispatch table and a thin `execute`. Zero business logic.
- `src/commands/fun/mini-game.test.ts`, subcommand routing tests.
- `src/features/games/duelHandler.ts`, `rpsHandler.ts`, `hangmanHandler.ts`. **Created in Phase 1 as STUB MODULES**, each exporting its real handler name with a placeholder body. Phases 2 through 4 replace only the body. Stubbing at the module boundary rather than inline in the command file is what lets a later phase change nothing about `mini-game.ts` and lets the routing test mock each handler by specifier.
- `src/features/games/challengeFlow.ts` + `challengeFlow.test.ts`
- `src/features/games/gamesCopy.ts`
- `src/features/games/gamesEmbeds.ts`
- `src/features/games/gamesAssets.ts` + `gamesAssets.test.ts`. **Added during Phase 2 on the owner's decision to use custom game art.** The art manifest plus a resolver that `existsSync` checks each declared file and falls back to the bundled Dero avatar when it is absent, so every game renders a real picture from day one and finished art drops in with no code change. See the art note in Technical Design.
- `src/features/games/duelResolve.ts` + `duelResolve.test.ts` (pure)
- `src/features/games/duelHandler.ts` (Discord facing)
- `src/features/games/rpsWinner.ts` + `rpsWinner.test.ts` (pure scoring, the nine combinations)
- `src/features/games/rpsRound.ts` + `rpsRound.test.ts` (pure round state machine). **Added during Phase 3.** The plan originally folded the race into the handler, but racing logic buried inside an async Discord handler is close to untestable. Pulled out, `applyPick` is a SYNCHRONOUS function that claims the reveal for at most one caller ever, and `closeRound` lets a timeout and a just in time throw settle without contradicting each other. Both invariants then have exhaustive unit tests instead of a comment.
- `src/features/games/rpsHandler.ts` + `rpsHandler.test.ts` (Discord facing). The handler test exists for the one claim only it can reach: that the two players' controls live on two SEPARATE ephemeral messages.
- `src/features/games/hangmanState.ts` + `hangmanState.test.ts` (pure rules: masking, case folding, what does and does not cost an attempt, win and loss)
- `src/features/games/hangmanWords.ts`
- `src/features/games/hangmanHandler.ts` + `hangmanHandler.test.ts` (Discord facing). Exports BOTH `runHangman` (the slash path) and `startHangmanRound` (the shared core), because the admin dashboard button is a second entry point into the same round, mirroring how `/fortune` and the invite card Fortune button share `respondWithFortune`.
- `src/features/games/fortuneHandler.ts`, a thin adapter that reads `question` and `private` off the subcommand and calls the EXISTING `respondWithFortune`. It exists so the dispatch table has four entries of one uniform shape and the command file holds no option reading logic of its own. It contains no fortune logic.

**Files to DELETE**

- `src/commands/fun/fortune.ts`, and nothing else. This is the entire deletion list.
- **Explicitly NOT deleted:** everything under `src/features/fortune/` (`respondWithFortune.ts`, `fortuneCopy.ts`, `fortuneEmbed.ts`, `fortunes.ts`, `rollFortune.ts`, `rollFortune.test.ts`, `secretCodes.ts`), `src/db/models/FortuneBuff.ts`, `src/db/stores/fortuneBuffStore.ts`, the fortune orb assets, and the `COLORS.FORTUNE` / `COLORS.FORTUNE_ULTRA` keys in `brand.ts`. The deleted file is 30 lines of option reading that `fortuneHandler.ts` replaces.
- No deregistration task accompanies the deletion. The `PUT` in `deploy-commands.ts` retires `/fortune` on its own, see Codebase Discovery.

**Files to modify**

- `src/base/copy/brand.ts`: add `GAME_CHALLENGE`, `GAME_DUEL`, `GAME_RPS`, `GAME_HANGMAN` to `COLORS`. Existing `FORTUNE` and `FORTUNE_ULTRA` keys stay untouched.
- `src/base/copy/packs/rok-commander.pack.ts`: one new field in `commandGuide.fields`, in kingdom voice. Phase 5.
- `src/base/copy/packs/general-events.pack.ts`: the same field in plain voice. Phase 5.
- `src/base/interfaces/ICommand.ts`: OPTIONAL accuracy fix only. If touched, widen `data` to a union admitting the subcommands only builder type (`SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder`, or a structural `Pick` of `name` and `toJSON`). Never `any`. This file is documentary, nothing enforces it, so leaving it alone is also a defensible choice, but the new command file must not be annotated against it either way.
- `SACRED_FILES/STATE.md`, `SACRED_FILES/2026-08/WIP.md`, and `SACRED_FILES/2026-08/FUTURE_PLANS.md` or `HISTORICAL.md`: Phase 5 only, per this repo's own THE SECOND LAW (ledgers updated the same session work ships).

**Explicit guardrails, files this plan does NOT touch**

- **`src/commands/fun/secret-code.ts`.** Out of scope by decision, per assumption 7. Not absorbed, not moved, not edited, not deleted. It stays a top level command and keeps buffing the fortune subcommand from outside `/mini-game`. The only place this plan mentions it in shipped output is the `commandGuide` field, which NAMES it alongside `/mini-game` without changing it.
- **Everything under `src/features/fortune/`.** The merge takes the command file only.
- **`buildFortuneButton()`, the `member:fortune` entry in `POWERUP_ACTIONS`, `runFortune`, and `GuildSetupManager.inviteCardComponents()`. The Fortune button on the Summon Dero card is untouched.** **AMENDED during Phase 4, by the owner's decision on 2026-08-08:** `PowerUps.ts` itself is no longer off limits, because admins now get a "Post hangman" button on the admin controls card. What was added: an `admin:hangman` entry in `POWERUP_ACTIONS`, a button in `buildAdminControlButtons()`, a `case` in the switch, and a `runPostHangman` that resolves `commandsChannelId` and calls the games feature's shared `startHangmanRound`. Everything named at the top of this bullet stays untouched, which was the guardrail's actual purpose. `GuildSetupManager` needs NO edit: it composes `buildAdminControlButtons()`, and `refreshIntroEmbeds`' `componentsAreEquivalent` check re-edits every existing guild's pinned admin card on the next boot.
- `src/commands/events/rps.ts`, `eightBall.ts`, `sun-qoute.ts`, `poll.ts`: dead stubs, leave alone. Deleting them is a legitimate separate cleanup silent can decide on later, not bundled into feature work.
- `src/base/copy/types.ts` and the packs' game CONTENT: per assumption 1, game copy does not enter the pack system. The single `commandGuide` field is a command listing, not game content, and adds no new key to `IPluginCopy`.
- `BOT_CONSTANTS.ADMIN_COMMANDS`: `mini-game` is NOT added. Games stay public.
- `EARLY_ACCESS_FEATURES` in `src/features/early-access/earlyAccess.ts`: `mini-game` is NOT added. See the gate granularity note in Technical Design for why adding it would be an all or nothing switch even if silent later wanted one game gated.

**Routing design note.** The merged command file must stay thin, because this repo's own rule is that business logic never lives in a command file, and folding four games into one file is exactly the moment that rule is easiest to break. The shape:

    // src/commands/fun/mini-game.ts
    const MINI_GAME_HANDLERS = {
      duel: runDuel,
      rps: runRps,
      hangman: runHangman,
      fortune: runFortune,
    } as const satisfies Record<string, (interaction: ChatInputCommandInteraction) => Promise<void>>;

Mirrors `POWERUP_ACTIONS` in `src/features/power-ups/PowerUps.ts` deliberately, so a reader who knows one knows the other, and so adding a fifth game is ONE table entry plus one `addSubcommand` callback rather than a new `switch` arm. `execute` reads `interaction.options.getSubcommand()`, looks the name up in the table, and calls it. An unrecognized name is an explicit, loud branch (log the name, reply with the generic `errorEmbed`), never a silent no op, because the only way to reach it is a builder and table mismatch a developer introduced. Each handler keeps living in its own feature module under `src/features/games/`, and `runFortune` is a thin call into the existing `respondWithFortune`, importing nothing new from the fortune feature beyond what `fortune.ts` already imported.

**Dependency graph.** `mini-game.ts` depends on all four handlers and on `gamesCopy.ts` (for the parent and subcommand descriptions). `duelHandler.ts` and `rpsHandler.ts` depend on `challengeFlow.ts`; `hangmanHandler.ts` and `fortuneHandler.ts` do not. Each handler depends on its own pure module (`duelResolve`, `rpsWinner`, `hangmanState`) and on `gamesEmbeds.ts`. `fortuneHandler.ts` depends only on `@features/fortune/respondWithFortune.js` and adds no new coupling. `gamesCopy.ts` and `gamesEmbeds.ts` underlie the three new games; fortune keeps using `fortuneCopy.ts` and `fortuneEmbed.ts` so its output does not drift. `challengeFlow.ts` is imported by exactly two handlers.

**Data flow.** Command invoked, Discord validates the subcommand and its options before the interaction arrives, `execute` routes on the subcommand name, the handler checks its own cooldown, issues a challenge (duel, rps) or starts a round (hangman) or calls `respondWithFortune` (fortune), Discord interaction round trip (accept, secret pick, or modal guess), pure logic module resolves the outcome, embed rendered from `brand.ts` colors and `gamesCopy` strings, state map entry cleaned up.

**Component flow (per subcommand, since this is a bot, not a frontend).** Duel: challenge embed, Accept/Decline row, resolution embed. Rock Paper Scissors: challenge embed, Accept/Decline row, two separate ephemeral rock/paper/scissors button rows, reveal embed. Hangman: public board embed, a "Guess a letter" button, a one field modal, board re render per guess, end state embed. Fortune: unchanged from today, the existing orb embed, ephemeral when `private` is true.

**Risk Register**

1. **Rock Paper Scissors race condition** (both players pick within the same tick). Likelihood: low but real. Mitigation: the reveal only fires once both picks are recorded, gated by a synchronous "already resolved" check with no `await` between the check and the write. Tested explicitly in Phase 3. Rollback: revert that phase's files, no data migration, state is in memory only.
2. **Discord modal and component gotchas** (modal must be the first response and cannot be deferred, a select and a button can silently drop input on a shared ephemeral message). Likelihood: medium, this codebase has hit an adjacent bug before. Mitigation: follow the exact mechanism named in the Phase 3 and Phase 4 spells, manually verify the accept then immediate ephemeral prompt flow in the test guild before calling either phase done. Rollback: same as above.
3. **Memory leak from abandoned challenges or hangman rounds.** Likelihood: medium if timeouts are wired loosely. Mitigation: every map entry gets a paired cleanup path on completion, decline, and timeout, mirroring `PowerUps`' finally block discipline. Phase 1's completion criteria requires this explicitly, Phase 4 restates it for hangman's own map.
4. **A future contributor defaults back to the pack system out of habit.** Likelihood: low but real, since most of this codebase does use the pack system. Mitigation: `gamesCopy.ts` carries an explanatory comment mirroring `fortuneCopy.ts`'s, and this document is the durable record of the decision. The one `commandGuide` field is called out as the deliberate, bounded exception so it does not read as precedent for moving game content into the packs.
5. **Discord rate limits from rapid game turns in an active channel.** Likelihood: low at this bot's current scale. Mitigation: reuse `CooldownManager` per game, do not add per guild throttling unless real usage shows a need.
6. **Global propagation lag on a production deploy.** Likelihood: certain, this is how Discord works, not a maybe. `deploy-commands.ts` registers GLOBAL commands in production and those can take up to an hour to reach every user, so for a window after `npm run deploy` some members will still see `/fortune` in their picker and no `/mini-game`, and a member who invokes the stale `/fortune` gets `noCommandMatch` because the file is gone from `client.commands`. Mitigation: the Phase 5 sequencing rule, verify propagation in a real guild BEFORE the version bump. Rollback: restore `fortune.ts` and re run deploy, which also takes up to an hour to propagate, so the verification gate is cheaper than the rollback.
7. **A live, shipped command was renamed and members have muscle memory for it.** Likelihood: certain for anyone who has used `/fortune`. `/fortune` has been live and generally available since launch and is one of the bot's most member facing features, with its own invite card button and its own secret code economy. After the merge, typing `/fortune` finds nothing. Mitigation: the release announcement MUST say explicitly where it went ("the crystal ball now lives under `/mini-game fortune`"), the `commandGuide` field names the new path on every guild's pinned member guide, and the Summon Dero card's Fortune button keeps working the whole time so the button path never breaks even for a member who cannot find the command. This is a hard requirement on the announcement flow, carried in the Phase 5 handoff note, not an optional nicety.
8. **The packs' `featureAnnouncement` blocks still name `` `/fortune` `` in live copy.** Likelihood: certain unless someone acts. All four blocks (public and inner sanctum, both packs) are launch release prose that names the old command, and `postFeatureAnnouncements` broadcasts whatever sits in that block on the first boot after a version bump. Bumping the version with those blocks unchanged would post copy pointing members at a command that no longer exists. Mitigation: the announcement flow rewrites both blocks in both packs for every release anyway, so the fix lands there; this plan's job is to make sure the announcement flow KNOWS, which the Phase 5 handoff note does. Do not fix it inside this plan, a half rewritten announcement block is worse than an untouched one.
9. **A future contributor annotates the new `data` export and reaches for a cast.** Likelihood: medium, because `ICommand` says `data: SlashCommandBuilder` and looks authoritative. `.addSubcommand()` narrows the type away from `SlashCommandBuilder`, so an annotation fails to compile and the tempting fix is `as any` or `as SlashCommandBuilder`, either of which silently discards the builder's real type. Mitigation: `mini-game.ts` carries a comment stating why `data` is unannotated and pointing at `fortune.ts`'s identical (pre deletion) precedent with `.addStringOption()`; if `ICommand` is touched at all it is WIDENED to a union, never satisfied by a cast.

---

## 5. TECHNICAL DESIGN

**Command builder shape.** One `SlashCommandBuilder` named `mini-game`, with a description, and four `addSubcommand` callbacks. The parent declares NO options of its own (constraint 3 in Goal Analysis), so every option lives inside its subcommand:

    export const data = new SlashCommandBuilder()
      .setName("mini-game")
      .setDescription(gamesCopy.commandDescription)
      .addSubcommand((sub) =>
        sub.setName("duel").setDescription(gamesCopy.duel.subcommandDescription)
          .addUserOption((o) => o.setName("opponent").setDescription(...).setRequired(true))
          .addStringOption((o) => o.setName("flip").setDescription(...).setRequired(true)
            .addChoices({ name: "Dice", value: "dice" }, { name: "Coin", value: "coin" })))
      .addSubcommand((sub) =>
        sub.setName("rps").setDescription(...)
          .addUserOption((o) => o.setName("opponent").setDescription(...).setRequired(true)))
      .addSubcommand((sub) => sub.setName("hangman").setDescription(...))
      .addSubcommand((sub) =>
        sub.setName("fortune").setDescription(fortuneCopy.commandDescription)
          .addStringOption((o) => o.setName("question").setDescription(fortuneCopy.questionOptionDescription).setMaxLength(200).setRequired(false))
          .addBooleanOption((o) => o.setName("private").setDescription(fortuneCopy.privateOptionDescription).setRequired(false)));

**`data` is deliberately NOT annotated.** `.addSubcommand()` narrows the builder's type to a subcommands only builder, which is not assignable to `SlashCommandBuilder`. Every existing command file in this repo already relies on inference for the same reason (`fortune.ts` narrows via `.addStringOption()`), and both loaders check only for the presence of the string keys `"data"` and `"execute"`, so nothing enforces the interface at compile time. Let inference carry the narrowed type. If `ICommand` is corrected, widen its `data` field to a union that admits the narrowed builder types. Never a cast to `any`.

**Subcommand routing contract.** `execute` does four things and nothing else: read `interaction.options.getSubcommand()`, look the name up in `MINI_GAME_HANDLERS`, call the handler, and handle the unknown name branch loudly. It reads no options, checks no cooldowns, builds no embeds, and touches no state map. Each handler receives the raw `ChatInputCommandInteraction` and reads its own options off it, which keeps the option contract colocated with the game that owns it. Handler signature is uniform across all four, `(interaction: ChatInputCommandInteraction) => Promise<void>`, so the table stays a plain record with no per entry special casing.

**Gate granularity consequence (documented, no work in this plan).**

Both of this bot's runtime gates key on `interaction.commandName` and nothing else. `interaction.commandName` for `/mini-game fortune` is `mini-game`. So after the merge:

- Adding `mini-game` to `BOT_CONSTANTS.ADMIN_COMMANDS` would make ALL FOUR games admin only.
- Adding `mini-game` to `EARLY_ACCESS_FEATURES` would put ALL FOUR games behind the Studio early access window, **including fortune, which is already live and generally available to everyone.** That would be a visible removal of a shipped feature from every non Studio guild.

**Until a composite key lands, adding `mini-game` to either gate is an all or nothing switch.** Per assumption 9 no gating ships in this plan and neither set is edited, so nothing is broken today; this subsection exists so a future session does not discover it the hard way.

**The fix a future session would apply**, when and only when there is a real reason to gate one game: resolve a composite key of the form `` `mini-game <subcommand>` `` when the interaction carries a subcommand, falling back to the bare command name when it does not. Concretely, one small helper in `main.ts`'s dispatch that computes the gate key once (`interaction.isChatInputCommand()` exposes `options.getSubcommand(false)`, which returns null rather than throwing when there is no subcommand), then feeds that key to BOTH `ADMIN_COMMANDS.has(...)` and `checkEarlyAccess(...)`. Existing entries in both sets keep working unchanged because a command with no subcommand still resolves to its bare name. `EARLY_ACCESS_FEATURES` would then accept `"mini-game duel"` as a one line entry exactly as its own header comment promises for any new power. **This is a note for a future session, not a task in any phase of this plan.**

**Data models.** No new Mongo models or collections, and no change to the existing `FortuneBuff` model. In memory shapes only, illustrative, not final:

    interface GameChallenge {
      challengeId: string
      guildId: string
      challengerId: string
      opponentId: string
      kind: "duel" | "rps"
      challengerInteraction: RepliableInteraction   // for the followUp path
      createdAt: number
      timeoutHandle: NodeJS.Timeout
    }

    interface RpsRoundState {
      challengeId: string
      picks: Partial<Record<"challenger" | "opponent", "rock" | "paper" | "scissors">>
      resolved: boolean
    }

    interface HangmanRoundState {
      channelId: string
      word: string
      guessed: Set<string>
      remainingAttempts: number
      boardMessageId: string
    }

**Game art, and why it is a manifest rather than inline paths.** The owner is drawing custom art for the games, and it does not exist yet, so `gamesAssets.ts` declares every image slot up front and resolves it at render time: custom file present on disk, attach it and point the embed at it; absent, attach the 85 KB bundled Dero avatar and point the embed at THAT. Nothing else in the feature builds a path into `assets/games/` by hand. This is exactly the discipline `respondWithFortune` already uses for its orb gifs (`existsSync` then degrade), one level up, and it buys three things: the games look finished today, finished art lands by dropping a file with no code change and no redeploy of anything but the assets, and the manifest doubles as the owner's art checklist (`missingGameAssets()` reports what is still outstanding). Slots for Phases 3 and 4 are declared now, marked with the phase that consumes them, so the full art list is knowable before those phases start. Files live under `assets/games/`, which deploys with the bot on Railway the same way `assets/dero` and `assets/fortune` already do.

**API contracts.** None. No new HTTP routes, pure Discord interactions.

**Component hierarchy.** Described in Impact Analysis's component flow above, restated here as the source of truth for Phases 2 through 4.

**State management.** One `Map` per concern: `activeChallenges` in `challengeFlow.ts` (keyed by a generated `challengeId`), an `rpsRounds` map in `rpsHandler.ts` (keyed by `challengeId`), and a `hangmanRounds` map in `hangmanHandler.ts` keyed by `channelId` (channel wide, not per user, since Open Question 2 recommends a public, multi guesser round). Key formats follow `cooldownManager`'s convention of a single template literal, not ad hoc string concatenation scattered across call sites. Merging the commands does NOT merge the maps, and it does NOT merge the cooldowns: each game keeps its own `CooldownManager` instance, and fortune keeps using the one already living at module scope in `respondWithFortune.ts` (which stays shared with the `#command-center` invite card button so that gate cannot be bypassed by alternating entry points).

**Validation strategy.** Discord validates the subcommand name, the presence of required options, and the `flip` choice value before the interaction reaches the bot, so none of that needs hand checking. What still needs it: a challenge cannot target the challenger themselves or a bot account, checked before any message posts. A hangman guess is validated for length one, alphabetic, not already guessed, case folded, before it is treated as a real turn. Cooldowns checked before issuing any new challenge or round, never after. Fortune's validation is unchanged, `respondWithFortune` already owns it.

**Error handling.** Reuse the existing `errorEmbed(message)` from `src/utils/embedBuilder.ts` for generic failures, its own title copy is generic wrapper text, not plugin voiced content, so reusing it does not violate assumption 1. The unknown subcommand branch logs the received name and replies with `errorEmbed`, it never silently returns. Discord side effects that follow a successful primary action stay fire and forget, logged and swallowed, matching the rest of this codebase.

**Security considerations.** No new env vars, no new external calls, no new auth surface. A hangman guess is user supplied text, render it the same defensive way fortune's echoed question is rendered, inside an embed field with mention parsing disabled, never as raw message content that could be misread as a mention or a markdown injection.

---

## 6. IMPLEMENTATION ROADMAP

```
PHASE 1: Foundation, the mini-game shell and the challenge engine
  Macro milestone: the single /mini-game command file exists with its dispatch table and all four
    subcommands declared, and a shared, reusable challenge and accept engine plus the feature local
    copy and embed home sit behind it. Every later phase REGISTERS INTO this shell rather than
    creating a command file of its own.
  Micro tasks:
    - [ ] Create src/commands/fun/mini-game.ts: the SlashCommandBuilder with four addSubcommand
          callbacks (duel, rps, hangman, fortune), NO top level options, data left unannotated with a
          comment explaining why, and the MINI_GAME_HANDLERS dispatch table mirroring POWERUP_ACTIONS.
          Phases 2 through 4 fill in real handlers; this phase may stub the three game handlers with a
          "coming soon" ephemeral so the file type checks and the routing test can run.
    - [ ] Wire the fortune subcommand for real in this phase, since it is pure adaptation with no new
          logic: create src/features/games/fortuneHandler.ts reading question and private off the
          subcommand and calling the existing respondWithFortune unchanged. Do NOT delete
          src/commands/fun/fortune.ts yet, that is Phase 5, so the command stays live while the rest of
          the games are built.
    - [ ] Write src/commands/fun/mini-game.test.ts: every declared subcommand routes to its own
          handler, and an unknown subcommand name fails loudly (logs and replies) rather than silently.
    - [ ] Create src/features/games/gamesCopy.ts, feature local copy including the parent command
          description and every subcommand description, no pack indirection, mirroring fortuneCopy.ts's
          shape and its explanatory comment.
    - [ ] Add GAME_CHALLENGE, GAME_DUEL, GAME_RPS, GAME_HANGMAN to COLORS in src/base/copy/brand.ts.
    - [ ] Build src/features/games/challengeFlow.ts: issue a challenge, accept/decline buttons via an
          inline collector, a self challenge and bot challenge guard, a timeout path, and guaranteed
          state cleanup on every exit (accept, decline, timeout).
    - [ ] Create src/features/games/gamesEmbeds.ts with a challenge issued embed builder, pulling
          AUTHOR/COLORS from brand.ts directly.
    - [ ] Write challengeFlow.test.ts covering self challenge rejection, double challenge rejection,
          and the timeout cleanup path with fake timers.
  Completion criteria: /mini-game type checks with four subcommands declared and routes correctly in
    tests; challengeFlow.ts exports a stable function signature Phase 2 can import with zero further
    plumbing; npx tsc --noEmit and npm run test pass; ADMIN_COMMANDS and EARLY_ACCESS_FEATURES are
    both unchanged; src/commands/fun/secret-code.ts is untouched.
  Depends on: none
  Spells:
    - mini-game shell, dispatch table, and the shared challenge engine → see "Spell: Phase 1 mini-game
      shell and challenge engine" in the SPELLS appendix

PHASE 2: Dice or coin flip duel
  Macro milestone: the first fully playable game, proves the Phase 1 engine and the dispatch table end
    to end with the simplest possible resolution (no secret choice step).
  Micro tasks:
    - [ ] Build src/features/games/duelResolve.ts, a pure function resolving a dice or coin duel with
          an injectable RNG, mirroring rollFortune.ts's shape.
    - [ ] Write duelResolve.test.ts covering both duel types, RNG boundaries, and a tie.
    - [ ] Build src/features/games/duelHandler.ts: reads opponent and flip off the subcommand, checks
          its OWN CooldownManager instance, calls challengeFlow.ts, resolves immediately on accept, and
          renders the result via a new gamesEmbeds.ts builder.
    - [ ] Replace the STUB BODY inside src/features/games/duelHandler.ts, keeping its runDuel export
          name. Phase 1 shipped that file as a stub module, so the MINI_GAME_HANDLERS entry already
          points here and needs NO edit. Do NOT create a new file under src/commands/.
    - [ ] Add duel copy to gamesCopy.ts.
    - [ ] Manual test guild run: two real accounts play a full duel, including a decline and a timeout.
  Completion criteria: /mini-game duel is playable end to end by two real Discord accounts in the test
    guild; tsc, lint, and test all pass; ADMIN_COMMANDS is unchanged.
  Depends on: Phase 1
  Spells: none, this phase is mechanical once the Phase 1 shell and engine exist.

PHASE 3: Rock Paper Scissors
  Macro milestone: the hardest interaction problem in this plan, two players making a secret
    simultaneous choice, resolved and shipped as a subcommand.
  Micro tasks:
    - [ ] Build src/features/games/rpsWinner.ts, a pure function scoring two choices, mirroring the
          pure/impure split in rollFortune.ts / respondWithFortune.ts.
    - [ ] Write rpsWinner.test.ts covering all nine choice combinations.
    - [ ] Build src/features/games/rpsHandler.ts and the secret choice flow: an ephemeral reply to the
          opponent's Accept interaction, a followUp on the challenger's original interaction, both
          carrying a rock/paper/scissors button row.
    - [ ] Replace the STUB BODY inside src/features/games/rpsHandler.ts, keeping its runRps export
          name. Phase 1 shipped that file as a stub module, so the MINI_GAME_HANDLERS entry already
          points here and needs NO edit. Do NOT create a new file under src/commands/.
    - [ ] Add the reveal embed to gamesEmbeds.ts and rps copy to gamesCopy.ts.
    - [ ] Handle the half complete round timeout (one player picked, the other did not) with a clear
          message to the player who did pick.
    - [ ] Manual test guild run: two real accounts play a full round, confirm neither sees the other's
          pick before both are locked in.
  Completion criteria: /mini-game rps is playable end to end by two real Discord accounts with an
    accurate reveal and no leaked picks; a race condition test (near simultaneous picks) passes; tsc,
    lint, and test all pass.
  Depends on: Phase 1
  Spells:
    - Secret choice and reveal flow → see "Spell: Phase 3 Rock Paper Scissors subcommand" in the SPELLS
      appendix

PHASE 4: Hangman
  Macro milestone: the third new game, fully standalone, proving the modal guess pattern and closing
    out the game set.
  Micro tasks:
    - [ ] Confirm the public channel game recommendation with silent (Open Question 2) before building
          the state shape.
    - [ ] Build src/features/games/hangmanWords.ts, one general purpose word list.
    - [ ] Build src/features/games/hangmanState.ts, a pure state machine (word, guessed letters,
          remaining attempts, win/lose check).
    - [ ] Write hangmanState.test.ts covering a correct guess, a wrong guess, a repeat guess, a case
          mismatched guess, a win, and a loss.
    - [ ] Build src/features/games/hangmanHandler.ts: starts a round, posts the public board, a Guess a
          letter button that opens a modal as its FIRST response.
    - [ ] Replace the STUB BODY inside src/features/games/hangmanHandler.ts, keeping its runHangman
          export name. Phase 1 shipped that file as a stub module, so the MINI_GAME_HANDLERS entry
          already points here and needs NO edit. Do NOT create a new file under src/commands/.
    - [ ] Add the board and end state embeds to gamesEmbeds.ts and hangman copy to gamesCopy.ts.
    - [ ] Manual test guild run: one real account plays a full round to a win and a separate round to a
          loss.
  Completion criteria: /mini-game hangman is playable end to end with a visible public board, any
    channel member can guess, invalid guesses give clear feedback without costing a turn, the round
    reaches a clean win or lose state with its map entry removed; tsc, lint, and test all pass.
  Depends on: Phase 1 (for the shell, gamesCopy.ts, gamesEmbeds.ts, and brand.ts colors only, NOT
    challengeFlow.ts)
  Spells:
    - Modal guess flow and public vs private recommendation → see "Spell: Phase 4 hangman subcommand"
      in the SPELLS appendix

PHASE 5: Fortune absorption, discoverability, cross game QA, ledgers, and handoff
  Macro milestone: /fortune formally retires into /mini-game fortune, the games become discoverable in
    both pinned command guides, all four subcommands are verified together, propagation is confirmed in
    a real guild, the repo's own ledgers are brought current, and the feature set is formally handed off
    as ready for the locked announcement flow.
  Micro tasks:
    - [ ] FORTUNE ABSORPTION: delete src/commands/fun/fortune.ts. Delete nothing else. Confirm
          src/features/fortune/ is fully intact, that fortuneHandler.ts still calls respondWithFortune,
          and that /mini-game fortune produces an identical reading to what /fortune produced. Write NO
          deregistration task and NO data migration: deploy-commands.ts's PUT retires the old name on
          its own, and FortuneBuff rows are keyed by userId with no command name anywhere in the schema.
    - [ ] REGRESSION: confirm the #command-center Summon Dero card's Fortune button still works after
          the command file is deleted. It routes through PowerUps → respondWithFortune and never touched
          the command, so it should be unaffected; verify rather than assume.
    - [ ] DISCOVERABILITY: add ONE new field to commandGuide.fields in BOTH
          src/base/copy/packs/rok-commander.pack.ts (kingdom voice) and
          src/base/copy/packs/general-events.pack.ts (plain voice). The field names /mini-game AND
          /secret-code together, because /secret-code buffs the fortune subcommand while living outside
          the command that holds it, and the guide is the only surface that can make that pairing
          obvious. This is also the moment /secret-code becomes discoverable at all: it has been live
          since 2026-07-04 and has never appeared in either guide. Match each pack's existing field
          shape ({ name, value: [...].join("\n") } satisfies IEmbedField).
    - [ ] Full regression pass: npx tsc --noEmit and npm run test CLEAN, npm run build clean, and
          npm run lint at or below its recorded baseline (see the lint baseline note in Codebase
          Discovery, the bot's lint is red before this plan starts and "clean" is not the bar).
          (Owner runs these.)
    - [ ] Confirm /secret-code still works and still buffs the fortune subcommand.
    - [ ] Confirm deploy-commands.ts picks up mini-game and no longer picks up fortune (dry check of the
          loader logic; real registration stays the owner's manual npm run deploy).
    - [ ] Cross game consistency pass: cooldown behavior (four independent windows, NOT one shared
          one), error embed wording, and Dero voice all consistent across the four subcommands.
    - [ ] PROPAGATION GATE, hard sequencing rule, do this BEFORE the version bump: after the owner runs
          npm run deploy in production, WAIT and then verify in a real guild that /mini-game appears in
          the picker with all four subcommands and that /fortune is gone. Production registers GLOBAL
          commands (Routes.applicationCommands) and global updates can take up to an hour to reach every
          user. Only once propagation is confirmed does the package.json version bump happen, because
          postFeatureAnnouncement.ts keys its once-per-(guild, version) broadcast to that version and
          fires it on the next boot. Announcing a command members cannot yet see is worse than
          announcing late. (The announcement flow also owns adding the new version to VERSION_SHIPPED_AT
          in postFeatureAnnouncement.ts; noted here so it is not lost, not a task of this plan.)
    - [ ] Update SACRED_FILES/STATE.md with the new live feature AND with the /fortune retirement, since
          live behavior changed for a shipped command.
    - [ ] Add a row to the current week in SACRED_FILES/2026-08/WIP.md.
    - [ ] Move the corresponding FUTURE_PLANS.md item (if one existed) to HISTORICAL.md, or add a fresh
          HISTORICAL.md entry documenting what shipped, since no FUTURE_PLANS item existed for this work
          before this plan (confirmed in Codebase Discovery during the initial research pass).
    - [ ] Write a short handoff note for reference_bot_release_announcement_flow.md stating three things
          it MUST carry: (a) /fortune moved to /mini-game fortune and members with muscle memory need to
          be told where it went, (b) all four featureAnnouncement blocks (public and innerSanctum, both
          packs) still name the old /fortune in launch era prose and get rewritten as part of that
          flow's normal per release copy pass, and (c) the announcement is fired by the version bump, so
          it must not be bumped before the propagation gate above is green.
  Completion criteria: every item above checked, /fortune is gone and /mini-game fortune works, both
    guides name the new command, ledgers match live code, and silent has an explicit go/no go point
    before any announcement copy gets drafted.
  Depends on: Phases 1 through 4
  Spells: none, this phase is procedural and already has a worked example in this repo
    (readMePlans/post-review-fixes.md's own Phase 8 verification pass).
```

---

## 6b. SPELLS

### Spell: Phase 1 mini-game shell and challenge engine

```
You are working in the Dero Discord Bot repo (TypeScript, ESM, Discord.js v14, Mongoose on MongoDB Atlas). This is Phase 1 of a 5 phase master plan to ship a set of minigames as native subcommands of ONE slash command named /mini-game (a dice or coin flip duel, a Rock Paper Scissors player challenge, a hangman word game, and the already live fortune reading folded in). Your job in this phase is TWO things and nothing else: build the single /mini-game command shell with its four subcommands and a dispatch table, and build a single reusable challenge and accept engine that Phase 2 (the duel) and Phase 3 (Rock Paper Scissors) will both import, so neither game builds its own copy of challenge issuance, accept and decline buttons, or timeout handling.

There is exactly ONE new file under src/commands/ in this entire plan and you are creating it now. Later phases add a handler and swap a table entry, they never create another command file.

Context you need, verified against the live repo:

Command files export data and execute(interaction) => Promise<void> and live under src/commands/<folder>/<name>.ts. The contract in src/base/interfaces/ICommand.ts is DOCUMENTARY, not enforced: no command file in this repo annotates its export, and both loaders (src/main.ts's boot loop and src/deploy-commands.ts) import the module dynamically and check only that the string keys "data" and "execute" exist. This matters directly to you, because calling .addSubcommand() narrows the builder's TypeScript type away from SlashCommandBuilder. DO NOT annotate the new data export. Let inference carry the narrowed type, exactly as src/commands/fun/fortune.ts does today (it narrows via .addStringOption() and is likewise unannotated). Leave a short comment on the export saying why it is unannotated so the next reader does not "fix" it. If you decide ICommand deserves a correctness pass, WIDEN its data field to a union that admits the subcommands only builder type. NEVER resolve this with a cast to any, and never with a cast to SlashCommandBuilder.

Discord subcommand rules you must build to, all four confirmed against current Discord developer documentation. A command supports at most 25 options total and subcommands count against that ceiling, so four is comfortable. Nesting is one level deep only, a command may hold subcommands or subcommand groups that hold subcommands and nothing deeper. A command that has subcommands CANNOT also carry top level options and its bare form becomes unusable, so /mini-game declares NO options of its own and every option is declared inside its own addSubcommand callback, there is no shared /mini-game option and specifically no shared private toggle. There is a combined 8000 character budget across every name, description, and choice value on the command, nowhere near a problem at four subcommands but worth knowing exists.

Because Discord will not let a member submit the bare parent of a subcommand bearing command, /mini-game with no subcommand is IMPOSSIBLE to invoke. Do not design a help embed, a default branch, or a fallback for it. The unknown subcommand branch in your dispatch exists to catch a developer mistake (a subcommand declared in the builder with no handler in the table), not a user reachable state, so it must fail LOUDLY: log the received name and reply with the shared errorEmbed, never silently return.

The four subcommands and their options:
  duel     opponent (user, required), flip (string, required, choices dice and coin)
  rps      opponent (user, required)
  hangman  no options
  fortune  question (string, optional, setMaxLength(200)), private (boolean, optional)

The fortune subcommand is an ABSORPTION of the already live /fortune command, so its option names, types, requiredness, and the 200 character cap must match src/commands/fun/fortune.ts EXACTLY. Reuse fortuneCopy.commandDescription, fortuneCopy.questionOptionDescription, and fortuneCopy.privateOptionDescription for its strings so the two cannot drift. Wire this subcommand for REAL in this phase, since it is pure adaptation with no new logic: create src/features/games/fortuneHandler.ts that reads the two options off the subcommand and calls the EXISTING respondWithFortune from @features/fortune/respondWithFortune.js, unchanged. It exists so the dispatch table has four entries of one uniform shape and the command file holds no option reading of its own; it contains no fortune logic. DO NOT delete src/commands/fun/fortune.ts in this phase, Phase 5 owns that, so the old command stays live while the rest of the games are built.

Build the dispatch table as a plain const record mapping subcommand name to handler, mirroring POWERUP_ACTIONS in src/features/power-ups/PowerUps.ts (which is declared `as const satisfies Record<string, ...>` and read by its handler to reject unknown keys and route known ones). Same shape here, so adding a fifth game later is one table entry plus one addSubcommand callback, never a new switch arm. Every handler takes the same signature, (interaction: ChatInputCommandInteraction) => Promise<void>, and reads its own options off the interaction. execute() does four things only: read interaction.options.getSubcommand(), look it up in the table, call it, handle the unknown name branch. No option reading, no cooldown checks, no embeds, no state maps in the command file. Stub the three game handlers (duel, rps, hangman) with a short "coming soon" ephemeral for now so the file type checks and the routing test can run; Phases 2 through 4 replace the stubs.

This bot has two button interaction patterns already in production. Persistent, globally registered handlers via src/handlers/interactionRegistry.ts (registerButton(prefix, handler), customIds shaped <prefix>:<arg1>:<arg2>, used for UI that must keep working indefinitely, independent of any single command's execution, like the decree edit buttons). Inline collectors (createMessageComponentCollector) scoped to a single command's own execution, used for short lived flows like the KvK season config checklist. Use the INLINE collector pattern for the challenge engine. A challenge is a one shot, short lived flow tied to one specific message, not something that needs to survive a bot restart or stay clickable forever, so it does not belong in the persistent registry.

Reuse src/utils/cooldownManager.ts's CooldownManager class following the module scope singleton pattern from src/features/fortune/respondWithFortune.ts, one instance shared by every entry point of the SAME game. Critical non goal: do NOT introduce one cooldown for all of /mini-game. Each game owns its own instance, because a single parent cooldown would mean playing hangman blocks a fortune reading, which is a behavior regression on a shipped feature. Fortune's cooldown already lives at module scope inside respondWithFortune (10 seconds, deliberately SHARED with the #command-center invite card Fortune button so alternating between the two entry points cannot bypass the gate), and the fortune subcommand inherits it for free by calling that same function, so do not add a second one for fortune.

Copy and embeds for this feature do NOT go through the two voice copy packs (src/base/copy/packs/rok-commander.pack.ts and general-events.pack.ts) or embedBuilder.ts's base(guildConfig) helper. That system is reserved for actual platform plugin surfaces (ROK reminders, schedule, leaderboard). Games are plain commands, exactly like /fortune and /secret-code, which deliberately opted OUT of the pack system, see the comment at the top of src/features/fortune/fortuneCopy.ts and the comment inside src/features/fortune/fortuneEmbed.ts explaining why. Mirror that pattern: put the parent command description, every subcommand description, and all challenge engine copy strings in a new src/features/games/gamesCopy.ts (a plain exported object, no pack indirection), and pull the Dero author and any embed color straight from src/base/copy/brand.ts's AUTHOR and COLORS exports, adding new COLORS keys there if this phase needs its own color (a neutral "challenge issued" state probably wants one, suggest COLORS.GAME_CHALLENGE, pick a ColorResolvable distinct from every existing key in that file).

Known traps to design around explicitly: what happens if the challenged player never responds at all, not just declines, this needs a real timeout path, not just a decline handler. What happens if the same two players are challenged twice concurrently, or a player tries to challenge themselves, or challenges a bot account, all three should be rejected before a challenge message ever posts. Every entry your engine puts into its in memory game state Map must be removed on completion, decline, AND timeout, with no path that leaves a stale entry behind, mirror the cleanup discipline in src/features/power-ups/PowerUps.ts's inflightNotificationsRoleResolves Map (cleared in a finally block). State is in memory only for v1, accept that an in progress challenge is lost if the bot redeploys mid challenge, Railway sends SIGTERM on every deploy per src/main.ts's own graceful shutdown comments, this is a deliberate v1 tradeoff, not an oversight.

No dashes anywhere in code comments or copy strings, not even compound words, use a space or rephrase instead. Hyphens inside identifiers like mini-game and secret-code are identifiers, not dashes, and are correct. Every non trivial branch needs a comment answering What, Who, When, Where, How as relevant, matching the numbered circle step and section marker voice already used throughout this codebase (look at src/features/fortune/respondWithFortune.ts for the exact voice to match). Every local import needs the .js suffix even though the source file is .ts, this project is pure ESM. Business logic belongs in src/features/games/, never inside the command file.

What NOT to do: do not touch src/commands/fun/secret-code.ts, it is deliberately OUT of this merge and stays its own top level command, redeeming a code is not a game. Do not delete or edit anything under src/features/fortune/. Do not delete src/commands/fun/fortune.ts yet. Do not touch src/commands/events/rps.ts, eightBall.ts, sun-qoute.ts, or poll.ts, these are dead, fully commented out stub files from before this bot had slash commands, leave them alone (note that a dead rps.ts already exists there, which is one more reason the live implementation belongs in src/features/games/). Do not add any new field to a Mongoose model or create a new collection, this phase is in memory only. Do not add mini-game to BOT_CONSTANTS.ADMIN_COMMANDS or to EARLY_ACCESS_FEATURES in src/features/early-access/earlyAccess.ts, every subcommand is open to every member by explicit owner decision. Do not build the duel, Rock Paper Scissors, or hangman games themselves in this phase, only the shell, the fortune adapter, and the shared engine.

Deliverables: src/commands/fun/mini-game.ts (builder with four subcommands, unannotated data export with its explanatory comment, MINI_GAME_HANDLERS dispatch table, thin execute, stubbed game handlers). src/features/games/fortuneHandler.ts (the thin real adapter). src/commands/fun/mini-game.test.ts covering that every declared subcommand routes to its own handler and that an unknown subcommand fails loudly. A new src/features/games/challengeFlow.ts exporting a function (or small set of functions) that a caller can invoke with a challenger id, an opponent id, a guild id, and a per game prompt renderer, and get back either an accepted result the caller acts on next, or a cleanly reported decline or timeout. A new src/features/games/gamesCopy.ts holding the parent and subcommand descriptions plus the challenge engine's user facing strings. Any new COLORS keys added to src/base/copy/brand.ts. A colocated challengeFlow.test.ts covering the self challenge rejection, the double challenge rejection, and the timeout cleanup path with fake timers.
```

### Spell: Phase 3 Rock Paper Scissors subcommand

```
You are working in the Dero Discord Bot repo (TypeScript, ESM, Discord.js v14). This is Phase 3 of a 5 phase master plan shipping a set of minigames as native subcommands of ONE slash command named /mini-game.

READ THIS FIRST: the command file ALREADY EXISTS. Phase 1 created src/commands/fun/mini-game.ts with a SlashCommandBuilder declaring four subcommands (duel, rps, hangman, fortune) and a MINI_GAME_HANDLERS dispatch table mapping each subcommand name to a handler. Your job is to add ONE subcommand's handler and swap it into that table. You must NOT create a new file under src/commands/. The rps subcommand and its opponent option are already declared in the builder; if the builder needs a small adjustment for this game, edit the existing addSubcommand callback in place.

Phase 1 also already built a shared challenge and accept engine at src/features/games/challengeFlow.ts (challenge issuance, accept and decline buttons, and timeout handling are all solved there, import it, do not rebuild any of it). Phase 2 already shipped the dice or coin flip duel handler at src/features/games/duelHandler.ts, which proved the engine and the table work end to end, read it before you start so your handler matches its shape. Your job in this phase is the one piece that is genuinely new: once two players have accepted a Rock Paper Scissors challenge, each must make a SECRET choice, rock, paper, or scissors, without seeing the other player's pick, and the bot reveals the result only once both picks are recorded.

Context you need, verified against the live repo and outside research:

This codebase's own CHANGELOG.md documents a real discord.js 14.25 bug it already hit, a StringSelectMenu and a button silently dropped input when they shared ONE ephemeral message, the fix was moving the select to its own follow up ephemeral message and using createMessageComponentCollector with an explicit ComponentType filter instead of awaitMessageComponent. Treat two players' secret choice prompts the same defensive way, give each player their OWN ephemeral message, never try to pack both players' choices into one shared message or embed.

The concrete mechanism to build: when the opponent clicks Accept (a ButtonInteraction the bot receives fresh), reply to THAT interaction directly with an ephemeral message containing three buttons, rock, paper, scissors. For the challenger, who is not clicking anything at that moment, use interaction.followUp() on the ORIGINAL slash command interaction that started the challenge (store a reference to it, or at minimum a bound followUp function, in the challenge state Phase 1 already tracks) to deliver their own separate ephemeral secret choice prompt at the same moment the opponent accepts. Discord interaction tokens remain valid for followUp calls for up to 15 minutes, comfortably longer than any reasonable challenge accept window, so this does not require DMs and does not depend on either player having DMs enabled from server members (a real fragility this codebase already treats carefully elsewhere, see the auto leave on Missing Permissions handling in src/main.ts as an example of how seriously blocked or restricted communication paths are treated here).

Public discord.js Rock Paper Scissors implementations researched for this task (for example the Discord Mini Games JS library's rock paper scissors module) confirm the challenge and accept shape, a confirmation prompt with a response window, an onTimeUp path naming both players if the opponent never answers, but do not document a specific mechanism for the secret choice step, so there is no single established community pattern to defer to here, the ephemeral reply plus followUp approach above is this plan's own reasoned design, build it as specified rather than inventing an alternative.

Known traps to handle explicitly, each needs a real, tested answer, not a guess: race conditions, if both players click their choice within the same tick, the reveal logic must only fire once, gate it behind a check like "is this round already resolved" before accepting either pick, and make the check and the write atomic within the single threaded event loop, do not await anything between checking and recording a pick. A player who already picked and clicks again, reject the second click with a short ephemeral acknowledgement, do not let it overwrite their first pick. The waiting player, whichever of the two picks first should see a small ephemeral acknowledgement that their pick was received and the bot is waiting on their opponent, so they are not left staring at a message with no feedback. The timeout path from the Phase 1 engine covers "opponent never accepted", but this phase adds a NEW timeout window for "accepted but never picked", if only one of the two players picks within that window, tell the player who DID pick what happened, do not leave them without a resolution. Every entry this handler writes into its own rpsRounds Map must be removed on reveal, on timeout, and on any early exit, no path that leaks.

Give this game its OWN CooldownManager instance at module scope in your handler, following src/features/fortune/respondWithFortune.ts's pattern. Do NOT reach for a shared /mini-game cooldown and do not add one, because a parent level cooldown would mean a rock paper scissors round blocks a fortune reading, which is a behavior regression on a shipped feature.

Build a pure, dependency free function, something like rpsWinner(choiceA, choiceB), that takes two choices and returns the outcome, modeled directly on the shape of src/features/fortune/rollFortune.ts, an injectable source of randomness is not needed here since there is no randomness in resolving two known choices, but match that file's separation of pure logic from Discord side effects exactly, this pure function gets its own colocated test file covering all nine input combinations.

No dashes anywhere in code comments or copy strings (hyphens inside identifiers like mini-game are identifiers, not dashes, and are correct). 5W comments on non trivial branches, matching this codebase's existing voice. ESM .js import suffixes on every local import. All user facing copy lives in src/features/games/gamesCopy.ts (created in Phase 1), not hardcoded in the handler, and does not go through the rok-commander or general-events copy packs, this feature is a plain command, not a platform plugin, exactly like /fortune.

What NOT to do: do not create any file under src/commands/. Do not modify src/features/games/challengeFlow.ts's public contract, only consume it. Do not implement the choice prompts as DMs. Do not add a leaderboard, win tracking, or any Mongo persistence, this stays in memory only, cleaned up the same way Phase 1's engine cleans up its own state. Do not touch src/commands/fun/secret-code.ts, src/commands/fun/fortune.ts, or anything under src/features/fortune/. Do not touch the dead stubs at src/commands/events/rps.ts, eightBall.ts, sun-qoute.ts, or poll.ts (note that a dead rps.ts lives there, do not confuse it for your work and do not revive it). Do not add mini-game to BOT_CONSTANTS.ADMIN_COMMANDS or EARLY_ACCESS_FEATURES.

Deliverables: src/features/games/rpsHandler.ts (the Discord facing handler), the rps entry in MINI_GAME_HANDLERS swapped from its Phase 1 stub to the real handler, a pure rpsWinner module plus its colocated test file, the secret choice Discord flow wired to the Phase 1 engine, and the reveal embed (via a new function in src/features/games/gamesEmbeds.ts, pulling colors from src/base/copy/brand.ts, add a new COLORS key there if needed). Acceptance: two real Discord users can run /mini-game rps against each other end to end, challenge, accept, pick privately with no leakage of the other's choice, and see one accurate reveal naming both choices and the winner or a tie, and a player who times out mid pick leaves their opponent with a clear resolution rather than silence.
```

### Spell: Phase 4 hangman subcommand

```
You are working in the Dero Discord Bot repo (TypeScript, ESM, Discord.js v14). This is Phase 4 of a 5 phase master plan shipping a set of minigames as native subcommands of ONE slash command named /mini-game.

READ THIS FIRST: the command file ALREADY EXISTS. Phase 1 created src/commands/fun/mini-game.ts with a SlashCommandBuilder declaring four subcommands (duel, rps, hangman, fortune) and a MINI_GAME_HANDLERS dispatch table mapping each subcommand name to a handler. Your job is to add ONE subcommand's handler and swap it into that table. You must NOT create a new file under src/commands/. The hangman subcommand is already declared in the builder and takes no options; if it needs a small adjustment, edit the existing addSubcommand callback in place.

This game is standalone, it does not use the Phase 1 challenge and accept engine at src/features/games/challengeFlow.ts, there is no opponent, one player plays against Dero (or, per the recommendation below, a channel plays together).

Product decision this spell resolves rather than leaving open: build hangman as a PUBLIC, channel visible game, not a private ephemeral one. The board embed posts visibly in the channel where the command was run, and anyone in that channel can submit a letter guess, not only the player who started the round. Reasoning to carry into the build, researched against how this ecosystem's own hangman bots are typically built (multiplayer support and auto gathering players shows up repeatedly as a real, established feature in dedicated Discord hangman projects), and matching this specific codebase's own precedent for its other casual, multi participant features, the poll system and the suggestion box are both public and open to anyone in the channel, not scoped to one user. A private ephemeral hangman round would also be awkward mechanically, since a modal guess response is itself ephemeral by nature, but the BOARD (the embed showing blanks, wrong guesses, and the remaining attempts) should be a normal public message that updates in place as guesses land, so the whole channel watches the word get solved.

Context you need, verified against the live repo and the official discord.js guide:

The only clean way to accept an arbitrary single letter guess is a modal text input. Discord's component limits rule out buttons or a select menu for the full alphabet, a message caps at five action rows of five buttons each, twenty five total, and a select menu caps at twenty five options, both short of the twenty six letters needed. Use a Modal with one TextInputBuilder, style Short, setMaxLength(1) and setMinLength(1) so Discord enforces a single character before your own validation even runs. Two hard modal constraints confirmed against the official discord.js guide, a modal cannot be deferred, it must be the FIRST response to whatever interaction triggers it, so the "guess a letter" button's handler must call showModal immediately, not after deferUpdate or deferReply. A modal supports a maximum of five top level components, not a constraint here since this only needs one text input, but do not add unrelated fields to the same modal later without checking that cap.

Your own validation on modal submit still needs to reject an empty submission (belt and suspenders past setMinLength), reject anything that is not a single alphabetic character (setMaxLength(1) stops length but not content, a digit or symbol will still pass Discord's own check), case fold the letter before comparing (a guess of "A" and "a" are the same guess), and reject a letter already guessed in this round without spending a turn, respond with a short ephemeral "already tried that letter" rather than silently failing. None of these rejections should count against the player's remaining attempts, only a genuinely wrong NEW letter should cost an attempt.

Reference src/features/schedule/decreeEditHandlers.ts for this codebase's one existing modal pattern, a "guess a letter" button plus modal should follow the same shape, a button with a customId the interaction registry or an inline collector can route, a modal built and shown on that click, and a submit handler that validates then updates state.

Word list, this codebase has no existing hangman appropriate word bank, base/constants has castle.json, city.json, commander.json, and qoutes.json, none fit. Build a new src/features/games/hangmanWords.ts with a plain array of words. Recommend ONE general purpose list, not a rok themed and a streamer themed list, since this feature does not route through the two voice copy packs at all, exactly like /fortune, see the comment at the top of src/features/fortune/fortuneCopy.ts explaining why fortune opted out of the pack system, the same reasoning applies here, doubling the word list content for a voice split nobody asked for is wasted authoring effort.

Build a pure, dependency free state machine, something like a HangmanState shape tracking the target word, the set of guessed letters, and the remaining attempts, with functions to apply a guess and to check win or lose, modeled on the separation of pure logic from Discord side effects in src/features/fortune/rollFortune.ts. This pure module gets its own colocated test file covering a correct guess, a wrong guess, a repeat guess, a case mismatched guess, a win, and a loss.

Give this game its OWN CooldownManager instance at module scope in your handler, following src/features/fortune/respondWithFortune.ts's pattern. Do NOT reach for a shared /mini-game cooldown and do not add one, because a parent level cooldown would mean starting a hangman round blocks a fortune reading, which is a behavior regression on a shipped feature.

A hangman guess is user supplied text, so render it the same defensive way fortune's echoed question is rendered, inside an embed field with mention parsing disabled, never as raw message content that could be misread as a mention or a markdown injection.

No dashes anywhere in code comments or copy strings (hyphens inside identifiers like mini-game are identifiers, not dashes, and are correct). 5W comments on non trivial branches. ESM .js import suffixes on every local import. All user facing copy lives in src/features/games/gamesCopy.ts (created in Phase 1, extend it here), not hardcoded, and does not go through the rok-commander or general-events copy packs.

What NOT to do: do not create any file under src/commands/. Do not require an opponent or route this through the Phase 1 challenge engine. Do not make the board ephemeral. Do not persist finished games or add a Mongo model, an in memory Map keyed by channel id (since this is a channel wide game, not a per user one) is enough for v1, and it must be cleaned up the instant a round ends, win, lose, or an admin initiated stop, mirror the cleanup discipline expected of the Phase 1 engine. Do not touch src/commands/fun/secret-code.ts, src/commands/fun/fortune.ts, or anything under src/features/fortune/. Do not touch the dead stubs at src/commands/events/rps.ts, eightBall.ts, sun-qoute.ts, or poll.ts. Do not add mini-game to BOT_CONSTANTS.ADMIN_COMMANDS or EARLY_ACCESS_FEATURES.

Deliverables: src/features/games/hangmanHandler.ts (the Discord facing handler that starts a round), the hangman entry in MINI_GAME_HANDLERS swapped from its Phase 1 stub to the real handler, a pure hangman state module plus its colocated test file, the board embed (a new function in src/features/games/gamesEmbeds.ts, pulling a new COLORS.GAME_HANGMAN key from src/base/copy/brand.ts), the guess button plus modal flow, and the word list file. Acceptance: a player can start a round with /mini-game hangman and a visible public board, anyone in the channel can guess a letter through the modal, the board updates after each guess, invalid guesses give clear ephemeral feedback without costing a turn, and the round reaches a clear win or lose state with its memory cleaned up afterward.
```

---

## 7. TESTING & CI/CD STRATEGY

**Unit tests.** `rpsWinner.test.ts` (all nine choice combinations, win, lose, tie). `duelResolve.test.ts` (RNG boundaries via an injectable rng, mirroring `rollFortune.ts`, tie handling). `hangmanState.test.ts` (correct guess, wrong guess, repeat guess, case mismatch, win, loss). `challengeFlow.test.ts` (self challenge rejection, double challenge rejection, timeout cleanup with fake timers).

**Subcommand routing tests (`mini-game.test.ts`), new in this revision and load bearing.**

- Every subcommand declared in the builder reaches its OWN handler and no other. Assert per name (`duel`, `rps`, `hangman`, `fortune`) with a fake interaction whose `options.getSubcommand()` returns that name, and confirm the matching handler was called exactly once and the other three were not.
- An unknown subcommand name fails LOUDLY: the handler set is untouched, an error is logged, and the user gets a reply. Assert it does not silently return. This is the guard that catches a builder and table mismatch, which is the single most likely way a future contributor breaks this command while adding a fifth game.
- The builder declares exactly the four expected subcommand names and NO top level options. `data.toJSON()` is the cheapest place to assert this and it also pins constraint 3 (a subcommands command cannot carry top level options) into a test rather than a comment.
- The fortune subcommand's option contract matches what `/fortune` shipped: `question` (string, optional, max length 200) and `private` (boolean, optional). A regression here is a silent behavior change for a live feature.

**Integration tests.** At least one mocked test per game handler exercising the full accept and resolve path with fake `interaction` objects, following the existing precedent in `ReminderScheduler.test.ts` and `GuildSetupManager.test.ts` (both mock discord.js objects directly rather than hitting real Discord).

**End to end scenarios (manual, test guild).** Duel: two accounts, full accept and resolve, plus a decline and a timeout. Rock Paper Scissors: two accounts, full round, confirm no leakage, plus a half complete timeout. Hangman: one account, a full win, a full loss, and a second account guessing in the same public round. Fortune: a public reading, a private reading, a question echo, and a cooldown hit, all confirmed identical to the pre merge `/fortune`.

**Edge cases.** Self challenge attempt. Challenging a bot account. Decline. Timeout on accept. Timeout on secret pick. Double pick attempt. Modal guess of a non letter. Modal guess of an already guessed letter. A hangman round abandoned mid game (no explicit stop command in v1, confirm the round simply sits until the process restarts or add a lightweight stop path if silent wants one, flagged as a nice to have, not required for Definition of Done). A member who still has the stale `/fortune` in their picker during the global propagation window (expect `noCommandMatch`, which is why the propagation gate exists).

**Regression checklist.**

- **The `#command-center` Summon Dero card's Fortune button still works after `src/commands/fun/fortune.ts` is deleted.** This is the highest value regression in the plan. The button routes `powerup:member:fortune` through `PowerUps` straight into `respondWithFortune` and never touched the command file, so it SHOULD be unaffected, but "should be" is exactly the kind of claim this repo's own rules say to verify at the call site. Confirm the button is still present on the invite card (`GuildSetupManager.inviteCardComponents()`), still routes (`POWERUP_ACTIONS["member:fortune"]`), and still produces a reading.
- `/mini-game fortune` and the Fortune button still SHARE one cooldown window, so alternating between them cannot bypass it.
- `/secret-code` still redeems and still buffs the fortune subcommand. `FortuneBuff` rows written before the merge still apply after it.
- `/fortune` still renders correctly through Phase 4 (it is not deleted until Phase 5), and is gone from the picker after Phase 5's deploy.
- `deploy-commands.ts`'s folder scan finds `mini-game` and no longer finds `fortune`, and the `PUT` body contains one `mini-game` entry with four subcommands.
- No change to `BOT_CONSTANTS.ADMIN_COMMANDS` and no change to `EARLY_ACCESS_FEATURES`.
- Both packs' `commandGuide` embeds still render, with the new field, and `refreshIntroEmbeds` edits the pinned guide in place rather than posting a duplicate.

**Manual QA checklist.** Run each end to end scenario above in the test guild (guild id `910668785856413707`, per the existing convention in `readMePlans/post-review-fixes.md`), then step through Phase 5's cross game consistency pass, then the propagation gate in a real production guild, before calling the feature set ready.

**CI/CD.** This repo has no automated pipeline today, no GitHub Actions file was found in any listing this session, and `CLAUDE.md` states plainly that the owner deploys manually. "Pipeline steps" here means the owner's existing manual sequence: `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run build`, then a git push that triggers Railway's auto build, then one manual `npm run deploy` to register the command with Discord, then the propagation wait and verification, and only then the `package.json` version bump that fires the release announcement on the next boot. Nothing in this plan blocks on CI because there is none. Whether silent wants an actual CI gate (a GitHub Actions workflow running tsc, lint, and test on every push) is a legitimate future item, out of scope for this plan, flagged here rather than assumed away.

---

## 8. FINAL REVIEW

**Requirement coverage.** Every functional requirement in Goal Analysis maps to a roadmap phase: the command shell, the dispatch table, and the fortune subcommand to Phase 1, duel to Phase 2, Rock Paper Scissors to Phase 3, hangman to Phase 4, the old command file deletion, discoverability, propagation, and ledger currency to Phase 5. The shared "open to every member" requirement is satisfied by NOT editing two files (`BOT_CONSTANTS.ADMIN_COMMANDS`, `EARLY_ACCESS_FEATURES`), which every phase's completion criteria restates so it cannot drift in by accident.

**Architecture consistency.** One command file, one dispatch table shaped like the `POWERUP_ACTIONS` table already in this repo, one copy home (`gamesCopy.ts`) for the three new games with fortune keeping its own so its output cannot drift, one embed home (`gamesEmbeds.ts`), one color home (`brand.ts`), and two of the four subcommands sharing one challenge engine. No game invents its own parallel pattern, and no game gets its own command file.

**Scalability and maintainability.** Adding a fifth game is one `addSubcommand` callback plus one dispatch table entry plus one handler file, with no new slash command, no new deploy consideration, and no new picker clutter. That is the whole point of the merge. The 25 option ceiling means the shape holds to roughly 25 games before it needs subcommand groups, which is far past any realistic need. In memory state is a deliberate, stated v1 tradeoff (assumption 2), not a hidden limitation. If a future need for persistence, wagering, or cross session games shows up, the pure logic modules already return structured results a store can wrap without a rewrite.

**Open Questions status.** Question 1 (persistence) resolved as "none for v1" for the three new games; fortune keeps the persistence it already has. Question 2 (hangman public vs private) resolved with a recommendation inside the Phase 4 spell, still needs silent's explicit confirmation before Phase 4 starts, called out again in that phase's micro tasks. Question 3 (word list split) resolved as "one general list," same confirmation point. Gating is not an open question, assumption 9 records it as decided.

**Rollback. This changed with the revision and is no longer purely additive.** Most of this plan is still additive (new files under `src/commands/fun/` and `src/features/games/`, four new keys in `brand.ts`'s `COLORS`, one new field in each pack's `commandGuide`), but Phase 5 DELETES a live command file and RENAMES a shipped command, so rollback is not a simple revert of new files.

- **Rolling back Phases 1 through 4** is still a plain revert of that phase's files plus the owner's normal Railway redeploy. Nothing is destroyed and `/fortune` is still live throughout.
- **Rolling back Phase 5** means restoring `src/commands/fun/fortune.ts` (git revert, it is a 30 line file with no dependencies of its own) and re running `npm run deploy`, because the `PUT` that retired `/fortune` will only bring it back when the file is present in the next `PUT` body. Budget the same up to an hour of global propagation on the way back that the forward deploy cost, which is the concrete reason the propagation gate is cheaper than the rollback.
- **`FortuneBuff` data survives in either direction.** Rows are keyed by `userId` with a unique index and carry no command name, so no redeemed buff and no pity streak is at risk going forward or coming back. There is no migration to run and no migration to undo.
- **`/secret-code` is unaffected in either direction**, since no phase touches it.

---

## EXECUTION PROTOCOL

- Execute one phase at a time, in the order above. Phase 1 first, always: it creates the single command file and the dispatch table that Phases 2, 3, and 4 register into, and Phase 3 depends on its challenge engine as well.
- Phases 2, 3, and 4 add a handler under `src/features/games/` and swap one dispatch table entry. **No phase after Phase 1 creates a file under `src/commands/`.** If a phase finds itself writing a new command file, it has misread the plan.
- Re validate against that phase's Completion Criteria before advancing, do not start Phase 3 on an unfinished Phase 1.
- Before Phase 4 begins, get silent's explicit answer on Open Questions 2 and 3 (hangman public vs private, one word list vs two). The Phase 4 spell already carries a recommendation, but this plan treats it as a confirm point, not a silent default.
- `/fortune` stays live and untouched through Phase 4. Only Phase 5 deletes its command file, and only after `/mini-game fortune` is confirmed to produce an identical reading.
- **Never bump `package.json` before the propagation gate is green.** The version bump is what fires `postFeatureAnnouncements` on the next boot, and production commands are global, so a bump ahead of propagation announces a command members cannot yet invoke.
- Do not add `mini-game` to `BOT_CONSTANTS.ADMIN_COMMANDS` or `EARLY_ACCESS_FEATURES` in any phase. If gating one game ever becomes genuinely wanted, read the gate granularity subsection in Technical Design first: both gates key on the command name alone today, so listing `mini-game` gates all four including the already generally available fortune.
- If new information emerges mid build (a Discord API behavior that does not match this plan's assumptions, a test that reveals the race condition mitigation is insufficient), update this roadmap and the Assumptions log in the Mission Brief rather than improvising silently.
- Stop and surface any Open Question that becomes blocking, do not guess past it.
- When Phase 5 completes, this feature set is ready for `reference_bot_release_announcement_flow.md`, and the handoff note must carry the three items named in that phase's final task (the `/fortune` move, the four stale `featureAnnouncement` blocks, and the version bump ordering). That flow is a separate, later initiative with its own step by step review process (ROK public, ROK inner sanctum, streamer public, streamer inner sanctum), not something this plan drafts or fires.
