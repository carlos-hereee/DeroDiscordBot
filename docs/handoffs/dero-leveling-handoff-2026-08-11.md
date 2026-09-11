# Dero leveling system: session handoff, 2026-08-11

**Read this before touching anything in `src/features/leveling/`.** It records what shipped, what is
deliberately unfinished, and the four places the master plan is WRONG. Everything below was verified
at the live call site or measured in this session, not carried forward from a doc.

**Canonical sources, in precedence order.** The CODE wins over all of them.

| What | Where |
|---|---|
| Open work, status, the deferred list | `SACRED_FILES/2026-08/FUTURE_PLANS-PART-3.md` **item 103** |
| Live behavior | `SACRED_FILES/STATE.md`, "the LEVELING system is built" |
| Known defects | `SACRED_FILES/TECH_DEBT.md`, four entries at the top |
| Per-phase session detail | `SACRED_FILES/2026-08/WIP.md`, week of August 10 |
| The plan and its nine spells | `TODO-PLANS/dero-leveling-and-games-master-plan-2026-08-10.md` |
| Announcement copy, drafted not wired | `roadmaps/handoffs/dero-leveling-announcement-draft-2026-08-11.md` |

---

## Status at a glance

**Phases 1 to 4 of 8 are code-complete. Phase 5's documentation half is done. Everything still open
is owner-gated.** The feature is functionally finished: it earns, it levels, it celebrates, it pays
out in roles and achievements, and it has member and admin surfaces.

**Nothing is pushed and nothing is deployed.** No leveling command is registered with Discord.

---

## Repo state, measured this session

```
repo    DeroDiscordBot   (remote is still github.com/carlos-hereee/Rok-CommanderBot)
branch  staging          working tree CLEAN
HEAD    4486292
version package.json 1.6.1, UNCHANGED. The bump is the owner's and it is what fires the announcement.
```

**⚠️ `staging` is 93 commits ahead of `origin/staging` (`a43cacd`).** That is not a leveling problem:
the entire recent bot history is unpushed, including the minigames merge and the game rooms work. The
leveling commits are only the last five of the ninety three. Do not treat a push as a leveling
decision.

| Commit | Phase |
|---|---|
| `d9a4d5c` | 1, the pure foundation, landing dark |
| `5a890cb` | 2, xp is earned, level ups celebrate without pinging |
| `5fdf57e` | 3, the member and admin surfaces |
| `444806b` | 4, role rewards and achievements |
| `4486292` | docs, `CLAUDE.md` feature row and the `@handlers/*` alias |

Across the five: **68 files changed, 10,808 insertions.** `src/features/leveling/` holds 34 files
(17 modules and 17 test files), plus five commands and two models outside it.

**Gates, all measured at `4486292`:** `npx tsc --noEmit` clean, `npm test` **755 passing across 50
files**, `npm run lint` **0 errors**. Re-run all three before trusting this document; a parallel
session shares this working tree.

---

## ⚠️ THE PLAN IS WRONG IN FOUR PLACES. Read these before executing any spell.

The spells are written to be pasted verbatim into a fresh session, which is exactly why a wrong
"ALREADY EXISTS" line gets acted on without checking. All four are corrected in the plan itself
(assumptions A11 and A12, trap T15, and the Phase 5 task list), but a pasted spell block does not
carry those corrections with it.

**1. `src/features/game-rooms/roomLifecycle.ts` DOES NOT EXIST.** Sections 2.4 and 4.2 and Spell 3
all name it, and Spell 3 lists it under "ALREADY EXISTS". That directory holds `roomTypes.ts` and
nothing else. `GameRoom.ts` and `gameRoomStore.ts` are real; the lifecycle module is not. Four of
Spell 3's five award hooks shipped (duel, rps, hangman, fortune); the game room one is unwired and
filed in `TECH_DEBT.md` with the fix written out.

