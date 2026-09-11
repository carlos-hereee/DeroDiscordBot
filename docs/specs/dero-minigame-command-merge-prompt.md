# Dero minigames: merge the game commands into one /mini-game command

Drafted 2026-08-07, revised the same day after three decisions from silent. Paste the block under "The prompt" into Claude Code, opened at `C:\Users\User\Desktop\projects\company-uno`.

This prompt revises the existing master plan document only. It writes no implementation code.

**What changed in this revision.** `/secret-code` is no longer absorbed and keeps its own top level command, so the cross repo pricing copy check is gone. Early access gating is explicitly deferred, all games ship open to everyone, so the composite key work is gone. The merge is now four subcommands instead of five, and the whole job got materially smaller and lower risk.

Confirmed by silent on 2026-08-07: `/fortune` folds into `/mini-game`, and `/secret-code` is the only fun command that stays top level. That leaves two slash commands where there were five. The one consequence to hold onto is that `/secret-code` buffs a subcommand it does not live next to, which the command guide task below is written to soften.

The separate secret code decision you made is captured after the prompt, under "The secret code decision". It is a different build with its own trap, and one worth reading before you commit to it.

## The prompt

```
You are working in the company-uno repo at C:\Users\User\Desktop\projects\company-uno. The Dero Discord Bot lives inside it at DeroDiscordBot/ and is a separate git repo (TypeScript, pure ESM, Discord.js 14.25.1, Mongoose on MongoDB Atlas).

Your job is ONE thing: revise the existing master plan document at TODO-PLANS/dero-bot-minigames-master-plan-2026-08-07.md so its entire architecture assumes a SINGLE slash command named mini-game with native Discord subcommands, instead of one slash command per game. Revise the document in place. Keep its existing structure, section numbering, headings, and voice. Do NOT write, scaffold, or edit any implementation file in DeroDiscordBot/src. This is a planning revision, not a build.

THE ARCHITECTURAL CHANGE

The plan currently specs three separate commands (/duel, /rps, /hangman). The owner has decided that too many slash commands is itself a usability problem. All three collapse into one command, and the already live /fortune folds in with them.

The target command shape, using Discord's native subcommand mechanism so typing /mini-game makes Discord's own command picker list the games:

  /mini-game duel opponent:<user> flip:<dice|coin>
  /mini-game rps opponent:<user>
  /mini-game hangman
  /mini-game fortune question:<text optional> private:<true|false optional>

/secret-code stays exactly where it is, as its own top level slash command. It is NOT part of this merge and nothing about it changes in this revision.

DECISIONS ALREADY MADE, DO NOT REOPEN THEM

1. Every subcommand is open to every member. No admin gate, no Studio early access gate, no tier gate. The owner decided on 2026-08-07 to ship all games open and tighten later only if real usage justifies it.

2. /secret-code is not absorbed. Leave src/commands/fun/secret-code.ts untouched.

3. /fortune IS absorbed and becomes /mini-game fortune.

VERIFIED FACTS ABOUT THIS REPO THAT THE REVISION MUST RESPECT

Every one of these was confirmed against live code on 2026-08-07. Do not restate them as open questions.

1. The command contract is documentary, not enforced. src/base/interfaces/ICommand.ts declares data as SlashCommandBuilder, but no command file annotates its export: src/commands/fun/fortune.ts writes `export const data = new SlashCommandBuilder()` with no type annotation, and both loaders (src/main.ts's boot loop and src/deploy-commands.ts) import the module dynamically and only check that the string keys "data" and "execute" exist. This matters because calling .addSubcommand() narrows the builder's TypeScript type away from SlashCommandBuilder. The plan must instruct the builder NOT to annotate the new data export, letting inference carry the narrowed type exactly as the existing files do. If ICommand is updated for accuracy, widen its data field to a union that admits the subcommand builder type. Never resolve this with a cast to any.

2. Both runtime gates key on the command name only, and the plan must record what that costs even though no gating ships now. In src/main.ts the admin guard reads `ADMIN_COMMANDS.has(interaction.commandName)` and the early access gate reads `checkEarlyAccess(interaction.commandName, interaction.guildId)`. src/features/early-access/earlyAccess.ts keys EARLY_ACCESS_FEATURES by slash command name and documents its purpose as shipping new Dero powers to Studio guilds first, one line per feature. Once every game is a subcommand of mini-game, neither gate can address a SINGLE game: listing mini-game would gate all four at once, including /fortune, which is already live and generally available to everyone. Per decision 1 above, no gating work ships in this plan. Record the limitation in Technical Design as a documented consequence, name the fix that a future session would apply (resolve a composite key of the form `mini-game <subcommand>` when the interaction carries a subcommand, falling back to the bare command name otherwise), and state plainly that until that change lands, adding mini-game to either gate is an all or nothing switch. This is a note for a future session, not a task in any phase.

3. The deploy script replaces the whole command set, so old names retire automatically. src/deploy-commands.ts issues rest.put against Routes.applicationCommands in production. A PUT overwrites the entire registered set, so deleting the fortune command file and adding mini-game.ts deregisters /fortune with no extra step. State this so nobody writes a manual cleanup task.

4. Production registers GLOBAL commands, which propagate slowly. The same script branches on isProduction and logs a propagation note. Global application command updates can take up to an hour to reach every user. Add this to Phase 5 as a hard sequencing rule: verify propagation in a real guild BEFORE the version bump that fires the release announcement, because reference_bot_release_announcement_flow.md ties the announcement to the package.json version bump, and announcing a command members cannot yet see is worse than announcing late.

5. Discord's limits on subcommands, confirmed against current Discord developer documentation. A command supports at most 25 options total and subcommands count against that ceiling, so four is comfortable. Nesting is one level deep only: a command may hold subcommands, or subcommand groups that hold subcommands, and nothing deeper. Critically, a command that has subcommands CANNOT also carry top level options, and its bare form becomes unusable. That means there is no shared /mini-game option: the private toggle on fortune has to be declared on the fortune subcommand itself, not on the parent. There is also a combined 8000 character budget across every name, description, and choice value on the command. Record all four constraints in the plan's Constraints section.

6. Nothing user facing appears to hardcode the old command name. A grep across the command files, src/features/fortune/, src/features/power-ups/, src/features/setup/ChannelContent.ts, src/utils/embedBuilder.ts, src/base/constants/log-messages.ts, and both copy packs found /fortune only inside code comments, never inside a copy string, an embed, or a locale file. Both packs' commandGuide fields list exactly /leaderboard, /list-events, and /suggestion-box, and neither mentions a fun command. Re run that grep across the whole of DeroDiscordBot/src to confirm before finalizing, then record the result in the plan. If it holds, the code blast radius of renaming is small and the plan should say so plainly rather than implying a large migration.

7. The fortune power up button is unaffected and must stay that way. src/features/power-ups/PowerUps.ts routes its member:fortune button straight into respondWithFortune, never through the slash command, and that button rides the Summon Dero invite card built in GuildSetupManager.inviteCardComponents. The revision must state that the button, its customId, and the cooldown Map that respondWithFortune owns are all untouched, and that the merge deletes only the thin command file at src/commands/fun/fortune.ts, never anything under src/features/fortune/.

8. Stored fortune data is untouched. FortuneBuff rows are keyed by user id with a unique index on userId, so a command rename cannot orphan a redeemed buff or a pity streak. Say this explicitly so nobody writes a migration that is not needed.

9. Do not collapse the cooldowns. Each feature owns its own CooldownManager instance, and respondWithFortune's ten second window is deliberately shared between the slash command and the power up button so alternating between them cannot bypass the gate. Merging the commands must NOT introduce one cooldown for all of /mini-game, because playing hangman would then block a fortune reading. State this as an explicit non goal.

WHAT TO CHANGE, SECTION BY SECTION

Mission Brief. Restate the goal as one command carrying four subcommands. Add an assumption recording that /fortune is absorbed, that this is a user facing rename of one shipped command, and that /secret-code was deliberately left out because redeeming a code is not a game. Add an assumption that the parent command is a pure container with no top level options, per constraint 5. Add an assumption recording the open to everyone decision and that gating is deferred by choice, not overlooked.

Goal Analysis. Rewrite the functional requirements against the new invocation shapes. Add a requirement that /mini-game with no subcommand is impossible to invoke, which is Discord's behavior and not a bug to design around.

Codebase Discovery. Add the findings above as verified discoveries with their file paths, especially the name keyed gates, the PUT deploy semantics, the global propagation delay, and the untyped data export convention.

Solution Brainstorming. Add a new lettered option block for the command topology, comparing three real alternatives: native subcommands (the chosen path, because Discord's picker gives the dropdown for free and each game keeps its own typed options), a single command with a game choice option (rejected, because every game would share one option set, so opponent has to go optional even for hangman and invalid combinations become expressible), and a select menu component posted by a bare command (rejected, because it costs an extra round trip and needs a second user picker to choose an opponent). Record why the chosen path wins.

Impact Analysis. Replace the three command files in Files to create with one src/commands/fun/mini-game.ts. Add a Files to DELETE list containing only src/commands/fun/fortune.ts, and state clearly that nothing under src/features/fortune/ is deleted. Add both copy packs to Files to modify for the commandGuide entry described below. Update the dependency graph so the single command file depends on every per game handler. Add an explicit Files this plan does NOT touch entry for src/commands/fun/secret-code.ts.

Add a routing design note. The merged command file must stay thin, because this repo's own rule is that business logic never lives in a command file. Specify a dispatch table mapping subcommand name to handler, mirroring the POWERUP_ACTIONS table already used in src/features/power-ups/PowerUps.ts, so adding a fifth game is one entry rather than a new switch arm. Each handler keeps living in its own feature module, and the fortune handler is a thin call into the existing respondWithFortune.

Risk Register. Add global propagation lag as a risk with the verify before announcing rule as its mitigation. Add one risk covering the rename of a live command: members with muscle memory for /fortune will find it missing, so the release announcement has to say where it went. Keep the existing risks, adjusting any wording that assumed separate commands. Remove nothing that still applies.

Technical Design. Keep the in memory state shapes. Add the subcommand routing contract. Note that the parent command carries no options and that per subcommand options are declared inside each addSubcommand callback. Add the gate granularity consequence from fact 2 as its own short subsection.

Implementation Roadmap. Rework the five phases so Phase 1 also delivers the mini-game command shell with its dispatch table, since every later phase registers into it. Phases 2, 3, and 4 change from creating their own command file to registering a subcommand and its handler. Phase 5 absorbs three new tasks: the fortune absorption and deletion of its old command file, the commandGuide entry in both packs, and the propagation verification gate before any version bump.

Discoverability task, new and easy to miss. Neither pack's commandGuide currently lists any fun command, so four games shipping under one command would be invisible to members. Add a Phase 5 task to add a single field to commandGuide.fields in BOTH src/base/copy/packs/rok-commander.pack.ts and src/base/copy/packs/general-events.pack.ts, matching each pack's voice. That field should name /mini-game AND /secret-code together, because /secret-code buffs the fortune subcommand while living outside the command that holds it, and the guide is the only surface that can make that pairing obvious. This is also the moment /secret-code becomes discoverable at all, since it has never appeared in either guide despite being live since 2026-07-04. Note that this is the one place games touch the copy packs, that it does not contradict the plan's existing assumption that game CONTENT stays out of the pack system, and that refreshIntroEmbeds editing the pinned guide in place on boot is the sanctioned exception to this repo's no silent edits rule but does NOT substitute for the fresh announcement post the release flow requires.

The three spells in section 6b. Rewrite all three so they build subcommands and handlers instead of standalone commands. The Phase 1 spell additionally owns the mini-game shell and the dispatch table. The Phase 3 and Phase 4 spells must be told that the command file already exists and that their job is to add one subcommand plus its handler, never to create a new file under src/commands/. Every trap already documented in those spells stays, including the discord.js 14.25 bug where a select menu and a button silently drop input on a shared ephemeral message, the rule that a modal cannot be deferred and must be the first response to its triggering interaction, and the memory cleanup discipline on every state map.

Testing and CI/CD. Add cases for subcommand routing, asserting every subcommand reaches its own handler and an unknown subcommand fails loudly rather than silently. Add a regression that the fortune power up button still works after its command file is deleted.

Final Review and Execution Protocol. Update the rollback note: this change is no longer purely additive, because it deletes one live command file and renames one shipped command, so rollback means restoring that file and re running deploy. State that FortuneBuff data survives in either direction.

REPO CONVENTIONS THE REVISED DOCUMENT MUST KEEP CARRYING

No em dashes or en dashes anywhere in the document or in any copy it specifies. Hyphens inside technical identifiers like secret-code, mini-game, and rok-commander.pack.ts are correct and stay. Every local import in this codebase carries a .js suffix even though the source is .ts, because the bot is pure ESM. Non trivial branches get comments answering What, Who, When, Where, and How as relevant. The owner runs npx tsc --noEmit, npm run lint, npm run test:run, npm run build, and npm run deploy manually, so the plan writes files and never deploys.

WHAT NOT TO DO

Do not write or edit any file under DeroDiscordBot/src. Do not create a second master plan document or a v2 file; revise the existing one in place. Do not touch src/commands/fun/secret-code.ts or anything under src/features/fortune/. Do not add any early access, admin, or tier gating to the games, and do not add mini-game to BOT_CONSTANTS.ADMIN_COMMANDS or EARLY_ACCESS_FEATURES. Do not revive src/commands/events/rps.ts, eightBall.ts, sun-qoute.ts, or poll.ts, which are dead fully commented out stubs from before this bot had slash commands. Do not move game copy into the two voice copy packs; the only pack edit in scope is the single commandGuide field. Do not renumber the plan's sections or invent new top level sections beyond what is described above. Do not update any SACRED_FILES ledger in this task, because no code has shipped yet and the ledgers record shipped state.

DELIVERABLES

A revised TODO-PLANS/dero-bot-minigames-master-plan-2026-08-07.md in which every section reflects one mini-game command with four subcommands, the three appendix spells build subcommands rather than commands, /secret-code is explicitly out of scope, the open to everyone decision is recorded as a deliberate choice with its gate granularity consequence documented, and the fortune absorption is scoped. Plus a short summary in your reply naming every section you changed and every decision you had to make that the instructions above did not settle.
```

