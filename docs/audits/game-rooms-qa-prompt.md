# Game rooms QA: prove the arc works before it deploys

Drafted 2026-08-12. Paste the block under "The prompt" into a fresh Claude Code session opened on
`C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot`.

It covers everything a keyboard can verify (gates, completion greps, mutation spot-checks, the
seams most likely to be wrong) and hands back a checklist for the parts that genuinely need a real
Discord guild. It deliberately does NOT ask for fixes, a deploy, or a push.

Assumption: you want a QA pass that REPORTS rather than repairs, because a session that silently
fixes what it finds gives you a green result and no idea what was broken. If you meant "find and
fix", say so and I will redraft the guardrails.

## The prompt

```
You are QA'ing a large, unshipped feature arc in a Discord bot before its first deploy. Your job is
to VERIFY and REPORT, not to fix. Read this whole prompt before running anything.

## The repo

Working directory: C:\Users\User\Desktop\projects\company-uno\DeroDiscordBot
Branch: staging. Expected HEAD: 871d371. It is ~128 commits ahead of origin/staging.
NOTHING IS PUSHED AND NOTHING IS DEPLOYED. That is expected, not a defect.

This is a TypeScript ESM Discord bot (discord.js v14, Mongoose, vitest). Local imports carry a `.js`
suffix even though the source is `.ts`. Path aliases: `@features/*`, `@db/*`, `@utils/*`, `@base/*`,
`@commands/*`, `@api/*`, `@handlers/*`.

## What was built

Two master plans, both now code-complete, adding "game rooms": a per-match Discord channel with its
own permission matrix, an append-only transcript, and an archive clock.

- A second managed category, 🎮 ARCADE GAMES, holding `📋arcade-rules` and `⚔️challenges`, alongside
  the existing 🪧 NOTICE BOARD and its eight channels. Ten channels, two categories.
- `⚔️challenges` is a board where a member starts a challenge, chooses Invite only or Open to all,
  gathers who is in, and opens a room.
- Games that run in a room: coin flip, dice roll, rock paper scissors (two players), hangman
  (cooperative, host authors the word and does not play), battleship (two players), Texas hold em
  (up to six, tournament, per-table chips).
- Blackjack deliberately does NOT get a room and runs in place on one edited message.

The plans are at `TODO-PLANS/dero-game-rooms-master-plan.md` (phases 1-5) and
`TODO-PLANS/dero-leveling-and-games-master-plan-2026-08-10.md` (phases 1-8). The session handoff
is `roadmaps/handoffs/dero-arcade-and-games-handoff-2026-08-12.md`. Read the handoff first; it is the
densest map. But treat every document as a HYPOTHESIS: this project's own house rule is that the code
wins over any doc, and this arc found four pre-existing bugs that every doc was silent about.

## Commands you may and may not run

MAY: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npx vitest run <path>`, any git read command,
any file read or grep.

MUST NOT, under any circumstances: `npm run build`, `tsc-alias`, `npm install`, `npm run deploy`,
`git push`, `git commit`, or anything that writes to Discord or a database. `npm run deploy`
registers GLOBAL slash commands and is the owner's to run. `npm install` triggers a postinstall
build. There is no `npm run test:run` and no `npm run test:coverage`; `npm test` is a single run.

## Part 1 — The gates

Run these three, in this order, and record the exact numbers:

    npx tsc --noEmit
    npm run lint
    npm test

Expected: tsc clean, lint 0 errors, and roughly 1187 tests passing across 71 files. A different test
count is not automatically wrong (someone may have added tests); a FAILING test is.

If `src/features/leveling/levelingWiring.test.ts` fails, re-run it alone
(`npx vitest run src/features/leveling/levelingWiring.test.ts`) before reporting it. It used to time
out under full-suite load and its budget was raised to 30 seconds this session. If it now fails
ALONE, that is a real regression and it matters a great deal: it is the only guard on a deliberate
circular import that becomes a boot-time crash in production if broken.

## Part 2 — The completion greps

Two greps encode completion criteria from the plans. Both must return zero.

    grep -rc "Bots do not play games" src/

Zero proves the bot-opponent rejection string is gone. It was deleted because the two ways into a
match are now a bot-populated StringSelect (a bot can never be an option) and a Join button (a bot
cannot click). If this is non-zero, either the string came back or somebody quoted it in a comment,
which defeats the check permanently. Report which.

    grep -c "GatewayIntentBits.MessageContent" src/main.ts

Zero proves the participation system still does not request the message-content intent.

Then a manual one. List every `addUserOption` in `src/` and read each:

    grep -rn "addUserOption" src/

NONE of them may be a game opponent picker. Expected: five in `src/commands/admin/xp.ts` (admin XP
targets) and two in `account.ts` / `achievements.ts` ("whose profile to show"). Any user option on a
`/mini-game` subcommand is a regression: Discord populates that picker and it will return bots,
which is the exact hole the deleted string used to paper over.

Also confirm there are no `UserSelectMenuBuilder` or `isUserSelectMenu` usages anywhere in `src/`.

## Part 3 — Mutation spot-checks

A green suite is not evidence a guard works. Pick the five below, break each ON PURPOSE, confirm the
named suite goes RED, then restore the file exactly. Use `git diff` to prove you restored it.

For each: if it goes red, the guard has teeth. If it stays GREEN, that is a finding — report it,
do not "fix" the test.

1. In `src/features/game-rooms/roomPermissions.ts`, empty the `THREAD_WRITE_DENIES` array.
   Expect `roomPermissions.test.ts` to fail. (Spectators could otherwise open a thread and type.)
2. In `src/features/game-rooms/roomGames.ts`, append the chosen throw to the public "locked in"
   line in `handleRpsSelect`. Expect `roomGames.test.ts` to fail. This is the regression the plan
   calls the one unforgivable one: spectators learning a rock-paper-scissors throw before the reveal.
3. In `src/features/games/holdemHand.ts`, delete the line that aliases an ace to rank 1 inside
   `findStraight`. Expect `holdemHand.test.ts` to fail. (The wheel, A-2-3-4-5, is a FIVE-high
   straight; without the alias it stops being a straight at all.)
4. In `src/features/games/holdemPots.ts`, change the `eligible` line in `buildPots` so it no longer
   filters out folded players. Expect `holdemPots.test.ts` to fail. (A folded player could win the
   pot they folded into.)
5. In `src/features/game-rooms/roomTurnSweep.ts`, move the `const loserId = ...` line to AFTER the
   `expireTurn(state)` call. Expect `roomTurnSweep.test.ts` to fail. (`expireTurn` passes the turn,
   so reading it afterwards blames the player who was still present.)

## Part 4 — Read these seams and say whether they are right

These are the places where the code deliberately departs from its own plan, or where the plan is
wrong. Confirm the CODE still does what is described. Report any that no longer match.

1. `src/features/game-rooms/roomPermissions.ts`, the finished phase. The plan's matrix says the
   locked state is "playing minus every SendMessages allow". Taken literally that leaves an
   invite-only finished room WRITABLE by its players, because with no explicit deny they fall
   through to the guild-wide @everyone base permission. The code must DENY SendMessages on
   @everyone at finish in BOTH visibilities. Confirm it does.

2. `src/features/game-rooms/roomLifecycle.ts`, `finish`. It must PERSIST the row BEFORE it locks the
   channel. The reverse order, on a crash between the two, leaves a locked channel attached to a row
   still marked "playing", which the finished-only archive sweep never touches and no recovery path
   finds.

3. `archiveAt` must have exactly ONE writer, `roomLifecycle.finish`. Grep for `archiveAt` and
   confirm nothing else assigns it. That single-writer property is what makes the archive sweep
   safe to point at a channel delete.

4. `src/features/game-rooms/roomTurnSweep.ts` and the hold em clock in
   `src/features/game-rooms/roomHoldemHandlers.ts`. Both must FORCE an action rather than pause.
   A table that waits for an absent player hands one person the power to stall everyone else, and
   for battleship it also means the room never finishes, so `archiveAt` is never stamped and the
   room holds its host's one-room slot forever.

5. The XP recording rule, which is subtle and bit twice. `awardXp` increments `games.<slug>.played`
   for ANY call that names a `game`. So any bonus paid MORE than once per match must NOT pass
   `game`, or `/account` records a play per bonus. Confirm: battleship's per-sink bonus omits it,
   hold em's per-hand XP omits it, and hold em's PLACEMENT payout is the one call that names it.

6. `src/features/games/holdemTable.ts` must contain NO store call at all. Chips are per-tournament
   and die with the table by decision (a persistent balance is an economy and a gambling moderation
   surface). Grep the file for any import from `@db/`. There should be none.

7. `src/features/game-rooms/roomHoldem.ts` and `roomHoldemHandlers.ts`: hole cards must reach the
   channel NOWHERE. Grep both for `holeCards` and confirm every render path is an ephemeral reply
   to the clicker's own interaction. Same check for battleship's `ownView` in
   `src/features/game-rooms/roomBattleship.ts`.

## Part 5 — Produce the guild QA checklist

Several completion criteria explicitly say "verified by hand in a real guild" and cannot be checked
from a keyboard. Do not attempt them. Instead, produce a checklist the owner can work through in one
sitting, ordered so that earlier steps set up later ones, and noting for each what a FAILURE looks
like rather than only what success looks like.

It must cover at least:

- A fresh `/setup` produces exactly TWO categories and TEN channels, with the two arcade channels
  under 🎮 ARCADE GAMES and not under 🪧 NOTICE BOARD.
- An existing guild gains the arcade category and both channels on the NEXT BOOT with no `/setup`
  re-run, and posts ONE summary repair notice rather than two.
- Deleting `⚔️challenges` rebuilds it under the arcade category.
- Running setup twice is a no-op: no duplicate channels, no reposted intro cards.
- `/self-destruct` leaves no orphan category.
- An invite-only room: the opener, the accepted player and one spectator see it; a fourth member
  does not. The spectator cannot type and cannot open a thread, but CAN react.
- A public room: every member sees it, exactly two can type, and the channel carries exactly ONE
  @everyone permission overwrite (check this in Discord's own channel permission UI).
- On finish: nobody can type, the result card is posted, and Archive now appears.
- Archive now deletes the channel immediately; left alone it clears within about 5 minutes of the
  4 hour mark.
- Restarting the bot mid-room leaves the room fully playable.
- Opening a second room as the same host is refused with a jump link to the first.
- A public rock-paper-scissors room: a spectator sees neither throw until the reveal. This is the
  one the plan calls unforgivable.
- A hosted hangman round with a custom word: the word appears in exactly ONE message, the result
  card. Wrong guesses 2, 4 and 5 each reveal a hint as its own post. The host cannot guess.
- A word containing a digit, a space, an accent, or fewer than three distinct letters is refused
  with a SPECIFIC reason each time.
- `/mini-game hangman` OUTSIDE a room behaves exactly as it does today, and is refused INSIDE one.
- A battleship match: neither player can see the other's unfired ships in any surface, including
  scrolling the transcript back. A player who walks away is forfeited rather than freezing the room.
- A six player hold em tournament runs to a single winner. A three-way all-in for different amounts
  pays correct main and side pots. A player who closes Discord is force folded and the table
  continues.

Flag prominently at the top of the checklist that NONE of this is reachable until the owner runs
`npm run deploy`, and that the deploy is now LOAD BEARING rather than optional: the
`/mini-game coin-flip`, `dice-roll` and `rps` subcommands had their `opponent` option removed, so
until the commands are re-registered every Discord client still shows the OLD builder with a
required opponent and silently ignores what a member types into it.

## What NOT to do

- Do NOT fix anything you find. Report it. A QA pass that silently repairs gives a green result and
  no record of what was broken.
- Do NOT edit any test to make it pass.
- Do NOT deploy, push, commit, install, or build.
- Do NOT treat "not deployed" as a defect. Nothing in this arc has shipped; that is the point.
- Do NOT trust a document over the code, including the handoff and including this prompt.
- Do NOT add features, refactor, or tidy. If you notice unrelated debt, list it under a separate
  heading and leave it alone.

## Deliverables

1. A written QA report with: the three gate results with exact numbers; each grep with its count;
   a pass/fail line per mutation spot-check; a pass/fail line per seam in Part 4 with the file and
   line you read; and a clearly separated FINDINGS section.
2. The guild QA checklist from Part 5, as a standalone markdown file at
   `roadmaps/audits/game-rooms-guild-qa-checklist.md`.
3. `git status` output proving the working tree is exactly as you found it, with every mutation
   restored.

Rank findings by whether they would be visible to a member, since this arc's whole failure mode is
things that look correct on screen.
```

## What I added that you did not ask for

- **A report-don't-repair guardrail, stated three ways** — the single highest-value line here. A QA
  session that fixes as it goes hands you a green result and no list of what was wrong.
- **The `levelingWiring` re-run instruction** — that test's budget was raised this session, so a red
  there now means something real. Without this note a QA session would dismiss it as the known flake.
- **"What a failure looks like" per guild step** — a checklist that only describes success gets
  ticked off by someone who saw nothing happen.
- **The `addUserOption` manual read** — the grep alone returns seven legitimate hits, so a naive
  "must be zero" check would report a false failure.
- **The comment-defeats-the-grep warning** — this actually happened during the build: an explanatory
  comment quoted the forbidden phrase and tripped its own completion check.
- **The MUST NOT command list** — `npm install` runs a build via postinstall and `npm run deploy`
  registers global commands, so both are genuinely destructive in this repo.
- **The deploy-is-load-bearing flag** — the removed `opponent` option means the in-between state is
  worse than a missing command, which a QA session would not guess.
- **"Rank findings by member visibility"** — this arc's failure mode is things that look right.

## Iterating

- If the session starts fixing things anyway, append: "You have violated the report-only rule.
  Revert every change with `git checkout -- <path>` and re-report."
- If you want it to fix as well as find, change the "What NOT to do" first bullet to: "Fix only what
  a test already proves is broken, one commit per finding, and list anything you chose not to fix."
- To scope it to one plan, delete the Part 4 items and Part 5 bullets belonging to the other, and
  say which phases are in scope at the top.
- If the guild checklist comes back thin, append: "Expand Part 5 so each line names the exact
  channel, button, and expected message text."

## Sources

- Codebase: `roadmaps/handoffs/dero-arcade-and-games-handoff-2026-08-12.md`,
  `TODO-PLANS/dero-game-rooms-master-plan.md`,
  `TODO-PLANS/dero-leveling-and-games-master-plan-2026-08-10.md`,
  `SACRED_FILES/STATE.md`, `SACRED_FILES/TECH_DEBT.md`, `SACRED_FILES/2026-08/WIP.md`,
  `DeroDiscordBot/CLAUDE.md`, and the feature source under `src/features/game-rooms/` and
  `src/features/games/`.
- No web research: every constraint here comes from this repo's own plans, ledgers and code.
