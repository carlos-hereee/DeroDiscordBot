# Game rooms: guild QA checklist

Produced 2026-08-12 by the keyboard QA pass over `DeroDiscordBot` at `staging` / `871d371`.

Every item below is a completion criterion that a keyboard cannot verify. The gates, the completion
greps, the mutation spot checks and the seam reads all passed; what is left is the set of behaviors
that only exist once Discord is drawing them.

Work top to bottom. Earlier sections build the fixtures later sections need.

---

## ⛔ READ THIS BEFORE STEP 1

**NOTHING BELOW IS REACHABLE UNTIL YOU RUN `npm run deploy`.**

```bash
npm run deploy
```

That registers GLOBAL slash commands and can take up to an hour to propagate. It is owner only.

**And the deploy is LOAD BEARING now, which it was not for previous releases.** Phase 4 removed the
`opponent` option from `/mini-game coin-flip`, `dice-roll` and `rps`. Until the commands are
re-registered, every Discord client still renders the OLD builder with a REQUIRED opponent field, and
a member who fills it in has the value silently discarded. That in-between state is worse than a
missing command, because it looks like it worked.

**How to tell propagation is done:** type `/mini-game coin-flip` in any channel and confirm Discord
offers NO opponent field. If it still asks for an opponent, stop. Propagation is incomplete and every
result below will be misleading.

You will need: a throwaway guild you can `/self-destruct`, plus at least **four** member accounts
(host, player two, a spectator, and a fourth member who must NOT see the invite-only room). Six for
the hold em section.

---

## Section A. A fresh `/setup` builds the right shape

Run in a guild that has never had the bot.

| # | Do | Pass | Fail looks like |
|---|---|---|---|
| A1 | Invite the bot, run `/setup` | Exactly **two** categories appear: `🪧 NOTICE BOARD` and `🎮 ARCADE GAMES` | A third category, or only one. One category means the games specs inherited the homebase parent (risk R2) |
| A2 | Count channels | Exactly **ten** | Nine means one spec never built. Eleven or more means a duplicate, which is R2 wearing a different coat |
| A3 | Read the `🪧 NOTICE BOARD` children | `📜introductions`, `📖command-center`, `🏆leaderboard`, `📅event-schedule`, `📢announcements`, `🔒inner-sanctum`, `🔜upcoming-events`, `🎛️admin-controls`. Eight | `🔜upcoming-events` missing or present-but-dead is the specific historical bug here: check it has an intro card, not just a name |
| A4 | Read the `🎮 ARCADE GAMES` children | `📋arcade-rules` and `⚔️challenges`. Two, and **under the arcade category** | Either one sitting under `🪧 NOTICE BOARD` is the R2 failure. This is the single most likely thing on this page to be wrong |
| A5 | Read `📋arcade-rules` and `⚔️challenges` | Each carries exactly ONE intro card | Two cards in either means the intro id derivation regressed |

## Section B. An existing guild gains the arcade on the next boot

This is the migration path, and it is the one real users take. Use a guild that was set up BEFORE
this arc (or delete `🎮 ARCADE GAMES` and both its channels from the Section A guild, then restart
the bot).

| # | Do | Pass | Fail looks like |
|---|---|---|---|
| B1 | Restart the bot. Do NOT run `/setup` again | `🎮 ARCADE GAMES` and both channels appear on their own | Nothing appears, and the arcade is only reachable by re-running `/setup`. That is a migration failure, not a cosmetic one: existing guilds are most of the install base |
| B2 | Read `🔒inner-sanctum` | **ONE** summary repair notice | TWO notices, or one notice per channel. A repair that announces itself twice trains admins to ignore it |
| B3 | Restart the bot a second time | No new channels, no new notice | A second notice on an already-repaired guild means the repair is not idempotent and will post on every boot forever |

## Section C. Repair, idempotence and teardown

| # | Do | Pass | Fail looks like |
|---|---|---|---|
| C1 | Delete `⚔️challenges` by hand. Wait | It is rebuilt **under `🎮 ARCADE GAMES`** | Rebuilt under `🪧 NOTICE BOARD`. This is the realtime form of R2 and it is a different code path from B1, so B1 passing does not cover it |
| C2 | Delete `📋arcade-rules` by hand | Same: rebuilt under the arcade category, with its intro card | A rebuilt channel with no intro card is a half repair |
| C3 | Run `/setup` again on a complete guild | A no-op. No duplicate channels, no reposted intro cards | Any reposted card. This is the `nextIntroIds` bug the arc fixed; a regression reposts on EVERY boot, not just this one |
| C4 | Run `/self-destruct` | Every channel AND both categories are gone | An orphaned empty `🎮 ARCADE GAMES` (or `🪧 NOTICE BOARD`) category left behind. An orphan category is permanent: nothing else ever cleans it up |

