import type { IEmbedField, IPluginCopy } from "../types.js";
import { COLORS, FOOTER, AUTHOR } from "../brand.js";

// ── general-events copy pack (streamer-plugin spec Phase 2 scaffold) ─────
// What:  the plain-English / streamer-tone alternative to rok-commander.
//        Used for any guild whose `GuildConfig.pluginId === "general-events"`.
//        Same shape as rok-commander.pack.ts so callers stay polymorphic;
//        only the words shipped to mortals change.
// Who:   community / streamer servers that want event reminders without the
//        medieval ROK roleplay voice. The first user is the streamer who
//        prompted the streamer-plugin spec; subsequent installs route here
//        via `setAppPlugin` on the dashboard.
// When:  every embed builder and slash command response that already calls
//        `getPluginCopy(guildConfig)` pulls from this pack when the guild
//        opted into "general-events". Per-guild copy overrides via
//        `getCopyOverride` still layer on top, owners who want to nudge a
//        single string can do so without forking the pack.
// Where: lives at `@base/copy/packs/general-events.pack`. Registered in
//        `@base/copy/packs.ts` COPY_PACKS so the runtime resolver finds it.
//        AVAILABLE_PLUGINS in the dashboard's PluginsContainer + PluginShell
//        MANIFEST_REGISTRY + nexious-server PLUGIN_REGISTRY all need to know
//        about "general-events" for the full end-to-end scaffold to work.
// How:   genuinely ROK-only keys (kvkConfirmation, configureReminders,
//        seasonEnd public surface, kvkConfigured response) are stubbed with
//        "[unused in this plugin]" sentinels per spec recommendation. If the
//        bot ever routes a general-events guild through a ROK-only code path
//        the user-visible string surfaces the bug loudly instead of silently
//        rendering empty content. The streamer-tone blocks that already
//        existed inside rok-commander (`streamSchedule`, `pauseSchedule`,
//        `goLiveSoon`, `announceStream`) are reproduced verbatim, they were
//        authored in plain voice from day one and no rewrite is needed.

const STUB = "[unused in this plugin]";

