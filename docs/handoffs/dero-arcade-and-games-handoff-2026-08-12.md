# Dero game rooms, arcade and the five games: session handoff, 2026-08-12

**Read this before touching `src/features/game-rooms/`, `src/features/games/`, `src/features/setup/`,
or anything named `arcade*` or `holdem*`.**

**⚠️ REWRITTEN IN FULL at the end of the session.** Earlier versions of this file were edited
incrementally as each phase landed and ended up contradicting themselves: a "what is left" section
listing finished work, and a trap that had since been fixed. This version supersedes all of it.

**The CODE wins over this document.** Re-run the gates before trusting a word of it.

| What | Where |
|---|---|
| Open work and status | `SACRED_FILES/2026-08/FUTURE_PLANS-PART-3.md` **items 103 and 105** |
| Live behavior | `SACRED_FILES/STATE.md` |
| Known defects | `SACRED_FILES/TECH_DEBT.md` |
| Per-session detail | `SACRED_FILES/2026-08/WIP.md`, week of August 10 |
| Game rooms plan (phases 1 to 5) | `TODO-PLANS/dero-game-rooms-master-plan.md` |
| Leveling and games plan (phases 1 to 8) | `TODO-PLANS/dero-leveling-and-games-master-plan-2026-08-10.md` |

---

## Repo state, measured at the end of the session

```
repo    DeroDiscordBot   branch staging
HEAD    871d371
gates   npx tsc --noEmit clean · npm test 1187 passing / 71 files · npm run lint 0 errors
```

**⚠️ `staging` is 128 commits ahead of `origin/staging`. Nothing is pushed and nothing is deployed.**

**BOTH MASTER PLANS ARE NOW CODE-COMPLETE.** Game rooms phases 1 to 5, leveling phases 1 to 8.
There is no next phase to build; what remains is verification in a real guild and a deploy.

**⚠️ `npm run deploy` IS LOAD BEARING NOW, WHICH IT WAS NOT BEFORE.** Phase 4 removed the `opponent`
option from `/mini-game coin-flip`, `dice-roll` and `rps`. Until the commands are re-registered,
every Discord client still shows the OLD builder with a required opponent, and a member who fills it
in has the value silently ignored. That is worse than a new command merely being absent. `npm run
deploy` is owner-only and registers GLOBAL commands (up to an hour to propagate).

**Working tree note:** `assets/dero/*` may show as modified. That is the owner's parallel art work,
not this session's, and was deliberately left unstaged.

---

## THE ONE BUG CLASS THAT ACCOUNTS FOR MOST OF THIS WORK

**A list that must agree with another list, where nothing enforces the agreement.** Seven instances,
four of them pre-existing bugs nobody had noticed. Every one was silent: no error, no failing test,
no type error.

| List | What went wrong | Now |
|---|---|---|
| `nextIntroIds` in `refreshIntroEmbeds` | Both arcade cards **reposted on every boot forever** | Derived from `CHANNEL_FIELDS` |
| `applyAdminRole`'s fetch list | Admin role **never granted on 🔜upcoming-events**, since it shipped | Walks `CHANNEL_SPECS` |
| `HOMEBASE_CHANNEL_FIELDS` in `selfDestruct` | Would leave an orphan channel **permanently** | Completeness test vs `CHANNEL_FIELDS` |
| `repairMissingChannels` parent | Would build arcade channels under 🪧 NOTICE BOARD (R2) | Resolves `spec.categoryField` |
| `ChannelDeleteWatcher` parent | Same, in realtime form | Resolves `spec.categoryField` |
| `SLOT_LABELS` in `/rename-channel` | Missing `adminCommandsChannelId` | Completeness test |
| `persistPayload` in `runAutoSetup` | Missing `nextDecreeChannelId`, so every `/setup` left a **dead 🔜upcoming-events** until the next reboot | Derived loop over `CHANNEL_FIELDS` |

**The rule that came out of it:** if a list must cover EVERY member of a set, DERIVE it. If it
encodes a CHOICE, keep it hand written and pin the choice with a test.