**2. The release announcement copy does NOT live in `postFeatureAnnouncement.ts`.** That file
resolves it per guild via `getPluginCopy(config).featureAnnouncement`. The copy belongs in the
`featureAnnouncement` block of **BOTH** packs, each with a `public` and an `innerSanctum` sub-block.
Four blocks, one commit. Editing only `rok-commander` leaves every general-events guild reading the
PREVIOUS release's announcement, with nothing failing and no test catching it. **RESOLVED 2026-08-11:
all four sub-blocks are wired and verified byte identical.** Both packs' own preceding comments were
corrected at the same time; rok-commander's had asserted that a release edit was "a one file change",
which is the belief that makes this trap work in the first place.

**3. `buildSuggestionBoxButton()` on the announcement is a CODE change, not copy.**
`postFeatureAnnouncement.ts` sent `{ embeds, allowedMentions }` with no `components` on either of
its two sends. **RESOLVED 2026-08-11:** the public send now carries a `components` row; the admin
send deliberately does not. The handler dispatches by customId prefix from `main.ts:297`, so the
button is not bound to the message it was built in.

**And one thing THIS DOCUMENT got wrong, added 2026-08-11.** It treated the announcement draft as
merely awaiting owner review. The draft's blocks 3 and 4 also **contradicted the 2026-07-04 owner
decision** recorded in `general-events.pack.ts`, which says both packs keep identical kingdom-voice
announcement blocks. The two packs were byte identical, so that decision had been followed, not just
recorded. **RESOLVED 2026-08-11: the owner ruled keep them identical.** Blocks 1 and 2 are wired
verbatim into both packs, blocks 3 and 4 discarded. Proof of the general rule at the bottom of this
file: do not trust this document.

**4. `VERSION_SHIPPED_AT` has been dormant since 1.5.1.** It holds `1.4.0`, `1.5.0` and `1.5.1` while
`package.json` is at `1.6.1`, so the "skip guilds that joined after this shipped" guard has done
nothing for every release since. This one needs its version added with an ISO date or it will do
nothing again.

---

## What is left

### Owner-gated. None of it can be done from a keyboard.

- [x] ~~Review the announcement draft, settle the pack-voice question, wire the copy into both
      packs, add the Suggestion Box components row.~~ **ALL DONE 2026-08-11.** Copy is identical
      across both packs and verified so; the button rides the public send only.
- [ ] **Manual QA in a real guild.** The checklist is section 8 of the plan. The two that matter
      most: five level ups in one burst must produce ONE combined message, and a prime level must
      look visibly different from a non prime one.
- [ ] **Load sanity:** 200 fast messages in a test guild. Confirm the flush batches, the cooldown
      holds, and no duplicate announcement fires.
- [ ] **Farm sanity:** sit muted and alone in an approved voice channel and confirm **zero** xp.
      Then unmute with one other member present and confirm it starts. Then idle past
      `decayAfterMinutes` and confirm the award drops.
- [ ] **Add the shipping version to `VERSION_SHIPPED_AT`.**
- [ ] **Verify GLOBAL command propagation in a real guild, THEN bump `package.json`.** In that
      order. Propagation takes up to an hour and the bump is what fires the announcement.
- [ ] Push, and decide separately what to do about the other 88 unpushed commits.

### Buildable at the keyboard, but not part of this release

- **The game room award hook**, once `roomLifecycle.finish` exists. `TECH_DEBT.md` has the fix.
- **Phase 6, blackjack.** Spell 7. No game room dependency, no private view problem, no chip model,
  which is why the plan orders it first of the three games. Ships as its own release.
- **Phase 7, battleship.** Spell 8. Needs the game rooms release.
- **Phase 8, texas hold em.** Spell 9. Needs game rooms AND Phase 6's card assets.

---

## The nine things a next session will otherwise rediscover the hard way

1. **`awardXp` is the ONLY way to grant xp.** Every listener, game hook, admin command and
   achievement unlock goes through it. It never throws. A game handler must never touch a store, the
   curve, or the announcer directly. That one rule is what makes phases 6 to 8 nearly free.

2. **⚠️ There is a DELIBERATE circular import**: `xpWriter` → `achievementUnlock` → `awardXp` →
   `xpWriter`. It is safe ONLY because every binding in it is a hoisted function declaration called
   at runtime. Rewrite any of them as `const fn = () => {}`, or call one at module scope, and it
   becomes a TDZ error at BOOT. `levelingWiring.test.ts` is the only thing guarding it, because every
   other leveling test mocks one side of the cycle. **Do not delete that file as redundant.**