Rebuild the guild with `/setup` before continuing.

## Section D. Room visibility, the permission matrix

The matrix is the one thing in this feature that is genuinely hard to verify by eye, because a wrong
entry produces a channel that LOOKS right and leaks. Check it in Discord's own channel permission UI,
not by trying to type.

### D1. An invite-only room

1. As **host**, go to `⚔️challenges` and press a game button (`Coin flip`, `Dice roll`,
   `Rock paper scissors`, `Hangman`, `Battleship` or `Texas hold em`).
2. Choose **Invite only**.
3. Invite **player two** and **spectator** from the picker (placeholder reads `Choose who to invite`).
4. Press **Start the match**.

| Check | Pass | Fail looks like |
|---|---|---|
| Host sees the room | yes | |
| Player two sees it | yes | |
| Spectator sees it | yes | |
| **Fourth member sees it** | **NO** | The fourth member seeing the channel is the headline leak of this section. Check with an account that was never in the pool |
| Spectator tries to type | refused | A spectator who can type is a broken deny |
| **Spectator opens a thread on any message and types there** | refused | ⚠️ This is the bypass everyone forgets. `SendMessages` alone does not stop it; both `CreatePublicThreads` and `SendMessagesInThreads` must be denied. A spectator typing in a thread reads to the room as the rule not applying |
| Spectator adds a reaction | **allowed** | A spectator who cannot react is over-denied. Reacting is most of what watching is for, and it is deliberately not denied |

### D2. A public room

1. Open a second room as a DIFFERENT host, choosing **Open to all**.
2. Let exactly two members join and start it.

| Check | Pass | Fail looks like |
|---|---|---|
| Every member of the guild sees it | yes | |
| Exactly two members can type | yes | A third typist means a player overwrite went to the wrong id |
| **Channel permission UI shows exactly ONE `@everyone` overwrite** | **one** | ⚠️ Open the channel's Permissions tab and COUNT. One entry per member is the O(members) regression this design exists to prevent. It works fine in a five member test guild and falls over in a real one, so a count of one here is the only place it gets caught |

## Section E. Finish and archive

Resolve the coin-flip or dice-roll room from D2 (one press of `Flip the coin` / `Roll the dice`
decides it).

| # | Check | Pass | Fail looks like |
|---|---|---|---|
| E1 | After the result | **Nobody** can type, including the two players and the host | A player who can still type after the match means the lock fell through to the guild-wide `@everyone` base permission. Test this as a PLAYER, not as an admin |
| E2 | Same, in a thread | Nobody can open a thread and type | The same bypass as D1, in the finished phase |
| E3 | The result card | Posted, and it is the LAST message in the channel | A result card buried above a later move means it posted before the lock |
| E4 | The card's text | Reads `This room is now read only. It disappears in 4 hours, or right now if the host presses Archive now.` | A different number of hours means `GAME_ROOM_ARCHIVE_DELAY_MS` and the copy disagree |
| E5 | The button | **`Archive now`** is present | |
| E6 | Press `Archive now` | The channel is deleted **immediately** | |
| E7 | On a SECOND finished room, leave it alone | The channel disappears within about **5 minutes of the 4 hour mark** (the sweep runs `*/5 * * * *`) | Still there at 4h15 means the archive sweep is not running or its query is wrong. Do not call it at 4h01: five minutes of slack is by design |

## Section F. Restart and the one-room-per-host rule

| # | Do | Pass | Fail looks like |
|---|---|---|---|
| F1 | Open a room, then restart the bot mid-match | The room is fully playable afterward: buttons respond, state is intact | Dead buttons, or a match that restarted from the beginning. The old in-memory design died on every deploy; the row is supposed to survive |
| F2 | As a host with a room already open, press a game button on `⚔️challenges` | Refused with `You already have a room open. Finish it first: #<the room>` and the channel name is a working **jump link** | A bare refusal with no link is a partial pass: log it. A SILENT no-op is a full fail, it reads as a broken button |
| F3 | Start a challenge card and abandon it without pressing Start. Wait ~10 minutes | The draft is reaped and the host can open a room again | A host locked out permanently. A draft counts as live against the partial unique index, so an unreaped draft holds the slot forever |