export const generalEventsCopy: IPluginCopy = {
	// Brand identity (footer, Dero author, color palette) is shared across all
	// packs, see @base/copy/brand. Identical to every other pack by design
	// (the kingdom vs neutral split is words, not chrome).
	FOOTER,
	AUTHOR,
	COLORS,

	// ── new-member greeter (v1.6) ──────────────────────────────────────
	// Same role as the rok-commander greeter, in neutral voice. Welcome
	// framings woven with a random icebreaker from the shared bank
	// (@features/greeter/icebreakers), posted as message content so the ping
	// notifies. See the rok-commander pack's greeter comment for the rationale.
	greeter: {
		framings: [
			(user: string, q: string) => `👋 Welcome, ${user}! Let's break the ice: ${q}`,
			(user: string, q: string) => `🎉 New face alert. Welcome ${user}. ${q}`,
			(user: string, q: string) => `👋 Hey ${user}, welcome in. Quick one: ${q}`,
			(user: string, q: string) => `✨ Welcome ${user}! ${q}`,
			(user: string, q: string) => `🙌 Glad you're here, ${user}. ${q}`,
			(user: string, q: string) => `☕ Welcome aboard, ${user}. ${q}`,
		] as Array<(user: string, q: string) => string>,
	},

	listEvents: {
		title: "📅 Active Events",
		noEvents:
			"📭 No active events are configured for this server yet.\n\n" +
			"Run `/configure-stream-schedule` for weekly streams or `/announce-stream` for one-off events.",
		fieldName: (name: string, type: "recurring" | "one-time") => (type === "recurring" ? `🔁 ${name}` : `📌 ${name}`),
		nextOccurrenceLabel: "Next occurrence",
		scheduledDateLabel: "Scheduled date",
		intervalLabel: (hours: number) => `Repeats every **${hours} hours**`,
		seasonEndLabel: "Ends",
		postedToHeader: (channelId: string) => `📢 All reminders post to <#${channelId}>`,
		postedToHeaderUnset: "⚠️ No announcements channel configured. Run `/setup` to build the home base.",
	},

	deleteEvent: {
		confirmTitle: "🗑️ Confirm Deletion",
		confirmDescription: (name: string) =>
			`Are you sure you want to delete **${name}**?\n\n` +
			"This will stop all future reminders for this event.\n" +
			"*This action cannot be undone.*",
		successDescription: (name: string) => `✅ **${name}** has been deleted. No further reminders will fire.`,
		notFound: (input: string) => `❌ No active event found matching **${input}**.`,
		cancelled: "❌ Deletion cancelled.",
		timedOut: "⏱️ No response, deletion cancelled.",
	},

	reminder: {
		title: (name: string, minutes: number) => `📺 ${name} starts in ${minutes} minutes!`,
		description: "Heads up, getting close to start time.",
		checklistField: "📋 Pre-stream Checklist",
		timeField: "🕐 Start Time",
	},

	testReminder: {
		// [TEST] prefix is a non-negotiable safety signal, same as rok-commander.
		// The dashboard test fire feature is the same on both packs; only the
		// audience copy underneath changes.
		title: (name: string) => `[TEST] 📺 ${name}, reminder drill`,
		description:
			"This is a test reminder dispatched from the admin dashboard. " +
			"No action required. " +
			"The real reminder will arrive at the scheduled time.",
		checklistField: "📋 Pre-stream Checklist (preview)",
		timeField: "🕐 Next Real Occurrence",
	},

	// Stubbed: KvK season is a Rise of Kingdoms concept. A general-events
	// guild that hits this code path is hitting a bug. The sentinel makes
	// that bug visible instead of letting the embed render empty.
	seasonEnd: {
		title: STUB,
		description: STUB,
	},

	leaderboard: {
		title: (name: string) => `🏆 ${name}, Leaderboard`,
		footer: "Full leaderboard available on the admin dashboard",
		row: (medal: string, username: string, score: number, events: number, acknowledged: number) =>
			`${medal} **${username}**\n` + `Score: ${score} | ` + `Events: ${events} | ` + `Reminders acknowledged: ${acknowledged}`,
		medals: ["🥇", "🥈", "🥉"],
		// Shown on the pinned LeaderboardBoard when no member has earned a
		// standing in the current window yet. Neutral streamer voice; points
		// members at the two ways to climb so an empty board reads as an
		// invitation rather than a dead feature.
		boardEmptyState:
			"No standings yet this week. React ✅ to event reminders and hop in voice during events to climb the board.",
	},

	// Public schedule board pinned in the schedule channel. Title
	// "📅 Event Schedule" is universal across packs as of 2026-05-22
	// (see project_category_name_universal memory). Both packs use the
	// same generic name; per-pack voice differentiation continues in
	// other surfaces (intro embed, leaderboard, command guides).
	scheduleBoard: {
		title: "📅 Event Schedule",
		description: (announcementsChannelId: string | null) =>
			announcementsChannelId
				? `📺 Reminders post in <#${announcementsChannelId}>. Keep an eye on this channel.`
				: "⚠️ No announcements channel configured yet. An admin needs to finish `/setup` before reminders can fire.",
		noEvents:
			"The future has yet to be written.\n\n" +
			"Once configured, upcoming events, streams, announcements, and community activities will be displayed here for all to see.\n\n" +
			"Admins can set up the server's schedule from the dashboard, or the in-Discord setup commands.",
		// `seasonEnded` is reused for general-events as "season ended" wording but
		// kept as a stub since general-events guilds do not use the season concept.
		// Code paths that try to render this string are bugs; sentinel surfaces them.
		seasonEnded: STUB,
		fieldName: (name: string, type: "recurring" | "one-time") => (type === "recurring" ? `🔁 ${name}` : `📌 ${name}`),
		nextOccurrenceLabel: "Next",
		scheduledDateLabel: "Scheduled",
		intervalLabel: (hours: number) => `Repeats every **${hours} hours**`,
		// Kept as STUB, there is no season anchor on general-events guilds.
		seasonEndTopLabel: STUB,
		completedSectionTitle: "📜 Completed Events",
		completedDateLabel: "Concluded",
		footer: "Updated automatically.",
	},

	// Stubbed: /configure-kvk-season is a ROK-only command. General-events
	// guilds use /configure-stream-schedule instead, which has its own copy
	// block (streamSchedule below). Sentinels here surface the bug if any
	// code path leaks ROK config flow into a general-events guild.
	configureReminders: {
		setupRequired: STUB,
		ruinsInvalid: STUB,
		altarInvalid: STUB,
		kauInvalid: STUB,
		invalidInputsHeader: STUB,
		ruinsAfterSeason: STUB,
		altarAfterSeason: STUB,
		kauAfterSeason: STUB,
		dateConflictsHeader: STUB,
		cancelled: STUB,
		settingUp: STUB,
		timedOut: STUB,
		confirmButtonLabel: STUB,
		editButtonLabel: STUB,
		bulletList: (items: string[]) => items.map((item) => `- ${item}`).join("\n"),
		checklistPromptTitle: STUB,
		checklistPromptDescription: STUB,
		checklistAcceptButtonLabel: STUB,
		checklistCustomizeButtonLabel: STUB,
		checklistSkipButtonLabel: STUB,
		checklistModalTitle: STUB,
		checklistModalInputLabel: STUB,
		checklistModalInputPlaceholder: STUB,
		checklistResolvedAccept: STUB,
		checklistResolvedCustom: (_itemCount: number) => STUB,
		checklistResolvedSkipped: STUB,
		checklistEmptyError: STUB,
		checklistPromptTimedOut: STUB,
	},

	// Stubbed: same reasoning as configureReminders. KvK is ROK-only.
	kvkConfirmation: {
		title: STUB,
		description: STUB,
		fields: {
			seasonEnd: STUB,
			ruins: {
				name: STUB,
				interval: STUB,
			},
			altar: {
				name: STUB,
				interval: STUB,
			},
			kau: {
				name: STUB,
			},
			channel: STUB,
		},
	},

	error: {
		title: "❌ Error",
	},

	arrival: {
		title: "📺 The bot is here.",
		description: (guildName: string, ownerId: string) =>
			`Hey <@${ownerId}>,\n\n` +
			`I have joined **${guildName}**.\n\n` +
			"Before I can do anything useful, I need one thing from you:\n\n" +
			"**Run `/setup` and pick an admin role.**\n\n" +
			"Once that is done I will build the home channels and start posting reminders for any events you configure.",
	},

	// ── pairing claim code DM (FUTURE_PLANS item 63) ──
	// Same role as the rok-commander pairingCode, in plain streamer voice.
	// Names the code, the 15 minute expiry, where to paste it, and that
	// re-inviting the bot issues a fresh code.
	pairingCode: {
		title: "🔑 Connect this server",
		description: (code: string) =>
			"Use this code to connect this server to your dashboard:\n\n" +
			`**\`${code}\`**\n\n` +
			"Open the plugin panel on your Company Uno dashboard at companyuno.com and paste it in.\n\n" +
			"The code expires in **15 minutes**. Re-invite the bot to get a fresh code.",
	},

	setup: {
		// Universal category name across packs. Decision 2026-05-22: the category
		// name is the first field that goes universal across packs (the rest of
		// per-pack voice, intro copy, leaderboard framing, command guide tone,
		// stays pack-specific). Rationale: the category is the bot's brand mark
		// in every server, and ROK-coded names alienate streamer / community
		// guilds. "Community Notice Board" reads natively for alliance leaders,
		// streamers, and community organizers alike. Aligns with the item 32
		// Herald rename direction toward unified bot identity at the brand level.
		categoryName: "🪧 NOTICE BOARD",
		// Universal across packs for the same reason categoryName is: a category
		// is the bot's brand mark in every server. Keep this identical to
		// rok-commander's.
		gamesCategoryName: "🎮 ARCADE GAMES",
		devSuffix: " (dev)",
		channels: {
			// Same channel keys as rok-commander so GuildSetupManager.populateChannels
			// does not need to branch on plugin id. Display names are neutral.
			intro: "📜introductions",
			commands: "📖command-center",
			leaderboard: "🏆leaderboard",
			schedule: "📅event-schedule",
			announcements: "📢announcements",
			admin: "🔒admin",
			nextDecree: "🔜upcoming-events",
			// Eighth channel: admin-only command + control surface (mirrors rok-commander).
			adminCommands: "🎛️admin-controls",
			// The two ARCADE GAMES channels. Channel NAMES are universal across packs
			// (the same reason the category name is), so these match rok-commander
			// exactly; only the intro copy below differs in voice.
			arcadeRules: "📋arcade-rules",
			arcadeChallenges: "⚔️challenges",
			// The two voice rooms, universal names for the same reason (mirrors
			// rok-commander, 2026-10 item 235).
			meetingVoice: "🏛️ Meeting Hall",
			arcadeVoice: "🎮 Arcade Lounge",
		},
	},

	channelContent: {
		introduction: {
			title: "📺 Welcome.",
			description:
				"Hey everyone, I am the **Stream Commander** for this server.\n\n" +
				"I keep an eye on the schedule so you do not have to. I post reminders before every stream or event, " +
				"keep a pinned schedule visible, and track who showed up.\n\n" +
				"**── What I do ──**\n" +
				"📺 Reminders before every scheduled stream or event.\n" +
				"📅 A pinned schedule that stays current automatically.\n" +
				"🏆 An optional leaderboard for active members.\n" +
				"⚙️ Configurable from Discord slash commands or the dashboard.\n\n" +
				"*Stick around, the next event is on its way.*\n\n" +
				"**Want me on your server?** The button below will summon me.",
		},

		commandGuide: {
			title: "📖 Member Commands",
			description:
				"The slash commands every member can run today. The full command set lives in the admin channel.",
			fields: [
				{
					name: "🏆 Leaderboard",
					value: ["`/leaderboard`", "View participation rankings."].join("\n"),
				},
				{
					name: "📋 Events",
					value: ["`/list-events`", "View all configured events."].join("\n"),
				},
				{
					name: "💡 Suggestion Box",
					value: ["`/suggestion-box`", "Send a suggestion or feature request to the Company Uno team."].join("\n"),
				},
				// The ONE place the games touch a copy pack, and it is a command
				// LISTING rather than game content, so it does not contradict the
				// games' standing decision to stay out of the pack system (see the
				// header of src/features/games/gamesCopy.ts). Keep this field in
				// lockstep with the rok-commander pack's, same two commands, plain
				// voice instead of kingdom voice.
				// The two are named TOGETHER on purpose: /secret-code buffs the
				// fortune subcommand while living outside the command that holds it,
				// and this guide is the only surface that can make that pairing
				// obvious. It is also the first time /secret-code has appeared in any
				// guide at all, despite being live since 2026-07-04.
				{
					name: "🎲 Mini Games",
					value: [
						"`/mini-game`",
						"Duel, rock paper scissors, hangman, and a fortune reading, all under one command.",
						"`/secret-code`",
						"Redeem a code for a permanent luck buff on your fortune readings.",
						"`/account`",
						"Your profile: level, server rank, your win/loss record in every game, and your achievements.",
						"`/levels`",
						"See who is most active in the server, this week, this month, or all time.",
						"`/achievements`",
						"What you have unlocked and what is closest. A few stay hidden until you earn them.",
					].join("\n"),
				},
			] satisfies IEmbedField[],
		},

		adminCommandGuide: {
			title: "🔒 Admin Command Guide",
			description:
				"The slash commands available to admins on this server.\n\n" +
				"Members never see this guide, the admin channel is role-gated.",
			fields: [
				{
					name: "📺 Stream / Schedule Commands",
					value: [
						"`/configure-stream-schedule`",
						"Set up a weekly recurring reminder on a fixed day and time.",
						"`/announce-stream`",
						"Schedule a one-off reminder for a specific future date and time.",
						"`/go-live-soon`",
						"Post a quick going-live announcement. One-shot, no reminder.",
						"`/pause-schedule`",
						"Pause reminders for a recurring event without deleting it.",
						"`/continue-schedule`",
						"Resume a paused recurring event.",
					].join("\n"),
				},
				{
					name: "📋 Event Management",
					value: ["`/delete-event`", "Remove a configured event."].join("\n"),
				},
			] satisfies IEmbedField[],
		},

		schedule: {
			title: "📅 Event Schedule",
			description:
				"The future has yet to be written.\n\n" +
				"Once configured, upcoming events, streams, announcements, and community activities will be displayed here for all to see.\n\n" +
				"Admins can set up the server's schedule from the dashboard, or the in-Discord setup commands.",
		},

		leaderboard: {
			title: "🏆 Active Members",
			description:
				"Member participation rankings post here after each event.\n\n" +
				"Reactions and attendance count toward the score.",
		},

		announcements: {
			title: "📢 Announcements",
			description:
				"Event reminders and stream announcements post here.\n\n" +
				"*Subscribe to this channel to never miss a stream.*",
		},

		nextDecree: {
			title: "🔜 Upcoming Events",
			description:
				"A heads-up for what is coming next.\n\n" +
				"As each event moves within the next day, a fresh post appears here with its time and any prep notes.\n\n" +
				"*Posts stay so you can scroll back to confirm what was announced.*",
		},

		// One embed PER GAME, same structure as rok-commander's, plain voice. The
		// `games` array is what the renderer walks, so adding a game is one entry
		// in BOTH packs and nothing else.
		// Grouped by player count, same structure as rok-commander's and for the
		// same reason: a flat list was already crowded at five games and would be
		// unreadable at eight. Blackjack appears in two groups on purpose, because
		// it genuinely has a solo mode and a table mode.
		arcadeRules: {
			title: "📋 Arcade rules",
			description:
				"Welcome to the arcade. Every game here is free to play, open to everyone, and every match earns XP toward your level.\n\n" +
				"Pick a game below, or hit **Host a game** and one will be set up for you.",

			hostTitle: "🎲 How to host a game",
			hostBody:
				"Hit **Host a game** under this card for anything you can play alone or with a crowd. It gets set up in the right channel and announced.\n\n" +
				"For a head to head match, go to the challenge board and pick your game there. A card gets posted, you choose who can see the room, and the match plays out inside it.\n\n" +
				"You can also start any game yourself with `/mini-game`.",

			joinTitle: "🚪 How to join a game",
			joinBody:
				"An open game posts a card with a button on it. Press it and you are in.\n\n" +
				"On the challenge board, a card marked **Open to all** takes anyone who hits **Join**; the host then picks who plays, and everyone else who joined can watch. A card marked **Invite only** is visible to the people the host picked and nobody else.\n\n" +
				"Party games seat anyone who hits **Take a seat** before the deal starts.",

			// Mirrors the rok-commander pack key for key. The two packs differ in VOICE
			// only; a key that exists in one and not the other is a compile error,
			// because IPluginCopy is derived from the rok-commander pack.
			roomTitle: "🏛️ What happens in a room",
			roomBody:
				"A head to head match gets its own channel under this category. Only the players can talk in it; anyone the host invited, or the whole server if the card was open, can watch and react.\n\n" +
				"When the match ends the room is locked. Nobody can type, the result gets posted, and the host can clear it right away with **Archive now**. Left alone, it clears itself a few hours later.\n\n" +
				"The record of the match outlives the room. Every move is kept, so a locked room is still readable until it is swept.",

			levelingTitle: "📈 How playing levels you up",
			levelingBody:
				"Every match pays XP, win or lose, because turning up is what is being rewarded. Winning pays more, and a rare hand pays more again.\n\n" +
				"XP becomes levels. Check yours with `/account`, and see the standings with `/levels`.",

			soloTitle: "🎯 Play alone (1 player)",
			versusTitle: "⚔️ Head to head (exactly 2)",
			partyTitle: "🎉 Party games (2 or more)",

			solo: [
				{ name: "🃏 Blackjack", how: "Beat the dealer without going over 21." },
				{ name: "🔮 Fortune", how: "Ask the crystal ball. Do not act on the answer." },
			],
			versus: [
				{ name: "🪙 Coin Flip", how: "One coin decides it. No ties." },
				{ name: "🎲 Dice Roll", how: "Both roll a d20. Highest wins, and a tie means nobody does." },
				{ name: "✂️ Rock Paper Scissors", how: "Both players pick in secret, revealed together." },
				{ name: "🚢 Battleship", how: "Fleets are placed for you, one shot a turn. Sink every ship first." },
			],
			party: [
				{ name: "🪢 Hangman", how: "One word, six wrong guesses, everyone in the channel guessing." },
				{ name: "🃏 Blackjack table", how: "Up to five seats against the dealer. Everyone plays their own hand." },
				{ name: "🃏 Texas hold em", how: "Up to six buy in with equal stacks. Blinds climb, and the last player with chips wins." },
			],

			hostButtonLabel: "Host a game",
			hostPickerPlaceholder: "Choose a game to host",
			hostPickerTitle: "🎲 What do you want to play?",
			hostNoChannel: "The arcade is not built yet. An admin needs to run `/setup`.",
			hostFailed: "That game could not be set up. Try again in a moment.",
			hostStarted: (game: string): string => `Your ${game} is live. Go play.`,
		},

		arcadeChallenges: {
			title: "⚔️ Challenge board",
			description:
				"This is where a match starts.\n\n" +
				"Pick a game below. A card is posted here, you choose whether the room is **Invite only** or **Open to all**, and once the players are in, a room is created and the match plays out inside it.\n\n" +
				"You can hold one challenge at a time. Finish it and the next one is yours.\n\n" +
				"*A finished room is locked, then cleared away. The record of the match is kept.*",
		},

		adminWelcome: {
			title: "🔒 Admin Channel",
			description: (ownerId: string, adminRoleId: string) =>
				`Hey <@${ownerId}>, you finished setup.\n\n` +
				`Members with <@&${adminRoleId}> can also use this channel to operate the bot.\n\n` +
				"From here you can configure events, manage reminders, and check the dashboard.\n\n" +
				"*Members of the server cannot see this channel.*",
		},

		channelRepairNotice: {
			title: "🔧 A Channel Was Restored",
			description: (channelName: string) =>
				`I noticed **${channelName}** was deleted from the server. ` +
				"I have rebuilt it.\n\n" +
				"⚠️ Every channel inside **🪧 NOTICE BOARD** is required for the bot to work. " +
				"If any are removed I cannot function properly. " +
				"Please leave them in place.",
			// Summary copy for multi-channel restores in a single sweep.
			summaryTitle: "🔧 Channels Were Restored",
			summaryBody: (count: number) =>
				`${count} channel${count === 1 ? "" : "s"} ${count === 1 ? "was" : "were"} deleted from the server. ` +
				"I have rebuilt them.\n\n" +
				"⚠️ Every channel inside **🪧 NOTICE BOARD** is required for the bot to work. " +
				"If any are removed I cannot function properly. " +
				"Please leave them in place.\n\n" +
				"Restored channels:",
		},
		castleRebuiltNotice: {
			title: "🪧 NOTICE BOARD Was Rebuilt",
			description:
				"My home category was missing when I came online. " +
				"I have rebuilt **🪧 NOTICE BOARD** and every channel inside it.\n\n" +
				"⚠️ The category and its channels are required for me to work. " +
				"Please do not delete them.",
		},
	},

	responses: {
		adminRolePending:
			"⚠️ **No admin role has been designated yet.**\n\n" + "Run `/setup` to assign a role that can configure this bot.",
		noWizardPowers:
			"⚠️ **Oops. You don't have wizard powers.**\n\n" +
			"This action is reserved for the server owner and admin roles.\n" +
			"Ask one of them if you need it done.",
		ownerOnly:
			"⚠️ **Only the server owner can run this command.**\n\n" +
			"Setup must be completed by the server owner before other admins can configure the bot.",
		alreadySetup:
			"🪧 **NOTICE BOARD is already set up.**\n\n" +
			"The bot's home category and channels already exist.\n" +
			"You do not need to run setup twice.",
		setupSuccess: (adminRoleId: string) => ({
			title: "🪧 NOTICE BOARD Set Up",
			description:
				"🪧 **NOTICE BOARD has been built.**\n\n" +
				`<@&${adminRoleId}> now has access to the admin channel.\n\n` +
				"You can configure your first event with `/configure-stream-schedule` or `/announce-stream`.",
		}),
		// Stubbed, kvkConfigured is the success response for /configure-kvk-season,
		// a ROK-only command. General-events guilds never reach this code path; if
		// they do the sentinel surfaces the routing bug.
		kvkConfigured: (_seasonEnd: number, _channelId: string) => STUB,
		setupFailed: "Something went wrong during setup. Please try again.",
		kvkConfigureFailed: STUB,
		commandExecuteFailure: "Something went wrong executing this command.",
		setupChannelsPending: "Channels are still being created. Please wait a moment and try again.",
		setupPending: {
			title: "📺 Setting Up",
			description: "Building **NOTICE BOARD**... please stand by.",
		},
		setupRequired:
			"⚠️ **Setup has not been completed.**\n\n" + "An admin must run `/setup` before any commands can be used.",
	},

	// Streamer-tone copy that already lived in rok-commander.pack.ts. Reproduced
	// here verbatim because it was already authored in plain voice, no rewrite
	// needed. Eventually this and the rok-commander copy could share a base
	// fragment, but Phase 2 prioritizes correctness over deduplication.
	streamSchedule: {
		setupRequired: "Run `/setup` first so the bot has an announcements channel to post in.",
		invalidTime: "Time invalid. Use 24h `HH:MM` like `19:30` or `09:00`.",
		invalidDay: "Day invalid. Pick one of: monday, tuesday, wednesday, thursday, friday, saturday, sunday.",
		alreadyExists: (name: string) =>
			`A schedule named **${name}** already exists. Pause it with \`/pause-schedule\` or pick a different name.`,
		confirm: {
			title: "📺 Confirm stream schedule",
			description: (name: string, dayLabel: string, nextOccurrenceUnix: number) =>
				[
					`**${name}**, every **${dayLabel}**.`,
					`Next stream: <t:${nextOccurrenceUnix}:F> (<t:${nextOccurrenceUnix}:R>)`,
					"",
					"Reminders fire at the offsets configured for this guild (default: 30 and 15 minutes before).",
				].join("\n"),
			audienceLine: (mentionRoleId: string | null, channelId: string) =>
				mentionRoleId ? `Pinging <@&${mentionRoleId}> in <#${channelId}>.` : `Pinging the guild member role in <#${channelId}>.`,
			autoPauseLine: (untilUnix: number) => `Auto-pauses on <t:${untilUnix}:F> (<t:${untilUnix}:R>) unless extended.`,
			confirmButtonLabel: "✅ Save schedule",
			cancelButtonLabel: "✖️ Cancel",
		},
		cancelled: "Cancelled. Nothing was saved.",
		timedOut: "Timed out. Run the command again when ready.",
		saved: (name: string) => `✅ **${name}** is live. The bot will post reminders before every stream.`,
		saveFailed: "Could not save the schedule. Try again, if it keeps failing, ping the bot owner.",
	},

	pauseSchedule: {
		notFound: "No schedule by that name. Use `/list-events` to see what is configured.",
		alreadyPaused: (name: string) => `**${name}** is already paused.`,
		paused: (name: string) => `⏸️ **${name}** paused. Resume with \`/continue-schedule name:${name}\`.`,
		pausedUntil: (name: string, untilUnix: number) =>
			`⏸️ **${name}** paused until <t:${untilUnix}:F> (<t:${untilUnix}:R>). It will resume automatically.`,
		invalidDuration: "Duration invalid. Use a positive number of days, max 90.",
		alreadyActive: (name: string) => `**${name}** is already active.`,
		resumed: (name: string) => `▶️ **${name}** resumed. Reminders will fire on the next scheduled time.`,
		failed: "Could not update the schedule. Try again.",
	},

	pauseAllSchedules: {
		noEvents: "No schedules to pause, this server has no events configured.",
		allAlreadyPaused: (total: number) =>
			`All ${total} schedules are already paused. Use \`/continue-all-schedules\` to resume them.`,
		paused: (count: number, skipped: number) =>
			skipped > 0
				? `⏸️ Paused **${count}** schedule(s). Skipped ${skipped} already-paused schedule(s) so their existing auto-resume dates stay intact.`
				: `⏸️ Paused **${count}** schedule(s). Resume any with \`/continue-schedule\` or all with \`/continue-all-schedules\`.`,
		pausedUntil: (count: number, skipped: number, untilUnix: number) =>
			skipped > 0
				? `⏸️ Paused **${count}** schedule(s) until <t:${untilUnix}:F> (<t:${untilUnix}:R>). Skipped ${skipped} already-paused schedule(s) so their existing auto-resume dates stay intact.`
				: `⏸️ Paused **${count}** schedule(s) until <t:${untilUnix}:F> (<t:${untilUnix}:R>). They will resume automatically.`,
		invalidDuration: "Duration invalid. Use a positive number of days, max 90.",
		partialFailure: (succeeded: number, failed: number) =>
			`Updated ${succeeded} schedule(s) but ${failed} failed. Run \`/list-events\` to see which ones flipped, then retry the rest individually.`,
		failed: "Could not pause the schedules. Try again.",
	},

	continueAllSchedules: {
		noEvents: "No schedules to resume, this server has no events configured.",
		noneCurrentlyPaused: "No schedules are currently paused. Nothing to resume.",
		resumed: (count: number) =>
			`▶️ Resumed **${count}** schedule(s). Reminders will fire on each event's next scheduled time.`,
		partialFailure: (succeeded: number, failed: number) =>
			`Resumed ${succeeded} schedule(s) but ${failed} failed. Run \`/list-events\` to see what is still paused, then retry the rest individually.`,
		failed: "Could not resume the schedules. Try again.",
	},

	goLiveSoon: {
		setupRequired: "Run `/setup` first so the bot has an announcements channel to post in.",
		invalidLeadTime: "Pick a lead time from the list (now / 10m / 30m / 1h / 3h / 6h).",
		announcementTitle: "📺 Going live soon",
		announcementBody: (leadLabel: string, startUnix: number, note: string | null) =>
			[`Stream starts **${leadLabel}**, <t:${startUnix}:t> (<t:${startUnix}:R>).`, note ? `\n${note}` : ""]
				.filter(Boolean)
				.join("\n"),
		posted: "✅ Announcement posted.",
		postFailed: "Could not post the announcement. Check bot permissions on the announcements channel.",
	},

	// featureAnnouncement: as of 2026-07-04 (owner decision) BOTH packs use the
	// SAME Dero kingdom-voice announcement, so this general-events block mirrors
	// rok-commander verbatim rather than translating to plain English. When the
	// next release ships, keep both packs' public + inner-sanctum blocks identical.
	// Reaffirmed 2026-08-11 at the leveling release: a plain-English variant of
	// this block had been drafted, and it was discarded rather than shipped once
	// the two packs were diffed and found byte identical. This rule is load
	// bearing precisely because breaking it fails silently, so DIFF the two
	// blocks after any edit instead of trusting that you pasted into both.
	featureAnnouncement: {
		// ── release 1.7.0 ── leveling, the arcade and its game rooms, Dero's voice ──
		// The first announcement since 1.6.1, so it carries everything this
		// release adds: leveling (production never had its announcement), the
		// arcade with a room per match, and Dero's voice. Public is Dero's kingdom
		// voice post to members; inner sanctum tells admins what is already
		// running in their server, what stays off until they turn it on, and how
		// to switch each one off. The renown paragraph lists levels 2, 3, 5, 7
		// and 11 and refuses to explain them, the same shape as the hidden prime
		// mover achievement: the discovery is the reward, so spelling it out
		// would spend it.
		//
		// Voice ships OFF in every guild, so the public block promises it only
		// where the keepers switch it on. Owner decision 2026-10-21: release copy
		// stays professional and never says where Dero's brain runs or when it is
		// offline. It also never promises always on voice (2026-10 item 216, risk
		// R9); featureAnnouncement.test.ts holds the copy to both.
		//
		// ⚠️ BOTH PACKS CARRY THIS BLOCK VERBATIM (owner decision 2026-07-04,
		// reaffirmed 2026-08-11). featureAnnouncement.test.ts fails when the two
		// drift, when a description passes Discord's 4096 character embed limit,
		// or when a long dash slips in.
		public: {
			title: "⚔️ THE REALM KEEPS SCORE, AND DERO SPEAKS",
			description:
				"Warriors.\n\nThree gifts arrive at once. I have been busy.\n\n**Renown.** The realm now keeps score. Speak in the halls, answer a comrade with a reaction, sit in an approved war room, or play a game, and you earn renown. Gather enough and you rise a level. I shall announce it here, and I shall never ping a soul doing it. A secret, since you would find it anyway: level 2, level 3, level 5, level 7, level 11. Look at those numbers until you see it.\n`/account` shows your level, your rank and your record in every game.\n`/levels` shows who is most present, this week, this month or since the beginning.\n`/achievements` shows the honors you have claimed. Some stay hidden until they are earned.\n\n**The arena.** Games now have rooms of their own. Go to ⚔️challenges, start a challenge, choose invite only or open to all, and once your rivals are gathered a room opens in the arcade for that match alone. Hangman with a word the host writes, coin flip, dice roll, rock paper scissors, battleship and Texas Hold'em are all played there, and blackjack is dealt right where you ask for it with `/mini-game blackjack`. Every move goes into the match's record, which outlives the room.\n\n**My voice.** Where your keepers switch it on, I can speak. A Listen button on welcomes and on most fortunes reads the post aloud to you alone, or plays it in your voice call when I sit there with you. Members on my task list can give me small tasks with `/dero tell`, bring me into a voice call with `/dero join`, and ask me for a Hold'em table, which I deal myself. In a call I listen only to members on my task list. Their speech goes to ElevenLabs to become text, and I record and keep nothing. Anyone on the task list can send me away with `/dero leave`.\n\nWant something I do not do yet? Press the Suggestion Box below. I read every one of them, which is more than I can say for most prophecies.\n\nRise well, warriors. The scroll is open.",
		},
		innerSanctum: {
			title: "🏛️ THE ORACLE EXPLAINS WHAT CHANGED",
			description:
				"Those who hold the reins.\n\nThree things arrived with this release. Here is what each one does in your server and how to take it in hand.\n\n**Leveling is already running.** Messages, reactions, approved voice channels and games earn renown. I read no message text: I know that a message happened, where and by whom, and nothing else. Message renown has a sixty second cooldown. Voice renown is off until you approve a voice channel by name. Nothing I post pings anyone.\n`/setup-level-system` sets the rates, the curve, which channels count, role rewards and where level ups post. `/setup-level-system toggle enabled:false` turns it all off, keeps every record, and resumes where it stopped when you switch it back on.\n`/xp` corrects, resets a member or the whole server (it asks first) and exports everything as a file.\nI will not hand out a role carrying Administrator or Manage Server, and I cannot grant a role above my own, so keep my role above any reward.\n\n**The arcade is open.** A new 🎮 ARCADE GAMES category holds 📋arcade-rules, ⚔️challenges and a 🎮 Arcade Lounge voice room, and the notice board gains a 🏛️ Meeting Hall voice room. Every match gets its own room under the arcade, seen only by its players unless the host opens it to all, and the room clears four hours after the match ends. The match record is kept.\n\n**My voice is switched off here**, and nothing listens or speaks until you turn it on. I speak in one voice made for me, so `/dero-config voice` needs that voice's id from my creator; ask for it through the Suggestion Box. Then `/dero-config enable`. The role, text channel and voice channel lists decide who may give me tasks, where I may post and which calls I may join. A monthly speech budget, $25 by default, is checked before every paid speech call. `/dero-config disable` or `/dero-config cap dollars:0` stops every speech call at once and ends a live call. In a call I hear only members on the task list; their speech goes to ElevenLabs to become text, and I keep no audio and no transcript.",
		},
	},

	announceStream: {
		setupRequired: "Run `/setup` first so the bot has an announcements channel to post in.",
		invalidDateTime: "Date/time invalid. Use `MM/DD @HH:MM` like `04/26 @19:30`.",
		dateInPast: "That time is already in the past. Pick a future date and time.",
		confirm: {
			title: "📺 Confirm planned stream",
			description: (title: string, startUnix: number) =>
				[
					`**${title}**`,
					`Starts: <t:${startUnix}:F> (<t:${startUnix}:R>)`,
					"",
					"Reminders fire at the offsets configured for this guild (default: 30 and 15 minutes before).",
				].join("\n"),
			audienceLine: (mentionRoleId: string | null, channelId: string) =>
				mentionRoleId ? `Pinging <@&${mentionRoleId}> in <#${channelId}>.` : `Pinging the guild member role in <#${channelId}>.`,
			confirmButtonLabel: "✅ Schedule it",
			cancelButtonLabel: "✖️ Cancel",
		},
		cancelled: "Cancelled. Nothing was saved.",
		timedOut: "Timed out. Run the command again when ready.",
		saved: (title: string) => `✅ **${title}** scheduled. The bot will post reminders before it starts.`,
		saveFailed: "Could not schedule the stream. Try again.",
	},
};
