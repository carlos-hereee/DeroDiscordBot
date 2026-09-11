# Dero Leveling System and Game Expansion, master plan

**Created 2026-08-10. Revised the same day** with silent's locked decisions and the game expansion scope.
Verified against live code in `DeroDiscordBot` on 2026-08-10. Arcane research current as of `docs.arcane.bot` (premium table last updated 2026-04-13). Discord platform limits verified against `docs.discord.com` on 2026-08-10.

Companion docs: [`dero-bot-minigames-master-plan-2026-08-07.md`](./dero-bot-minigames-master-plan-2026-08-07.md) (duel, rps, hangman, fortune, BUILT) and [`dero-game-rooms-master-plan.md`](./dero-game-rooms-master-plan.md) (a channel per match, MID BUILD, and a **hard dependency of phases 7 and 8**).

---

## LOCKED DECISIONS

Answered by silent on 2026-08-10. These are settled. Do not relitigate them; if one turns out wrong, that is a new decision, not a correction.

| # | Decision | What it means downstream |
|---|---|---|
| **D1** | **The curve is `xpForLevel(n) = 3n² + 47n + 101`.** Quadratic, deliberately between Arcane's linear and the steeper exponentials. **All three coefficients are prime.** | Level 50 is ~6,684 messages, against 4,589 for Arcane's linear and 9,711 for Arcane's exponential. MEE6's own published curve is 9,756. Shipped as a named preset `dero`; linear, exponential and flat stay available as alternates |
| **D2** | **Prime numbers are milestone levels.** Levels 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97 are the loud ones | Replaces the "every N levels" milestone rule entirely. Achievement tier thresholds are primes too |
| **D3** | **Every level up posts to `#announcements`, and none of them ever ping.** Milestone levels get the loud treatment. Only explicitly approved message types may ping | New codebase invariant: a `PINGABLE` allowlist. See 5.5 |
| **D4** | **Leveling is ON in every guild immediately on deploy.** No opt in | Reverses the draft's off by default posture. R16 is rewritten around this and the mitigations move from "off by default" to "safe by default" |
| **D5** | **Blackjack, battleship and texas hold em fold into this plan as phases 6, 7 and 8**, in that order. Blackjack goes first because it is the only one with no private view problem, no game room dependency and no chip model, so it proves the whole "add a game" path cheaply. | One document, eight phases. **But each of 6, 7 and 8 ships independently after Phase 5**, so the leveling release is never blocked behind hold em. That is the one adjustment made to the instruction, and it is made specifically to protect the thing you asked for from the thing you asked for next |

### The prime mechanic, and why it is better than "every 5 levels"

This started as an aesthetic preference and turned out to be structurally correct, which is worth saying plainly.

Milestone density should be **high early and thin out late**. Early milestones drive the first week of engagement, when a new member needs frequent proof that the system is real. Late milestones should be rare, because rarity is the entire reward at level 60. "Every 5 levels" gives you a flat 20 percent density forever, which is exactly wrong at both ends.

Prime gaps do the right thing for free:

| Band | Prime milestone levels | Density |
|---|---|---|
| Levels 1 to 20 | 2, 3, 5, 7, 11, 13, 17, 19 | **8 in 20, 40 percent** |
| Levels 21 to 50 | 23, 29, 31, 37, 41, 43, 47 | **7 in 30, 23 percent** |
| Levels 51 to 100 | 53, 59, 61, 67, 71, 73, 79, 83, 89, 97 | **10 in 50, 20 percent** |

Four milestones in a member's first day or two, then a widening gap that never fully closes. Nobody in this category ships this. It is also trivially cheap: a sieve computed once at boot, memoized, and a `Set.has(level)` lookup thereafter.

### The curve, in the only units that matter

`xpForLevel(n) = 3n² + 47n + 101`, per level cost, multiplied by a per guild multiplier and rounded. Messages assume the default 15 to 40 XP roll averaging 27.5, one award per 60 seconds, message XP only.

| Level | Cost of that level | Cumulative XP | Approx messages | Prime milestone |
|---|---|---|---|---|
| 2 | 207 | 151 | 6 | yes |
| 3 | 269 | 358 | 14 | yes |
| 5 | 411 | 964 | 36 | yes |
| 7 | 577 | 1,866 | 68 | yes |
| 10 | 871 | 3,879 | 142 | no |
| 13 | 1,219 | 6,828 | 249 | yes |
| 17 | 1,767 | 12,496 | 455 | yes |
| 23 | 2,769 | 25,498 | 928 | yes |
| 31 | 4,441 | 53,250 | 1,937 | yes |
| 41 | 7,071 | 109,000 | 3,964 | yes |
| 50 | 9,951 | 183,799 | 6,684 | no |
| 53 | 11,019 | 214,708 | 7,808 | yes |
| 97 | 32,887 | 1,127,136 | 40,987 | yes |
| 100 | 34,801 | 1,227,699 | 44,644 | no |

The message column is a **ceiling**, computed as cumulative XP divided by 27.5 and rounded up, so it is the first message at which the level is actually reachable. Do not floor it: 5 messages is 137.5 XP and level 2 costs 151.

Level 2 at six messages is deliberate. A member who says hello and answers the greeter's icebreaker should level up before they stop paying attention.

And because reactions, voice and games all award XP too, real numbers will land well below the message only column. Those are the ceiling, not the expectation.

---

## MISSION BRIEF

**Goal:** Give the Dero bot a complete Arcane class progression system, XP from messages, reactions, approved voice channels and every mini game, levels on a prime flavored quadratic curve, MEE6 style tiered achievements including hidden ones, role rewards, a member profile command with per game records, and a public celebration on every level up. Then expand the game library with battleship, blackjack and texas hold em.

**Tier:** **Deep (Tier 3).** Four reasons. ① This adds the bot's **first ever `messageCreate` listener**, a permanently hot path on a process whose `main.ts` currently carries a comment explaining why that listener does not exist. ② It introduces a **second leaderboard** alongside a shipped one that measures something completely different. ③ It is cross cutting: games, game rooms, setup, the copy packs, `GuildConfig`, the command loaders, the announcement flow. ④ Phases 6 to 8 add three games whose designs are each dictated by a different hard Discord platform limit.

**Definition of Done, leveling (phases 1 to 5):**

1. A member earns XP from chatting, from reacting, from being in an approved voice channel, and from playing any mini game, each on its own cooldown.
2. Winners of duel, rps and hangman earn more than participants, and a game room match pays more than a channel match.
3. Every level up posts a Dero congratulations to `#announcements` with a celebratory reaction, and **never pings anyone**.
4. Prime levels get a visibly louder celebration than ordinary levels.
5. `/account` shows a member their level, XP, guild rank, per game win, loss, draw and assist record, messages sent, reactions given, voice minutes, and every achievement they hold **with the specific action that earned it**.
6. Achievements unlock in Bronze, Silver, Gold and Diamond tiers at prime thresholds, at least one is hidden until earned, and each announces on unlock.
7. Reaching a configured level grants a configured role, without the bot ever mass assigning roles and without it ever granting a role carrying Administrator or Manage Server.
8. Leveling is live in every guild on deploy, is safe with zero configuration, and a single flag fully disables it with no data loss.
9. The release announcement invites members to request a game through the existing Suggestion Box button.
10. `npx tsc --noEmit` clean, `npm test` green, `SACRED_FILES` updated, a FUTURE_PLANS item filed for the cut work.

**Definition of Done, games (phases 6 to 8):** each of battleship, blackjack and hold em is a `/mini-game` subcommand, awards XP through the same `awardXp` API, records a win, loss or draw on the player's `/account`, and ships as its own release independently of the other two.

**Assumptions (running log):**

- **A1.** This attaches to the game rooms release. Phases 7 and 8 additionally **depend on game rooms being shipped**, because both need a channel per match.
- **A2.** Leveling is free for every member, mirroring the mini games decision. The entitlement seam is still built, modelled on `gameRoomAccess.ts`, so a future tier gate is a config flip and not a refactor.
- **A3.** Leveling data lives in the bot's own Mongo, alongside `FortuneBuff` and `GameRoom`, and never routes through `serverApi` / `USE_REMOTE_EVENTS`. That flag governs events only.
- **A4. REVERSED by silent's answer.** Voice XP is **in scope for v1**, restricted to an admin approved list of voice channels. See 5.3.
- **A5.** Message XP is awarded **without reading message content**. The bot does not request the `MessageContent` privileged intent and this plan does not change that.
- **A6. SUPERSEDED by D1.**
- **A7. CONFIRMED by reading the source.** `getCopyOverride(key, guildConfig)` at `src/base/copy/getCopy.ts:77` takes an **arbitrary string key** and reads `GuildConfig.copyOverrides.get(key)`. Not scoped to pack fields. A key such as `leveling.levelUp` works with no schema change.
- **A8.** Achievements are defined in code as a frozen array (the `fortunes.ts` / `hangmanWords.ts` precedent). Only member progress is persisted. Admin authored achievements are out of scope.
- **A9. NEW.** Texas hold em uses a **per tournament chip stack**, not a persistent server currency. This is the decision that makes hold em buildable without first building an economy system. See 6.3.
- **A10. NEW.** `/rank` from the draft is **absorbed into `/account`**. One profile command, not two, consistent with silent's own rule that too many slash commands is itself a usability problem.
- **A11. NEW, 2026-08-11, and it CORRECTS this document.** `src/features/game-rooms/roomLifecycle.ts` **does not exist yet.** Section 2.4, section 4.2 and Spell 3 all name it, and Spell 3 lists it under "ALREADY EXISTS". Read against live code on 2026-08-11, `src/features/game-rooms/` holds `roomTypes.ts` and nothing else: game rooms is mid build at `8ada4fd` (room record, store, constants, entitlement seam) and `fa6a95f` (the GuildConfig fields), so `GameRoom.ts` and `gameRoomStore.ts` are real and the lifecycle module is not. **Four of Spell 3's five award hooks are unblocked** (duel, rps, hangman, fortune); only the game room hook waits on the lifecycle landing. Phase 2 proceeds without it. This widens A1: phases 7 and 8 already depended on the game rooms release, and now a slice of Phase 2 does too.
- **A12. NEW, 2026-08-11.** Phase 1 added **one file this plan did not name**, `src/features/leveling/levelingTypes.ts`, following the `roomTypes.ts` precedent so `@db/models/MemberLevel.ts` can import a slug union without pulling feature code into the DB layer. It exists because `GAME_SLUGS` could NOT be reused: that list means "games that get their own channel" (never blackjack, and deliberately not fortune), while leveling needs "games that keep a record on `/account`" (six slugs, also not fortune, for a different reason). Two questions, two answers. See 4.1.

**Open Questions:** none blocking. D1 through D5 closed every one that mattered. Two remain, both deferrable past Phase 5:

| # | Question | Recommendation | Decision point |
|---|---|---|---|
| Q7 | Does hold em need a persistent server chip balance later, or do per tournament stacks stay the model forever? | Per tournament forever. A persistent balance is a gambling economy and a moderation surface | Before Phase 8 |
| Q8 | Do battleship's persistent private boards use a private channel per player, or a pull based "view my board" button? | **Pull based button.** A private channel per player costs 2 channels per match against a 500 channel server cap, on top of game rooms' own channel | Before Phase 7 |

---

## 1. GOAL ANALYSIS

### Functional requirements

**Earning**

- F1. Message XP, once per cooldown, without reading message content.
- F2. **Reaction XP**, once per cooldown, awarded to the reactor, the message author, or both, configurable.
- F3. **Voice XP** for members in an **admin approved** voice channel, awarded on a sweep, with anti idle rules.
- F4. Mini game XP: play XP for everyone who took part, win XP on top for the winner.
- F5. Game room XP, paying more than the same game played in a channel.
- F6. XP restrictions: excluded channels and roles, expressed as **one mode selector plus one list**.
- F7. Per role and per channel XP multipliers with an explicit stacking rule.
- F8. Lifetime counters: messages, reactions given, voice minutes, per game played, won, lost, drawn and assisted.

**Progressing**

- F9. Level derived from total XP through a pure, invertible, unit tested curve with selectable presets, defaulting to `dero` (D1).
- F10. **Prime levels are milestones** (D2) and are visibly louder.
- F11. Every level up posts a Dero congratulations to `#announcements` with a celebratory reaction and **zero pings** (D3).
- F12. Role rewards on level up, stack or replace.
- F13. Tiered achievements at prime thresholds, at least one hidden, announcing on unlock, each recording **how** it was earned.

**Seeing**

- F14. `/account [member]` the full profile. Absorbs `/rank` (A10).
- F15. `/levels` top members for this week, this month, all time.
- F16. A self refreshing standings board in the leaderboard channel.
- F17. `/achievements [member]` unlocked with the earning action, in progress with a bar, hidden omitted until earned.

**Administering**

- F18. `/setup-level-system` sets everything in 5.1.
- F19. `/xp` add, remove, set xp, set level, reset member, reset server.
- F20. Export a guild's leveling data on request. Arcane has no export, nobody can import from Arcane, and the community workaround is a console script that scrapes their web leaderboard and drops everyone past the first 100 members. Shipping export costs an afternoon and is a real wedge.

**Announcing**

- F21. The feature announcement invites members to request a game through the **existing Suggestion Box button** (`buildSuggestionBoxButton()` in `src/features/suggestion-box/SuggestionBox.ts`), and names battleship, blackjack and hold em as already coming.

**Games (phases 6 to 8)**

- F22. Battleship, two players, fleet placement, turn based firing, persistent private boards.
- F23. Blackjack, one player against the dealer, hit, stand, double, split, insurance.
- F24. Texas hold em, two to six players, tournament chip stacks, blinds, four betting rounds, force fold on timeout.

### Non functional requirements

- N1. **Zero DB writes on the common message path.** A message that fails the cooldown costs one `Map.get`.
- N2. Buffered writes flush on an interval and from inside the **existing** `gracefulShutdown`.
- N3. All XP mutation atomic, `$inc` inside `findOneAndUpdate` or `bulkWrite`. No read modify write anywhere.
- N4. Weekly and monthly views need **no scheduled reset**. Arcane's own debugging page admits their weekly and monthly leaderboards only reset when an unrelated notification setting is enabled, "a known issue, no ETA for fix". That bug class is designed out.
- N5. Every Discord side effect is fire and forget: logged, swallowed, never thrown back. `CLAUDE.md` **convention 7**, under Conventions and rules, not one of the five Critical invariants.
- N6. Every in memory Map is bounded and swept.
- N7. Rank for one member is an index only count, never a sort of the guild.
- N8. Assume XP input is adversarial. Public farming tools for this category are mature, including 24/7 voice self bots, which is exactly why F3 has anti idle rules.
- N9. **No game may depend on the bot spontaneously updating a private view.** Interaction tokens die at 15 minutes with no renewal. See T16.
### Constraints

- **C1.** Pure ESM, `.js` suffix on every local import. `CLAUDE.md` documents six aliases: `@utils/*` `@base/*` `@api/*` `@features/*` `@commands/*` `@db/*`. `@handlers/*` also resolves (`main.ts` imports `@handlers/interactionRegistry.js`) but is missing from that list, a doc gap worth fixing in passing.
- **C2.** `npx tsc --noEmit` is the verification step. Never run `npm run build`, `tsc-alias`, `npm run deploy`, or anything that emits or deploys. The owner does those manually.
- **C3.** Tests colocated `*.test.ts`, Vitest, `npm test` is a **single** run. `npm run test:run` and `npm run test:coverage` **do not exist**; a spec doc has already shipped with those wrong names once.
- **C4.** No dashes in any user facing copy or anywhere else in output. Hyphens inside slash command identifiers are identifiers, not dashes.
- **C5.** Stores in `src/db/stores/` are thin Mongoose wrappers. Business logic goes in feature modules. Store methods are not tested.
- **C6.** Discord caps a command at 25 options, one level of subcommand nesting, and a command carrying subcommands cannot also carry top level options.
- **C7.** Production registers **global** commands. Propagation takes up to an hour, and the feature announcement fires on the `package.json` version bump.
- **C8.** The bot ships with the Administrator permission integer. **Administrator does not bypass role hierarchy.**
- **C9. NEW, platform.** Five action rows per message, five buttons per row, so **25 buttons maximum**. A string select holds **25 options**. `custom_id` is capped at **100 characters**. Components V2 replaces the five row cap with a 40 component budget, roughly 30 buttons, and costs you `content` and `embeds` entirely.
- **C10. NEW, platform.** **Interaction tokens live 15 minutes.** After that, `editReply` and `followUp` return HTTP 401 with error `50027`. There is no renewal. A normal channel message the bot posted itself has **no** edit time limit.
- **C11. NEW, platform.** An ephemeral message can only be edited through the interaction webhook that created it, inside those 15 minutes, and a bot **cannot** send a new ephemeral message outside an interaction the member just triggered.
- **C12. NEW, platform.** Application emojis: **2000 per application**, usable in every server, and **`USE_EXTERNAL_EMOJIS` is not required**. Guild emoji cap out at 50 to 250 and would need uploading per server.
- **C13. NEW, platform.** A custom emoji serializes as roughly 25 characters (`<:name:1234567890123456789>`), so a 10 by 10 custom emoji grid is about 2,500 characters and **overflows the 2000 character message content limit**. It must live in an embed description (4096) or use Unicode emoji instead.

### Acceptance criteria

Mapped one to one against the Definition of Done in section 9.

---

## 2. CODEBASE DISCOVERY

### 2.1 The finding that reframes the request

The bot **already has** `src/features/activity-tracking/`, `PlayerActivity`, `src/features/leaderboard/`, a `#leaderboard` channel, a pinned `LeaderboardBoard`, a `/leaderboard` command and a `leaderboardTrackingEnabled` toggle.

**None of it is a leveling system, and none of it can be extended into one.**

`PlayerActivity` is keyed `{ eventId, eventOccurrence, userId }` with a unique compound index. Every row requires an event and an occurrence. `ActivityTracker`'s three listeners are `MessageReactionAdd` (only ✅, only on a message that is a stored `ReminderLog`, only when that log is not a test fire), `VoiceStateUpdate` (only while a ROK event window is open) and `PresenceUpdate` (only in the first ten minutes of an event). `computeScore` weights acknowledging a reminder, being online at start, joining voice, and capped voice minutes.

That system answers **did this warrior show up for this KvK event.** Leveling answers **how present is this member in this server over time.** Folding the second into the first means inventing a fake `eventId` for "just chatting", which corrupts the participation score, the `/leaderboard` command, the dashboard players route and the pinned board simultaneously.

**Leveling is a new, parallel feature beside activity tracking, not inside it.** The vocabulary table in 5.9 is what stops the next reader merging them back.

**This matters twice over now that reaction XP and voice XP are in scope**, because those are the two events `ActivityTracker` already listens to. Two listeners on the same event is correct here and will look like a bug to the next reader. Both new listeners must carry a comment saying so, and neither may touch `PlayerActivity`.

### 2.2 There is no `messageCreate` listener, and that is on purpose

`src/main.ts` lines 60 to 85 construct the client with `Guilds`, `GuildMembers`, `GuildMessages`, `GuildVoiceStates`, `GuildPresences`, `GuildMessageReactions`, and carries this comment at lines 67 to 72:

> MessageContent intent intentionally NOT requested: the bot reads no message text (every message.content reference is commented-out legacy code, and there is no messageCreate listener). MessageContent is a privileged intent gated by Discord verification at 100+ guilds, so requesting it while unused is pure verification risk. Re-add only if a feature genuinely needs to read message bodies.

`grep -rn "messageCreate" src/` returns exactly one hit: that comment.

This is a gift. `GuildMessages` alone tells the bot **that** a message happened, in which channel, from which member. That is the whole input a cooldown gated award needs. `MessageContent` is only required for per word or length based XP, which is also the most gameable mode in the category. Skipping it skips a privileged intent, a verification hurdle at 100 guilds, a privacy surface and a farming vector in one decision.

The clause "and there is no messageCreate listener" becomes false in Phase 2. **Update that clause, keep the rest of the comment**, which stays true and is the reasoning that protects the decision.

Everything else is already in place: `GuildMessageReactions` plus `Partials.Reaction` and `Partials.Message` are declared (reaction XP needs no intent change), and `GuildVoiceStates` is declared (voice XP needs no intent change either).

### 2.3 What is already built and must be reused

| Thing | Path | How this plan uses it |
|---|---|---|
| `CooldownManager` | `src/utils/cooldownManager.ts` | Reaction, voice and game cooldowns. Its contract: `check()` does **not** record; callers `record()` only after success |
| `interactionRegistry` | `src/handlers/interactionRegistry.ts` | `registerButton(prefix, handler)` and `registerModal(prefix, handler)`. `PowerUps.ts` and `SuggestionBox.ts` are the models |
| `gateOwnerOrAdmin` | `src/utils/permissions.ts` | Admin gating, and re verification inside any button handler |
| Board post or edit | `LeaderboardBoard.ts` `postOrEdit` | Copy wholesale: edit in place, recover on `10008` / `10003`, bail on a foreign author, never throw |
| Coalescing throttle | `LeaderboardBoard.ts` `scheduleLeaderboardRefresh` | Copy the **coalescing** shape: the first event schedules, later events in the window are absorbed and the timer is left running. Deliberately not a reset on each call debounce |
| Feature local copy | `gamesCopy.ts`, `fortuneCopy.ts` | The precedent for opting out of the two voice packs. See 2.6 |
| Brand colors | `src/base/copy/brand.ts` `COLORS` | Add leveling and new game keys beside `GAME_CHALLENGE` / `GAME_DUEL` / `GAME_RPS` / `GAME_HANGMAN` |
| Entitlement seam | `src/features/entitlements/gameRoomAccess.ts` | The exact shape for a fail open, cached, server resolved gate built before the price |
| Pure and impure split | `duelResolve.ts`, `rpsWinner.ts`, `hangmanState.ts`, `occurrenceCalculator.ts` | Every new pure module follows these: no discord.js, no I/O, no module state, injectable rng and clock |
| **Suggestion Box** | `src/features/suggestion-box/SuggestionBox.ts` | `buildSuggestionBoxButton()` returns a ready `ButtonBuilder`. **This is the "request a game" CTA in F21.** No new feedback surface needed |
| **Feature announcement** | `src/features/announcements/postFeatureAnnouncement.ts` | Once per guild per `package.json` version, idempotent through `botLogStore` on `feature_announced:<version>`, posts to `#announcements` and the admin channel. It can also skip guilds that joined after a version shipped, **but only for versions listed in the hardcoded `VERSION_SHIPPED_AT` map**, which today holds 1.4.0, 1.5.0 and 1.5.1 while `package.json` is already at 1.6.1. That skip is therefore dormant, and the release version must be added to that map or it will not apply |
| `challengeFlow` | `src/features/games/challengeFlow.ts` | `issueChallenge({ interaction, opponent, kind, gameLabel })` with an inline component collector. **Battleship reuses this** rather than writing a second challenge handshake |
| `gamesAssets` | `src/features/games/gamesAssets.ts` | `resolveGameAsset(key)` returning `{ ref, attachment }`. The three new games register their art here |

### 2.4 Where every XP hook goes, exactly

| Source | File | Insertion point | Who earns |
|---|---|---|---|
| message | new `messageXp.ts` | `Events.MessageCreate` | author |
| reaction | new `reactionXp.ts` | `Events.MessageReactionAdd`, a **second** listener beside `ActivityTracker`'s | reactor and/or author, configurable |
| voice | new `voiceXp.ts` | a sweep over cached voice states, **not** a `VoiceStateUpdate` award | every qualifying member in an approved channel |
| duel | `games/duelHandler.ts` | after `outcome.accept.reply(...)`, beside `cooldown.record(cooldownKey)` at line 83 | both players; winner from `result.winner`; `"tie"` pays both the tie amount |
| rps | `games/rpsHandler.ts` | after `scoreRps(...)` around line 288 and after the reveal embed | same three way shape |
| hangman | `games/hangmanHandler.ts` | the `won` branch around line 307 | every id in the new participants set. **See T13** |
| fortune | `fortune/respondWithFortune.ts` | after a successful reading | reader only, small flat award. **Not** `fortuneHandler.ts`, see T12 |
| game room | `game-rooms/roomLifecycle.ts`, the `finish` path | the `playing` to `finished` transition | `GameRoom.playerIds`, winner from `GameRoom.winnerId`. **Not** `gameRoomStore.ts` |
| blackjack | Phase 6 | on hand resolution | player |
| battleship | Phase 7 | on sink and on win | shooter |
| hold em | Phase 8 | on hand won and on tournament placement | winner and finishers |

Every one is **fire and forget**. XP must never be able to break a game.

### 2.5 The K, D, A model for `/account`

silent asked for a K/D/A style record. Games do not have kills, so here is the mapping, and it is worth getting right because it is the number members will screenshot.

| Column | Means | Per game |
|---|---|---|
| **Played** | rounds you took part in | all |
| **Won** | rounds you won | duel, rps, blackjack, battleship, hold em hands |
| **Lost** | rounds you lost | all |
| **Drawn** | ties | duel dice, rps, blackjack push |
| **Assists** | you materially advanced a round somebody else won | **hangman**: you revealed at least one correct letter in a round another member solved |

Hangman is the only current game with a genuine assist, and it is the reason the participants set in T13 has to exist anyway. Battleship and hold em add none. If a future game is co operative, assists is where it lands.

`/account` also shows a **W/L ratio** per game and an overall one, messages sent, reactions given, voice minutes, level, XP into level, XP to next, guild rank, and every achievement held **with the action that earned it**.

### 2.6 The copy pack decision

`CLAUDE.md` rule 5 routes user facing copy through `rok-commander.pack.ts`. `gamesCopy.ts` and `fortuneCopy.ts` both carry explicit comments explaining why they opted out: "rock beats scissors has no kingdom voice and no streamer voice, so a two voice split here would double the authoring work for content that would read identically in both packs."

Leveling splits down the middle of that test:

- **Structural copy** ("Level", "XP to next", "Rank", command and option descriptions, error strings) reads identically in both voices. Feature local, `levelingCopy.ts`.
- **The Dero congratulations** is the one string with a real voice. "You reached level 13" versus "Your renown grows, warrior."

**The call:** `levelingCopy.ts` holds the default template, and the congratulations is additionally overridable per guild via `getCopyOverride("leveling.levelUp", guildConfig)` and `getCopyOverride("leveling.milestone", guildConfig)`. **This is confirmed, not assumed:** `getCopy.ts:77` takes an arbitrary string key and reads `copyOverrides.get(key)`. Two voices without authoring two packs, and the owner can retune the one voiced string with no deploy.