## Section G. Rock paper scissors secrecy

**The plan calls a regression here the one unforgivable one.** Run it as a PUBLIC room so a spectator
is watching.

1. Host opens a `Rock paper scissors` room, **Open to all**, one opponent joins, Start.
2. Host presses the move button, picks a throw from the ephemeral select.

| # | Check as the SPECTATOR | Pass | Fail looks like |
|---|---|---|---|
| G1 | After the first player picks | The channel shows only `<@host> has locked in their pick.` | **Any** mention of rock, paper or scissors in that line. This is the failure the whole design exists to prevent |
| G2 | The picking player's own screen | Shows `Locked in: **rock**. Waiting on the other player.` privately | If that confirmation is visible to anyone else, the ephemeral flag was dropped |
| G3 | Scroll back through the whole channel before the second pick | Neither throw appears anywhere | A throw in an earlier message, an embed footer, or a button label |
| G4 | After the second pick | Both throws revealed together, winner named | |

## Section H. Hangman in a room

Host authors the word and does **not** play.

1. Host opens a `Hangman` room from `⚔️challenges`, gathers at least one other member, Start.
2. Host presses **`Set the word`** and fills the modal: the word, a required hint, and up to three
   extra hints one per line.

| # | Check | Pass | Fail looks like |
|---|---|---|---|
| H1 | The word during the round | Appears in **exactly ONE message**, the result card, after the round is over | The word in the opener, in a hint, in an error, or in the mask before it is solved. Scroll the entire transcript to check |
| H2 | Wrong guesses 2, 4 and 5 | Each reveals one extra hint **as its own post** | Hints arriving at different counts, or batched into an edit of an earlier message |
| H3 | The host presses `Guess a letter` | Refused: `You set the word, so you do not get to guess it.` | The host being able to guess their own word |
| H4 | Fewer extra hints than three | Only the ones that exist are revealed, silently | An empty hint post at threshold 4 or 5 |

### H5. Word validation, and what to expect

Press `Set the word` and try each. **Read this note first or you will record a false failure:** a
digit, a space and an accent all produce the SAME message, because they are all the same rule
(letters a to z only). Only the distinct-letter case has its own message. "A specific reason each
time" means specific rather than a generic "invalid word", not four different strings.

| Input | Expected message |
|---|---|
| `pl4net` (digit) | `Letters A to Z only. No spaces, digits, accents or punctuation, because the mask would show them.` |
| `ice cream` (space) | the same message |
| `café` (accent) | the same message |
| `aaaa` (fewer than 3 distinct) | `That word repeats too few letters to be a game. Use at least 3 different ones.` |
| `cat` (3 letters) | `That word is too short. Use at least 4 letters.` |
| a 13 letter word | the too-long message |
| word `planet`, hint `the answer is planet` | `That hint gives the word away. Say something true about it instead.` |
| word `planet`, hint `plan` | **the same refusal.** ⚠️ Check this one specifically: a four letter prefix hands over most of the mask in order, and the naive check misses it. A hint of `plan` being ACCEPTED is a real leak |

**Fail looks like:** any of these being accepted, or any refusal that echoes the word back. A rejection
message containing the offending word defeats the entire point of a hidden word.

## Section I. `/mini-game hangman` outside and inside a room

| # | Do | Pass | Fail looks like |
|---|---|---|---|
| I1 | Run `/mini-game hangman` in an ordinary channel | Behaves exactly as it does today: casual mode, bundled word bank, stage art | Any change here is a regression in a shipped feature. The room version is additive |
| I2 | Run `/mini-game hangman` INSIDE a game room | Refused | Running a second casual game inside a room, which puts two games in one transcript |
| I3 | Run `/mini-game blackjack` anywhere | Runs **in place on one edited message**, and does NOT create a channel | A blackjack room being created. Blackjack deliberately does not get one; a hand takes a minute |

## Section J. Battleship

Two players. Budget about 30 minutes for J4.