## What I added that you did not ask for

- **The gate granularity consequence, recorded rather than built.** You deferred gating, which is the right call for now. But the reason it will be awkward later is structural, not a preference: both gates key on the command name, so once the games are subcommands, gating becomes all or nothing. The prompt writes that down with the exact future fix, so the session that eventually wants it does not rediscover the problem from scratch.
- **Global propagation before the version bump.** Production registers global commands, which can take an hour to appear. Your announcement flow fires on the version bump, so without a sequencing rule you would announce a command members cannot see yet.
- **The commandGuide discoverability gap.** Neither copy pack lists any fun command today. Four games under one command would ship completely invisible to members.
- **The TypeScript narrowing trap.** `.addSubcommand()` changes the builder's type. Your existing command files survive only because none of them annotate `data`. Worth naming so nobody "fixes" it with a cast.
- **Do not merge the cooldowns.** Easy wrong turn once the commands are one, and it would make hangman block a fortune reading.
- **A rename risk for a live command.** `/fortune` is shipped and in use. The announcement has to tell people where it went, which is a copy requirement, not just an engineering one.

## The secret code decision, and the trap in it

Your idea: a list of unique codes, each redeemable exactly once, logged so a second person entering the same code is rejected. That is a clean giveaway mechanic and it is worth building. Two things to settle before it becomes a spell, because as stated it would break both codes that are already live.