### 2.7 The traps, all verified against live code and live platform docs on 2026-08-10

- **T1.** `leaderboardTrackingEnabled` governs **participation writes only**. Do not reuse, extend or rename it. Leveling gets `leveling.enabled`.
- **T2.** Admin gating here is **two independent mechanisms and you need both.** ① `BOT_CONSTANTS.ADMIN_COMMANDS`, a runtime `Set` checked in `main.ts` against `interaction.commandName` alone. ② `.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)` on the builder, which is what actually **hides** the command in a member's picker. Note `configure-leaderboard-tracking` is an admin command that is **not** in `ADMIN_COMMANDS`, so that Set is not the definition of "admin command". `/setup-level-system` and `/xp` need both. `/account`, `/levels` and `/achievements` need neither.
- **T2b. Naming, decided by silent 2026-08-10.** The admin config command is **`/setup-level-system`**, not `/level-config` and not `configure-level-system`. Note that this deliberately breaks the repo's existing `configure-*` family (`configure-leaderboard-tracking`, `configure-leaderboard-week-start`, `configure-auto-heal`, `configure-rok-reminders`, `configure-stream-schedule`). Do not "correct" it back. The upside is real: an admin typing `/setup` in the picker now sees the homebase builder **and** the leveling setup side by side, which is exactly the moment they are most likely to want it, and leveling ships on by default so discoverability at that moment matters more than family consistency. The one thing to watch: `/setup` builds channels and roles, `/setup-level-system` only writes config and creates nothing, so the command description must say so plainly or an admin will expect it to provision something.
- **T3.** `ICommand.data` is typed `SlashCommandBuilder` but is documentary only; both loaders read modules dynamically. `.addSubcommand()` narrows the builder type, so `/xp`'s `data` export must stay **unannotated**. Never cast to `any`, never to `SlashCommandBuilder`. `mini-game.ts` lines 29 to 44 spell this out.
- **T4. CORRECTED, the older project memory note is stale.** The `commandGuide` fun command entry **already shipped** with the mini games. `commandGuide.test.ts` asserts both packs name `` `/mini-game` `` and `` `/secret-code` `` in one shared field. The live trap is sharper: that file also asserts **"lists the SAME command set in both packs"** by regex extracting every `` `/command` `` from each guide and comparing sorted arrays. Adding `/account` to one pack and forgetting the other is a **hard test failure**, not a silent gap. It also pins Discord's limits, 25 fields and 1024 characters per value, so new commands join an existing field.
- **T5.** `deploy-commands.ts` does a `rest.put` on the full set, so nothing needs manual deregistration. Production is **global**, propagation is up to an hour, and the announcement fires on the `package.json` version bump. Verify propagation in a real guild **before** the bump.
- **T6.** Do not collapse cooldowns. Each feature keeps its own `CooldownManager`. Message, reaction and voice XP are three more, separate.
- **T7.** `PlayerActivity` deliberately has **no TTL** and the model says so at length: it is the historical record the leaderboard reads back. The new `XpPeriod` collection is the opposite case, derivable per period aggregates, so a TTL there is correct. Read T7 as "TTL only what is derivable", not "this repo does not TTL".
- **T8.** Every homebase channel except `#introductions` is member read only. Members earn message XP in the guild's **own** channels, outside the bot's category. A test guild whose only channels are the homebase will appear to award nothing, which reads as a bug and is not one.
- **T9.** `GuildSetupManager.createChannels` has **zero test coverage**; `GuildSetupManager.test.ts` spies out `runAutoSetup`. Do not add a channel there casually. Second reason the levels board reuses `leaderboardChannelId`.
- **T10.** Bot game state is module scoped `Map`s and does not survive a Railway redeploy. `main.ts` **already registers** `SIGTERM` and `SIGINT` to a `gracefulShutdown` ending in `process.exit()`. The XP flush hooks **into** it as step ⓪; it does not add a second listener.
- **T11.** `src/commands/events/rps.ts`, `eightBall.ts`, `sun-qoute.ts`, `poll.ts` are dead, fully commented out, pre slash command stubs (verified: `rps.ts` line 1 is `// import { Message } from "discord.js";`). Never revive them.
- **T12.** The `powerup:member:fortune` button calls `respondWithFortune` directly. Award fortune XP there or the button path silently earns nothing.
- **T13.** `HangmanRound` holds only `{ starterId, state, stop }`. There is **no participant set**, so hangman XP and hangman assists are both impossible until `participants: Set<string>` is added and populated on modal submit. Also: `actorId` in the terminal branch is whoever made the **final** guess, the solver on a win and the member who hanged it on a loss. Gate the win bonus on `won === true`.
- **T14.** `gameRoomAccess.ts` fails **open** and `earlyAccess.ts` fails **closed**, deliberately, and the file warns that the next reader will want to "fix" the inconsistency. The leveling seam copies `gameRoomAccess` for the same reason.
- **T15. PAID 2026-08-11.** This said no FUTURE_PLANS item for leveling, XP or achievements existed anywhere in `SACRED_FILES` (grepped across `FUTURE_PLANS.md`, `-PART-2`, `-PART-3` and `STATE.md`), and that the work **owed a new item**. It is now **2026-08 item 103**, in `SACRED_FILES/2026-08/FUTURE_PLANS-PART-3.md`, filed in the same session that shipped Phase 1 and carrying the whole deferred list Phase 5 would otherwise have had to reconstruct. Phase 5 UPDATES that item rather than creating one. Note also that **game rooms itself still has no FUTURE_PLANS item** (grepped, zero hits across all three parts), which is a separate gap and is recorded inside 103.
- **T16. NEW, and it decides the design of two games.** Interaction tokens live **15 minutes**, then `editReply` and `followUp` return 401 `50027` forever. There is no renewal. Every button click mints a **fresh** token with a fresh 15 minutes, so a private view can only be maintained as a chain of **member initiated** re anchors. A normal channel message the bot posted has **no** edit limit. Consequence: the public board is a bot channel message edited for the whole match, and any private view is delivered on the member's own click. The production Texas Hold'Em Poker bot states this in its own public description: "Due to discord limitations regarding ephemeral responses, every player must click on this button at the start of each hand in order to view their cards."
- **T17. NEW.** 25 buttons per message, and Components V2 raises that to roughly 30, not 100. **A battleship 10 by 10 grid can never be a button grid.** See 6.1.
- **T18. NEW.** A modal **cannot** be shown in response to a modal submit. No chained modals. Multi step input must be re triggered by a button.
- **T19. NEW.** Do not reach for DMs. A bot can DM a shared server member by default, but the member can disable it and you get `50007` with no recourse, and Discord explicitly warns "DMs should generally be initiated by a user action" and that opening many DM channels quickly can get the bot rate limited or blocked. The mini games plan already ruled DMs out for rps; that ruling extends to every game here.
- **T20. NEW.** A 10 by 10 grid of **custom** emoji is about 2,500 characters and overflows the 2000 character message content limit (C13). Put grids in an embed description, or use Unicode emoji.
---

## 3. SOLUTION BRAINSTORMING

### Approach A, extend `PlayerActivity` with a synthetic event

Add a reserved `eventId` such as `__chat__` so `/leaderboard` and the dashboard pick it up free.

**Effort** low. **Risk** severe. It poisons the `totalScore`, `eventsAttended` and `totalVoiceMinutes` that `activityStore.findAllGroupedByPlayer` aggregates, silently changing what a shipped, member visible command reports. Every existing aggregation would need a `$ne` filter, and any one missed would be wrong quietly. **Rejected.**

### Approach B, a separate leveling feature with one award API

`src/features/leveling/` with `MemberLevel` and `XpPeriod`, its own commands, its own board message in the existing leaderboard channel, and a small `awardXp` that every source calls.

**Effort** medium. **Risk** medium, concentrated in one place, the new hot listener. Nothing existing changes behavior. The games touch it with one fire and forget line each, and phases 6 to 8 inherit it for free. **Selected.**

### Approach C, approach B plus Redis for ranks

Mirror XP into a Redis sorted set per guild so `ZREVRANK` answers rank in O(log n).

**Effort** high, and it adds infrastructure the bot does not have. The stack is Railway plus Mongo Atlas, no Redis anywhere. An index only `countDocuments({ guildId, totalXp: { $gt: mine } })` is exact and fast well into the tens of thousands, one to two orders of magnitude past this bot's size. **Rejected for v1, documented as the escape hatch in 5.10.**

### Decision

**Approach B.** The only option that adds leveling without changing what a shipped leaderboard reports, and the one scaling concern it defers has a clean upgrade path that needs no data model change.

---

## 4. IMPACT ANALYSIS

### 4.1 Files to create, phases 1 to 5

```
src/features/leveling/levelingTypes.ts          pure vocabulary: slugs, sources, outcomes (A12)
src/features/leveling/levelCurve.ts             pure: presets incl. dero, prefix sums, binary search
src/features/leveling/levelCurve.test.ts
src/features/leveling/primeLevels.ts            pure: sieve once at boot, isMilestone(level)
src/features/leveling/primeLevels.test.ts
src/features/leveling/levelPeriod.ts            thin wrapper over leaderboardWindow.periodKey
src/features/leveling/levelingCopy.ts           feature local copy, no pack indirection
src/features/leveling/levelingEmbeds.ts         does NOT call embedBuilder.base()
src/features/leveling/xpWriter.ts               cooldown claim, stage, buffered flush, flushNow
src/features/leveling/xpWriter.test.ts
src/features/leveling/awardXp.ts                the ONE public award API
src/features/leveling/awardXp.test.ts
src/features/leveling/messageXp.ts              messageCreate listener + restrictions
src/features/leveling/messageXp.test.ts
src/features/leveling/reactionXp.ts             second MessageReactionAdd listener
src/features/leveling/reactionXp.test.ts
src/features/leveling/voiceXp.ts                approved channel sweep + anti idle
src/features/leveling/voiceXp.test.ts
src/features/leveling/levelUpAnnouncer.ts       coalescing queue, Dero congrats, reaction, NO PINGS
src/features/leveling/levelUpAnnouncer.test.ts
src/features/leveling/roleRewards.ts            desired set, roles.set, error taxonomy
src/features/leveling/roleRewards.test.ts
src/features/leveling/achievements.ts           frozen definitions, prime thresholds, hidden entries
src/features/leveling/achievementEngine.ts      pure evaluate(counters, unlocked) -> newly unlocked
src/features/leveling/achievementEngine.test.ts
src/features/leveling/LevelsBoard.ts            pinned standings board
src/features/entitlements/levelingAccess.ts     fail open seam

src/db/models/MemberLevel.ts + .test.ts
src/db/models/XpPeriod.ts
src/db/stores/memberLevelStore.ts
src/db/stores/xpPeriodStore.ts

src/commands/fun/account.ts               /account              public  (absorbs /rank, A10)
src/commands/fun/levels.ts                /levels               public
src/commands/fun/achievements.ts          /achievements         public
src/commands/admin/setup-level-system.ts  /setup-level-system   admin
src/commands/admin/xp.ts + .test.ts       /xp                   admin, subcommands, UNANNOTATED data
```

### 4.2 Files to modify, phases 1 to 5

| File | Change | Phase |
|---|---|---|
| `src/main.ts` | Register the three XP listeners and the announcer, start the voice sweep, boot sweep `refreshAllLevelsBoards`, **update the MessageContent clause at lines 67 to 72**, and add `flushNow()` as step ⓪ **inside the existing `gracefulShutdown`**, never as a second `SIGTERM` listener (T10, R6) | 2, 3 |
| `src/base/copy/brand.ts` | `COLORS`: `LEVEL_UP`, `LEVEL_MILESTONE`, `ACCOUNT`, `ACHIEVEMENT`, `LEVELS_BOARD` | 1 |
| `src/base/constants/BOT_CONSTANTS.ts` | A `LEVELING` block; add `setup-level-system` and `xp` to `ADMIN_COMMANDS` | 1, 3 |
| `src/db/models/GuildConfig.ts` | The `leveling` subtree and `levelsMessageId` | 1 |
| `src/base/copy/packs/rok-commander.pack.ts` | Add `/account`, `/levels`, `/achievements` to the **existing** `commandGuide` fun field | 3 |
| `src/base/copy/packs/general-events.pack.ts` | The same edit. Both or the suite fails (T4) | 3 |
| `src/base/copy/packs/commandGuide.test.ts` | Assert the three new commands in both packs | 3 |
| `src/features/games/duelHandler.ts` | One fire and forget `awardGameXp` | 2 |
| `src/features/games/rpsHandler.ts` | Same | 2 |
| `src/features/games/hangmanHandler.ts` | `participants: Set<string>` on `HangmanRound`, populate on modal submit, award on end, record assists (T13) | 2 |
| `src/features/fortune/respondWithFortune.ts` | Small award here, **not** in `fortuneHandler.ts` (T12) | 2 |
| `src/features/game-rooms/roomLifecycle.ts` | Award on `finish` from `playerIds` and `winnerId`. **Not** the store (C5) | 2 |
| `src/features/announcements/postFeatureAnnouncement.ts` | The release entry, plus `buildSuggestionBoxButton()` on the public embed (F21) | 5 |
| `src/base/constants/log-messages.ts` | A `leveling` block | 1 |
| `src/features/reminders/ReminderScheduler.ts` | Hourly tick also refreshes levels boards | 3 |
| `src/features/leaderboard/leaderboardWindow.ts` | Add a date injectable `periodKey(date, granularity, weekStart)`. The **only** file under `leaderboard/` this plan touches | 1 |
| `src/features/games/challengeFlow.ts` | `ChallengeKind` is `"duel" \| "rps"` today and must gain `"battleship"`. The handshake itself is reused unchanged | 7 |
| `DeroDiscordBot/CLAUDE.md` | A `leveling/` feature row, and the missing `@handlers/*` alias (C1). The stale messageCreate sentence is in `main.ts`, not here | 5 |

### 4.3 Files to delete

None.

### 4.4 Dependency graph

```
levelCurve.ts     (pure) ─┐
primeLevels.ts    (pure) ─┤
levelPeriod.ts    (pure) ─┤
achievementEngine (pure) ─┤
                          ├─> awardXp.ts ─┬─> messageXp.ts  ─┐
MemberLevel / XpPeriod ───┤               ├─> reactionXp.ts  ├─> main.ts
memberLevelStore ─────────┘               ├─> voiceXp.ts     ─┘
xpPeriodStore                             ├─> duel / rps / hangman / respondWithFortune
                                          ├─> roomLifecycle.finish
                                          ├─> battleship / blackjack / holdem  (phases 6 to 8)
                                          ├─> levelUpAnnouncer.ts ──> Discord
                                          └─> roleRewards.ts ───────> Discord

memberLevelStore ──> account.ts / levels.ts / achievements.ts / xp.ts / LevelsBoard.ts
levelingAccess.ts ──> awardXp.ts (seam only, allows everything today)
```

Two rules the graph encodes and section 8 tests:

1. The four pure modules import **nothing** from discord.js, a store, or a handler. Same discipline as `duelResolve`, `rpsWinner`, `hangmanState` and `occurrenceCalculator`.
2. **`awardXp.ts` is the only public entry point.** Every source calls it and nothing else. A game handler never touches a store, the curve or the announcer directly. This is what makes phases 6 to 8 nearly free.

### 4.5 Data flow, message XP

```
messageCreate
  └─ author.bot?    return   (0 I/O)      └─ no guild?   return  (0 I/O)
  └─ system?        return   (0 I/O)
  └─ claimCooldown(guild,user) false? return   (0 I/O, SYNCHRONOUS, no await)
  └─ config = cachedGuildConfig(guildId)        (TTL cache)
  └─ leveling.enabled false?  return
  └─ channel or role restricted? return
  └─ xp = roll(min,max) * multiplier
  └─ stage(guildId, userId, xp)                 in-memory Map
       ...
  flush every 10s, and flushNow() from gracefulShutdown
  └─ bulkWrite [$inc totalXp, counters] MemberLevel   (ordered:false, upsert)
  └─ bulkWrite [$inc xp]                XpPeriod      (week key + month key)
  └─ for each doc whose level crossed:
       └─ claim: updateOne({_id, announcedLevel:{$lt:new}}, {$set:{announcedLevel:new}})
       └─ modifiedCount === 0? someone else announced. skip
       └─ levelUpAnnouncer.enqueue(...)      fire and forget, NEVER pings
       └─ roleRewards.reconcile(...)         fire and forget
       └─ achievementEngine.evaluate(...)    fire and forget, flush path ONLY
```

**The cooldown claim is synchronous with no `await` between its read and its write.** That single property is the entire race defense: two messages in the same tick cannot both pass, because the second sees the first's write without ever yielding the event loop. Same discipline as `hangmanHandler.startHangmanRound` claiming a channel slot and `challengeFlow`'s pair key.

### 4.6 Risk Register

The single home for risk. Later sections reference by id.

| id | Risk | Likelihood | Impact | Mitigation | Rollback |
|---|---|---|---|---|---|
| **R1** | The first `messageCreate` listener becomes a permanent hot path and regresses the bot | Medium | High | Cheapest guards first, synchronous cooldown claim before any await, TTL cached config, buffered writes | `leveling.enabled = false` per guild, or the global kill switch env var. No deploy |
| **R2** | Someone adds per word or length XP later and reaches for `MessageContent` | Medium | High | Stated in `levelingCopy.ts` and in the `main.ts` comment, and the XP roll function **takes no message text as a parameter**, so it cannot be done accidentally | Revert one line |
| **R3** | Two leaderboards confuse members and the next engineer | High | Medium | Vocabulary table 5.9, separate commands, a subtitle in each embed stating what it measures | Copy only |
| **R4** | Role reward fails `50013` because the role sits above the bot's, or carries Administrator | High | Medium | Hierarchy precheck, `role.managed` check, refuse Administrator and ManageGuild, catch anyway because discord.js reports stale positions, log **once per guild plus role** | Remove the reward; `/account` self heals on next run |
| **R5** | Level up posts make `#announcements` unreadable | **High**, raised by D3 | Medium | **Never ping** (D3), per channel coalescing collapses a burst into one combined message, ordinary level ups are a compact one liner while only prime milestones get the full Dero card | Set `announceMode` to `milestone` or `off` |
| **R6** | Buffered XP lost on a Railway redeploy | Medium | Low | `flushNow()` from **inside** `gracefulShutdown`, before `client.destroy()` and `disconnectMongoose()`. A sibling `SIGTERM` listener would race that shutdown and could be killed mid `bulkWrite` or fire after Mongo disconnected | Accepted |
| **R7** | Concurrent upserts race and throw `E11000` | Medium | Low | Unique compound index on `{ guildId, userId }`, retry once on code 11000. The retry always succeeds because the doc now exists | n/a |
| **R8** | Unbounded cooldown and pending maps | Medium | Medium | Sweep entries older than the max configured cooldown; pending clears on every flush | Restart clears both |
| **R9** | Global propagation lag collides with the version bump announcement | Medium | Medium | Verify propagation in a real guild before the bump. A Phase 5 gate, not a suggestion | Delay the bump |
| **R10** | `XpPeriod` grows unbounded | Low | Medium | TTL index sized to the retention window. Legitimate here and not on `PlayerActivity` because period rows are derivable (T7) | Drop the index |
| **R11** | Achievement recursion: unlock grants XP, XP levels up, level up re evaluates | Medium | High | Evaluate **only from the flush path**, never inside an unlock. Unlock XP stages into the **next** flush like any other award, and the evaluator is idempotent against already unlocked ids | Set achievement XP to 0 |
| **R12** | Leveling copy routed wholesale into a voice pack because of `CLAUDE.md` rule 5 | High | Low | 2.6 states the split and `levelingCopy.ts` carries the reasoning inline, as `gamesCopy.ts` does | Cheap refactor |
| **R13** | Hangman XP silently rewards two people, and assists never work | High | Medium | Phase 2 adds `participants: Set<string>` before any hangman award | Award starter only |
| **R14** | `/xp` fails to compile because `data` was annotated (T3) | Medium | Low | Leave `data` unannotated and say why | Remove the annotation |
| **R15** | Leveling commands added to one pack's `commandGuide` and not the other | Medium | Medium | `commandGuide.test.ts` already asserts both packs list the **same** command set, so this fails the suite rather than shipping | Copy only |
| **R16. REWRITTEN by D4** | Leveling is on everywhere on deploy, so an admin who did not ask for it gets an unconfigured system in a live server | **High** | **High** | **Safe by default, not off by default.** ① never ping (D3). ② `announceChannelId` falls back to `announcementsChannelId`, which every set up guild has. ③ restrictions default to excluding nothing, so nothing silently earns zero. ④ on the **first ever level up in a guild**, post a one time notice in the admin channel naming `/setup-level-system` and how to disable, idempotent through `botLogStore` the way the feature announcement already is. ⑤ a global kill switch env var. ⑥ the release announcement leads with the fact that this is now on | Global env kill switch (redeploy, no code change), or `leveling.enabled = false` per guild (no deploy) |
| **R17** | XP farming in a bot command or spam channel | High | Medium | 60s message cooldown as the industry floor, restrictions configured to exclude bot channels, and **no length or per word bonus at all** | Add the channel to restrictions |
| **R18. NEW** | Voice XP farmed by a member idling in a channel forever, or by a 24/7 voice self bot | **High** | Medium | Copy Arcane's three countermeasures wholesale: a **minimum member count** in the channel, require **not self muted and not self deafened and not server muted or deafened**, and **anti idle decay** that reduces the award after a configured session length. Plus this bot's own addition: only **admin approved channels** earn at all (F3), which no competitor offers | Empty the approved list |
| **R19. NEW** | Reaction XP farmed by spamming reactions on one message, or by reaction trading | High | Low | Its own cooldown, defaulting to 5 minutes, and awarding at most once per member per message | Set reaction XP to 0 |
| **R20. NEW** | A phase 6 to 8 game depends on the bot pushing an update into a private view, and silently breaks after 15 minutes (T16) | **High** | **High** | Every private view is **pull based**: the public board carries a per player button, and the private state is delivered on **that member's own click** using **that click's** token. No correctness may depend on an unsolicited private update | Design constraint, not a runtime failure |
| **R21. NEW** | A game room or private channel per player exhausts a server's channel cap | Medium | Medium | Server cap is 500 channels including categories and voice; game rooms already caps 20 concurrent per guild and deletes on archive. **Battleship uses pull based private boards, not a channel per player** (Q8) | Lower the game rooms cap |
| **R22. NEW** | Hold em becomes a gambling economy and a moderation surface | Medium | High | **Per tournament chip stacks only** (A9). No persistent balance, no transfers, no purchase, nothing that survives the table | Design constraint |

---

## 5. TECHNICAL DESIGN

### 5.1 Data models

**`MemberLevel`**, one row per member per guild. The durable truth.

```
memberLevelId  String  unique default v4      (matches every other model in this repo)
guildId        String  required
userId         String  required
username       String  required               (display name at write time, same precedence
                                               ActivityTracker uses: nickname, globalName, username)
totalXp        Number  default 0              (the ONLY XP field. level is DERIVED)
announcedLevel Number  default 0              (announcement claim, NOT the member's level)
messages       Number  default 0
reactionsGiven Number  default 0
voiceMinutes   Number  default 0
fortuneReadings Number default 0             (backs the hidden dero-knows achievement)
games          Map<string, {                  keyed by game slug: duel, rps, hangman,
                 played, won, lost, drawn,    battleship, blackjack, holdem
                 assists }>
unlocked       [{ id, tier, at, earnedBy }]   earnedBy is the human sentence for /account
lastAwardAt    Date    default null
timestamps: true

index { guildId: 1, userId: 1 } unique         <- required, R7 depends on it
index { guildId: 1, totalXp: -1 }              <- rank + board, index only
```

`level` is **never stored.** A stored level is a second source of truth that drifts the moment someone runs `/xp set` or the guild changes its curve. `announcedLevel` is **not** the member's level, it is a high water mark that makes announcement claiming atomic, and it needs a comment saying so or the next reader will "fix" it into a level field.

`unlocked` carries `earnedBy` because silent asked for `/account` to show **how** an achievement was earned. Compose that sentence at unlock time ("solved 101 hangman rounds", "reached level 31") rather than reconstructing it later from counters that have since moved.

**`XpPeriod`**, one row per member per guild per period. Derivable, disposable.

```
xpPeriodId String unique default v4   (uniformity with every other model, nothing looks it up)
guildId    String required
userId     String required
period     String required            "2026-W32" or "2026-08"
xp         Number default 0
timestamps: true

index { guildId: 1, period: 1, xp: -1 }
index { guildId: 1, userId: 1, period: 1 } unique
TTL on createdAt sized to the retention window
```

**This design is the whole answer to N4.** There is no `weekXp` field to zero, therefore no reset job, therefore no reset job to fail. "This week" is a query on the current period key. Arcane ships a documented, unfixed bug in exactly this spot; a schema with nowhere to put that bug beats a job that has to remember to run.

**`GuildConfig` additions:**

```
levelsMessageId: { type: String, default: null }      // sibling of leaderboardMessageId

leveling: {
  enabled:           { type: Boolean, default: TRUE },     // D4, on everywhere
  curve:             { enum ["dero","linear","exponential","flat"], default: "dero" },   // D1
  curveMultiplier:   { type: Number, default: 1 },
  maxLevel:          { type: Number, default: null },
  milestoneMode:     { enum ["prime","everyN"], default: "prime" },                       // D2
  milestoneEveryN:   { type: Number, default: 5 },         // only read when mode is everyN

  message:  { enabled: true,  min: 15, max: 40, cooldownSeconds: 60 },
  reaction: { enabled: true,  min: 10, max: 25, cooldownSeconds: 300,
              awards: { enum ["reactor","author","both"], default: "reactor" } },
  voice:    { enabled: true,  perMinute: 5, cooldownSeconds: 180,
              approvedChannels: [String],                  // EMPTY MEANS NONE EARN
              minMembers: 2, decayAfterMinutes: 120, decayFactor: 0.25 },

  announceMode:      { enum ["announcements","current","milestone","off"], default: "announcements" },
  announceChannelId: { type: String, default: null },      // null -> announcementsChannelId
  reactionEmoji:     { type: String, default: "🎉" },      // Dero's congratulations reaction

  restrictionMode:   { enum ["exclude","only"], default: "exclude" },
  restrictedChannels:[String],
  restrictedRoles:   [String],

  stackRewards:      { type: Boolean, default: true },
  rewards:           [{ level: Number, roleId: String }],
  roleMultipliers:   [{ roleId: String, multiplier: Number }],
  channelMultipliers:[{ channelId: String, multiplier: Number }],
  stackMultipliers:  { type: Boolean, default: false },
}
```