3. **The achievement pass has exactly ONE call site**, the flush in `xpWriter`. Never call it from an
   unlock handler: an unlock grants xp, xp can cross a level, and a level change moves the metrics
   the unlock was evaluated against. `awardXp` buffers `source: "achievement"` for the same reason.

4. **Level is DERIVED from `totalXp` and never stored.** `MemberLevel.announcedLevel` sits beside it
   and is NOT a level, it is a high water mark that makes the announcement claim atomic. Three
   comments say so because the instinct to "fix" it into a level field is strong.

5. **The cooldown claim in `xpWriter` must stay synchronous.** It reads and writes with no `await`
   between, which is the entire race defense for two messages in the same tick. This is also why
   `@utils/cooldownManager.js` is deliberately NOT used: its `check()`/`record()` split is right for
   a slash command and wrong where the claim IS the guard.

6. **`guildConfigStore.update` runs `findOneAndUpdate` WITHOUT `runValidators`.** Schema enums and
   ranges never see an admin write, so every numeric is clamped at the command layer against
   `BOT_CONSTANTS.LEVELING.LIMITS`, which `levelingConfig` also normalizes against on read. Patch with
   DOTTED paths (`leveling.voice.minMembers`), never by replacing the `leveling` subtree.

7. **The fortune award lives in `respondWithFortune.ts`, never `fortuneHandler.ts`.** The power-up
   button calls the former directly, so an award in the handler earns nothing on the button path.

8. **Voice `approvedChannels` defaults EMPTY and empty means NOBODY EARNS.** Opposite polarity to
   every other list in the subtree. If anyone "fixes" it to mean "all channels", a 24/7 voice self bot
   earns from day one in every guild on the platform.

9. **`MessageContent` is still not requested and must stay that way.** `xpRules.rollXp` takes no
   message-text parameter, so per-word xp needs a deliberate signature change rather than a flipped
   line. The pressure to add it will come from leveling; `main.ts`'s intent comment says so.

---

## Two decisions that look like oversights and are not

**The levels board is ALL TIME only.** `/levels` covers this week and this month, but the pinned
board cannot without a join on every refresh: `XpPeriod` stores a `userId` and an `xp` total and
deliberately no username. The board's own subtitle promises presence "all the time", so it is honest.
Filed in `TECH_DEBT.md` because "why is there no weekly board" will be asked.

**`/achievements` was absent from the command guide through Phase 3 and joined in Phase 4**, in the
same commit that shipped its command. A guide naming a command Discord does not know sends members to
a dead end. `commandGuide.test.ts` asserted the ABSENCE through Phase 3 and asserts the presence now.

---

## How to verify anything here

```bash
cd DeroDiscordBot && npx tsc --noEmit && npm test && npm run lint
```

`npm test` is a SINGLE run. `npm run test:run` and `npm run test:coverage` DO NOT EXIST, and a spec
doc has already shipped with those wrong names once.

**Never run** `npm run build`, `tsc-alias`, `npm run deploy`, or `npm install`. The owner does those
manually, and `npm run deploy` registers GLOBAL commands.

The regression checklist runs at every phase boundary and has passed at each of the four. The
mechanical version:

```bash
git diff --stat src/db/models/PlayerActivity.ts src/db/stores/activityStore.ts \
  src/features/leaderboard/ src/features/activity-tracking/ src/commands/admin/leaderboard.ts
grep -c "GatewayIntentBits.MessageContent" src/main.ts   # must be 0
```

Empty diff and a zero means the participation system is untouched and the privileged intent is still
not requested. Both held at `4486292`.

---

## The one thing to do first, whoever picks this up

**Do not trust this document.** Run the three gates, run the two greps above, and read
`SACRED_FILES/2026-08/FUTURE_PLANS-PART-3.md` item 103 for current status. A doc is a map; the code
is the territory, and this repo has already been bitten twice this week by a plan that said a file
existed when it did not.