**`HIDEABLE_CHANNELS` in `/channels` is the one that encodes a choice** and must NOT be derived: it
deliberately excludes introductions and both admin channels. Its test asserts the exclusions.

---

## ⚠️ TRAPS THAT WILL BITE THE NEXT SESSION

**1. `tsc` DOES NOT TYPE CHECK TESTS.** `tsconfig.json` excludes them. A rename touching a persisted
value will not be caught by the tsc gate; only running the suite finds it.

**2. `resolveChannelId` in `channels.ts` has a switch with NO default.** An unhandled field returns
null and the autocomplete filter drops the channel silently. Adding to `HIDEABLE_CHANNELS` alone
looks like it works and does not.

**3. A GREEN SUITE IS NOT EVIDENCE A GUARD WORKS.** Mutation testing changed the outcome repeatedly
across this arc. It proved the battleship leak boundary bites; it proved the blackjack settle
guard's tests were **vacuous**; and in Phase 8 it proved one guard was redundant (see below). Break
the guard on purpose. It costs one minute.

**4. ~~Run the gates sequentially because `levelingWiring.test.ts` times out.~~ FIXED.** That test
`await import()`s the real module graph unmocked and had crept past vitest's 5s default as the suite
grew, failing on EVERY full run while passing alone in 1.2s. Each of its cases now carries a 30
second budget. **The guard is not weakened**: the failure it catches is a TDZ error, which throws the
instant the cycle evaluates, so the timeout only ever bounded transform speed. Running the gates
sequentially remains the house habit but this file no longer forces it.

**5. A CONSTANT rng CANNOT PLACE A BATTLESHIP FLEET OR DEAL A POKER HAND.** `placeFleet` retries on
collision, so `() => 0.5` puts every ship in one square and throws after 500 attempts. Any fixture
needing placement or a deal wants a deterministic generator that VARIES; the test files use a small
LCG.

**6. Sets do not survive JSON.** `JSON.stringify(new Set())` is `{}`, and Mongo stores that. Both
battleship and hold em serialise explicitly in both directions. A match that round-tripped without
it would silently forget every hit or every shot with no error anywhere.

---

## WHAT SHIPPED, PHASE BY PHASE

### Game rooms Phase 2 (the arcade category) — complete

🎮 ARCADE GAMES with `📋arcade-rules` and `⚔️challenges`, alongside 🪧 NOTICE BOARD's eight channels.
Ten channels, two categories. Task 2.15's create-path coverage landed last, and **the task's own
stated reason was wrong**: it claimed `createChannels` is never invoked by the suite. It is, twice;
an `afterEach` releases the spy. What was missing was any ASSERTION about what it produced.

### Game rooms Phase 3 (room lifecycle) — complete, `7c9e779`

`roomNaming` and `roomPermissions` (pure), `RoomProvisioner.open`, `roomTrail.postMove`,
`roomLifecycle.finish` / `archiveNow`, the 5 minute archive sweep and its cron, the `gameroom:`
handlers, a boot recovery sweep, the R14 guard in `ChannelDeleteWatcher`, and a temporary debug
command since deleted.

**⚠️ THE PLAN'S PERMISSION MATRIX IS WRONG FOR THE FINISHED PHASE and the code deliberately
deviates.** "Minus every SendMessages allow" does not lock an invite-only room: with no explicit
deny, players fall through to the guild-wide @everyone base permission, which grants SendMessages in
almost every server. The code DENIES SendMessages on @everyone at finish in BOTH visibilities, plus
the thread pair. **Do not "fix" it back toward the matrix.**

**Other load-bearing decisions:** `finish` PERSISTS BEFORE IT LOCKS (the reverse leaves a locked
channel on a "playing" row that the finished-only sweep never touches); a public room spends exactly
ONE `@everyone` overwrite; `archiveAt` has exactly one writer, which is what makes the sweep safe.

### Game rooms Phase 4 (the challenge board) — complete, `03e16ad`

⚔️challenges is how a two-player match starts. A draft `GameRoom` row is the handshake and survives
the Railway deploy that killed the old in-memory one several times a week.