Two lines deserve their reasoning inline in the schema.

**`restrictionMode` plus one list.** Arcane's restrictions page opens with a DANGER banner saying misconfiguration there is their **largest support item**, because they ship "No XP channels" (a blacklist) and "XP channels" (a whitelist) as adjacent settings with inverted semantics: add one channel to the whitelist and XP silently dies everywhere else. One mode plus one list makes that unrepresentable. `/setup-level-system` also echoes a live preview, "XP is earned in 14 of 17 channels".

**`voice.approvedChannels` defaults to empty, and empty means nobody earns voice XP.** This is the opposite default from every other setting here and it is deliberate: silent asked for "approved voice calls", so voice XP is opt in per channel by construction. A guild that never configures it never has a voice farming surface. Say so in the schema comment, because an empty array that means "none" rather than "all" is exactly the kind of thing a later reader inverts.

### 5.2 The curve and the primes

```
xpForLevel(n, preset, multiplier) -> Number      // XP to complete level n
  dero         3*(n^2) + 47*(n) + 101            // DEFAULT (D1), all coefficients prime
  linear       (n * 100) + 75                    // Arcane's default
  exponential  5*(n^2) + (n*50) + 75             // Arcane's own exponential preset.
                                                  // NOT MEE6's, which is 5n^2 + 50n + 100
  flat         1000
  each multiplied by curveMultiplier, then ROUNDED (Arcane rounds, it does not floor)

totalXpForLevel(n)   cumulative prefix sum, computed ONCE at boot to MAX_LEVEL_CEILING
levelFromTotalXp(xp) binary search over that prefix array
xpIntoLevel(xp) / xpToNextLevel(xp)              for the progress bar

isMilestone(level)   primeLevels.ts: sieve once at boot, Set.has thereafter
```

Precompute the prefix sums at module load per `(preset, multiplier)` pair, memoized. `levelFromTotalXp` is then a binary search in microseconds and **never** a loop subtract and **never** a DB call. Loop subtracting is what most tutorial code does and it becomes CPU at scale.

`primeLevels.ts` is a sieve to `MAX_LEVEL_CEILING` computed once at boot into a `Set<number>`. `isMilestone` is then O(1). It is pure, it is ten lines, and it is unit tested against a hand written list of the primes under 100.

### 5.3 The three passive XP sources

**Message XP.** Guard order in 4.5. No content is read. The roll function takes no message text as a parameter.

**Reaction XP.** A **second** `MessageReactionAdd` listener, registered beside `ActivityTracker`'s. Both must carry a comment pointing at each other, because two listeners on one event reads as a bug. The differences are total: `ActivityTracker` filters to ✅ on a stored `ReminderLog` and writes `PlayerActivity`; this one accepts any emoji, ignores `ReminderLog` entirely, and writes `MemberLevel`. Its own `CooldownManager` at 5 minutes, at most one award per member per message, and `awards` decides whether the reactor, the author, or both are paid. Never award a member for reacting to their own message. Reaction removal never claws XP back, because that turns into a farm loop of its own.

**Voice XP, and why it is a sweep and not an event handler.** Do **not** join voice channels. Arcane's own docs give the reasoning and it is sound: joining "would limit voice XP to one voice channel, be expensive to run, and a privacy nightmare." Instead, on an interval, walk the cached voice states per guild and award members who pass **all** of:

1. the channel id is in `voice.approvedChannels` (silent's "approved voice calls", and no competitor gates this way),
2. the channel holds at least `minMembers` non bot members,
3. the member is **not** `selfMute`, `selfDeaf`, `serverMute` or `serverDeaf`,
4. the member's continuous session has not exceeded `decayAfterMinutes`, past which the award is multiplied by `decayFactor`.

Conditions 2, 3 and 4 are Arcane's anti farm set copied wholesale, because a 24/7 voice self bot is a real, public, mature tool. Condition 1 is this bot's addition and is strictly stronger than anything Arcane offers.

**This does not touch `ActivityTracker`'s voice listener**, which tracks ROK event participation and stays exactly as it is.

### 5.4 The award API

```
awardXp({
  guildId, userId, username,
  amount,                                 // pre multiplier base
  source: "message"|"reaction"|"voice"|"game"|"gameRoom"|"achievement"|"admin",
  game?: "duel"|"rps"|"hangman"|"battleship"|"blackjack"|"holdem",
  outcome?: "won"|"lost"|"drawn"|"assist",
  counters?: { messages?, reactionsGiven?, voiceMinutes?, fortuneReadings? },
  client,
}) -> Promise<void>                        // NEVER throws, always resolves
```

`source` is not decoration. It is what lets `message` stage into the buffer while an admin `/xp add` writes through immediately, and what the achievement evaluator reads to avoid R11. `game` plus `outcome` is what maintains the `/account` K, D, A record in the same atomic write as the XP, so the two can never disagree.

### 5.5 Level up celebration, and the never ping invariant

Per channel queue with a coalescing window, the same shape as `scheduleLeaderboardRefresh`. Above a burst threshold, send **one combined message** instead of N. This solves both the "trains your community to mute the channel" complaint and Discord's per channel `429` risk with one mechanism, and no bot in this category ships it.

Two tiers of celebration, which is what makes D3 survivable in a channel that also carries reminders:

- **Ordinary level.** One compact line inside the coalesced message. No embed, no art, no reaction.
- **Prime milestone level** (D2). The full treatment: a Dero authored embed in `COLORS.LEVEL_MILESTONE`, the Dero congratulations line from `levelingCopy` or the guild's `getCopyOverride("leveling.milestone", ...)` , the bundled Dero art via `resolveGameAsset` style attachment, any role reward named in an `{earned:...}` block, and **the bot adds `leveling.reactionEmoji` to its own message** so members can pile on. That reaction is the "Dero adds a congratulations with reaction" silent asked for, and putting it on the bot's own post rather than the member's message means it works even when the level up came from a reaction or a voice sweep with no message to react to.

**THE NEVER PING INVARIANT (D3).** Every level up message sets:

```
allowedMentions: { parse: [], roles: [], users: [] }
```

so a `<@id>` renders as a name and notifies nobody. This is the existing pattern from `BOT_CONSTANTS.REMINDER_LOG_OFFSETS.TEST` test fires and the duel result embed, so it is house style already.

Make it structural rather than a habit: define a **`PINGABLE` allowlist** in `BOT_CONSTANTS` naming the message kinds that may ping (real reminder fires, go live announcements) and have the leveling announcer assert its kind is absent from that set. A future engineer adding a ping then has to add themselves to a list with a name on it, which is a decision, instead of deleting one line, which is an accident.

Permission precheck before every send, because otherwise the failure is invisible to the admin: `ViewChannel`, `SendMessages`, `EmbedLinks`, `AttachFiles`, and `AddReactions` for the congratulations reaction. Missing any means record a config warning and return, never throw.

Template tags: `{user.mention}` `{user.name}` `{user.level}` `{user.xp}` (progress into the level, not the total) `{guild.name}`, and an `{earned:...}` conditional block rendered only when a role was also granted, dropped entirely when not.

### 5.6 Role rewards

Compute the **full desired set**, apply it in one call.

```
canAssign(role):
  bot has ManageRoles
  AND !role.managed                                   // integration and booster roles, never
  AND me.roles.highest.comparePositionTo(role) > 0    // Administrator does NOT bypass this
  AND !role.permissions.has(Administrator)            // refuse
  AND !role.permissions.has(ManageGuild)              // refuse

desired = new Set(member.roles.cache.keys())
for every reward role: desired.delete(id)
for every earned reward (respecting stackRewards): if canAssign -> add, else report
await member.roles.set([...desired], `Level ${newLevel}`)
```

`roles.set` is one atomic PATCH. Sequential `add` then `remove` leaves a window where the member holds both roles or neither, and two close level ups can interleave so the removal strips the newer role. `roles.set` removes the window instead of guarding it.

Errors: `50013` is hierarchy or permission, **never retry**, and log **once per guild plus role**, never per member, or a large guild floods the Railway logs. `10011` means the role was deleted, so **self heal** by dropping that entry from `leveling.rewards`. Keep the try/catch even behind a passing precheck, because discord.js can report stale role positions.

**Never mass assign.** Discord does not want it and at 10k members it is 10k calls against a per guild bucket. Reconcile lazily on the next level up, and on demand when the member runs `/account`. That second path is exactly the fix Arcane shipped on 2025-07-28 "due to a large number of users needing the ability to apply role rewards retroactively". An opt in, rate limited, resumable backfill command is a FUTURE_PLANS item.

### 5.7 Achievements

Arcane **has no achievements system at all**; the word does not appear anywhere in their docs, command list or premium table. So this is modelled on MEE6's plugin, which silent specifically asked for, plus one thing nobody ships.

Definitions frozen in code, following `fortunes.ts` and `hangmanWords.ts`. **Every tier threshold is prime** (D2).

```
{
  id: "voice-of-the-realm",
  category: "messages" | "reactions" | "voice" | "games" | "levels" | "special",
  metric:   "messages" | "reactionsGiven" | "voiceMinutes" | "fortuneReadings" |
            "gamesPlayed" | "gamesWon" | "assists" | "level" | "milestoneLevels" | "<game>.won",
  tiers: [ { name:"bronze",  threshold: 53,   xp: 101  },
           { name:"silver",  threshold: 251,  xp: 307  },
           { name:"gold",    threshold: 1009, xp: 1013 },
           { name:"diamond", threshold: 5003, xp: 3001 } ],
  hidden: false,
  roleId: null,                    // optional, top tier only
  earnedBy: (tier) => `sent ${tier.threshold} messages`,   // the /account sentence
}
```

**The launch set, twelve tracks.** Nine visible, three hidden.

| id | Category | Metric | Bronze / Silver / Gold / Diamond | Hidden |
|---|---|---|---|---|
| `voice-of-the-realm` | messages | messages | 53 / 251 / 1009 / 5003 | no |
| `the-applause` | reactions | reactionsGiven | 29 / 101 / 503 / 2003 | no |
| `round-table` | voice | voiceMinutes | 61 / 251 / 1009 / 3001 | no |
| `contender` | games | gamesPlayed | 11 / 41 / 151 / 503 | no |
| `champion` | games | gamesWon | 5 / 23 / 101 / 251 | no |
| `duelist` | games | duel.won | 3 / 17 / 71 / 199 | no |
| `strategist` | games | rps.won | 3 / 17 / 71 / 199 | no |
| `wordsmith` | games | hangman.won | 3 / 13 / 53 / 151 | no |
| `ascendant` | levels | level | 7 / 23 / 47 / 89 | no |
| `prime-mover` | special | milestone levels reached | 5 / 11 / 19 / 31 | **yes** |
| `the-assist` | games | assists | 7 / 29 / 101 / 251 | **yes** |
| `dero-knows` | special | `fortuneReadings` | 13 / 53 / 199 / 601 | **yes** |

`prime-mover` is the one that ties the whole system together: it is hidden, and it rewards you for hitting prime levels, which a member only discovers by hitting a few and noticing the pattern. That is the achievement people will screenshot.

Everything else worth stealing from MEE6, and the one thing to skip:

- **The four tier track** beats four separate one shot achievements, both to author and to read. Taken.
- **Reward on unlock**: role, XP, or both. Taken. MEE6 also has "take role" and "give coins"; there is no currency here and a take role is a moderation action, so both are skipped.
- **Announcement destination** current channel, specific channel, or DM. Taken, minus DM (T19).
- **"Almost there" nudges** for a member near a tier. Strong retention mechanic, rarely copied. **Deferred to FUTURE_PLANS**, because it needs its own throttle or it becomes spam.
- **Deadlines** for seasonal achievements. Deferred, and a natural fit for a future KvK season tie in.

And the differentiator: **hidden achievements**. Not user privacy settings, which the dedicated Achievements bot has, but designer hidden entries that do not appear in `/achievements` at all until they unlock. MEE6 has none. Three ship at launch.

The evaluator is **pure**: `evaluate(counters, unlockedIds) -> newlyUnlocked[]`. It reads counters `MemberLevel` already maintains, so achievements add **zero new listeners and zero new writes on the message path**. It runs from the flush path only (R11) and is idempotent.

### 5.8 `/account`, the profile

One command, absorbing `/rank` (A10). Sections in order:

1. **Identity.** Display name, avatar, level, the progress bar, XP into level, XP to next, and whether the next level is a prime milestone (a small nudge that works because members will already have noticed the pattern).
2. **Standing.** Guild rank via the index only count in 5.10, plus this week's and this month's rank.
3. **Record.** The K, D, A table from 2.5: one row per game with played, won, lost, drawn, assists and W/L ratio, plus an overall row.
4. **Presence.** Messages sent, reactions given, voice minutes.
5. **Achievements.** Every unlocked entry with its tier and its `earnedBy` sentence, then the closest two in progress with a bar. Hidden entries appear only once earned.

Side effect: reconcile the member's reward roles (5.6). Comment why, or it looks like an odd place for a role write.

### 5.9 Vocabulary, and the wall between the two leaderboards

Normative. This is the mitigation for R3.

| Concept | Participation system (shipped) | Leveling system (new) |
|---|---|---|
| Unit | participation score | XP |
| Ladder | standings | levels |
| Model | `PlayerActivity` | `MemberLevel` / `XpPeriod` |
| Command | `/leaderboard` | `/levels`, `/account` |
| Board | `LeaderboardBoard`, `leaderboardMessageId` | `LevelsBoard`, `levelsMessageId` |
| Toggle | `leaderboardTrackingEnabled` | `leveling.enabled` |
| Reaction listener | ✅ on a `ReminderLog` message | any emoji, any message |
| Voice listener | `VoiceStateUpdate` during an event window | an interval sweep over approved channels |
| Answers | did you show up for this event | how present are you in this server |

Both boards live in `#leaderboard`. Each embed carries a one line subtitle stating which question it answers.

### 5.10 Rank without sorting the world

1. **One member's rank.** `1 + countDocuments({ guildId, totalXp: { $gt: mine } })` against `{ guildId: 1, totalXp: -1 }`. Index only, exact, fine into the tens of thousands. **This is what `/account` uses.**
2. **A page of ranks.** `$setWindowFields` with `$denseRank` (ties share a rank, no gaps) or `$documentNumber` (strictly unique). Choose deliberately, it is visible to members; `$denseRank` is the friendlier default.
3. **Very large or very hot.** Redis sorted set per guild. Not v1, and the data model does not change to get there.

### 5.11 Validation, error handling, security

- Every `/setup-level-system` numeric input is range clamped at the command layer: cooldowns 5 to 3600, XP min 1 to 1000, max not below min, `curveMultiplier` 0.1 to 100, `minMembers` 1 to 25, `decayFactor` 0 to 1.
- `/xp set level` is capped at a documented ceiling so nobody writes a level whose prefix sum was never computed.
- A reward role carrying Administrator or Manage Server is refused at **config time** with a clear message, not silently at grant time. **A leveling bot handing out admin because someone chatted a lot is a security incident, not a bug.**
- Guild scoping is a security boundary, `CLAUDE.md` invariant 2. Every leveling query filters on `guildId`. Nothing is global or cross server.
- `/xp` and `/setup-level-system` are gated three ways: `.setDefaultMemberPermissions(Administrator)` so Discord hides them, `ADMIN_COMMANDS` so the runtime gate catches anyone who reaches them anyway, and `gateOwnerOrAdmin` inside the handler. Button surfaces re verify on click, because a persistent button cannot rely on a slash command's permission filter.
- No message content is read, stored or logged. The XP roll function does not accept message text, so it cannot be added by accident.
- Export (F20) is admin gated and guild scoped.
---

## 6. THE THREE NEW GAMES, TECHNICAL DESIGN

silent asked for battleship, blackjack and texas hold em. Each one is dictated by a different hard Discord limit, which is why they are three phases and not one.

**The single fact that shapes all three:** an interaction token lives **15 minutes** and cannot be renewed (T16, C10). A normal channel message the bot posted has **no** edit limit. So in every game below, the **public board is a bot channel message edited for the whole match**, and any **private view is delivered on the member's own click**, using that click's fresh token. Nothing may depend on the bot pushing an unsolicited private update. This is not a preference; the production Texas Hold'Em Poker bot says the same thing in its own store listing.

**Rendering, decided once for all three: application emojis.** An application can own **2000 emojis**, they work in **every server**, and `USE_EXTERNAL_EMOJIS` is **not required** (C12). That is a 52 card deck plus board tiles uploaded once, rendering identically everywhere with zero admin setup. Guild emoji cap at 50 to 250 and would need uploading per server, and canvas generated PNGs mean a fresh file upload on every redraw, which for a board edited every turn for 45 minutes is the expensive choice. **The trap** (C13): a custom emoji serializes as roughly 25 characters, so a 10 by 10 custom emoji grid is about 2,500 characters and overflows the 2000 character content limit. Grids go in an **embed description** (4096), or use Unicode emoji for grid tiles and custom emoji for cards.

### 6.1 Battleship

**The limit that decides it:** 100 cells against 25 buttons per message (T17, C9). A clickable 10 by 10 grid is impossible, under V1 and under Components V2 alike.

Research finding worth stating plainly: **no open source Discord battleship uses components for firing.** The field runs on reactions, typed coordinates, emoji grid embeds, and DMs or private channels for the private board, most of it predating the components API. willu98's bot uses reactions and two private text channels; the `discord-battleship` npm package uses DM text commands; `battleship-py` takes a typed `A5`. **The two select menu approach below appears to be unshipped by anyone**, which makes it a small original contribution rather than a copy.

**Design.**

- **Input: two string selects.** Column A to J (10 options) and row 1 to 10 (10 options), both far under the 25 option cap, two action rows out of five. A third row carries Fire, View my board, and Forfeit. No typing, works on mobile, no modal round trip.
- **Public board:** one bot channel message per match, edited every turn, carrying the **opponent facing** view only (hits, misses, sunk ships, never unfired ship positions). Unicode emoji grid in an embed description (C13).
- **Private board:** a **View my board** button. The click mints a fresh token and replies ephemerally with that player's own fleet and incoming fire. Pull based, per R20 and T16. **Not** a private channel per player (Q8): two extra channels per match against a 500 channel server cap, on top of the game room's own channel, is the wrong trade.
- **Placement:** a placement phase before firing. Five ships, and the honest v1 is **auto placement with a Reroll button**, because manual placement is a second full coordinate UI for a fraction of the value. Manual placement is a FUTURE_PLANS item.
- **Challenge:** reuse `issueChallenge` from `challengeFlow.ts`. Do not write a second handshake.
- **Home:** a **game room** (`GAME_SLUGS` gains `"battleship"`, and `ChallengeKind` in `challengeFlow.ts` gains it too), because a match runs long and deserves its own channel. This is why Phase 7 depends on game rooms.
- **Timeout:** a per turn clock. On expiry, forfeit the turn; after two consecutive, forfeit the match. Never leave a room open forever, the archive sweep depends on rooms terminating.
- **XP:** play XP to both, win XP to the winner, and a small per sink bonus so a losing player who fought still earns.

**State:** `battleshipState.ts`, pure. Two 10 by 10 grids, fleet definitions, `applyShot(state, playerId, coord) -> "hit"|"miss"|"sunk"|"invalid"|"repeat"`, `isFleetDestroyed(state, playerId)`. No discord.js, no I/O, injectable rng for auto placement. Same shape as `hangmanState.ts`.

### 6.2 Blackjack

**The easy one, and worth doing first of the three.** Hit, Stand, Double, Split, Insurance is **exactly five buttons, exactly one action row** (C9). The dealer's hole card is secret from *everyone*, so there is **no per player private view and therefore no interaction token problem at all** (T16 does not apply). One player against the dealer means no turn queue and no idle player timeout.

**Design.**

- **Table:** ⚠️ **THE OWNER REVERSED THIS ON 2026-08-11. Multiplayer at one table is IN.** This bullet previously read "solo versus the dealer, multiplayer at one table is deferred" on the grounds that no surveyed Discord blackjack implements it and it degenerates to a turn queue plus a per player action timeout. The owner asked instead for **three surfaces: create a solo game, create a table, join a public table.** The turn queue and the per player timeout are therefore accepted costs, not reasons to cut. **The engine was built for N seats from the first line, so solo is the N=1 case** and one state machine serves all three (`blackjackState.ts`, `ade85b3`).
- **Surface:** `/mini-game blackjack` in any channel, **still with NO game room**, and that survives the reversal intact. A table is one bot message edited for the match, exactly as hangman already runs a multi member round in place. Hold em needs a room because a tournament is six players over 45 plus minutes with a long transcript; a blackjack hand takes a minute. **So this phase still does not depend on game rooms and can still ship first.** The one thing genuinely gated on game rooms is SERVER WIDE discovery of open tables, which arrives when the `⚔️challenges` board lands (game rooms Phase 4); until then "public" means anyone who can see the channel, which is the reach hangman has today.
- **No insurance, and it is not an oversight.** The button list below says "Hit, Stand, Double, Split, Insurance", but insurance is a SIDE BET and the stakes bullet fixes v1 at no chips and no wager. There is nothing to insure and nothing to pay it from. Double survives the same cut only because it re-expresses without money: exactly one card, then stand, for a doubled XP stake. Restoring insurance means building the chip economy this plan deliberately deferred.
- **Cards:** application emojis, 52 cards plus a card back, uploaded once (C12).
- **Split:** turns one hand into two, so the action row re renders per active hand and the state machine carries a hand index. This is the only genuinely fiddly part; everything else is a lookup table.
- **Stakes:** **none in v1.** No chips, no wager, no economy. The reward is XP and the `/account` record. This keeps blackjack entirely clear of R22.
- **XP:** play XP per hand, win XP on a win, half on a push, a small bonus on a natural blackjack.

**State:** `blackjackState.ts`, pure. Shoe with a seeded shuffle, hand value with soft and hard aces, dealer policy (stand on soft 17 by default, configurable), `resolve(hand, dealer) -> "win"|"lose"|"push"|"blackjack"`. Injectable rng. Fully testable without a single Discord type, and the ace and split cases are exactly the sort of thing this repo already pins in `hangmanState.test.ts`.

### 6.3 Texas hold em

**The hard one, and last for a reason.** It is the only one of the three that needs chips, the only one with 2 to 6 players, and the only one where the private view problem is load bearing every single hand.

**A9, the decision that makes it buildable: per tournament chip stacks, not a server currency.** Everyone buys in for the same stack when the table opens, chips exist only inside that tournament, and nothing survives the table. This is the model the production Texas Hold'Em Poker bot uses, and it sidesteps the entire economy design problem, the gambling moderation surface, and R22 in one decision. If a persistent balance is ever wanted, that is a separate decision (Q7), and the recommendation is no.

**Design, with the constraint each choice answers.**

- **Table:** 2 to 6 players. Open with `/mini-game holdem`, then a join window with a Buy in button, mirroring the production bot's 20 second window.
- **Hole cards: a Show cards button, clicked once per hand.** This is T16 made visible to the player. The production bot ships exactly this and states the reason in its own listing: "Due to discord limitations regarding ephemeral responses, every player must click on this button at the start of each hand in order to view their cards." Do not try to be cleverer than that. Do not use DMs (T19).
- **Betting UI:** `[Show cards] [Check/Call] [Bet/Raise] [Fold] [Quit]` is **five buttons, one action row** (C9). Raise sizing is a **second row of preset sizes** (min, 1/2 pot, pot, 2x pot, all in), not a modal, because a second row of five buttons is one click and a modal is a round trip.
- **Idle players:** a per turn clock of 15 to 60 seconds, default 30, that **force folds** on expiry. Force fold, never pause. A table that waits on a member who closed Discord is a table that never ends, and the game rooms archive sweep depends on rooms terminating.
- **Blinds:** escalate on a `pace` setting, so a tournament converges rather than running all night.
- **Side pots:** required for correctness the moment two players go all in for different amounts. No surveyed implementation documents handling them, which means this is the part most likely to be quietly wrong. **It gets its own pure module and its own test suite**, and the tests come from hand written scenarios, not from play testing.
- **Home:** a **game room**, mandatory. Six players, 45 plus minutes, and a long transcript. Phase 8 depends on game rooms.
- **XP:** play XP per hand contested, win XP per hand won, and a placement bonus at tournament end scaled by finishing position.

**State:** three pure modules, because this is where correctness lives.
`holdemHand.ts` (7 card best hand evaluation and comparison), `holdemBetting.ts` (a betting round state machine: who acts, what is legal, when the round closes), `holdemPots.ts` (main pot and side pot construction from per player commitments). None of them import discord.js. `holdemHand` is table driven and exhaustively testable; `holdemPots` gets scenario tests for the all in cases.

### 6.4 What the three share

A new `src/features/games/` sub area, following exactly the conventions the shipped games established:

- Pure resolution split from the Discord handler, matching `duelResolve` / `duelHandler`.
- Feature local copy in `gamesCopy.ts`, no pack indirection.
- New `COLORS` keys in `brand.ts`, one per game.
- Art registered through `gamesAssets.ts`.
- One entry each in `MINI_GAME_HANDLERS` and one `.addSubcommand()` in `mini-game.ts`. **That is the whole command surface change**, because the merge to subcommands already did the hard part. Note the 25 option ceiling per command (C6): four games today plus three more is seven subcommands, comfortably inside it.
- One `awardXp` call each, which is the entire leveling integration.
- `mini-game.test.ts` already asserts every declared subcommand has a handler and every handler is declared, both directions, so adding a game without wiring it fails the suite.

---

## 7. IMPLEMENTATION ROADMAP

**Eight phases.** Phases 1 to 5 are the leveling system and ship as one release. Phases 6, 7 and 8 are the three games, and **each ships independently after Phase 5** rather than all together. That is the one adjustment to D5, and it exists so that hold em, which is the largest and least certain piece of work here, can never hold up the leveling release or the two easier games.

Every phase leaves the bot working, testable and deployable.

```
PHASE 1: Foundation, pure and dark   ✅ CODE-COMPLETE 2026-08-11
  Shipped on DeroDiscordBot `staging` d9a4d5c, NOT pushed, NOT deployed. 22 files,
  2,729 insertions. Gates measured: tsc clean, npm test 385 across 35 files, lint 0.
  Ledger: 2026-08 item 103 (filed this session, paying trap T15). Session detail:
  SACRED_FILES/2026-08/WIP.md, week of August 10. Added one file this plan did not
  name, levelingTypes.ts, see A12.
  Macro milestone: every pure module, model, store, constant and config field exists,
  is unit tested, and is wired to nothing. Runtime behavior is byte for byte unchanged.
  Micro tasks:
    - [x] levelCurve.ts + test: four presets with dero (3n^2 + 47n + 101) as default,
          multiplier, ROUNDING not flooring, memoized prefix sums, binary search invert,
          xpIntoLevel, xpToNextLevel. Pure.
    - [x] primeLevels.ts + test: sieve to MAX_LEVEL_CEILING once at boot into a Set,
          isMilestone(level) O(1). Test against a hand written list of primes under 100.
    - [x] Add a date injectable periodKey(date, granularity, weekStart) to
          leaderboardWindow.ts. It has no ISO week number logic today and thisWeekRange
          reads new Date() internally, so it cannot be tested at a boundary. Extend it
          there, do NOT fork a second copy of the week math. Then levelPeriod.ts is a
          thin wrapper.
    - [x] MemberLevel.ts + test (both indexes, unique compound asserted), XpPeriod.ts
          with its TTL, memberLevelStore.ts, xpPeriodStore.ts (thin, untested).
    - [x] GuildConfig: the leveling subtree per 5.1 with enabled defaulting TRUE (D4),
          curve "dero", milestoneMode "prime", voice.approvedChannels EMPTY meaning
          none, plus levelsMessageId. Extend GuildConfig.test.ts.
    - [x] brand.ts COLORS: LEVEL_UP, LEVEL_MILESTONE, ACCOUNT, ACHIEVEMENT, LEVELS_BOARD.
    - [x] BOT_CONSTANTS: the LEVELING block, and the PINGABLE allowlist (5.5).
    - [x] log-messages.ts: a leveling block.
    - [x] levelingCopy.ts with the pack opt out comment and the no MessageContent rule,
          levelingEmbeds.ts which does NOT call embedBuilder.base().
    - [x] levelingAccess.ts, fail OPEN, mirroring gameRoomAccess.ts including its
          warning about why it differs from earlyAccess.ts.
  Completion criteria: npx tsc --noEmit clean; npm test green; grep confirms nothing
  outside src/features/leveling/ and src/db/ imports anything created here; booting the
  bot produces no new log lines and no behavior change.
  Depends on: none
  Spells: Spell 1, leveling foundation

PHASE 2: Earning, five sources   ✅ CODE-COMPLETE 2026-08-11 (four of five sources)
  Shipped on DeroDiscordBot `staging` 5a890cb, NOT pushed, NOT deployed. 27 files,
  4,298 insertions. Gates measured: tsc clean, npm test 561 across 44 files (was
  385 / 35), lint 0. Ledger: 2026-08 item 103. Session detail:
  SACRED_FILES/2026-08/WIP.md, week of August 10.
  ⚠️ THE GAME ROOM SOURCE IS NOT WIRED, because roomLifecycle.ts does not exist
  (see A11). Message, reaction, approved voice and all four mini games are live;
  the game room hook lands when roomLifecycle.finish does.
  ⚠️ Added two files this plan did not name, both for the house pure/impure
  split: xpRules.ts (restrictions, multipliers, the roll, all pure) and
  levelingConfig.ts (the TTL cached normalized config five callers share, with a
  synchronous peek so the message path claims its cooldown with no await ahead
  of it).
  Macro milestone: XP is earned from five of the seven award sources (messages, reactions,
  approved voice, mini games, game rooms; achievement and admin land in phases 4 and 3), and a level up celebrates itself without pinging.
  Micro tasks:
    - [x] xpWriter.ts: bounded cooldown Map with a SYNCHRONOUS claim, pending delta Map,
          10s bulkWrite flush with ordered:false, an exported flushNow(), and a sweep for
          both Maps. Injectable clock and interval.
    - [x] awardXp.ts, the single public API (5.4). Never throws. Buffers for source
          "message", writes through for everything else. game + outcome maintain the
          K/D/A record in the SAME atomic write as the XP.
    - [x] Atomic level detection in the flush: derive oldLevel from newTotal minus
          awarded, claim with updateOne({_id, announcedLevel:{$lt:new}}), skip when
          modifiedCount is 0, retry once on E11000. Two levels in one flush produce ONE
          announcement at the higher level.
    - [x] messageXp.ts: guard order per 4.5, restrictionMode honored, multipliers
          honoring stackMultipliers, TTL cached config.
    - [x] reactionXp.ts: a SECOND MessageReactionAdd listener. Comment pointing at
          ActivityTracker's and vice versa. Own cooldown at 5 min, once per member per
          message, awards reactor / author / both, never self reactions, removal never
          claws back.
    - [x] voiceXp.ts: an interval SWEEP over cached voice states, not an event award.
          Award only in voice.approvedChannels, only at or above minMembers non bot
          members, only when not selfMute/selfDeaf/serverMute/serverDeaf, with decay
          after decayAfterMinutes. Do NOT join a voice channel.
    - [x] levelUpAnnouncer.ts: coalescing queue, ordinary levels as a compact line,
          prime milestones as the full Dero card with art and the reactionEmoji added to
          the bot's OWN message, permission precheck incl. AddReactions, template tags,
          the {earned:...} block, and allowedMentions parse [] on EVERY send with the
          PINGABLE assertion (D3).
    - [x] The R16 first level up admin notice: once per guild, idempotent through
          botLogStore, naming /setup-level-system and how to disable.
    - [x] main.ts: register three listeners and the announcer, start the voice sweep,
          add flushNow() as step ⓪ INSIDE gracefulShutdown, and UPDATE the MessageContent
          clause at lines 67 to 72 without deleting the rest of that comment.
    - [x] HangmanRound gains participants: Set<string>, populated on every modal submit,
          so hangman XP and assists both become possible (T13, R13).
    - [x] Award hooks, all fire and forget: duelHandler after the result reply;
          rpsHandler at the reveal; hangmanHandler in the won/lost branch with the win
          bonus gated on won === true; respondWithFortune (NOT fortuneHandler, T12);
          roomLifecycle.finish from playerIds and winnerId (NOT the store).
          ⚠️ THE roomLifecycle LEG IS NOT DONE: that module does not exist yet (A11).
  Completion criteria: in a test guild, messages, reactions, approved voice and all four
  games move totalXp (the game room leg only once roomLifecycle.finish exists, see A11);
  a level up posts exactly one message,
  in #announcements, pinging nobody; a prime level looks visibly different from a
  non prime one; leveling.enabled false writes nothing and posts nothing.
  Depends on: Phase 1
  Spells: Spell 2, XP engine and the three passive sources. Spell 3, game award hooks.

PHASE 3: Seeing, the member and admin surfaces   ✅ CODE-COMPLETE 2026-08-11
  Shipped on DeroDiscordBot `staging` 5fdf57e, NOT pushed, NOT deployed. 14 files,
  1,995 insertions. Gates measured: tsc clean, npm test 595 across 46 files (was
  561 / 44), lint 0. Ledger: 2026-08 item 103. Session detail:
  SACRED_FILES/2026-08/WIP.md, week of August 10.
  ⚠️ ONE DEVIATION: /achievements was NOT added to the commandGuide. Its command
  does not exist until Phase 4, and the guide is the only surface telling a member
  a command exists, so naming it now points people at a command Discord does not
  know. /account and /levels went in; a test asserts /achievements is absent and
  says to delete that case in the commit that ships the command.
  ⚠️ /setup-level-system is NINE SUBCOMMANDS, not the flat option list this plan
  implies. Discord caps a command at 25 options AND forbids subcommands beside top
  level options, and the 5.1 subtree has more settings than that.
  Macro milestone: members can see everything about their own progress, admins can
  configure and correct, and the commands are discoverable.
  Micro tasks:
    - [x] /account [member], the full profile per 5.8: identity, standing, the K/D/A
          record table, presence counters, achievements with their earnedBy sentence.
          Reconciles reward roles as a side effect. Public, and in NEITHER admin
          mechanism (T2).
    - [x] /levels: this week, this month, all time. Public.
    - [x] LevelsBoard.ts: a SECOND pinned message in leaderboardChannelId anchored by
          levelsMessageId. Copy postOrEdit and the coalescing refresh from
          LeaderboardBoard.ts wholesale, including the foreign author bail and the
          10008 / 10003 recovery. Never touch leaderboardMessageId.
    - [x] Boot sweep refreshAllLevelsBoards in main.ts beside refreshAllLeaderboards,
          plus the hourly safety tick in ReminderScheduler.
    - [x] /setup-level-system: every field in 5.1, clamped per 5.11, with the live restriction
          preview and a config time refusal of any reward role carrying Administrator or
          Manage Server. Includes the approved voice channel picker.
    - [x] /xp add / remove / set-xp / set-level / reset-member / reset-server. data
          export UNANNOTATED (T3, R14). Destructive subcommands need a confirm button.
    - [x] setup-level-system and xp get BOTH ADMIN_COMMANDS membership AND
          .setDefaultMemberPermissions(Administrator) (T2).
    - [~] Add /account and /levels to the EXISTING commandGuide fun field
          (/achievements deferred to Phase 4 with its command, see above)
          in BOTH packs. commandGuide.test.ts already asserts both packs list the SAME
          command set, so a one pack edit fails the suite; extend it to name the three.
    - [x] Export for F20, admin gated, guild scoped.
  Completion criteria: /account returns a rank verified by hand against the DB for a
  guild of at least three members; the levels board posts, edits in place and recovers
  after deletion; the participation board is untouched; /leaderboard output is byte
  identical to before.
  Depends on: Phase 2
  Spells: Spell 4, the /account profile and the levels board.

PHASE 4: Rewards and achievements   ✅ CODE-COMPLETE 2026-08-11
  Shipped on DeroDiscordBot `staging` 444806b, NOT pushed, NOT deployed. 21 files,
  1,807 insertions. Gates measured: tsc clean, npm test 755 across 50 files (was
  595 / 46), lint 0. Ledger: 2026-08 item 103. Session detail:
  SACRED_FILES/2026-08/WIP.md, week of August 10.
  ⚠️ R11 (the recursion trap) is closed THREE ways, not one: the pass has exactly
  one call site (the flush), the engine is pure and takes a counters snapshot so
  it cannot apply the xp it returns, AND awardXp now BUFFERS source "achievement"
  alongside "message" so a bonus lands in the next flush window. That third change
  broke an existing awardXp test asserting write-through, which is what it was for.
  ⚠️ A DELIBERATE CIRCULAR IMPORT now exists: xpWriter -> achievementUnlock ->
  awardXp -> xpWriter. Safe only because every binding in it is a hoisted function
  declaration called at runtime. levelingWiring.test.ts guards it; nothing else
  would, because every other leveling test mocks one side of the cycle.
  ⚠️ /achievements joined the commandGuide HERE, closing the Phase 3 deviation.
  THE LEVELING FEATURE IS NOW FUNCTIONALLY COMPLETE. Phase 5 is a release gate,
  not a build, and almost none of it can be done from the keyboard.
  Macro milestone: levels pay out, in roles and in a twelve track tiered achievement
  system with three hidden entries.
  Micro tasks:
    - [x] roleRewards.ts: canAssign per 5.6, full desired set, ONE roles.set call, stack
          vs replace, the three error branches with once per guild+role logging.
    - [x] Wire reconciliation into the level up path and into /account. Never mass assign.
    - [x] achievements.ts: the twelve tracks in 5.7, every threshold prime, three hidden,
          each with its earnedBy sentence builder.
    - [x] achievementEngine.ts: pure evaluate(counters, unlocked) -> newly unlocked.
          Idempotent. Called ONLY from the flush path (R11).
    - [x] Unlock side effects: $addToSet onto unlocked with tier, timestamp and the
          composed earnedBy sentence; stage the tier XP through awardXp source
          "achievement" into the NEXT flush; grant the optional role through roleRewards;
          announce.
    - [x] /achievements [member]: unlocked with tier and earning action, in progress with
          a bar, hidden entries omitted entirely until earned.
  Completion criteria: crossing a level grants exactly the right role set in one API
  call; a reward role above the bot's logs once and does not retry; crossing an
  achievement threshold unlocks exactly one tier whose XP does not trigger a second
  unlock in the same pass; prime-mover stays invisible until it fires.
  Depends on: Phase 3
  Spells: Spell 5, role rewards. Spell 6, the achievement engine.

PHASE 5: Hardening, ledgers, release
  Macro milestone: verified end to end, ledgers tell the truth, safe to bump the version.
  THIS IS WHERE THE LEVELING SYSTEM SHIPS.
  Micro tasks:
    - [ ] Cross feature QA per section 8's manual checklist, in a real guild, on a real
          deploy.
    - [ ] Load sanity: 200 fast messages in a test guild. Confirm the flush batches, the
          cooldown holds, and no duplicate announcement fires.
    - [ ] Farm sanity: sit muted in an approved voice channel alone and confirm ZERO
          voice XP. Unmute with one other member present and confirm it starts. Idle
          past decayAfterMinutes and confirm the award drops.
    - [x] Update CLAUDE.md: a leveling/ feature row, and the missing @handlers/* alias.
          DONE 2026-08-11, plus two permanent gotchas that belong in law rather than a
          ledger: the two systems that both measure presence and must never be folded
          together, and the two MessageReactionAdd listeners that read as a bug and are
          not one.
    - [x] Update SACRED_FILES STATE.md with live behavior, TECH_DEBT.md with what was cut.
          DONE 2026-08-11. STATE.md carries the status line, five ⚠️ warnings and a
          pointer, per its own "detail goes one level down" rule. TECH_DEBT.md gained
          four entries: the unwired game room hook, the deliberate circular import and
          the one test guarding it, the all-time-only board, and the reaction
          once-per-message claim expiring with the sweep.
    - [x] File the FUTURE_PLANS item that does not exist yet (T15). DONE 2026-08-11 as
          2026-08 item 103, filed in the session that shipped Phase 1 rather than here,
          and updated at every phase since. It covers: the
          "almost there" nudge, achievement deadlines, a rate limited role backfill
          command, rank cards, manual battleship placement, multiplayer blackjack, and a
          persistent chip balance if Q7 ever flips.
    - [ ] Add the release version to the VERSION_SHIPPED_AT map in postFeatureAnnouncement.ts.
          It holds only 1.4.0, 1.5.0 and 1.5.1 today while package.json is at 1.6.1, so the
          joined-after-ship skip is currently dormant and will not apply without this.
    - [~] Write the release announcement. DRAFTED 2026-08-11, all four blocks, at
          roadmaps/handoffs/dero-leveling-announcement-draft-2026-08-11.md. NOT wired.
          ⚠️ THIS TASK NAMES THE WRONG FILE, corrected 2026-08-11. The copy does NOT
          live in postFeatureAnnouncement.ts: that file resolves it per guild via
          getPluginCopy(config).featureAnnouncement. The copy belongs in the
          `featureAnnouncement` block of BOTH packs (rok-commander and general-events),
          each with a `public` and an `innerSanctum` sub-block. FOUR blocks, one commit.
          Editing only one pack leaves every general-events guild reading the PREVIOUS
          release's announcement with nothing failing anywhere.
          ⚠️ AND buildSuggestionBoxButton() IS A CODE CHANGE, not copy.
          postFeatureAnnouncement.ts sends `{ embeds, allowedMentions }` with NO
          components today, on both sends. Adding the button means adding a components
          row to the PUBLIC send. Small, and not written yet.
          Content requirements are unchanged and all four are met in the draft: lead with
          leveling being ON in every server and name /setup-level-system for admins who
          want it off (R16); name /account, /levels and /achievements; explain that prime
          levels are the milestone levels, because that mechanic is invisible otherwise;
          and invite members to request a game, naming battleship, blackjack and texas
          hold em as already on the way (F21).
    - [ ] Verify GLOBAL command propagation in a real guild BEFORE the package.json
          version bump (T5, R9).
    - [ ] Hand off to reference_bot_release_announcement_flow.
  Completion criteria: every leveling Definition of Done item demonstrably true in a
  real guild; tsc clean; suite green; all four ledgers updated; announcement drafted
  but NOT fired.
  Depends on: Phase 4
  Spells: none. Verification, documentation and a release gate, all mechanical and all
  fully specified above.

PHASE 6: Blackjack
  Macro milestone: /mini-game blackjack, solo versus the dealer, earning XP and a
  /account record. SHIPS AS ITS OWN RELEASE.
  Ordered FIRST of the three games despite being listed second, because it is the only
  one with no private view problem, no game room dependency and no chip model, so it
  proves the whole "add a game" path cheaply.
  Micro tasks:
    - [ ] Upload 52 cards plus a card back as APPLICATION emojis (C12). Record the ids
          in a frozen map. This asset work is shared with Phase 8, so do it properly once.
    - [ ] blackjackState.ts + test, pure: seeded shoe, soft and hard ace values, dealer
          policy, resolve() -> win | lose | push | blackjack. Injectable rng.
    - [ ] blackjackHandler.ts: one action row of Hit, Stand, Double, Split, Insurance.
          Public channel message edited per action. Hand index in state for splits.
    - [ ] gamesCopy.ts, a COLORS key, gamesAssets entries, one MINI_GAME_HANDLERS entry,
          one addSubcommand.
    - [ ] awardXp on hand resolution with game "blackjack" and the right outcome.
  Completion criteria: a full hand plays out including a split and a double; the dealer
  hole card is never leaked before the reveal; ace totals are correct in every test case;
  /account shows a blackjack row.
  Depends on: Phase 5
  Spells: Spell 7, blackjack.

PHASE 7: Battleship
  Macro milestone: /mini-game battleship, two players in a game room, with a pull based
  private board. SHIPS AS ITS OWN RELEASE.
  Micro tasks:
    ALL NINE DONE 2026-08-12, commits 556cc44 (the match, boards and controls) and
    56578d2 (the turn clock and the sink bonus). NOT pushed, NOT deployed.
    Gates at 56578d2: tsc clean, npm test 1058 / 66 files, lint 0.
    ⚠️ `levelingWiring.test.ts` FLAKES under a full-suite run and passes alone in
    1.2s; it is the known 5 second dynamic-import guard recorded in TECH_DEBT.md,
    and it got closer to the line as the module graph grew. Re-run before believing
    a red one.
    - [x] battleshipState.ts + test, pure: two grids, fleet definitions, applyShot,
          isFleetDestroyed, auto placement with injectable rng.
          Pre-existing (463f279, 2026-08-12), 31 tests, unchanged by this pass.
    - [x] Two string select input, column A to J and row 1 to 10, plus a row of Fire,
          View my board, Forfeit. NEVER a button grid (T17).
          T17 is not merely a style rule: a 10x10 button grid is 100 components
          against Discord's hard cap of 25 (5 rows of 5), so the obvious version is
          impossible rather than ugly. The half-entered coordinate is stored on the
          ROW, not in a Map, so a deploy mid-aim costs a re-click and two players
          aiming at once cannot collide on one slot.
    - [x] Public board: ONE bot channel message per match, edited every turn, opponent
          facing view only, Unicode emoji grid in an EMBED DESCRIPTION not message
          content (C13, T20).
          ⚠️ THIS DELIBERATELY DIFFERS FROM HANGMAN'S APPEND-ONLY TRAIL, which is
          worth stating because the two rules look contradictory. A 10x10 grid
          reposted per shot would be thirty unreadable walls, so the BOARD carries
          the state and is edited, while the TRAIL carries the narration and appends.
          Both exist; neither is redundant.
    - [x] Private board: a View my board button replying ephemerally on the member's own
          click. Pull based (T16, R20). No private channels, no DMs (Q8, T19).
          It is the one surface that renders a player's own UNFIRED ships, so it is
          gated playersOnly on top of being ephemeral.
    - [x] Auto placement with a Reroll button. Manual placement is deferred.
          Reroll is refused once ANY shot has landed: re-laying a fleet mid-match
          would move ships out from under hits the opponent already earned.
    - [x] ~~Reuse issueChallenge from challengeFlow.ts. Do not write a second handshake. Its
          ChallengeKind union is "duel" | "rps" today and must gain "battleship".~~
          ⚠️ STALE, CORRECTED 2026-08-12. `challengeFlow.ts` NO LONGER EXISTS: game
          rooms Phase 4 retired it and deleted the file along with versusHandler,
          rpsHandler and rpsRound, because it kept a match in process memory and a
          Railway deploy mid-handshake lost it. `ChallengeKind` went with it. The
          instruction's INTENT survives and is stronger than before: do not write a
          second handshake, reuse the CHALLENGE BOARD
          (`@features/game-rooms/challengeBoard.ts`), whose draft GameRoom row is the
          handshake and survives a deploy. Adding a game there is one entry in
          `CHALLENGE_GAMES` plus its slug in `GAME_SLUGS`.
    - [x] Add "battleship" to GAME_SLUGS in roomTypes.ts and wire the room lifecycle.
          Also added to CHALLENGE_GAMES, so it is startable from ⚔️challenges like
          every other two player game. RoomProvisioner lays both fleets and posts the
          board the moment the channel appears, rather than lazily on the first
          click, so the fleets exist before anyone can press Fire.

    - [x] Per turn clock: forfeit the turn on expiry, forfeit the match after two.
          DONE 2026-08-12, `56578d2`. `roomTurnSweep.ts` runs on the EXISTING 5
          minute room cron rather than a second one, right after the archive sweep.
          Turn budget `GAME_ROOM_TURN_TIMEOUT_MS` (10 min), so a real expiry lands
          between 10 and 15 minutes; a second cron for one game's clock would cost a
          tick across every guild to save a casual player five minutes.
          ⚠️ THE LOSER IS CAPTURED BEFORE `expireTurn` RUNS, because that function
          PASSES THE TURN, so reading `state.turn` afterwards names the wrong player
          and the forfeit notice blames the person who was still there. Mutation
          verified, since both orderings type check and only one is right.
          Idle is measured from the last MOVE, falling back to `startedAt` so an
          unplayed match gets a full first turn instead of expiring on the next tick.
    - [x] awardXp: play to both, win to the winner, a small per sink bonus.
          DONE 2026-08-12, `56578d2`. Play and win ride `awardTwoPlayerResult` on the
          winning shot, unchanged. The sink bonus is a DIRECT `awardXp` call, and it
          deliberately omits `game`.
          ⚠️ PASSING `game` WOULD CORRUPT `/account`. awardXp increments
          `games.<slug>.played` for ANY call that names a game, so a five sink match
          would record "played 6" against a match the member played once, and
          /account renders that line. The match record stays written exactly once.
          `GAME_SINK_XP` is 15, so five sinks total 75, below `GAME_ROOM_WIN_XP`
          (120): a losing player who sank four ships must not out-earn the winner,
          and a test pins that inequality rather than trusting the two numbers to
          stay in the right order.
  Completion criteria: a full match completes inside a game room; neither player can see
  the other's unfired ships in any surface including the transcript; a player who walks
  away is forfeited rather than freezing the room; the room archives normally.
  Depends on: Phase 5 AND the game rooms release
  Spells: Spell 8, battleship.

PHASE 8: Texas hold em
  Macro milestone: /mini-game holdem, 2 to 6 players, per tournament chip stacks, in a
  game room. SHIPS AS ITS OWN RELEASE.
  Micro tasks:
    THE THREE PURE MODULES ARE DONE 2026-08-12, commit b724cf7 on staging, 89
    tests. NOT pushed, NOT deployed. ⚠️ THE EIGHT DISCORD-FACING TASKS BELOW ARE
    STILL OPEN, so hold em is NOT playable: there is no table, no dealing, no
    hole cards and no room. What exists is the hard, self-contained half.
    - [x] holdemHand.ts + test, pure: best 5 of 7 evaluation and comparison. Table driven,
          exhaustively tested, every hand class and every tie break. 42 tests.
          ⚠️ THE WHEEL IS A FIVE HIGH STRAIGHT, so A-2-3-4-5 is the WEAKEST straight
          rather than the strongest. Handled by aliasing the ace to rank 1 before
          the scan, which finds it in one loop with no second special case.
          ⚠️ A STRAIGHT FLUSH IS SCANNED INSIDE THE FLUSH SUIT ONLY. A board with
          five hearts and a separate straight in mixed suits is a flush; scanning
          all seven for a straight after finding a flush claims a straight flush
          that does not exist and pays a hand that should have lost.
          `compareHands` returns 0 on a genuine tie, because a split pot is a real
          result and a comparator that never ties pays whoever was compared first.
    - [x] holdemBetting.ts + test, pure: the betting round state machine. Who acts, what
          is legal, when the round closes, blind posting, all in. 27 tests.
          ⚠️ A BUG FOUND BY ITS OWN TESTS: all in was gated on beating the current
          bet, which silently left a short stack facing an over-bet with only fold
          and a capped call. That removes the exact all in that CREATES a side pot,
          so the pot module's whole reason for existing was unreachable from the
          betting module. All in is legal whenever the player has chips.
          `legalActions` and `applyAction` read the same rules, so what the UI is
          allowed to draw and what the machine accepts cannot disagree.
    - [x] holdemPots.ts + test, pure: main and side pot construction from per player
          commitments. SCENARIO TESTED for the all in cases. No surveyed implementation
          documents side pots, so assume nothing and write the cases by hand. 20 tests,
          written by hand as instructed, including the three way all in the
          completion criteria name.
          The invariant that makes the layer model right: a player can only win
          chips they could have LOST. Folded chips stay in the pot and off the
          folder's name. Odd chips are handed out one at a time in seat order
          rather than floored, which would destroy a chip on every split pot and
          drift the tournament total with no error to explain it.
    - [x] Chip model: per tournament stacks only (A9, R22). Buy in on join, chips die
          with the table, no persistent balance, no transfers.
    - [x] Table open + a join window with a Buy in button.
    - [x] Hole cards behind a Show cards button, clicked once per hand (T16). Never DMs.
    - [x] Betting UI: five buttons in one row, plus a preset raise size row. No modal.
    - [x] Per turn clock of 15 to 60s default 30 that FORCE FOLDS. Never pause.
    - [x] Blind escalation on a pace setting so a tournament converges.
    - [x] Add "holdem" to GAME_SLUGS and wire the room lifecycle.
    - [x] awardXp per hand won plus a placement bonus at tournament end.
    ALL ELEVEN DONE 2026-08-12, commits b724cf7 (the three pure modules), f54f796
    (the tournament engine) and 871d371 (the Discord layer). NOT pushed, NOT
    deployed. Gates at 871d371: tsc clean, npm test 1187 / 71 files, lint 0.

    ⚠️ THREE BUGS THE TESTS FOUND, ALL OF WHICH LOOK FINE ON SCREEN:
    ① All in was gated on beating the current bet, which left a short stack facing
      an over-bet with only fold and a capped call. That removes the exact all in
      that CREATES a side pot, so the pot module was unreachable from betting.
    ② Settlement left `totalCommitted` standing after paying winnings into stacks,
      so anything summing stack plus commitments counted the same chips twice and
      the table appeared to double its chips every hand.
    ③ A street opened when only ONE player still had chips and the rest were all
      in, waiting forever for an action with no legal form. Poker deals the rest
      out. Checking for ZERO contenders rather than fewer than TWO is the off by
      one between a table that finishes and one that hangs.

  Completion criteria: a six player tournament runs to a single winner; a three way all
  in for different amounts produces correct main and side pots, proven by test not by
  play; a player who closes Discord is force folded and the table continues; no chip
  state survives the tournament.
    • Side pots: PROVEN BY TEST, by hand, including the three way all in.
    • Force fold: proven by test, on its own 10 second interval (node-cron cannot
      go finer than a minute and the budget is 30 seconds).
    • No chip state survives: there is no store call in holdemTable at all, so a
      finished tournament cannot leave a balance behind even by accident.
    • A six player tournament running to a single winner is the one criterion that
      still wants a REAL GUILD; the engine is driven to completion in tests.
  Depends on: Phase 5 AND the game rooms release. Recommended after Phase 6 so the card
  emoji work is already done.
  Spells: Spell 9, hold em hand evaluation and pots.
```
---

## 8. TESTING AND CI/CD STRATEGY

### Unit tests, colocated `*.test.ts`, Vitest

| Module | What is pinned |
|---|---|
| `levelCurve.test.ts` | Every preset at levels 1, 10, 50; the `dero` curve's published table in 5.2 reproduced exactly; multiplier **rounds** not floors (Arcane's own case, 537.5 to 538); `levelFromTotalXp` is the exact inverse of `totalXpForLevel` across the range; `maxLevel` caps; level 0, negative XP and above ceiling XP do not throw |
| `primeLevels.test.ts` | The 25 primes under 100 exactly; 1 is not prime; 2 is; a composite near a prime is not; the sieve runs once |
| `levelPeriod.test.ts` | Week key rolls at the guild's `weekStart`; the last millisecond of a week and the first of the next differ; month boundary; the year boundary week |
| `xpWriter.test.ts` | Two claims in the same tick, only one wins; a claim after the window wins; flush batches N deltas into one `bulkWrite`; flush swaps pending before awaiting; `flushNow` drains; both Maps swept |
| `awardXp.test.ts` | Never throws when the store rejects; `message` buffers while every other source writes through; zero amount is a no op; `game` plus `outcome` updates the K/D/A record in the same write as the XP |
| `messageXp.test.ts` | Bot, DM and system message return with zero store calls; cooldown blocks; `exclude` and `only` behave oppositely and correctly; multipliers under both stacking modes; disabled guild writes nothing |
| `reactionXp.test.ts` | Self reaction earns nothing; a second reaction on the same message by the same member earns nothing; `awards` reactor / author / both each pay the right people; removal claws nothing back; a ✅ on a `ReminderLog` message still reaches `ActivityTracker` unchanged |
| `voiceXp.test.ts` | A channel not in `approvedChannels` pays nothing; below `minMembers` pays nothing; self muted, self deafened, server muted and server deafened each pay nothing; decay applies past `decayAfterMinutes`; bots are not counted toward `minMembers` |
| `levelUpAnnouncer.test.ts` | **Every send has `allowedMentions` parse empty**; the `PINGABLE` assertion fires if the kind is ever added to that set; coalescing collapses a burst; the combined message lists every level up; a prime level renders the full card and a non prime renders the compact line; missing permissions records a warning and does not throw; `off` sends nothing; the `{earned:...}` block drops with no role |
| `roleRewards.test.ts` | Desired set under stack and replace; a role above the bot excluded and reported; `managed` excluded; Administrator excluded; ManageGuild excluded; `10011` self heals the config; `50013` does not retry and logs exactly once per guild plus role |
| `achievementEngine.test.ts` | Every threshold in 5.7 exactly at, one under, one over; already unlocked ids never re emitted; two tiers in one pass emit both in order; hidden entries excluded from listing but not from evaluation; a tier's XP reward does not cause a second unlock in the same pass |
| `MemberLevel.test.ts` | The unique compound index exists (`GameRoom.test.ts` is the model) |
| `xp.test.ts` | Every declared subcommand has a handler and vice versa, both directions (`mini-game.test.ts` is the model) |
| `commandGuide.test.ts` (extend) | Both packs name `/account`, `/levels` and `/achievements`, and the existing same command set assertion still passes |
| `blackjackState.test.ts` | Soft and hard ace totals; a natural; dealer policy at soft 17; split hand independence; double; push; shoe exhaustion |
| `battleshipState.test.ts` | `applyShot` hit, miss, sunk, invalid, repeat; auto placement never overlaps and never runs off the grid; `isFleetDestroyed` only at the true end |
| `holdemHand.test.ts` | Every hand class, every tie break, wheel straights, best 5 of 7 selection, exact ties |
| `holdemPots.test.ts` | **Scenario tests, hand written.** Two way all in for different amounts; three way all in for three different amounts; a folded player's dead chips; an uncalled bet returned |
| `holdemBetting.test.ts` | Legal action sets per position; round closes on the right action; blind posting; short all in does not reopen the betting |