| # | Check | Pass | Fail looks like |
|---|---|---|---|
| J1 | The public board | Both grids show only FIRED positions | ⚠️ An unfired ship visible anywhere on the public board. Check both halves of the embed, not just your opponent's |
| J2 | Press `Show my board` (or the own-board control) | Ephemeral, shows your own fleet | Anyone else seeing it |
| J3 | **Scroll the whole transcript back** | No unfired ship position appears in any earlier message, including the board message's edit history and the move trail | This is the subtle one: the board is ONE message edited every turn, so an old render is not visible, but a trail entry naming a ship's position would be. Read the trail, not just the board |
| J4 | One player closes Discord and walks away | First turn expires **10 to 15 minutes** after the last shot (10 minute budget, checked on a 5 minute sweep). TWO consecutive expiries forfeit the MATCH, so the room finishes in roughly **20 to 30 minutes** | ⚠️ Do not record a failure at minute 11. Record one if the room is still `playing` after 35 minutes. A frozen match is the worst failure in this arc: the room never reaches `finish`, `archiveAt` is never stamped, the sweep never sees it, and it holds the host's one-room slot forever |
| J5 | After the forfeit | A result card, the loser named in the trail | **The wrong player blamed.** The forfeiting player is captured before the turn passes; if the trail names the player who was still present, the ordering regressed |
| J6 | Reroll, if offered | Replaces only your own fleet, ephemerally | Your new layout being announced publicly |

## Section K. Texas hold em

Six accounts. This is the longest item on the page; do it last.

| # | Check | Pass | Fail looks like |
|---|---|---|---|
| K1 | Six players press `Buy in (1000)`, host presses `Deal` | Table starts, blinds 10/20 | |
| K2 | Press `Show my cards` | Ephemeral, your two hole cards | ⚠️ Hole cards reaching the channel in ANY form. Check the public table embed carries the board and the pot but never a player's hand |
| K3 | Scroll the transcript back after a hand | No hole card appears in any earlier message | |
| K4 | The controls | `Fold`, `Check`, `Call`, `Raise`, `All in`, plus `Half pot (n)` and `Pot (n)`. **No modal** | A modal appearing costs a round trip against a 30 second clock |
| K5 | Blinds over time | Double every 6 hands | A table that never converges |
| K6 | A player closes Discord | **Force folded 30 to 40 seconds later** (30s budget, 10s tick). The table continues | ⚠️ A PAUSED table is the failure. If the table waits, one absent player is stalling five present ones, which is exactly what the clock exists to prevent |
| K7 | **Three-way all-in for different amounts** | Main pot and side pot(s) pay out correctly: a short stack all in for 20 cannot win the 80 two others bet on top | This is the highest-value single check in the section. Set it up deliberately: give three players visibly different stacks and get all three all in on one hand |
| K8 | A player folds after betting | Their chips stay in the pot and are won by someone else. They win nothing | A folded player collecting a pot they folded into |
| K9 | The wheel, if it comes up | A-2-3-4-5 is the LOWEST straight, beaten by 2-3-4-5-6 | The wheel beating a higher straight |
| K10 | Tournament end | Runs to a **single winner** | A table that hangs with players still holding chips |
| K11 | After the tournament | `/account` shows hold em **played 1**, not one per hand | ⚠️ A count matching the hand count means the per-hand XP call started naming the game. Play a long tournament to make this visible |

## Section L. XP recording, across the arc

Run these AFTER everything above, so there is history to read.

| # | Check with `/account` | Pass | Fail looks like |
|---|---|---|---|
| L1 | Battleship, after a match where you sank several ships | **played 1** | played 5 or 6. The per-sink bonus must not record a play |
| L2 | Hold em, after one tournament | **played 1** | played 30. The per-hand payout must not record a play |
| L3 | Coin flip / dice roll / rps | **played 1** per match | |

---

## What this checklist does NOT cover

- **Art.** `assets/games/` does not exist, so every game falls back to the Dero avatar. Missing art is
  expected right now and is not a failure. `missingGameAssets()` reports what is outstanding.
- **The dashboard game-history surface.** The bot half (`GET /api/game-rooms`) is built; the client
  and the proxy passthrough are not (2026-08 item 105). There is nothing to click yet.
- **Load.** Nothing here exercises a guild large enough to stress the single-`@everyone`-overwrite
  design. D2's overwrite count is the proxy for it.

## If something fails

Record what you saw, not what you expected. Then check the code before assuming the checklist is
right: this checklist is a document, and the house rule is that the code wins over any document,
including this one.