1. **`challengeFlow.ts`, `versusHandler.ts`, `rpsHandler.ts` and `rpsRound.ts` are DELETED**, not
   deprecated. Their pure halves (`versusResolve`, `rpsWinner`) are untouched and drive
   `roomGames.ts`.
2. **F9 is structural, so there is no bot-opponent string to find.** The two ways into a match are a
   bot-populated StringSelect and a Join button a bot cannot click. **Do NOT add an `addUserOption`
   to a game**: that re-opens the hole and the copy string that covered it is gone. A test asserts
   no subcommand carries a user option at all.
3. **One pool mechanism serves both visibilities.** A draft's `spectatorIds` holds everyone who is
   in; at start one is promoted to player (or all of them, for a cooperative game) and the rest stay.
4. **`RoomProvisioner.open` takes `existingRoomId`** when adopting a draft, or the insert collides
   with the unique index against the host's own draft.

### Game rooms Phase 5 (hangman in rooms) — complete, `9aa05a2`

Host authors a word behind a modal with a required hint and up to three extra hints, earned at 2, 4
and 5 wrong guesses. Every letter is its own attributed message. **The host cannot guess their own
word**, refused at both the button and the modal submit.

**The hint leak rule needed TWO directions.** "Must not contain the word" catches "planet" and
"planetary" but NOT "plan", a four-letter prefix that hands over most of the mask in order. A hint
token of at least three characters contained BY the word is refused too.

`GET /api/game-rooms` ships on the bot behind the existing signature gate, terminal rooms only,
projecting `secret` away AT THE DATABASE.

### Leveling Phase 7 (battleship) — complete, `556cc44` + `56578d2`

Two string selects plus Fire, because **a 10x10 button grid is 100 components against Discord's cap
of 25**. The public board is ONE message edited every turn while the trail appends; that looks like
it contradicts hangman's append-only rule and does not, because a grid reposted per shot would be
thirty unreadable walls.

**⚠️ THE TURN CLOCK IS WHAT MAKES AN ABANDONED MATCH TERMINATE AT ALL.** Without it a player who
closes Discord freezes the match, the room never reaches `finish`, `archiveAt` is never stamped, the
archive sweep never sees it, and it holds its host's one-room slot forever.

**The forfeiting player is captured BEFORE `expireTurn` runs**, because that function passes the
turn. Both orderings type check and only one is right.

### Leveling Phase 8 (Texas hold em) — complete, `b724cf7` + `f54f796` + `871d371`

Up to six players, per-tournament chips, blinds doubling every six hands. Hole cards pull-based and
ephemeral. Five betting buttons plus two preset sizes, **no modal** (a modal costs a round trip under
a 30 second clock). The clock **force folds and never pauses**, on its own 10 second interval,
because node-cron cannot go finer than a minute.

**⚠️ FOUR BUGS THE TESTS FOUND, AND EVERY ONE LOOKS FINE ON SCREEN.** This is why poker needed the
test count it got.

1. **The wheel.** A-2-3-4-5 is a FIVE high straight, the weakest; reading the ace high makes the
   worst straight beat every other one.
2. **Straight flush scanned across all seven cards.** A board with five hearts plus a separate
   mixed-suit straight is a FLUSH; scanning all seven claims a straight flush that does not exist.
3. **All in gated on beating the current bet**, leaving a short stack facing an over-bet with only
   fold and a capped call. That removes the exact all-in that CREATES a side pot.
4. **A street opened with only ONE player holding chips** and the rest all in, waiting forever for an
   action with no legal form. Checking for ZERO contenders rather than fewer than TWO is the off-by-
   one between a table that finishes and one that hangs.

**Chips die with the table, enforced by ABSENCE.** There is no store call in `holdemTable.ts`, so a
finished tournament cannot leave a balance behind even by accident. That answers open question Q7
("does hold em ever need a persistent balance") in code: never.