### Integration tests

- `awardXp` to `MemberLevel` to a level up claim, with two concurrent awards, asserting exactly one announcement is claimed.
- A flush where a member crosses two levels at once, asserting one announcement at the higher level.
- A flush where the higher level is prime and the lower is not, asserting the milestone card and not the compact line.
- `XpPeriod` writes landing under the right week and month key across a week boundary.
- `LevelsBoard` post, edit, then a simulated `10008` recovery, asserting `levelsMessageId` updates and `leaderboardMessageId` is untouched.

### End to end scenarios

1. New guild runs `/setup`, a member chats, reaches level 2 within six messages, sees a Dero congratulations in `#announcements` that pings nobody, and `/account` shows it.
2. A member reaches level 3 (prime) and the celebration is visibly different from level 4.
3. Existing guild deploys. Leveling is on (D4). The admin channel receives exactly one first level up notice naming `/setup-level-system`.
4. Two members play a duel; both gain play XP, the winner more, and both `/account` records update.
5. A hangman round with four guessers: all four are in `participants`, the solver gets the win, the other three get an assist.
6. A member sits alone and muted in an approved voice channel for an hour and earns **nothing**.
7. Admin `/xp set-level 25`; `/account` reflects it and reward roles reconcile on that same run.
8. A reward role is dragged above the bot's role; the grant fails, logs once, and `/account` still renders.
9. Weekly rollover: Sunday 23:59 and Monday 00:01 XP land in different period keys with no job running.
10. `prime-mover` stays absent from `/achievements` until it fires, then appears with its earning sentence.

### Edge cases

Zero members on the board; a member who left still holding top XP; `totalXp` exactly on a level boundary; `xpMin === xpMax`; `curveMultiplier` 0.5 and 100; `maxLevel` reached; a 5000 member guild's `/levels`; a deleted announcement channel; a deleted reward role; a nickname change mid week; a Railway redeploy mid flush; an achievement whose role was deleted; a voice channel deleted while members are in it; a reaction on a message the bot cannot fetch; **a game whose interaction token expired mid match** (phases 6 to 8, the T16 case).

### Regression checklist, run at every phase boundary

- [ ] `/leaderboard` output is byte identical to before this work.
- [ ] The participation board still refreshes on reminder fire, ✅ reaction, voice, boot and hourly.
- [ ] `leaderboardTrackingEnabled = false` still stops participation writes and still renders history.
- [ ] A ✅ reaction on a `ReminderLog` message still reaches `ActivityTracker` and still writes `PlayerActivity`.
- [ ] `ActivityTracker`'s voice listener still tracks ROK event windows and is unaffected by the voice sweep.
- [ ] `PlayerActivity` gained no fields and no TTL.
- [ ] All four existing `/mini-game` subcommands behave identically with leveling disabled.
- [ ] `/fortune` via the `powerup:member:fortune` button still works and now earns.
- [ ] Per game cooldowns are still independent; hangman still does not block a fortune reading.
- [ ] The `MessageContent` intent is still not requested.
- [ ] **No leveling message pings anyone, ever** (D3).
- [ ] `npx tsc --noEmit` clean and the full suite green.

### Manual QA checklist, Phase 5, in a real guild

- [ ] Three messages inside 60 seconds award exactly once.
- [ ] A message in a restricted channel awards nothing.
- [ ] Reacting to your own message awards nothing.
- [ ] Level up posts once, in `#announcements`, with a reaction, pinging nobody.
- [ ] A prime level looks different from a non prime level.
- [ ] Five level ups in one burst produce one combined message.
- [ ] Muted and alone in an approved voice channel for 10 minutes earns nothing.
- [ ] Unmuted with one other member earns; idling past decay earns visibly less.
- [ ] A voice channel not on the approved list earns nothing.
- [ ] Crossing a role reward grants it and removes the previous one under replace mode.
- [ ] A reward role above the bot logs once, no crash, no retry storm.
- [ ] `/account` on self and on another member.
- [ ] `/levels` across all three timeframes.
- [ ] `/achievements` before and after an unlock; a hidden one is invisible until it fires.
- [ ] Deleting the levels board reposts only that board.
- [ ] `/xp reset-member`, then `/account`.
- [ ] Toggle leveling off; chat; nothing is written.

### CI/CD

The bot has no automated pipeline. Its gate is manual, so it is written down here rather than remembered.

| Step | Command | Gate |
|---|---|---|
| Type check | `npx tsc --noEmit` | **Blocking.** The standard verification in code mode |
| Tests | `npm test` (single run; `test:run` and `test:coverage` do not exist) | **Blocking** |
| Lint | `npm run lint` | Blocking on errors, warnings are judgment |
| Build | `npm run build` | **Owner only.** Never run by an agent |
| Command registration | `npm run deploy` | **Owner only.** Global, up to 1 hour to propagate |
| Deploy | Railway | **Owner only** |
| Announcement | `package.json` version bump | **Owner only, and last.** Verify propagation first (R9) |

What blocks a merge: a `tsc` error, a failing test, a `src/features/leveling/` import reaching outside the feature except through `awardXp`, leveling copy added to a voice pack beyond the `commandGuide` entry, any reintroduction of the `MessageContent` intent, and **any leveling send without `allowedMentions` parse empty**.

Feature flags and rollback, escalating: `leveling.enabled` per guild (config, no deploy), a global kill switch env var (redeploy, no code change), revert the `main.ts` listener registrations (code, three lines). **No step deletes data.** Turning leveling back on resumes exactly where it left off.

---

## 9. FINAL REVIEW

### Requirement coverage

| Req | Where it lands | Phase |
|---|---|---|
| F1 message XP, no content | `messageXp.ts`, `xpWriter.ts` | 2 |
| F2 reaction XP | `reactionXp.ts` | 2 |
| F3 voice XP, approved channels | `voiceXp.ts` sweep | 2 |
| F4 mini game XP with a winner bonus | hooks in all four games | 2 |
| F5 game room XP | `roomLifecycle.finish` | 2 |
| F6 restrictions | `restrictionMode` plus one list | 1, 2 |
| F7 multipliers | role and channel, `stackMultipliers` | 1, 2 |
| F8 counters incl. K/D/A | `MemberLevel.games` map | 1, 2 |
| F9 curve | `levelCurve.ts`, `dero` default (D1) | 1 |
| F10 prime milestones | `primeLevels.ts` (D2) | 1 |
| F11 Dero congrats, reaction, no ping | `levelUpAnnouncer.ts` (D3) | 2 |
| F12 role rewards | `roleRewards.ts` | 4 |
| F13 achievements | `achievements.ts`, `achievementEngine.ts` | 4 |
| F14 `/account` | `src/commands/fun/account.ts` | 3 |
| F15 `/levels` | `src/commands/fun/levels.ts` | 3 |
| F16 standings board | `LevelsBoard.ts` | 3 |
| F17 `/achievements` | `src/commands/fun/achievements.ts` | 4 |
| F18 `/setup-level-system` | `src/commands/admin/setup-level-system.ts` | 3 |
| F19 `/xp` | `src/commands/admin/xp.ts` | 3 |
| F20 export | admin gated route or command | 3 |
| F21 announcement with Suggestion Box CTA | `postFeatureAnnouncement.ts` | 5 |
| F22 battleship | `battleshipState` + handler | 7 |
| F23 blackjack | `blackjackState` + handler | 6 |
| F24 hold em | three pure modules + handler | 8 |
| N1 zero writes on the common path | guard order 4.5 | 2 |
| N2 buffered plus shutdown flush | `xpWriter` in `gracefulShutdown` | 2 |
| N3 atomic only | `$inc`, `bulkWrite`, the claim | 2 |
| N4 no reset job | `XpPeriod` period keys | 1 |
| N5 fire and forget | every Discord side effect | 2, 3, 4 |
| N6 bounded maps | `xpWriter` sweep | 2 |
| N7 index only rank | `{ guildId, totalXp: -1 }` | 1, 3 |
| N8 adversarial input | cooldowns, restrictions, voice anti idle, no length bonus | 1, 2 |
| N9 no pushed private views | pull based buttons in every game | 6, 7, 8 |

### Architectural consistency

The pure and impure split (`levelCurve`, `primeLevels`, `levelPeriod`, `achievementEngine`, `blackjackState`, `battleshipState`, the three `holdem` modules against everything else) matches `duelResolve` / `duelHandler`, `rpsWinner` / `rpsHandler`, `hangmanState` / `hangmanHandler` and `occurrenceCalculator` / `GuildEventManager`. Board ownership matches `ScheduleBoard` and `LeaderboardBoard`. Copy ownership matches `gamesCopy` and `fortuneCopy` and states its reasoning inline the same way. The entitlement seam matches `gameRoomAccess`. The challenge handshake is reused, not rewritten. Stores stay thin. **Nothing here invents a new pattern; every piece has a sibling in the repo already.**

### Scalability and maintainability

- Rank is index only and exact to the tens of thousands, with a documented upgrade that needs no schema change.
- Writes are batched, so message volume scales the flush payload rather than the write count.
- Weekly and monthly views have no job to fail, removing a bug class the market leader currently ships.
- Achievements read counters the writer already maintains, so adding one is a data change, not a code change, at zero runtime cost.
- Adding a seventh XP source, or a fourth new game, is one `awardXp` call plus one `MINI_GAME_HANDLERS` entry.
- Prime milestones are a boot time sieve and an O(1) `Set.has`.

### Open questions, resolved or deferred with an owner

| # | State | Owner and decision point |
|---|---|---|
| Q1 to Q6 | **CLOSED by D1 to D5 and the voice XP reversal (A4)** | done 2026-08-10 |
| Q7 persistent chip balance | **Deferred.** Recommendation: never; per tournament stacks forever (A9, R22) | silent, before Phase 8 |
| Q8 battleship private board mechanism | **Recommended: pull based button**, not a channel per player (R21) | silent, before Phase 7 |
| U1 `getCopyOverride` contract | **RESOLVED** by reading `getCopy.ts:77`. Arbitrary string key | closed |
| U2 `createChannels` change needed | **Expected no**, confirmed in Phase 3 | executing agent |

Neither Q7 nor Q8 blocks anything before Phase 7.

### Rollback confirmed against the register

R1, R5, R16, R17, R18, R19 all roll back with a config flip and no deploy. R2, R14 roll back with a one line revert. R6, R7, R10 are bounded by design. R4, R13, R15 are corrected forward, because nothing is destroyed by them. R20, R21, R22 are design constraints, not runtime failures, and cannot be "rolled back" so much as violated, which is why each is named in the phase that must honor it.

**No step in this plan deletes data.** `/xp reset-server` is the only destructive operation in the feature, it is admin gated, it needs a confirm button, and it is the guild's own data.

### The honest risk assessment

The riskiest decision in this plan is **D4, on everywhere immediately**, and it is silent's call to make. It is the one choice that puts a brand new hot listener and a new public message stream into every live guild on a single deploy with no opt in. R16's six mitigations exist specifically because of it, and the first level up admin notice is the one that matters most: it is the difference between an admin discovering leveling from a member's confused question and discovering it from a message that names the command to configure it.

The second riskiest is **hold em's side pots**, because no surveyed implementation documents them, which means there is no reference to check against and the failure mode is a player being paid the wrong amount in a situation that only arises when someone is all in. That is why it is a pure module with hand written scenario tests, and why it is in the last phase.

---

## EXECUTION PROTOCOL

1. Execute one phase at a time, in order. Do not start a phase before its `Depends on` is met. **Phases 7 and 8 additionally require the game rooms release to have shipped.**
2. Re validate against the phase's Completion Criteria before advancing. `npx tsc --noEmit` and `npm test` are blocking at every phase boundary, not just at the end.
3. **Phase 5 is a release boundary.** The leveling system ships there. Phases 6, 7 and 8 are three further independent releases, in that order, and none of them may be allowed to delay the others.
4. Never run `npm run build`, `tsc-alias`, `npm run deploy`, `npm install`, or anything that emits or deploys. Write the files and ask silent to install and deploy.
5. When new information emerges, update the Roadmap and the Assumptions log. Do not improvise silently.
6. D1 through D5 are locked. If one turns out to be wrong, surface it as a new decision for silent, not as a correction you make yourself.
7. Nothing in this plan fires the release announcement. That is a Phase 5 handoff to the owner's existing flow, gated on verified global command propagation.
8. Every phase that touches a shipped file must leave that file's existing behavior identical. The regression checklist in section 8 is the proof, and it runs at every phase boundary.
---

## SPELLS

Nine paste ready prompts, one to two per phase. Each is self contained: the executing agent needs no other part of this document. Paste the fenced block, nothing outside it.

Phase 5 gets no spell on purpose. It is verification, ledger updates and a release gate, all mechanical and all fully specified in sections 7 and 8.

---

### Spell 1: leveling foundation

Phase 1. Target: Claude Code in `DeroDiscordBot`.

```
You are working in the DeroDiscordBot repo at C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot. A Discord bot: TypeScript, pure ESM, discord.js v14, Mongoose on MongoDB Atlas, deployed on Railway.

GOAL
Build the pure foundation of a new leveling feature. Everything you create is imported by nothing. When you are done the bot's runtime behavior must be byte for byte identical. That is deliberate: the foundation lands dark so the hot path in the next phase has a tested floor.

HOUSE RULES, non negotiable
- Pure ESM. Every local import carries a .js suffix even though the source is .ts.
- Aliases: @utils/* @base/* @api/* @features/* @commands/* @db/* @handlers/*.
- Verification is `npx tsc --noEmit`. NEVER run npm run build, tsc-alias, npm run deploy, or npm install. The owner does those manually.
- Tests colocated: foo.test.ts next to foo.ts. Vitest. The test command is `npm test` and it is a SINGLE run. `npm run test:run` and `npm run test:coverage` DO NOT EXIST.
- No dashes in user facing copy or in your replies. Hyphens inside slash command identifiers are identifiers, not dashes.
- Comment non trivial logic in the house voice: prose, circled digit steps, box drawing section markers. Cover what, who, when, where, how.
- Stores in src/db/stores/ are THIN Mongoose wrappers. Business logic goes in feature modules. Do not test store methods.

CREATE src/features/leveling/levelCurve.ts
Pure. No discord.js, no store import, no mutable module state, no I/O. Model it on the repo's existing pure modules, which all carry a header comment stating the split: src/features/games/duelResolve.ts, rpsWinner.ts, hangmanState.ts, and src/features/events/occurrenceCalculator.ts.

Four presets giving the XP to COMPLETE level n, each multiplied by a per guild multiplier then ROUNDED (round, not floor: multiplier 0.5 at a cost of 1075 must give 538, not 537):
  dero         3*(n*n) + 47*n + 101      <- THE DEFAULT
  linear       (n * 100) + 75
  exponential  5*(n*n) + (n * 50) + 75
  flat         1000

The dero curve is the owner's chosen default and its three coefficients (3, 47, 101) are all PRIME. That is intentional and it pairs with primeLevels.ts below. Say so in a comment so nobody "tidies" them into round numbers.

Export: type CurvePreset; xpForLevel(n, preset, multiplier); totalXpForLevel(n, preset, multiplier) cumulative; levelFromTotalXp(totalXp, preset, multiplier, maxLevel); xpIntoLevel(...); xpToNextLevel(...).

The requirement that matters most: compute the cumulative prefix sum ONCE per (preset, multiplier) pair, memoized in a module level Map, up to a MAX_LEVEL_CEILING you define as 1000. levelFromTotalXp is then a BINARY SEARCH over that array. Do NOT loop subtract per call and do NOT ever touch the database. Comment this, because loop subtracting is what most tutorial code does and it becomes CPU at scale.

maxLevel null means uncapped; a maxLevel clamps without throwing. Negative XP, zero XP and XP above the ceiling must all return sane values and never throw.

CREATE src/features/leveling/levelCurve.test.ts
Pin each preset at levels 1, 10 and 50. Pin the dero curve's cumulative values exactly: level 2 = 151, level 5 = 964, level 10 = 3,879, level 25 = 31,224, level 50 = 183,799, level 100 = 1,227,699 (cumulative XP to REACH that level, i.e. the sum of xpForLevel(1) through xpForLevel(level - 1)). Pin the rounding case. Pin that levelFromTotalXp is the exact inverse of totalXpForLevel across a wide sweep. Pin maxLevel capping and the no throw cases.

CREATE src/features/leveling/primeLevels.ts and primeLevels.test.ts
Pure. A sieve of Eratosthenes to MAX_LEVEL_CEILING computed ONCE at module load into a Set<number>, and isMilestone(level): boolean that is an O(1) Set.has thereafter.

Why this exists, and put it in the comment: PRIME LEVELS ARE THE MILESTONE LEVELS. This replaces an "every N levels" rule entirely. It is not only an aesthetic choice by the owner, it produces the correct milestone density curve for free: 8 milestones in levels 1 to 20 (40 percent), 7 in 21 to 50 (23 percent), 10 in 51 to 100 (20 percent). High early when a new member needs frequent proof the system is real, thinning later when rarity is the reward.

Test against a hand written list of the 25 primes under 100: 2 3 5 7 11 13 17 19 23 29 31 37 41 43 47 53 59 61 67 71 73 79 83 89 97. Assert 1 is not a milestone and 2 is.

EXTEND src/features/leaderboard/leaderboardWindow.ts, do not create a second week math module
That file already owns this repo's week boundary math: the WeekStart type ("sunday" | "monday"), the Sunday based getDay rotation for Monday anchoring, thisWeekRange, thisMonthRange, weekBoundaryTitle. It is pure, with no Discord and no DB imports.

What it does NOT have and what you must ADD there rather than fork:
  - any ISO week NUMBER logic, so it cannot produce "2026-W32"
  - an injectable date: thisWeekRange takes only weekStart and reads new Date() internally, so it cannot be tested at a boundary

Add: periodKey(date: Date, granularity: "week" | "month", weekStart: WeekStart): string returning "2026-W32" and "2026-08". Take the date as a parameter. Reuse the existing rotation rather than writing a second one. Leave the existing three exports behaving exactly as they do now.

Then CREATE src/features/leveling/levelPeriod.ts as a thin wrapper if the leveling feature wants a narrower signature, and test the year boundary week, the last millisecond of a week versus the first of the next, both weekStart values, and a month boundary.

CREATE src/db/models/MemberLevel.ts
Follow src/db/models/GameRoom.ts and PlayerActivity.ts for shape and voice.
  memberLevelId  String unique default v4 (uuid, same as every other model here)
  guildId        String required
  userId         String required
  username       String required
  totalXp        Number default 0
  announcedLevel Number default 0
  messages       Number default 0
  reactionsGiven Number default 0
  voiceMinutes   Number default 0
  fortuneReadings Number default 0   <- backs the hidden dero-knows achievement, so it must
                                        exist from Phase 1 even though nothing reads it yet
  games          Map of { played, won, lost, drawn, assists }, keyed by game slug
                 ("duel", "rps", "hangman", and later "battleship", "blackjack", "holdem")
  unlocked       array of { id, tier, at, earnedBy }
  lastAwardAt    Date default null
  timestamps: true

Indexes, both required:
  { guildId: 1, userId: 1 } UNIQUE     <- concurrent upserts race and throw E11000 without it
  { guildId: 1, totalXp: -1 }          <- makes rank an index only count

Three comments the next reader needs:
1. `level` is deliberately NOT a field. It is DERIVED from totalXp through levelCurve. A stored level is a second source of truth that drifts the instant an admin runs /xp set or the guild changes its curve preset.
2. `announcedLevel` is NOT the member's level. It is a high water mark used only to make level up announcement claiming atomic across concurrent flushes. Say this explicitly or the next reader will "fix" it into a level field.
3. `unlocked[].earnedBy` is a human sentence composed AT UNLOCK TIME ("solved 53 hangman rounds"), because the /account command shows HOW an achievement was earned and the counters will have moved on by the time anyone looks.

CREATE src/db/models/MemberLevel.test.ts asserting the unique compound index exists. src/db/models/GameRoom.test.ts is the model for how this repo tests a schema.

CREATE src/db/models/XpPeriod.ts
  xpPeriodId String unique default v4, guildId String required, userId String required,
  period String required, xp Number default 0, timestamps
  index { guildId: 1, period: 1, xp: -1 }
  index { guildId: 1, userId: 1, period: 1 } UNIQUE
  a TTL index on createdAt

Comment WHY the TTL is correct here when src/db/models/PlayerActivity.ts deliberately has none. Read the retention note in PlayerActivity.ts first so the two agree rather than appearing to contradict: PlayerActivity is the irreplaceable historical record the leaderboard reads back; XpPeriod rows are derivable per period aggregates.

Also comment the design intent: there is no weekXp field to zero, therefore no reset job, therefore no reset job that can fail. Arcane, the market leader, ships a documented unfixed bug where weekly and monthly leaderboards only reset if an unrelated notification setting is enabled. A schema with nowhere to put that bug beats a job that has to remember to run.

CREATE src/db/stores/memberLevelStore.ts and xpPeriodStore.ts
Thin wrappers. Model on activityStore.ts and gameRoomStore.ts. No business logic, no tests.

MODIFY src/db/models/GuildConfig.ts
Add `levelsMessageId: { type: String, required: false, default: null }` beside the existing leaderboardMessageId, and a nested `leveling` subtree:

  enabled TRUE, curve "dero", curveMultiplier 1, maxLevel null,
  milestoneMode "prime" (enum "prime" | "everyN"), milestoneEveryN 5,
  message  { enabled true, min 15, max 40, cooldownSeconds 60 },
  reaction { enabled true, min 10, max 25, cooldownSeconds 300,
             awards "reactor" (enum "reactor" | "author" | "both") },
  voice    { enabled true, perMinute 5, cooldownSeconds 180, approvedChannels [],
             minMembers 2, decayAfterMinutes 120, decayFactor 0.25 },
  announceMode "announcements" (enum "announcements" | "current" | "milestone" | "off"),
  announceChannelId null, reactionEmoji "🎉",
  restrictionMode "exclude" (enum "exclude" | "only"), restrictedChannels [], restrictedRoles [],
  stackRewards true, rewards [], roleMultipliers [], channelMultipliers [], stackMultipliers false

THREE defaults need their reasoning in a comment or they will be inverted later:

1. `enabled` defaults TRUE. The owner decided leveling ships ON in every guild immediately, with no opt in. Do not "helpfully" default it false.

2. `voice.approvedChannels` defaults to an EMPTY ARRAY, and empty means NOBODY EARNS VOICE XP. This is the opposite polarity from every other list here and it is deliberate: voice XP is opt in per channel by construction, so a guild that never configures it never has a voice farming surface. An empty array that means "none" rather than "all" is exactly the kind of thing a later reader inverts, so say it loudly.

3. `restrictionMode` is one enum paired with ONE list. Arcane ships a blacklist and a whitelist as sibling settings and their own docs open with a DANGER banner calling that misconfiguration their largest support item, because adding one channel to the whitelist silently kills XP everywhere else. One mode plus one list makes that unrepresentable.

Extend GuildConfig.test.ts for the new defaults.

MODIFY src/base/copy/brand.ts
Add LEVEL_UP, LEVEL_MILESTONE, ACCOUNT, ACHIEVEMENT and LEVELS_BOARD to COLORS. Hex values distinct from every existing key including the four GAME_ keys, FORTUNE and FORTUNE_ULTRA. Follow the existing comment style, which explains WHY each color was chosen relative to its neighbours. LEVEL_MILESTONE should read as clearly more special than LEVEL_UP, since prime levels get the loud treatment.

MODIFY src/base/constants/BOT_CONSTANTS.ts
Add a LEVELING block: flush interval (10 seconds), map sweep interval, announcement coalescing window, the burst threshold above which announcements combine, the voice sweep interval, and the per game XP amounts (play 25, win 75, tie 40, fortune 10, gameRoom play 40, gameRoom win 120). Comment each the way the GAME_ROOM_ constants there are commented.

ALSO add a PINGABLE constant: a frozen Set naming the message kinds that are ALLOWED to ping members (real reminder fires, go live announcements). Comment its purpose: leveling messages must NEVER ping, and a future engineer who wants to add a ping should have to add their kind to a named list, which is a decision, rather than delete one allowedMentions line, which is an accident.

MODIFY src/base/constants/log-messages.ts
Add a `leveling` block matching the shape of the existing per feature blocks.

CREATE src/features/leveling/levelingCopy.ts
Feature local copy, NOT routed through the copy packs. Model on src/features/games/gamesCopy.ts and src/features/fortune/fortuneCopy.ts and copy their explanatory comment style.

You will read a rule in CLAUDE.md saying user facing copy routes through the rok-commander pack. That rule does NOT apply to structural copy here, for the same reason gamesCopy.ts states inline: "Level", "XP to next" and "Rank" read identically in the kingdom voice and the streamer voice. Write that reasoning into the file.

ONE exception, and comment it: the Dero level up congratulations is the single string with a real voice. Its default lives here, and it is additionally overridable per guild through getCopyOverride("leveling.levelUp", guildConfig) and getCopyOverride("leveling.milestone", guildConfig). This is already VERIFIED for you, so do not re investigate: src/base/copy/getCopy.ts line 77 exports getCopyOverride(key, guildConfig) taking an ARBITRARY string key and returning guildConfig.copyOverrides.get(key) or undefined. It is not scoped to pack fields. No new schema field is needed.

Also write in, as a comment, the rule that leveling must NEVER award XP based on message length or word count, because that would require the privileged MessageContent intent that src/main.ts deliberately does not request, and because length based XP is the most gameable mode in this category.

CREATE src/features/leveling/levelingEmbeds.ts
Embed builders for the account profile, the levels board, the level up card and achievements. Do NOT call embedBuilder.base(). Import COLORS directly from @base/copy/brand.js. Mirrors src/features/games/gamesEmbeds.ts, which opts out of base() for the same reason.

CREATE src/features/entitlements/levelingAccess.ts
Copy the structure of src/features/entitlements/gameRoomAccess.ts including its cache shape and its two TTLs. It must FAIL OPEN, and carry over the equivalent of its warning comment explaining why it deliberately differs from src/features/early-access/earlyAccess.ts, which fails closed. Leveling is free for everyone today, so a server blip must never silently take it away. Today it returns allowed for everyone; it exists so a future tier gate is a config flip and not a refactor.

DO NOT
- Do not register anything in src/main.ts. Not one line. That is the next phase.
- Do not add a messageCreate listener.
- Do not request the MessageContent intent, now or ever.
- Do not touch src/features/activity-tracking/, PlayerActivity.ts, activityStore.ts, or anything in src/features/leaderboard/ EXCEPT leaderboardWindow.ts, where you are explicitly adding periodKey. That is a separate system: it scores ROK event participation keyed by eventId and eventOccurrence, and its existing exports must keep behaving identically.
- Do not reuse or extend GuildConfig.leaderboardTrackingEnabled. Leveling gets its own flag.
- Do not add a TTL to PlayerActivity.
- Do not put any leveling copy into either voice pack.

DELIVERABLES
The files above. Clean `npx tsc --noEmit`. Green `npm test`. A short report confirming via grep that nothing outside src/features/leveling/, src/db/ and leaderboardWindow.ts imports anything you created.

ACCEPTANCE
Booting the bot after this change produces no new log lines, registers no new listener, and changes no behavior anywhere.
```