**The blocker.** `GILDED-BY-SILENT` was announced publicly to every member at launch as the free gift, and `THE-GOLDEN-NOD` is named in your PRO and BUSINESS pricing as a subscriber perk. Both are designed to be redeemed by many people. Make every code single use and the public gift goes to whoever types fastest, and exactly one paying subscriber ever gets the paid perk. Single use is right for a hunt or a drop, and wrong for a broadcast gift or a recurring perk.

**The fix that costs almost nothing.** Do not replace multi use with single use. Give each code a redemption cap: one for hunt codes, unlimited for the public gift, and a per user one time rule on top so nobody double dips. That serves both models, breaks nothing live, and is the same shape item 88 already sketched.

**The real technical trap.** Single use needs an atomic claim. Today `fortuneBuffStore.grantIfHigher` reads then writes, and there is no code side collection at all, codes are a hardcoded array in `secretCodes.ts` and the only per user record is `FortuneBuff.code`, which gets overwritten the moment someone upgrades. So you cannot answer "has this code been claimed" from what exists. It needs a new model with a unique index on the code and a single `findOneAndUpdate` that filters on unclaimed and sets the claimer in one operation. Anything read then write lets two people claim the same code in the same tick.

**Worth knowing:** this is item 88, the generic redeemable code system, which you deferred on 2026-07-04 behind an explicit note that scope creep is your public enemy number one. You are allowed to change your mind. I am flagging it because you asked me to hold that line, and because the redemption cap version above is the small slice that gets you the hunt without opening the whole item.