**⚠️ ONE MUTATION SURVIVED AND IT IS A FINDING, NOT A GAP.** Deleting `actedSince = []` from the
bet/raise branch broke nothing, because a raise by definition pushes `currentBet` above what everyone
else committed, so `everyoneSquare` already holds the round open. The reset is kept but is NOT the
load-bearing guard, and the code says so.

---

## THE XP RECORDING RULE, WHICH BIT TWICE

**`awardXp` increments `games.<slug>.played` for ANY call that names a game.** So a bonus paid more
than once per match must NOT pass `game`, or `/account` records a play per bonus.

- **Battleship's per-sink bonus** omits `game`. A five-sink match would otherwise read "played 6".
- **Hold em's per-hand XP** omits `game`. A 30 hand tournament would otherwise read "played 30".
- **Hold em's placement payout** is the ONE call that names the game, so a tournament records once.

---

## WHAT IS LEFT

**Nothing that a keyboard can do on either plan.** Everything remaining is one of three kinds:

### Owner-gated

- **`npm run deploy`**, which is now load bearing (see the top of this file).
- **Manual QA in a real guild.** Every phase has completion criteria of the form "verified by hand":
  the invite-only visibility check, a public room's exactly-two-typists, the rps spectator secrecy,
  a six player hold em tournament running end to end.
- **Leveling's release checklist (item 103):** load and farm sanity, `VERSION_SHIPPED_AT`, then the
  `package.json` bump AFTER verifying global propagation.
- **Art.** `assets/games/` does not exist; every game falls back to the Dero avatar. See the asset
  table below.

### Open items on the platform side

- **2026-08 item 105**, the dashboard game-history surface. The BOT half is done
  (`GET /api/game-rooms`); the client and the proxy passthrough are not.
- The **game room XP hook** in `TECH_DEBT.md`, now unblocked. It carries a decision: `finish` is
  also called for ABANDONED rooms, so paying full XP is farmable (open a room, delete the channel).

### The art manifest, for whoever is drawing

Files go under `assets/games/`. No code change is needed; `missingGameAssets()` reports what is
still outstanding.

| Path | Status |
|---|---|
| `challenge.gif` | ⚠️ **ORPHANED by Phase 4. Do not draw.** Nothing renders it. |
| `coin-flip/flip.gif`, `dice-roll/roll.gif`, `dice-roll/tie.png` | Used, room result card |
| `rps/rock.png`, `paper.png`, `scissors.png`, `tie.png` | Used, the WINNING throw |
| `hangman/stage-0..6.png` | Used, casual mode only |
| `hangman/win.png`, `lose.png` | Used, casual and room result card |

Blackjack, battleship and hold em declare **no art**: battleship and hold em render Unicode grids and
cards because those surfaces are edited every turn.

---

## Two decisions that look like oversights and are not

**Schema paths were renamed rather than left alone.** `gamesRulesChannelId` →
`arcadeRulesChannelId`, `gamesChallengesChannelId` → `arcadeChallengesChannelId`, and `duel` →
`coinflip` / `diceroll`. **All free because nothing is deployed and nothing has ever written them.**
That window closes on the first deploy; after it, each is a data migration.

**The game rooms FEATURE keeps its name.** A room is a per-match channel INSIDE the category. The
category is the arcade; the rooms are what happen in it.

---

## How to verify anything here

```bash
cd DeroDiscordBot && npx tsc --noEmit && npm run lint && npm test
```

`npm test` is a SINGLE run; `npm run test:run` and `npm run test:coverage` DO NOT EXIST.
**Never run** `npm run build`, `tsc-alias`, `npm run deploy` or `npm install`.

The participation-system regression check still holds and should stay holding:

```bash
grep -c "GatewayIntentBits.MessageContent" src/main.ts   # must be 0
```

And the Phase 4 completion grep, which must stay at zero:

```bash
grep -rc "Bots do not play games" src/                   # must be 0
```

---

## The one thing to do first

**Do not trust this document.** Run the gates, run both greps, and read items 103 and 105. A doc is
a map; the code is the territory, and this arc found four pre-existing bugs that every doc in the
repo was silent about.