---

### Spell 2: XP engine and the three passive sources

Phase 2. Target: Claude Code in `DeroDiscordBot`. Assumes the Phase 1 foundation exists.

```
You are working in the DeroDiscordBot repo at C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot. TypeScript, pure ESM, discord.js v14, Mongoose, Railway.

ALREADY EXISTS from the previous phase, use it and do not rebuild it:
  src/features/leveling/levelCurve.ts    four presets, "dero" default = 3n^2 + 47n + 101,
                                         memoized prefix sums, binary search invert
  src/features/leveling/primeLevels.ts   isMilestone(level), O(1), prime levels are milestones
  src/features/leveling/levelPeriod.ts   periodKey for "2026-W32" and "2026-08"
  src/features/leveling/levelingCopy.ts and levelingEmbeds.ts
  src/db/models/MemberLevel.ts           totalXp, announcedLevel, counters, games map, unlocked[]
  src/db/models/XpPeriod.ts
  src/db/stores/memberLevelStore.ts, xpPeriodStore.ts
  GuildConfig.leveling subtree, enabled defaults TRUE
  BOT_CONSTANTS.LEVELING and BOT_CONSTANTS.PINGABLE

GOAL
Make XP actually get earned, from THREE passive sources (messages, reactions, approved voice channels), and make a level up celebrate itself in the announcements channel WITHOUT PINGING ANYONE. This adds the bot's FIRST EVER messageCreate listener, so it is a permanently hot path on a process that has never had one. Every instruction about ordering and I/O below is a hard requirement, not a style preference.

HOUSE RULES
- Pure ESM, .js suffix on every local import. Aliases: @utils/* @base/* @api/* @features/* @commands/* @db/* @handlers/*.
- Verification is `npx tsc --noEmit`. NEVER run npm run build, tsc-alias, npm run deploy, or npm install.
- Tests colocated, Vitest, `npm test` is a SINGLE run. `npm run test:run` and `npm run test:coverage` do not exist.
- No dashes in user facing copy or in your replies.
- Discord side effects following a successful primary action are FIRE AND FORGET: log, swallow, never throw back. This is convention 7 in CLAUDE.md, under "Conventions and rules", NOT one of the five "Critical invariants". It is why refreshLeaderboard swallows its own failures.
- Comment non trivial logic covering what, who, when, where, how.

THE INTENT CONSTRAINT, read before writing any code
src/main.ts lines 60 to 85 build the client WITHOUT the MessageContent privileged intent. Lines 67 to 72 carry a comment that includes the clause "and there is no messageCreate listener", followed by two more sentences about privileged intent verification risk at 100+ guilds.

You must NOT request MessageContent. The GuildMessages intent already tells you THAT a message happened, in which channel, from which member, which is the complete input a cooldown gated award needs. MessageContent is only needed for per word or length based XP, which is the most gameable mode in this category and which this feature deliberately does not offer.

UPDATE that one clause in place. Do NOT delete or truncate the surrounding comment; the verification risk reasoning stays true and is what protects the decision.

Good news you do not need to change: GuildMessageReactions plus Partials.Reaction and Partials.Message are ALREADY declared, so reaction XP needs no intent change. GuildVoiceStates is ALREADY declared, so voice XP needs none either.

CREATE src/features/leveling/xpWriter.ts
Three responsibilities, in this order of importance.

1. THE COOLDOWN CLAIM. A module scoped Map keyed `${guildId}:${userId}:${source}` to a last award timestamp. One function claims: read, compare against the window, and if it passes, WRITE THE NEW TIMESTAMP AND RETURN TRUE.

   There must be NO await anywhere between that read and that write. That synchrony is the entire race defense for the common case: two messages in the same tick cannot both pass, because the second sees the first's write without ever yielding the event loop. Comment this explicitly. The repo already uses this discipline twice: startHangmanRound in hangmanHandler.ts claiming a channel slot, and the pair key in challengeFlow.ts.

   Do NOT use the existing CooldownManager from @utils/cooldownManager.js for this. Its contract deliberately separates check() from record(), which is right for a slash command where you only burn the window after success, and wrong here where the claim IS the guard.

2. THE WRITE BUFFER. A pending Map keyed the same way to an accumulated delta of xp and counters. A flush on the BOT_CONSTANTS.LEVELING interval that:
   - swaps the pending map out FIRST, before any await, so new events accumulate into a clean map rather than one being drained
   - issues ONE bulkWrite of updateOne ops against MemberLevel with $inc for totalXp and the counters, $setOnInsert for guildId, userId, username, upsert true, ordered FALSE so one bad op does not drop the batch
   - issues a second bulkWrite against XpPeriod for the current week key AND the current month key
   - exports flushNow() for shutdown

   State the tradeoff in a comment: buffered XP is lost on a hard crash, bounded by the flush interval, and that is acceptable for XP specifically. It would not be for anything a member paid for.

3. THE SWEEP. Both maps must be bounded. Sweep entries older than the maximum configured cooldown on an interval. An unbounded map on a busy bot is a slow leak.

Both the clock and the flush interval must be injectable so tests never wait on real time.

SHUTDOWN, and do not get this wrong
src/main.ts ALREADY registers process.on("SIGTERM") and process.on("SIGINT") to a gracefulShutdown function that ends in process.exit(). Do NOT register a second SIGTERM listener: it would race that shutdown, so your flush could be killed mid bulkWrite or fire after disconnectMongoose() has already run. Instead call `await flushNow()` as a new step ⓪ INSIDE gracefulShutdown, before stopScheduler, wrapped in its own try/catch exactly like the other steps there.

CREATE src/features/leveling/awardXp.ts
The single public entry point. Every XP source in the codebase calls this and nothing else.

  awardXp({ guildId, userId, username, amount, source, game?, outcome?, counters?, client })
  source  = "message" | "reaction" | "voice" | "game" | "gameRoom" | "achievement" | "admin"
  game?   = "duel" | "rps" | "hangman" | "battleship" | "blackjack" | "holdem"
  outcome?= "won" | "lost" | "drawn" | "assist"

Rules:
  - It NEVER throws. Every failure is logged and swallowed.
  - source "message" stages into the buffer. Every other source writes through immediately, because a game result or an admin correction should be visible on the next /account rather than up to a flush window later.
  - When game and outcome are present, update the member's games map ($inc on played plus the outcome key) in the SAME atomic write as the XP, so the XP and the win/loss record can never disagree.
  - It is the ONLY module a handler or command may import for granting XP.

LEVEL UP DETECTION, atomic, do not deviate
  - $inc is atomic and server side, so the returned post increment document is the truth and oldTotal is exactly newTotal minus the amount awarded. Derive both levels from levelCurve. No second read.
  - Before ANY side effect, CLAIM the announcement: updateOne({ _id, announcedLevel: { $lt: newLevel } }, { $set: { announcedLevel: newLevel } }). If modifiedCount is 0, another path already announced this level, so return without announcing. This makes a double announcement impossible.
  - Two concurrent upserts on the same missing key can both attempt an insert and one gets E11000. Known long standing mongoose behavior. The unique compound index on { guildId, userId } exists; wrap the upsert in a retry once on code 11000. The retry always succeeds because the document now exists.
  - A member who crosses two levels in one flush gets ONE announcement, at the higher level.

CREATE src/features/leveling/messageXp.ts
Guard clauses in exactly this order, cheapest first, because the overwhelming majority of messages must die at zero I/O:
  1. message.author.bot   return
  2. no message.guild     return
  3. message.system       return
  4. claimCooldown fails  return            <- still zero I/O
  5. read guild config    <- from a TTL cache, NOT a fresh findByGuildId per message
  6. leveling.enabled false or message.enabled false  return
  7. restriction check, honoring restrictionMode "exclude" versus "only"
  8. restricted role check
  9. roll xp between min and max, apply role and channel multipliers honoring stackMultipliers (additive when stacking, highest only when not), floor with a minimum of 1
 10. awardXp source "message", counters { messages: 1 }

The xp roll function must NOT accept message text as a parameter. That is the structural guarantee nobody can add length based XP later without deliberately changing a signature.

CREATE src/features/leveling/reactionXp.ts
A SECOND Events.MessageReactionAdd listener, registered beside the one in src/features/activity-tracking/ActivityTracker.ts.

Two listeners on one event reads as a bug, so BOTH must carry a comment pointing at the other. The differences are total: ActivityTracker's filters to the ✅ emoji on a message that is a stored ReminderLog and writes PlayerActivity; yours accepts any emoji, ignores ReminderLog entirely, and writes MemberLevel. Neither may touch the other's model.

Rules: its own cooldown (default 300s), at most one award per member per message, `awards` decides whether the reactor, the message author, or both are paid, NEVER award a member for reacting to their own message, and reaction REMOVAL never claws XP back because that becomes a farm loop of its own. Fetch partials before reading properties, the way ActivityTracker does.

CREATE src/features/leveling/voiceXp.ts
A SWEEP on an interval, NOT an award on VoiceStateUpdate.

Do NOT join a voice channel. Arcane's own docs give the reasoning and it is sound: joining "would limit voice XP to one voice channel, be expensive to run, and a privacy nightmare."

On each tick, walk the cached voice states per guild and award only members who pass ALL of:
  1. the channel id is in leveling.voice.approvedChannels. AN EMPTY LIST MEANS NOBODY EARNS. This is the owner's "approved voice calls" requirement and it is opt in by construction.
  2. the channel holds at least minMembers NON BOT members
  3. the member is NOT selfMute, selfDeaf, serverMute or serverDeaf
  4. if the member's continuous session exceeds decayAfterMinutes, multiply the award by decayFactor

Conditions 2, 3 and 4 are Arcane's anti farm set copied wholesale, because a 24/7 voice self bot is a real, public, mature tool. Condition 1 is this bot's own addition and is stronger than anything Arcane offers. Comment all four.

This must NOT touch ActivityTracker's VoiceStateUpdate listener, which tracks ROK event participation during event windows and stays exactly as it is.

CREATE src/features/leveling/levelUpAnnouncer.ts
A per channel queue with a coalescing window. Copy the COALESCING shape from scheduleLeaderboardRefresh in src/features/leaderboard/LeaderboardBoard.ts and read its comment first: the FIRST event schedules a send one window out and later events inside that window are absorbed with the timer LEFT RUNNING. It is deliberately not a reset on each call debounce, which would starve the channel during a busy burst.

Above the BOT_CONSTANTS burst threshold, send ONE combined message listing every level up instead of N. This solves both the "trains your community to mute the channel" complaint and Discord's per channel 429 risk with one mechanism, and no bot in this category ships it.

TWO TIERS OF CELEBRATION, and this is what makes the announcements channel survivable:
  - ORDINARY level: one compact line inside the coalesced message. No embed, no art, no reaction.
  - PRIME MILESTONE level (primeLevels.isMilestone(newLevel)): the full treatment. A Dero authored embed in COLORS.LEVEL_MILESTONE, the congratulations line from levelingCopy or the guild's getCopyOverride("leveling.milestone", config), the bundled Dero art, any role reward named in an {earned:...} block, and THE BOT ADDS leveling.reactionEmoji TO ITS OWN MESSAGE so members can pile on.

Put the reaction on the BOT'S OWN post, not on the member's message. A level up can come from a reaction or a voice sweep where there is no message to react to, so anchoring to the bot's post is the only version that always works.

THE NEVER PING INVARIANT, this is a hard requirement from the owner
EVERY level up message, ordinary and milestone alike, must set:
  allowedMentions: { parse: [], roles: [], users: [] }
so a <@id> renders as a name and notifies nobody. This is already house style: the test reminder fires and the duel result embed both do it.

Make it structural, not a habit. Assert at send time that this message kind is NOT in BOT_CONSTANTS.PINGABLE, and fail loudly in development if it ever is. A future engineer who wants leveling to ping should have to add a named kind to that allowlist, which is a decision, rather than delete one line, which is an accident.

Permission precheck before every send, because otherwise the failure is invisible to the admin: channel.permissionsFor(guild.members.me) must have ViewChannel, SendMessages, EmbedLinks, AttachFiles, and AddReactions for the congratulations reaction. Missing any means record a config warning and return, never throw.

Support all four announceMode values: "announcements" (announceChannelId, falling back to config.announcementsChannelId), "current", "milestone" (prime levels only), "off".

Template tags: user mention, user name, user level, user xp (progress INTO the level, not the total), guild name, and an {earned:...} conditional block rendered only when a role was also granted.

THE FIRST LEVEL UP ADMIN NOTICE
Leveling ships ON in every guild with no opt in, which means some admin will meet this feature for the first time when a member asks about it. Prevent that: on the FIRST level up ever recorded in a guild, post a one time notice to the guild's admin channel naming /setup-level-system and how to disable it. Make it idempotent through botLogStore, exactly the way src/features/announcements/postFeatureAnnouncement.ts makes its per version announcement idempotent. Read that file for the pattern.

MODIFY src/main.ts
Register the three listeners and the announcer beside the existing registerActivityListeners call, start the voice sweep interval, add `await flushNow()` as step ⓪ inside gracefulShutdown, and update the MessageContent clause. Nothing else changes.

TESTS
Cover, at minimum: two claims in the same tick with exactly one winner; flush batching, map swapping and flushNow; awardXp never throwing and buffering only for "message"; the games map updating in the same write; messageXp's zero I/O early returns and both restriction modes; reactionXp's self reaction, repeat reaction and awards modes, plus that a ✅ on a ReminderLog message still reaches ActivityTracker unchanged; voiceXp's four gates and the decay; and for the announcer, that EVERY send has allowedMentions parse empty, that a prime level renders the card while a non prime renders the compact line, and that a missing permission records a warning rather than throwing.

DO NOT
- Do not request the MessageContent intent.
- Do not award XP based on message length, word count or content of any kind.
- Do not write to the database on an event that fails its cooldown.
- Do not use a read, modify, write anywhere. Every XP mutation is $inc.
- Do not store a level field.
- Do not register a second SIGTERM listener.
- Do not join a voice channel.
- Do not touch src/features/activity-tracking/, PlayerActivity, activityStore, or src/features/leaderboard/ except to import the coalescing pattern.
- Do not reuse GuildConfig.leaderboardTrackingEnabled.
- Do not collapse cooldowns. Message, reaction and voice each get their own window.
- Do not let any leveling message ping anyone.

DELIVERABLES
The files above. Clean `npx tsc --noEmit`. Green `npm test`. A short report confirming that with leveling.enabled false a messageCreate event results in zero database calls, and that every send site in levelUpAnnouncer.ts sets allowedMentions parse empty.

ACCEPTANCE
In a test guild with leveling enabled: three messages inside 60 seconds award exactly once; a level up posts exactly one message in #announcements that pings nobody; a prime level looks visibly different from a non prime one; five level ups in one burst produce one combined message; sitting alone and muted in an approved voice channel earns nothing; with leveling disabled nothing is written and nothing posts.
```
---

### Spell 3: game award hooks

Phase 2. Target: Claude Code in `DeroDiscordBot`. Assumes `awardXp` exists.

```
You are working in the DeroDiscordBot repo at C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot. TypeScript, pure ESM, discord.js v14.

ALREADY EXISTS, use it and do not rebuild it:
  src/features/leveling/awardXp.ts
    awardXp({ guildId, userId, username, amount, source, game, outcome, counters, client })
    It NEVER throws. source is "message"|"reaction"|"voice"|"game"|"gameRoom"|"achievement"|"admin".
    game is a slug; outcome is "won"|"lost"|"drawn"|"assist". Passing game + outcome updates the
    member's win/loss/draw/assist record in the same atomic write as the XP.
  BOT_CONSTANTS.LEVELING holds every XP amount. Never inline a number in a handler.

GOAL
Wire XP awards into the four shipped mini games and into game rooms. Everyone who took part earns play XP; the winner earns more. This is a small change to five shipped files plus one structural gap you must close first, and the whole point is that it must be impossible for XP to break a working game.

HOUSE RULES
- Pure ESM, .js suffix on every local import.
- Verification is `npx tsc --noEmit`. NEVER run npm run build, tsc-alias, npm run deploy, or npm install.
- Tests colocated, Vitest, `npm test` is a single run.
- No dashes in user facing copy.
- Every award is FIRE AND FORGET, following convention 7 in CLAUDE.md under "Conventions and rules": it happens AFTER the game's primary action has already succeeded and posted, its errors are logged and swallowed, and it can never throw back into a collector callback where no caller is left to catch it. src/features/games/hangmanHandler.ts has a `swallow(label)` helper that is the house shape for exactly this.

THE STRUCTURAL GAP, close this first
src/features/games/hangmanHandler.ts defines `interface HangmanRound { starterId, state, stop }`. There is NO record of who guessed. Hangman is a PUBLIC channel wide game where any member can guess through the modal, so as written you can only reward two people: the starter, and whoever made the final guess.

Add `participants: Set<string>` to HangmanRound, initialize it with the starter in startHangmanRound, and add every guesser's id to it in the modal submit path. This unlocks two things at once: hangman XP for everyone who played, and the ASSIST outcome, which is how a member who revealed letters in a round somebody else solved gets credit. Hangman is currently the only game with a genuine assist.

THE FIVE INSERTION POINTS

1. src/features/games/duelHandler.ts
   After the `await outcome.accept.reply(...)` that posts the result, beside the existing `cooldown.record(cooldownKey)` at the end of runDuel.
   The DuelResult union from duelResolve.ts gives `winner: "challenger" | "opponent" | "tie"` for dice, and `"challenger" | "opponent"` for coin (a single coin cannot tie, which the union already guarantees).
   Award both players play XP with game "duel". The winner gets win XP and outcome "won"; the loser gets outcome "lost". A tie pays both the tie amount with outcome "drawn".

2. src/features/games/rpsHandler.ts
   At the reveal, after the `scoreRps(challengerChoice, opponentChoice)` call and after the reveal embed has been sent. RpsOutcome is the same three way union. Same shape as duel, game "rps".

3. src/features/games/hangmanHandler.ts
   In the branch where `const won = round.state.status === "won"`, after the end board edit. Award every id in the participants set, game "hangman".
   CAREFUL with actorId in that scope: it is whoever made the FINAL guess, which is the solver on a win and the member who hanged the round on a loss. GATE THE WIN BONUS ON `won === true` EXPLICITLY, or you will hand a win bonus to the person who lost it.
   On a win: actorId gets outcome "won"; every OTHER participant gets outcome "assist". On a loss or expiry: every participant gets outcome "lost" and play XP anyway, because showing up is the behavior being rewarded.

4. src/features/fortune/respondWithFortune.ts
   NOT src/features/games/fortuneHandler.ts. This matters: the `powerup:member:fortune` button in src/features/power-ups/PowerUps.ts calls respondWithFortune DIRECTLY, bypassing the command handler. Award inside respondWithFortune and both entry points earn. Award inside fortuneHandler and the button silently earns nothing.
   Fortune has a 10 second cooldown and is the most farmable of the four, so its award is small and flat. Play XP only, no outcome, since a reading has no winner. DO pass counters { fortuneReadings: 1 }, because a later phase's hidden dero-knows achievement reads that counter and nothing else increments it.

5. src/features/game-rooms/roomLifecycle.ts, the finish path
   ⚠️ CHECK THIS ONE EXISTS BEFORE YOU START, and skip it cleanly if it does not.
   As of 2026-08-11 it DOES NOT: src/features/game-rooms/ holds roomTypes.ts and nothing
   else, because game rooms is still mid build (GameRoom.ts and gameRoomStore.ts are real,
   the lifecycle module is not). Hooks 1 to 4 above are unblocked and are the deliverable;
   this fifth one lands when roomLifecycle.finish does. Do NOT invent the module to have
   somewhere to put the award, and do NOT put the award in the store instead.
   NOT src/db/stores/gameRoomStore.ts. Stores in this repo are thin Mongoose wrappers with no business logic and no tests (CLAUDE.md rule 6), and src/db/models/GameRoom.ts explicitly names roomLifecycle as the module that owns the finish decision. gameRoomStore.finish only writes what roomLifecycle already decided.
   Read participants straight off the document: GameRoom carries `playerIds: string[]` and `winnerId: string | null` as first class fields. Do NOT reconstruct participants from the RoomMove trail; that is a detour past data that already exists.
   Use source "gameRoom" rather than "game", and the gameRoom amounts, which are higher: a match with its own channel is a bigger commitment than a one message duel.

COUNTERS AND THE RECORD
Every award passes game and outcome so the member's per game played / won / lost / drawn / assists record stays correct. These feed both the /account profile and the achievement engine, which is exactly why they ride along with the award instead of being computed separately later.

DO NOT
- Do not change any game's rules, odds, cooldowns, embeds, copy or timing.
- Do not add an await between a game's result computation and the message that shows it. The award goes AFTER the player already saw the outcome.
- Do not let an award failure change what a player sees.
- Do not inline XP amounts. They live in BOT_CONSTANTS.LEVELING.
- Do not touch src/commands/events/rps.ts, eightBall.ts, sun-qoute.ts or poll.ts. Those are dead, fully commented out, pre slash command stubs. Never revive them.
- Do not add anything to src/commands/fun/mini-game.ts. That file routes and does nothing else, by design; the comment at its execute function says so.
- Do not collapse the per game cooldowns.

TESTS
Extend the existing colocated suites rather than creating new files where one exists (duelHandler.test.ts, rpsHandler.test.ts, hangmanHandler.test.ts all exist). Assert: a duel awards both and the winner more; a tie pays both the tie amount as "drawn"; hangman on a win gives the solver "won" and every other participant "assist"; hangman on a LOSS gives nobody a win bonus; a rejected award does not change the game's visible output; the fortune award fires on the BUTTON path as well as the command path.

DELIVERABLES
The modified files plus the HangmanRound change, extended tests, clean `npx tsc --noEmit`, green `npm test`. A short report confirming every call site sits after the player facing message and is fire and forget, and stating explicitly whether insertion point 5 was wired or skipped for absence.

ACCEPTANCE
Playing each of the four games moves totalXp and the per game record for every participant, and disabling leveling leaves them behaving exactly as they do today. The game room leg is acceptance only once roomLifecycle.finish exists; until then its absence is a reported gap, not a failure.
```