Say the word and I will craft that as its own spell.

## Iterating

- To keep `/fortune` top level too, delete decision 3 and fact 7 through 9 from the prompt, change the target shape to three subcommands, and drop the fortune absorption from Phase 5.
- To switch the command name to `/dero`, replace `mini-game` with `dero` throughout the prompt before pasting.
- If the revision comes back having quietly added gating anyway, append: "Remove every early access, tier, and admin gate from the plan. Games are open to everyone. The only mention of gating allowed is the documented consequence note in Technical Design."

## Sources

- Codebase: `TODO-PLANS/dero-bot-minigames-master-plan-2026-08-07.md`, `TODO-PLANS/item-88-redeemable-codes.md`, `DeroDiscordBot/src/main.ts`, `DeroDiscordBot/src/deploy-commands.ts`, `DeroDiscordBot/src/base/interfaces/ICommand.ts`, `DeroDiscordBot/src/base/constants/BOT_CONSTANTS.ts`, `DeroDiscordBot/src/features/early-access/earlyAccess.ts`, `DeroDiscordBot/src/features/fortune/*`, `DeroDiscordBot/src/features/power-ups/PowerUps.ts`, `DeroDiscordBot/src/db/models/FortuneBuff.ts`, `DeroDiscordBot/src/db/stores/fortuneBuffStore.ts`, `DeroDiscordBot/src/base/copy/brand.ts`, both copy packs, `DeroDiscordBot/tsconfig.json`, `DeroDiscordBot/package.json`, `DeroDiscordBot/CLAUDE.md`, `DeroDiscordBot/CHANGELOG.md`
- Web: [Discord application commands documentation](https://docs.discord.com/developers/interactions/application-commands), [discord.js advanced command creation guide](https://discordjs.guide/legacy/slash-commands/advanced-creation), [discord.js SharedSlashCommandSubcommands reference](https://discord.js.org/docs/packages/discord.js/14.19.2/SharedSlashCommandSubcommands:class), [discord.js issue 10256, slash command builder type incompatibility](https://github.com/discordjs/discord.js/issues/10256)