---

### Spell 4: the `/account` profile and the levels board

Phase 3. Target: Claude Code in `DeroDiscordBot`.

```
You are working in the DeroDiscordBot repo at C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot. TypeScript, pure ESM, discord.js v14, Mongoose.

GOAL
Build the member facing surfaces for the leveling system: a full /account profile, a /levels command, and a self refreshing standings board.

THE THING MOST LIKELY TO GO WRONG HERE
This bot ALREADY has a leaderboard, and it is not this one. src/features/leaderboard/LeaderboardBoard.ts owns a pinned message in the guild's leaderboard channel showing ROK EVENT PARTICIPATION standings, aggregated from PlayerActivity, keyed by eventId and eventOccurrence. It answers "did this warrior show up for this event". Yours answers "how present is this member in this server".

Your board is a SECOND message in the SAME channel (GuildConfig.leaderboardChannelId), anchored by a NEW field GuildConfig.levelsMessageId. Do not touch leaderboardMessageId, do not change LeaderboardBoard.ts's behavior, and do not create a Discord channel. A new channel means a CHANNEL_SPECS entry, a SLOT_LABELS entry in rename-channel.ts, a rename path and a backfill for every existing guild, all to separate two things that are both standings, and GuildSetupManager.createChannels has ZERO test coverage today so changes there are unusually risky.

ALREADY EXISTS, use it:
  src/features/leveling/levelCurve.ts     levelFromTotalXp, xpIntoLevel, xpToNextLevel
  src/features/leveling/primeLevels.ts    isMilestone(level)
  src/features/leveling/levelPeriod.ts    periodKey for "2026-W32" and "2026-08"
  src/features/leveling/levelingEmbeds.ts builders that do NOT call embedBuilder.base()
  src/db/models/MemberLevel.ts            index { guildId: 1, totalXp: -1 } already exists,
                                          plus a `games` map of per game
                                          { played, won, lost, drawn, assists }
                                          and `unlocked` entries carrying an earnedBy sentence
  src/db/models/XpPeriod.ts               index { guildId: 1, period: 1, xp: -1 } already exists
  GuildConfig.levelsMessageId

CREATE src/commands/fun/account.ts
Public, read only. This is the member's profile and it ABSORBS what would otherwise be a /rank command. One command, not two: the owner's standing rule is that too many slash commands is itself a usability problem.

Five sections in order:
  1. IDENTITY. Display name, avatar, level, a progress bar, XP into the current level, XP to next level, and a note when the NEXT level is a prime milestone. Prime levels are the milestone levels in this system, so a small "your next level is a milestone" nudge lands well once members have noticed the pattern.
  2. STANDING. Guild rank, plus this week's and this month's rank from XpPeriod.
  3. RECORD. A table with one row per game, columns Played, Won, Lost, Drawn, Assists and a W/L ratio, plus an overall row. Assists only ever appear for hangman today; other games leave it zero.
  4. PRESENCE. Messages sent, reactions given, voice minutes.
  5. ACHIEVEMENTS. Every unlocked entry with its tier AND its earnedBy sentence (that field exists precisely so this section can say HOW it was earned), then the closest two in progress with a bar. Hidden achievements appear only once earned.

RANK MUST BE AN INDEX ONLY COUNT, not a sort of the guild:
  rank = 1 + countDocuments({ guildId, totalXp: { $gt: myTotalXp } })
against the existing { guildId: 1, totalXp: -1 } index. Exact, and fast well past the size this bot will ever see. Do NOT fetch and sort members in application code.

/account must ALSO reconcile the member's reward roles as a side effect once role rewards ship in the next phase. Leave a clearly commented seam for that call now, and write down the reason, because it looks like an odd place for a role write: role rewards are never mass assigned, so an admin who adds a level 10 reward sees nothing happen for existing level 40 members and reads it as broken. Arcane hit this hard enough that they shipped exactly this fix, making the member's own rank command reconcile their roles.

Do NOT put /account into BOT_CONSTANTS.ADMIN_COMMANDS and do NOT give it setDefaultMemberPermissions. It is public, like /leaderboard and /list-events, which are deliberately outside that set because members seeing their own standing is the entire point.

CREATE src/commands/fun/levels.ts
Public, read only. This week, this month, all time. Weekly and monthly read XpPeriod on the current period key; all time reads MemberLevel sorted by totalXp. Same public gating rules as /account.

CREATE src/features/leveling/LevelsBoard.ts
Read src/features/leaderboard/LeaderboardBoard.ts end to end first and copy its structure, invariants and comment discipline. Specifically reuse, do not reinvent:
  - The postOrEdit helper: edit the stored message in place; if the stored message is not authored by this bot, BAIL QUIETLY rather than reposting into a channel you may not own; on DiscordAPIError 10008 (unknown message) or 10003 (unknown channel), fall through and post fresh, updating the stored id; treat 50005 as the foreign author case; on any other error return and let the next trigger retry.
  - The silent bail when the guild has no leaderboardChannelId, because setup has not finished.
  - The silent bail when config.homebaseDestroyed is true.
  - Never throw. Every failure logged and swallowed.
  - The COALESCING throttle from scheduleLeaderboardRefresh: the first event schedules one window out and later events are absorbed with the timer LEFT RUNNING. Read the comment there explaining why this is deliberately not a reset on each call debounce, and preserve that reasoning in yours.

Do not import LeaderboardBoard and do not try to generalize the two into one module. They read different collections, render different embeds and answer different questions. Two clear files beat one abstract one here.

The board renders the top 10 for a configurable window, honoring the guild's weekStart the same way LeaderboardBoard does. EVERY embed you render must carry a one line subtitle saying which question it answers, so a member scrolling the channel is never guessing which board is which.

Refresh triggers, mirroring the existing board: a boot sweep refreshAllLevelsBoards called in src/main.ts beside refreshAllLeaderboards; the hourly safety tick in src/features/reminders/ReminderScheduler.ts, which is what catches a period rolling over with no activity; and a coalesced refresh after a level up.

Do NOT pin the new message. The leaderboard channel is read only so the board stays put without one, and the 2026-06 pinning policy only pins the member writable introductions channel. LeaderboardBoard.ts says this in a comment; match it.

COMMAND DISCOVERABILITY, do not skip this
The pinned member command guide is the ONLY surface that tells a member which commands exist. It ALREADY has a fun command field naming /mini-game and /secret-code, so this is an EDIT to that guide, not a new field.

Add /account, /levels and /achievements to the guide in BOTH src/base/copy/packs/rok-commander.pack.ts AND src/base/copy/packs/general-events.pack.ts.

Read src/base/copy/packs/commandGuide.test.ts BEFORE editing either pack. It already asserts both packs list the SAME command set, by regex extracting every backtick wrapped slash command from each guide and comparing sorted arrays. Editing one pack and forgetting the other is a hard test failure, which is exactly the guard you want. It also asserts Discord's embed limits: at most 25 fields, at most 1024 characters per field value, so prefer extending an existing field over adding three new ones. Extend that test to name the three new commands.

DO NOT
- Do not modify LeaderboardBoard.ts, leaderboardChannelHandlers.ts, or the /leaderboard command. leaderboardWindow.ts is the ONE exception: an earlier phase added periodKey there deliberately, so importing from it is expected and adding to it is allowed, as long as thisWeekRange, thisMonthRange and weekBoundaryTitle keep behaving exactly as they do now.
- Do not touch GuildConfig.leaderboardMessageId.
- Do not create a Discord channel or add a CHANNEL_SPECS entry.
- Do not add /account or /levels to ADMIN_COMMANDS or give them setDefaultMemberPermissions.
- Do not sort the whole guild to compute one member's rank.
- Do not build a separate /rank command.

TESTS
LevelsBoard: post, edit, then a simulated 10008 recovery asserting levelsMessageId is updated and leaderboardMessageId is untouched; a foreign author bails without posting; an empty guild renders the empty state rather than throwing.
account and levels: correct window selection; rank math against a seeded set including a tie; the record table sums correctly across games; a hidden achievement does not appear before it is unlocked.
commandGuide.test.ts: both packs name the three new commands and the existing same command set assertion still passes.

DELIVERABLES
The files above, clean `npx tsc --noEmit`, green `npm test`, and a short report confirming by grep that no file under src/features/leaderboard/ was modified except leaderboardWindow.ts.

ACCEPTANCE
Both boards live in the same channel, each edits only its own message, deleting either one causes only that one to be reposted, and /leaderboard returns byte identical output to before this change.
```

---

### Spell 5: level role rewards

Phase 4. Target: Claude Code in `DeroDiscordBot`.

```
You are working in the DeroDiscordBot repo at C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot. TypeScript, pure ESM, discord.js v14.

GOAL
Grant Discord roles when a member reaches a configured level. This is the single most failure prone part of any leveling bot, and almost all of the failure modes are SILENT, so the error handling below is the actual deliverable, not a footnote.

ALREADY EXISTS:
  GuildConfig.leveling.rewards        array of { level, roleId }
  GuildConfig.leveling.stackRewards   true means keep every reward earned; false means keep ONLY
                                      the highest and remove the rest
  src/features/leveling/awardXp.ts    calls into the level up path
  src/commands/fun/account.ts         has a commented seam waiting for the reconcile call

CREATE src/features/leveling/roleRewards.ts

THE FIVE REFUSAL CONDITIONS
A role is assignable only if ALL of these hold. Write them as one canAssign function with a comment naming each failure mode, because every one produces the same opaque DiscordAPIError 50013 at the API and they are otherwise indistinguishable:
  1. the bot has the ManageRoles permission
  2. the role is not `managed` (integration roles and the Nitro booster role can never be assigned by a bot)
  3. the bot's own highest role sits STRICTLY ABOVE the target role
  4. the role does not carry the Administrator permission
  5. the role does not carry the ManageGuild permission

Condition 3 needs its own comment: this bot ships with the Administrator permission integer, and ADMINISTRATOR DOES NOT BYPASS ROLE HIERARCHY. A reward role dragged above the bot's own role will fail no matter what permissions the bot holds.

Conditions 4 and 5 are a security refusal, not a convenience. A leveling bot handing out Administrator because someone chatted a lot is a security incident, not a bug. Refuse at config time in /setup-level-system with a clear message, AND again here at grant time, because config can be edited directly in Mongo.

ONE ATOMIC WRITE, NOT ADD THEN REMOVE
Compute the FULL desired role set and apply it in a single call:
  start from the member's current roles
  delete every roleId that appears in leveling.rewards, earned or not
  add back every reward the member has now earned, respecting stackRewards, and only those passing canAssign
  await member.roles.set([...desired], `Level ${newLevel}`)

Comment why this is not add() then remove(): sequential calls leave a window where the member holds both roles or neither, and two close level ups can interleave so the removal strips the NEWER role. roles.set is one atomic PATCH, so the window does not exist rather than being guarded against.

THE ERROR TAXONOMY
  50013 Missing Permissions. Hierarchy, a managed role, or a missing permission. DO NOT RETRY, it will never succeed. Log ONCE PER GUILD PLUS ROLE, never once per member, or a large guild floods the Railway logs with the same line thousands of times. Keep a module scoped Set of already reported guild plus role keys.
  10011 Unknown Role. The reward role was deleted. SELF HEAL by removing that entry from GuildConfig.leveling.rewards.
  Anything else. Log and swallow.
  Keep the try/catch even behind a passing precheck: discord.js can report stale role positions, so a hierarchy check can pass and the API call still fail.

NEVER MASS ASSIGN
Do not backfill roles for every member when config changes. Discord does not want it and at ten thousand members it is ten thousand API calls against a per guild bucket. Reconcile in exactly two places:
  1. lazily, on the member's next level up
  2. on demand, when the member runs /account

Wire the /account call into the seam that command already has. Comment WHY, because it looks like an odd place for a role write: without it, an admin who adds a level 10 reward sees nothing happen for existing level 40 members and reports the feature as broken. Arcane shipped this exact fix after enough people hit it. An opt in, rate limited, resumable backfill command is a future item, not this task.

HOUSE RULES
- Pure ESM, .js suffix on every local import.
- Verification is `npx tsc --noEmit`. NEVER run npm run build, tsc-alias, npm run deploy, or npm install.
- Tests colocated, Vitest, `npm test` is a single run.
- No dashes in user facing copy.
- The reconcile call is FIRE AND FORGET at every call site. A failed role grant must never break a level up announcement or an /account reply.
- Comment non trivial logic covering what, who, when, where, how.

TESTS, roleRewards.test.ts
Split the pure part from the Discord part the way this repo splits duelResolve from duelHandler: the desired set computation takes current roles, the reward config and the new level and returns a role id array, with no discord.js in sight, so the interesting logic is trivially testable.
Pin: desired set under stack true and stack false; a role above the bot excluded and reported; a managed role excluded; an Administrator role excluded; a ManageGuild role excluded; 10011 removing the config entry; 50013 not retrying and logging exactly once for a repeated guild plus role.

DO NOT
- Do not grant a role carrying Administrator or Manage Server, under any configuration.
- Do not use add() then remove().
- Do not retry a 50013.
- Do not log a role failure once per member.
- Do not mass assign or backfill.
- Do not throw out of the reconcile function.

DELIVERABLES
roleRewards.ts and its test, the wiring into the level up path and into /account, the config time refusal in /setup-level-system, clean `npx tsc --noEmit`, green `npm test`.

ACCEPTANCE
Crossing a configured level produces exactly the right role set in one API call. A reward role positioned above the bot's role logs once, does not retry, and does not break the level up announcement or the /account reply.
```

---

### Spell 6: the achievement engine

Phase 4. Target: Claude Code in `DeroDiscordBot`.

```
You are working in the DeroDiscordBot repo at C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot. TypeScript, pure ESM, discord.js v14, Mongoose.

GOAL
Add a tiered achievement system on top of the leveling feature. Achievements unlock from counters the XP writer ALREADY maintains, so this must add ZERO new listeners and ZERO new writes on the message path.

Context worth knowing: Arcane, the bot this feature is modelled on, has NO achievements system at all. The word does not appear anywhere in their documentation, command list or premium table. The model below is MEE6's Achievements plugin, which the owner specifically asked for, plus one thing nobody in the category ships.

ALREADY EXISTS, use it and do not add to it:
  src/db/models/MemberLevel.ts   messages, reactionsGiven, voiceMinutes, a `games` map of per game
                                 { played, won, lost, drawn, assists }, and
                                 unlocked: [{ id, tier, at, earnedBy }]
  src/features/leveling/awardXp.ts
  src/features/leveling/primeLevels.ts   isMilestone(level)
  the flush path in src/features/leveling/xpWriter.ts

CREATE src/features/leveling/achievements.ts
A frozen definitions array, defined in CODE, not in the database. This follows how src/features/fortune/fortunes.ts and src/features/games/hangmanWords.ts already hold their content. Admin authored achievements are explicitly out of scope.

Definition shape:
  id          stable string, NEVER change one after release; the unlocked array stores it
  category    "messages" | "reactions" | "voice" | "games" | "levels" | "special"
  metric      "messages" | "reactionsGiven" | "voiceMinutes" | "fortuneReadings" |
              "gamesPlayed" | "gamesWon" | "assists" | "level" | "milestoneLevels" | "<game>.won"
  tiers       four entries named bronze, silver, gold, diamond, each { threshold, xp }
  hidden      boolean
  roleId      optional, granted on the top tier only
  earnedBy    a function of the tier returning the human sentence stored on unlock

EVERY TIER THRESHOLD IS A PRIME NUMBER. That is a deliberate design signature of this system: prime numbers are also the milestone levels. Do not round them to 50 / 250 / 1000 / 5000.

Ship these twelve tracks exactly:
  voice-of-the-realm  messages        messages         53 / 251 / 1009 / 5003   visible
  the-applause        reactions       reactionsGiven   29 / 101 / 503 / 2003    visible
  round-table         voice           voiceMinutes     61 / 251 / 1009 / 3001   visible
  contender           games           gamesPlayed      11 / 41 / 151 / 503      visible
  champion            games           gamesWon         5 / 23 / 101 / 251       visible
  duelist             games           duel.won         3 / 17 / 71 / 199        visible
  strategist          games           rps.won          3 / 17 / 71 / 199        visible
  wordsmith           games           hangman.won      3 / 13 / 53 / 151        visible
  ascendant           levels          level            7 / 23 / 47 / 89         visible
  prime-mover         special         milestoneLevels  5 / 11 / 19 / 31         HIDDEN
  the-assist          games           assists          7 / 29 / 101 / 251       HIDDEN
  dero-knows          special         fortuneReadings  13 / 53 / 199 / 601      HIDDEN

Tier XP rewards scale with the tier; use prime values there too (roughly 101 / 307 / 1013 / 3001).

Hidden achievements are the differentiator and they are nearly free given this schema. Nobody in the category ships designer hidden entries: MEE6 has none, and the dedicated Achievements bot only offers user controlled privacy, which is a different thing. A hidden achievement does not appear in /achievements AT ALL until it unlocks, not even as a locked placeholder.

`prime-mover` is the one that ties the system together: it is hidden, and it rewards reaching PRIME levels, which a member only discovers by hitting a few and noticing the pattern. Get this one right.

CREATE src/features/leveling/achievementEngine.ts
ONE pure function. No discord.js, no store, no mutable module state:
  evaluate(counters, unlockedIds) -> newly unlocked entries

It must be IDEMPOTENT: an id and tier already present in unlockedIds is never emitted again, however the counters move. Crossing two tiers in one pass emits both, in tier order.

THE RECURSION TRAP, this is the one thing that will break if you get it wrong
An unlock grants XP. XP can cause a level up. A level up changes the "level" and "milestoneLevels" metrics. If the engine runs from inside an unlock, that is a loop.

The rule: the engine is called ONLY from the flush path in xpWriter, once per flushed member per flush, and NEVER from inside an unlock handler. XP granted by an unlock is STAGED into the NEXT flush window exactly like any other award, using awardXp with source "achievement". Combined with idempotency, that makes the loop impossible rather than merely unlikely. Write this reasoning into a comment at the top of the module, because it is not obvious from the code and the natural instinct is to evaluate immediately.

UNLOCK SIDE EFFECTS, all fire and forget after the primary write
  $addToSet onto MemberLevel.unlocked with { id, tier, at, earnedBy }. Never a read modify write.
  COMPOSE the earnedBy sentence AT UNLOCK TIME ("sent 251 messages", "reached 11 milestone levels"),
    because /account shows HOW an achievement was earned and the counters will have moved on.
  stage the tier's XP through awardXp with source "achievement"
  grant the optional role through roleRewards, REUSING its canAssign checks rather than writing new ones
  announce the unlock, with allowedMentions parse empty like every other leveling message

CREATE src/commands/fun/achievements.ts
Public and read only. Do NOT add it to BOT_CONSTANTS.ADMIN_COMMANDS and do not give it setDefaultMemberPermissions.
Shows unlocked achievements with their tier AND their earnedBy sentence, in progress achievements with a progress bar toward the next tier, and OMITS hidden achievements entirely until they unlock. A hidden achievement that HAS unlocked shows normally.

HOUSE RULES
- Pure ESM, .js suffix on every local import.
- Verification is `npx tsc --noEmit`. NEVER run npm run build, tsc-alias, npm run deploy, or npm install.
- Tests colocated, Vitest, `npm test` is a single run.
- No dashes in user facing copy. Achievement names and descriptions live in the definitions file or levelingCopy.ts, never inline in a handler.
- Comment non trivial logic covering what, who, when, where, how.

TESTS, achievementEngine.test.ts
Every threshold exactly at, one under, one over. An already unlocked id and tier never re emitted. Crossing two tiers in one evaluation emits both in order. Hidden entries excluded from the listing but NOT from evaluation. A tier's XP reward does not trigger a second unlock inside the same pass. prime-mover counts milestone levels using primeLevels.isMilestone and not a hardcoded list.

DO NOT
- Do not add a listener. Every metric already exists as a counter on MemberLevel.
- Do not add a database write to the message path.
- Do not evaluate from inside an unlock handler.
- Do not store achievement definitions in Mongo.
- Do not change an achievement id after release.
- Do not use a read modify write on the unlocked array. Use $addToSet.
- Do not show a hidden achievement before it unlocks, not even as a locked placeholder with a hidden name.
- Do not round the prime thresholds.

DELIVERABLES
achievements.ts, achievementEngine.ts, achievementEngine.test.ts, the /achievements command, the flush path wiring, clean `npx tsc --noEmit`, green `npm test`.

ACCEPTANCE
Crossing a threshold unlocks exactly one tier, its XP lands in the NEXT flush rather than the current one, no second unlock fires in the same pass, /achievements never reveals a hidden entry before it is earned, and every unlocked entry can state how it was earned.
```
---

### Spell 7: blackjack

Phase 6. Target: Claude Code in `DeroDiscordBot`.

```
You are working in the DeroDiscordBot repo at C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot. TypeScript, pure ESM, discord.js v14, Mongoose, Railway.

GOAL
Add blackjack as a fifth /mini-game subcommand: one player against the dealer, earning XP and a win/loss record through the existing leveling system.

WHY THIS ONE IS FIRST OF THE THREE NEW GAMES
Hit, Stand, Double, Split and Insurance is EXACTLY five buttons, which is exactly one Discord action row. The dealer's hole card is secret from EVERYONE, so there is no per player private view and therefore none of the interaction token problems that shape battleship and poker. One player means no turn queue and no idle player timeout. It needs no game room. It is the cheapest possible proof of the "add a game" path, so get the pattern right here and the other two inherit it.

ALREADY EXISTS, use it and do not rebuild it:
  src/commands/fun/mini-game.ts        MINI_GAME_HANDLERS table + addSubcommand builder.
                                       Its `data` export is deliberately UNANNOTATED because
                                       .addSubcommand() narrows the builder type. Do not annotate it,
                                       do not cast to any, do not cast to SlashCommandBuilder.
  src/features/games/gamesCopy.ts      feature local copy, deliberately NOT routed through the
                                       two voice packs. Read its header comment and follow it.
  src/features/games/gamesEmbeds.ts    embed builders that do NOT call embedBuilder.base()
  src/features/games/gamesAssets.ts    resolveGameAsset(key) -> { ref, attachment }
  src/base/copy/brand.ts               COLORS, already holds GAME_DUEL / GAME_RPS / GAME_HANGMAN
  src/utils/cooldownManager.ts         CooldownManager; check() does NOT record, callers record()
                                       only after success
  src/features/leveling/awardXp.ts     awardXp({ ..., source: "game", game, outcome })
                                       NEVER throws. game + outcome maintains the win/loss record.

HOUSE RULES
- Pure ESM, .js suffix on every local import. Aliases @utils/* @base/* @features/* @commands/* @db/* @handlers/*.
- Verification is `npx tsc --noEmit`. NEVER run npm run build, tsc-alias, npm run deploy, or npm install.
- Tests colocated as foo.test.ts, Vitest, `npm test` is a SINGLE run. `npm run test:run` and `npm run test:coverage` do not exist.
- No dashes in user facing copy. Hyphens in slash command identifiers are identifiers, not dashes.
- Split PURE resolution from the Discord handler, exactly the way src/features/games/duelResolve.ts splits from duelHandler.ts and rpsWinner.ts from rpsHandler.ts. The pure half has no discord.js import, no I/O, no mutable module state, and an INJECTABLE rng so tests pin the shuffle.
- Comment non trivial logic covering what, who, when, where, how.

STEP 1: CARD ASSETS, do this properly because Phase 8 reuses it
Upload a 52 card deck plus a card back as APPLICATION EMOJIS, not guild emojis.

This is the right primitive and the reasoning belongs in a comment: an application can own 2000 emojis, they render in EVERY server the bot is in, and USE_EXTERNAL_EMOJIS is NOT required to use them. Guild emojis cap at 50 at base tier and 250 at level 3, nowhere near a deck, and would have to be uploaded per server by each admin. Canvas generated PNGs mean a fresh file upload on every single redraw, which for a hand edited several times per round is the expensive choice.

Record the emoji ids in a frozen map in a new src/features/games/cardAssets.ts keyed by rank and suit. Do NOT use the Unicode playing card block (U+1F0A0 and up): nothing authoritative documents how Discord renders those, they are monochrome text glyphs rather than emoji, and they will look broken on some platforms.

STEP 2: CREATE src/features/games/blackjackState.ts and blackjackState.test.ts
Pure. Everything interesting lives here:
  - a shoe with a seeded, injectable shuffle
  - hand value with SOFT and HARD ace handling (an ace is 11 until that would bust, then 1)
  - dealer policy, stand on soft 17 by default and configurable
  - resolve(playerHand, dealerHand) -> "win" | "lose" | "push" | "blackjack"
  - split support: splitting turns one hand into two, so the state carries an array of hands and an active hand index

The ace and split cases are the only genuinely tricky part of blackjack and they are exactly the sort of thing this repo already pins hard in hangmanState.test.ts. Test: a soft 17 versus a hard 17; A + A + 9; a natural blackjack versus a 21 made from three cards (a natural wins, a 21 pushes); doubling on a split hand; the dealer drawing to exactly 17; shoe exhaustion mid hand.

STEP 3: CREATE src/features/games/blackjackHandler.ts
The thin Discord half. It reads options, gates spam, renders, and delegates every decision to blackjackState.

  - ONE action row: Hit, Stand, Double, Split, Insurance. Exactly five buttons is exactly the per row limit, which is why this game fits so cleanly. Disable the buttons that are illegal in the current state rather than erroring on click.
  - The hand lives on ONE public bot channel message, EDITED on every action. A normal channel message the bot posted has NO edit time limit, unlike an interaction response, so this is the durable surface.
  - The dealer's hole card is simply not rendered until the reveal. No privacy mechanism is needed at all, because it is secret from everyone including the player.
  - Its OWN CooldownManager instance. Do NOT share one with another game: a shared cooldown would mean starting a blackjack hand blocks a fortune reading, which is a behavior regression on a shipped feature.
  - A round timeout that resolves the hand rather than leaving it open forever.

STEP 4: WIRE IT
  - one COLORS key in brand.ts, distinct from every existing key
  - copy in gamesCopy.ts under a `blackjack` object, following the shape of the `duel` and `hangman` objects there
  - art registered in gamesAssets.ts
  - ONE entry in MINI_GAME_HANDLERS and ONE .addSubcommand() in mini-game.ts. That is the entire command surface change; the earlier merge to subcommands already did the hard part. mini-game.test.ts asserts every declared subcommand has a handler and every handler is declared, both directions, so forgetting either half fails the suite.
  - awardXp on hand resolution: play XP always, win XP on a win, half on a push, a small bonus on a natural. game "blackjack", outcome "won" / "lost" / "drawn". Amounts live in BOT_CONSTANTS.LEVELING, never inline.

DO NOT
- Do not add stakes, chips, a wager or any currency. v1 rewards XP and the /account record only. This keeps blackjack entirely clear of the gambling economy question, which is deliberately deferred to the poker phase and answered there with per tournament chips.
- Do not build multiplayer at one table. No surveyed Discord blackjack implements it, and it degenerates into a turn queue on a public message plus a per player timeout for no new mechanic.
- Do not use ephemeral messages for the hand. There is no secret to protect.
- Do not use the Unicode playing card block.
- Do not annotate the `data` export in mini-game.ts.
- Do not touch src/commands/events/eightBall.ts, poll.ts, rps.ts or sun-qoute.ts. Those are dead, fully commented out, pre slash command stubs. Never revive them.
- Do not route blackjack copy through either voice pack.

DELIVERABLES
cardAssets.ts, blackjackState.ts + test, blackjackHandler.ts, the wiring above, clean `npx tsc --noEmit`, green `npm test`.

ACCEPTANCE
A full hand plays out including a split and a double; the dealer hole card is never visible before the reveal in any surface; every ace case in the tests is correct; /account shows a blackjack row with the right win, loss and push counts.
```

---

### Spell 8: battleship

Phase 7. Target: Claude Code in `DeroDiscordBot`. Requires the game rooms release.

```
You are working in the DeroDiscordBot repo at C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot. TypeScript, pure ESM, discord.js v14, Mongoose, Railway.

GOAL
Add battleship as a /mini-game subcommand: two players, fleet placement, turn based firing, played inside a game room, earning XP through the existing leveling system.

READ THIS FIRST. TWO PLATFORM LIMITS DECIDE THE ENTIRE DESIGN, AND BOTH ARE NON NEGOTIABLE.

LIMIT ONE: 25 BUTTONS PER MESSAGE. A Discord message allows 5 action rows of 5 buttons. A 10 by 10 battleship grid is 100 cells. THERE IS NO VERSION OF THIS WHERE THE GRID IS A BUTTON GRID. Components V2 raises the budget to 40 total components, roughly 30 buttons, which is still nowhere near 100. Do not attempt a paged button grid either; a 5 by 5 quadrant of buttons consumes all five rows and leaves no room for the quadrant switcher.

  THE INPUT IS TWO STRING SELECT MENUS: a column select with options A through J, and a row select with options 1 through 10. A string select allows 25 options, so ten is comfortable, and each select occupies one action row. A third row carries Fire, View my board, and Forfeit. No typing, works on mobile, no modal round trip.

  Worth knowing: no open source Discord battleship appears to do it this way. The field runs on reactions, typed coordinates, emoji grid embeds, and DMs or private channels, most of it predating the components API. This approach is a small original contribution, so comment the reasoning where the selects are built.

LIMIT TWO: AN INTERACTION TOKEN LIVES 15 MINUTES AND CANNOT BE RENEWED. After 15 minutes, editReply and followUp return HTTP 401 with error code 50027, forever. There is no refresh mechanism. A battleship match runs longer than that.

  BUT: every button click and every select choice is a NEW interaction with its OWN fresh token and its own fresh 15 minutes. And a NORMAL CHANNEL MESSAGE the bot posted itself has NO edit time limit at all.

  So the architecture is forced, and it is the right one:
    - the PUBLIC BOARD is a normal bot channel message, edited every turn, for the whole match. No time limit.
    - the PRIVATE BOARD is delivered ONLY on the member's own click, using THAT click's token, as an ephemeral reply.
  NOTHING may depend on the bot spontaneously pushing an update into a private view. If you find yourself wanting to, you have designed something that silently breaks after 15 minutes.

ALREADY EXISTS, use it and do not rebuild it:
  src/features/games/challengeFlow.ts    issueChallenge({ interaction, opponent, kind, gameLabel })
                                         with an inline component collector. REUSE THIS. Do not
                                         write a second challenge handshake. Its exported
                                         ChallengeKind union is "duel" | "rps" today, so widen it
                                         to include "battleship". That is the ONLY change that
                                         file needs.
  src/features/game-rooms/roomTypes.ts   GAME_SLUGS, ROOM_STATUSES, RoomMove, RoomSecret
  src/db/models/GameRoom.ts              playerIds, winnerId, status, secret, moves
  src/features/game-rooms/roomLifecycle  the finish path, which already awards game room XP
  src/features/games/gamesCopy.ts, gamesEmbeds.ts, gamesAssets.ts
  src/features/leveling/awardXp.ts

HOUSE RULES
- Pure ESM, .js suffix on every local import.
- Verification is `npx tsc --noEmit`. NEVER run npm run build, tsc-alias, npm run deploy, or npm install.
- Tests colocated, Vitest, `npm test` is a SINGLE run.
- No dashes in user facing copy.
- Split PURE state from the Discord handler, the way duelResolve splits from duelHandler and hangmanState from hangmanHandler. Injectable rng.
- Comment non trivial logic covering what, who, when, where, how.

CREATE src/features/games/battleshipState.ts and battleshipState.test.ts
Pure. Two 10 by 10 grids, fleet definitions (carrier 5, battleship 4, cruiser 3, submarine 3, destroyer 2), placement, and:
  applyShot(state, playerId, coord) -> "hit" | "miss" | "sunk" | "invalid" | "repeat"
  isFleetDestroyed(state, playerId) -> boolean
  autoPlace(rng) -> a legal fleet layout
No discord.js, no I/O, no module state. Test: every applyShot outcome including repeat and out of bounds; auto placement never overlaps, never runs off the grid, and places every ship exactly once; isFleetDestroyed is false until the true final hit.

PLACEMENT
v1 is AUTO PLACEMENT with a Reroll button. Manual placement is a second full coordinate UI for a fraction of the value and is deliberately deferred to a future item. Say so in a comment so it does not read as an oversight.

BOARD RENDERING, and a trap that will bite you
Render the grid as UNICODE emoji tiles, and put it in an EMBED DESCRIPTION, not in message content.

The trap: a CUSTOM emoji serializes as roughly 25 characters (<:name:1234567890123456789>), so a 10 by 10 grid of custom emoji is about 2,500 characters and OVERFLOWS Discord's 2000 character message content limit. An embed description allows 4096. Unicode emoji are a few bytes each and fit either way. Use Unicode tiles for the grid; if you want custom art, it goes on the result card, not in the grid.

The public board shows the OPPONENT FACING view only: hits, misses and sunk ships. It must never show an unfired ship position, in the board, in the embed, in a log line, in a custom_id, or in the room transcript. Note also that custom_id is capped at 100 characters, so encode a room id and a coordinate, never serialized state.

PRIVATE BOARD
A "View my board" button on the public message. The click mints a fresh token and replies EPHEMERALLY with that player's own fleet and the incoming fire against it. Pull based, per the token limit above.

Do NOT use a private text channel per player: that is two extra channels per match against a 500 channel per server cap, on top of the game room's own channel, and the game rooms feature already caps concurrent rooms because of channel pressure.
Do NOT use DMs: a member can have DMs closed, you get error 50007 with no recourse, and Discord explicitly warns that opening many DM channels quickly can get a bot rate limited or blocked. The mini games plan already ruled DMs out for rps; that ruling extends here.

GAME ROOM INTEGRATION
Add "battleship" to GAME_SLUGS in roomTypes.ts and wire the room lifecycle. A match runs long and produces a long transcript, so it belongs in its own channel. The room's finish path already awards game room XP; your job is to report the winner into it.

TIMEOUTS
A per turn clock. On expiry, forfeit the TURN. After two consecutive expiries, forfeit the MATCH. A room that never terminates is a room the archive sweep never reclaims, and the sweep is what keeps a guild clear of Discord's 50 channels per category limit.

XP
Play XP to both players, win XP to the winner, and a small per sink bonus so a losing player who fought still earns something. Amounts in BOT_CONSTANTS.LEVELING, never inline. game "battleship", outcome "won" / "lost".

WIRE IT
One COLORS key, copy in gamesCopy.ts, art in gamesAssets.ts, one MINI_GAME_HANDLERS entry, one addSubcommand. mini-game.test.ts asserts both directions, so forgetting either half fails the suite. Leave the `data` export UNANNOTATED.

DO NOT
- Do not build a button grid for the board, paged or otherwise.
- Do not depend on the bot pushing an update into a private view.
- Do not put the grid in message content.
- Do not use DMs or a private channel per player.
- Do not leak an unfired ship position into any surface, including the persisted room transcript.
- Do not write a second challenge handshake; reuse issueChallenge.
- Do not let a match run without a turn clock.
- Do not annotate the `data` export.

DELIVERABLES
battleshipState.ts + test, battleshipHandler.ts, the GAME_SLUGS and room lifecycle wiring, the command wiring, clean `npx tsc --noEmit`, green `npm test`.

ACCEPTANCE
A full match completes inside a game room; neither player can see the other's unfired ships in ANY surface including the transcript; a player who walks away is forfeited rather than freezing the room; the room archives normally; the private board still works 40 minutes into a match.
```

---

### Spell 9: texas hold em

Phase 8. Target: Claude Code in `DeroDiscordBot`. Requires the game rooms release, and Phase 6's card assets.

```
You are working in the DeroDiscordBot repo at C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot. TypeScript, pure ESM, discord.js v14, Mongoose, Railway.

GOAL
Add texas hold em as a /mini-game subcommand: 2 to 6 players, tournament chip stacks, blinds, four betting rounds, played inside a game room, earning XP through the existing leveling system.

This is the largest of the three games and the last to ship. Three things below are load bearing and everything else is ordinary work.

LOAD BEARING ONE: CHIPS ARE PER TOURNAMENT, NOT A SERVER CURRENCY.
Everyone buys in for the same stack when the table opens, chips exist only inside that tournament, and NOTHING survives the table. No persistent balance, no transfers, no purchase, no cross table carry.

This is the decision that makes hold em buildable at all. A persistent chip balance is an economy system, a gambling moderation surface and a whole separate design problem. The production Texas Hold'Em Poker bot uses exactly this tournament stack model. Do not add a persistent balance, do not add a daily bonus, do not add a shop, and if you find yourself wanting a Currency model, stop: that is a different feature and a different decision.

LOAD BEARING TWO: HOLE CARDS ARE DELIVERED BY A "SHOW CARDS" BUTTON, CLICKED ONCE PER HAND.
An interaction token lives 15 MINUTES and cannot be renewed; after that editReply and followUp return HTTP 401 with error 50027, forever. A tournament runs far longer. But every button click is a NEW interaction with a fresh token, and a normal channel message the bot posted has NO edit limit.

So: the table state is a normal bot channel message edited for the whole hand, and each player's hole cards are delivered ephemerally on THEIR OWN CLICK of a Show cards button, once per hand. The production bot ships exactly this and states the reason in its own public listing: "Due to discord limitations regarding ephemeral responses, every player must click on this button at the start of each hand in order to view their cards."

Do not try to be cleverer than that. Do NOT use DMs: a member can have DMs closed, you get error 50007 with no recourse, and Discord warns against opening many DM channels quickly. Do NOT try to push an update into a player's ephemeral view.

LOAD BEARING THREE: SIDE POTS ARE THE PART MOST LIKELY TO BE QUIETLY WRONG.
The moment two players are all in for different amounts, correctness requires main and side pot construction. NO surveyed Discord implementation documents handling them, which means there is no reference to check against, and the failure mode is a player being paid the wrong amount in a situation that only arises when someone is all in.

So side pots get their OWN pure module and their OWN scenario test suite, written by hand, not discovered through play testing.

ALREADY EXISTS, use it and do not rebuild it:
  src/features/games/cardAssets.ts       the 52 card APPLICATION emoji map from the blackjack phase
  src/features/game-rooms/roomTypes.ts   GAME_SLUGS, ROOM_STATUSES, RoomMove
  src/db/models/GameRoom.ts              playerIds, winnerId, status, moves
  src/features/game-rooms/roomLifecycle  the finish path
  src/features/games/gamesCopy.ts, gamesEmbeds.ts, gamesAssets.ts
  src/features/leveling/awardXp.ts

HOUSE RULES
- Pure ESM, .js suffix on every local import.
- Verification is `npx tsc --noEmit`. NEVER run npm run build, tsc-alias, npm run deploy, or npm install.
- Tests colocated, Vitest, `npm test` is a SINGLE run.
- No dashes in user facing copy.
- PURE modules carry no discord.js import, no I/O, no mutable module state, and an injectable rng. Same discipline as duelResolve.ts and hangmanState.ts.
- Comment non trivial logic covering what, who, when, where, how.

CREATE THREE PURE MODULES, because this is where correctness lives

1. src/features/games/holdemHand.ts + test
   Best five of seven evaluation and comparison. Table driven. Test EVERY hand class and EVERY tie break: high card down to the fifth kicker, one pair with three kickers, two pair with a kicker, trips, the WHEEL straight (A2345), straight flush, the royal, quads with a kicker, and exact ties that split the pot. This module is exhaustively testable and there is no excuse for a gap.

2. src/features/games/holdemBetting.ts + test
   The betting round state machine: whose turn it is, which actions are legal from that position, what a legal raise size is, when the round closes, blind posting, and the rule that a SHORT ALL IN does not reopen the betting for players who have already acted. Test each.

3. src/features/games/holdemPots.ts + test
   Main and side pot construction from per player commitments. SCENARIO TESTS, hand written:
     - two players all in for different amounts, a third calls the larger
     - three players all in for three different amounts
     - a folded player's chips are dead money in the main pot
     - an uncalled bet is returned to the bettor rather than entering a pot
     - a split pot with an odd chip
   Assume nothing. There is no public reference implementation to check against.

CREATE src/features/games/holdemHandler.ts
  - Open with /mini-game holdem, then a join window with a Buy in button, mirroring the production bot's short window.
  - Table of 2 to 6 players.
  - Betting UI: [Show cards] [Check/Call] [Bet/Raise] [Fold] [Quit] is EXACTLY five buttons, which is exactly one action row. Raise sizing is a SECOND row of PRESET sizes (min, half pot, pot, two times pot, all in), not a modal. A second row of five buttons is one click; a modal is a round trip, and modals cannot be chained anyway.
  - Disable illegal actions rather than erroring on click.
  - A per turn clock of 15 to 60 seconds, default 30, that FORCE FOLDS on expiry. Force fold, never pause. A table waiting on a member who closed Discord is a table that never ends, and the game rooms archive sweep depends on rooms terminating.
  - Blind escalation on a pace setting so a tournament converges rather than running all night.
  - The table message is a NORMAL bot channel message, edited per action. Batch state into ONE edit per turn; do not animate card by card, because every edit queues against a per channel rate limit bucket and a redraw loop will visibly stall.

GAME ROOM INTEGRATION
Add "holdem" to GAME_SLUGS in roomTypes.ts and wire the room lifecycle. Six players over 45 plus minutes with a long transcript is exactly what game rooms exist for.

XP
Play XP per hand contested, win XP per hand won, plus a placement bonus at tournament end scaled by finishing position. Amounts in BOT_CONSTANTS.LEVELING, never inline. game "holdem", outcome "won" / "lost".

WIRE IT
One COLORS key, copy in gamesCopy.ts, art in gamesAssets.ts, one MINI_GAME_HANDLERS entry, one addSubcommand. Leave the `data` export UNANNOTATED. Note the 25 option ceiling per command: four existing games plus blackjack, battleship and holdem is seven subcommands, comfortably inside it.

DO NOT
- Do not add a persistent chip balance, a currency model, a daily bonus, transfers or a shop.
- Do not use DMs for hole cards.
- Do not push an update into a player's private view.
- Do not use a modal for raise sizing.
- Do not let a table pause indefinitely on an idle player.
- Do not ship side pots without the scenario tests.
- Do not animate the board with many small edits.
- Do not annotate the `data` export.

DELIVERABLES
holdemHand.ts, holdemBetting.ts, holdemPots.ts each with a test file, holdemHandler.ts, the GAME_SLUGS and room lifecycle wiring, the command wiring, clean `npx tsc --noEmit`, green `npm test`.

ACCEPTANCE
A six player tournament runs to a single winner; a three way all in for three different amounts produces correct main and side pots, PROVEN BY TEST not by play; a player who closes Discord is force folded and the table continues; no chip state survives the tournament; a player can still see their hole cards in hand 20, an hour into the game.
```

---

## SOURCES

**Codebase, read directly on 2026-08-10:**
`DeroDiscordBot/CLAUDE.md` · `src/main.ts` (intents lines 60 to 85, the MessageContent comment 67 to 72, `gracefulShutdown` and its `SIGTERM` / `SIGINT` registration, listener registration, boot sweeps) · `src/features/activity-tracking/ActivityTracker.ts`, `activity.types.ts`, `ParticipationStore.ts` · `src/db/models/PlayerActivity.ts`, `GuildConfig.ts`, `GameRoom.ts` · `src/db/stores/activityStore.ts`, `gameRoomStore.ts` · `src/features/leaderboard/LeaderboardBoard.ts`, `leaderboardWindow.ts`, `leaderboardChannelHandlers.ts` · `src/features/games/` (`duelHandler.ts`, `duelResolve.ts`, `rpsWinner.ts`, `rpsHandler.ts`, `hangmanHandler.ts`, `hangmanState.ts`, `challengeFlow.ts`, `gamesCopy.ts`, `gamesEmbeds.ts`, `gamesAssets.ts`) · `src/features/game-rooms/roomTypes.ts` · `src/features/entitlements/gameRoomAccess.ts` · `src/features/early-access/earlyAccess.ts` · `src/features/power-ups/PowerUps.ts` · `src/features/suggestion-box/SuggestionBox.ts` · `src/features/announcements/postFeatureAnnouncement.ts` · `src/features/fortune/fortuneCopy.ts` · `src/base/copy/brand.ts`, `getCopy.ts`, `packs/commandGuide.test.ts` · `src/base/constants/BOT_CONSTANTS.ts` · `src/utils/cooldownManager.ts`, `permissions.ts` · `src/commands/fun/mini-game.ts` · `src/commands/admin/leaderboard.ts`, `configure-leaderboard-tracking.ts` · `src/commands/events/rps.ts` (confirmed fully commented out) · `package.json` · `SACRED_FILES/2026-08/FUTURE_PLANS*.md` and `STATE.md` (grepped for XP, leveling, achievement, rank card; zero hits, T15)

**Project memory:** `project_dero_bot_minigames_master_plan_2026_08_07` · `project_dero_minigames_command_merge_2026_08_07` · `project_dero_game_rooms_2026_08_10` · `project_dero_bot_minigames_audit_2026_08_07` · `reference_bot_release_announcement_flow`

**Arcane's own documentation:** [docs home](https://docs.arcane.bot/) · [Leveling](https://docs.arcane.bot/plugins/leveling/) · [XP Options, the published curve formulas](https://docs.arcane.bot/plugins/leveling/setup/xp-options) · [Levelup Message](https://docs.arcane.bot/plugins/leveling/setup/levelup-message) · [Role Rewards](https://docs.arcane.bot/plugins/leveling/setup/role-rewards) · [XP Boosters](https://docs.arcane.bot/plugins/leveling/setup/xp-boosters) · [XP Restrictions, the DANGER banner](https://docs.arcane.bot/plugins/leveling/setup/restrictions) · [Highlights](https://docs.arcane.bot/plugins/leveling/setup/highlights) · [Debugging, the unfixed weekly reset bug](https://docs.arcane.bot/plugins/leveling/debugging) · [Rank Card](https://docs.arcane.bot/plugins/leveling/card) · [XP Management](https://docs.arcane.bot/plugins/leveling/management) · [Premium feature table](https://docs.arcane.bot/premium) · [FAQ](https://docs.arcane.bot/frequently-asked-questions) · changelogs [1-29-2025](https://docs.arcane.bot/changelogs/1-29-2025/), [6-30-2025](https://docs.arcane.bot/changelogs/6-30-2025/), [7-28-2025](https://docs.arcane.bot/changelogs/7-28-2025/), [9-2-2025](https://docs.arcane.bot/changelogs/9-2-2025/)

**Competitors, curves and achievements:** [MEE6 XP formula](https://github.com/Mee6/Mee6-documentation/blob/master/docs/levels_xp.md) · [MEE6 Levels wiki](https://wiki.mee6.xyz/en/plugins/levels) · [MEE6 Achievements wiki](https://wiki.mee6.xyz/en/plugins/achievements) · [Lurkr leveling speed](https://lurkr.gg/docs/guides/customize-leveling-speed) · [Lurkr multipliers](https://lurkr.gg/docs/guides/setting-up-leveling-multipliers) · [Lurkr imports](https://lurkr.gg/docs/guides/importing-levels-from-other-bots) · [Amari message and voice XP](https://docs.amaribot.com/features/message-voice-xp) · [Tatsu leveling](https://tatsu.gg/leveling) · [Achievements bot](https://top.gg/bot/764668440857804801) · [Atom's Arcane import guide](https://docs.leveling.gg/src/faq/arcane_import)

**Failure modes and technique:** [Exporting data from Arcane Bot](https://blog.aspy.dev/exporting-data-from-arcane-bot/) · [Are Arcane imports possible](https://www.answeroverflow.com/m/1375889447949697124) · [XP leveling setup practice](https://peakbot.pro/blog/discord-xp-leveling-system-setup) · [Why your bot will not assign roles](https://peakbot.pro/blog/why-discord-bot-wont-assign-roles) · [discord.js roles guide](https://github.com/AnIdiotsGuide/discordjs-bot-guide/blob/master/understanding/roles.md) · [discord.js stale role positions, issue 3286](https://github.com/discordjs/discord.js/issues/3286) · [mongoose upsert E11000, issue 7183](https://github.com/Automattic/mongoose/issues/7183) · [Ranked leaderboards with MongoDB aggregation](https://hjr265.me/blog/making-ranked-leaderboards-with-mongodb-aggregation-framework/) · [MrAugu/discord-xp](https://github.com/MrAugu/discord-xp) · [Discord XP farmer](https://github.com/facepunchh/Discord-XP-farmer)

**Discord platform limits, verified 2026-08-10:** [Component reference, 5 rows, 5 buttons, 25 select options, 100 char custom_id, Components V2 and its 40 component budget](https://docs.discord.com/developers/components/reference) · [Receiving and responding, the 3 second initial response and the 15 minute token](https://docs.discord.com/developers/interactions/receiving-and-responding) · [Opcodes and status codes, 50027 invalid webhook token and 50007 cannot send messages to this user](https://docs.discord.com/developers/topics/opcodes-and-status-codes) · [Message resource, the 2000 character content limit and 4096 character embed description](https://docs.discord.com/developers/resources/message) · [Emoji resource, 2000 application emojis with no USE_EXTERNAL_EMOJIS requirement](https://docs.discord.com/developers/resources/emoji) · [Create DM and its "DMs should generally be initiated by a user action" warning](https://docs.discord.com/developers/resources/user#create-dm) · [Rate limits, per channel buckets and the 10,000 invalid requests per 10 minutes ban](https://docs.discord.com/developers/topics/rate-limits) · [Threads](https://docs.discord.com/developers/topics/threads) · [Server caps, 500 channels](https://support.discord.com/hc/en-us/articles/33694251638295-Discord-Account-Caps-Server-Caps-and-More) · [discord.js action rows](https://discordjs.guide/legacy/interactive-components/action-rows) · [discord.js display components](https://discordjs.guide/popular-topics/display-components) · [discord.js modals](https://discordjs.guide/legacy/interactions/modals) · [discord.js issue 8335, invalid webhook token on editReply](https://github.com/discordjs/discord.js/issues/8335) · [ephemeral outside interactions, open feature request](https://github.com/discord/discord-api-docs/discussions/7693)

**The three new games, prior art:** [Texas Hold'Em Poker bot, the source of the "click Show cards each hand" pattern and the force fold timer](https://discordbotlist.com/bots/texas-holdem-poker) · [Joimer/discord-poker SPEC](https://github.com/Joimer/discord-poker/blob/master/SPEC.md) · [BlackJack Bot, five action buttons](https://top.gg/bot/1278735065286709309) · [willu98 Discord Battleship, reactions plus private channels](https://github.com/willu98/Discord_BattleShip_Bot) · [discord-battleship npm, DM based](https://www.npmjs.com/package/discord-battleship) · [battleship-py, typed coordinates and emoji grids](https://pypi.org/project/battleship-py/) · [playing card generator](https://github.com/false-fox/playing-card-generator) · [discord-card-canvas](https://github.com/Gusarovv/discord-card-canvas)

**Explicit not founds, so nobody re researches them:** Arcane has no achievements system, no level up DM option, no scheduled or global XP event multiplier, no cross server global XP, no daily leaderboard, and no documented import or export. Amari's per message XP range and native curve formula are not published. Tatsu publishes no formula. No open source Discord battleship uses components for firing. No surveyed Discord blackjack implements multiplayer at one table. No surveyed hold em implementation documents side pot handling. No official Discord source states the folklore "5 messages per 5 seconds per channel" limit, and no source states what fraction of users have DMs closed, so neither number appears in this plan. Reddit was unreachable from the research environment, so community sentiment is represented through vendor documentation, official support threads and practitioner writeups instead.
