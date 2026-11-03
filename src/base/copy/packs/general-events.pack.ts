import type { IEmbedField, IPluginCopy } from "../types.js";
import { COLORS, FOOTER, AUTHOR } from "../brand.js";
import { rokCommanderCopy } from "./rok-commander.pack.js";

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
		// The welcome card under the greeting, neutral voice. See the
		// rok-commander pack's greeter.card comment.
		card: {
			kicker: "NEW MEMBER",
			title: (name: string) => `Welcome, ${name}`,
			subtitle: (guildName: string) => `Glad you found ${guildName}`,
			memberCount: (count: number) => `Member number ${count.toLocaleString("en-US")}`,
		},
	},

	listEvents: {
		title: "📅 Active Events",
		noEvents:
			"📭 No active events are configured for this server yet.\n\n" +
			"Run `/events stream weekly` for weekly streams or `/events stream announce` for one-off events.",
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

	// Stubbed: /events kvk-season is a ROK-only command. General-events
	// guilds use /events stream weekly instead, which has its own copy
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

	// The one button a confirm carries when Discord refuses its modal (2026-10 item 257,
	// owner item 12): showConfirm in utils/textModal.ts. Its Submit and this button run the
	// same handler, so the word is the same in both packs.
	confirm: {
		button: "✅ Confirm",
	},

	// The title over a private text answer shown as a notice modal (2026-10 item 254
	// Phase 5b), one per feature whose copy lives only in the packs. Discord cuts a modal
	// title at 45 characters. Both packs carry the same words: a title names the feature.
	notice: {
		leaderboard: "🏆 Leaderboard",
		secretCode: "🔐 Secret code",
		kvkSeason: "⚔️ KvK season",
		events: "📅 Events",
		gameRequests: "🗳️ Game requests",
		poll: "🗳️ Poll",
		powerUps: "⚡ Power ups",
		schedule: "📅 Schedule",
		// The areas Phase 1c of 2026-10 item 263 titled: every refusal outside the game rooms
		// that is a state, not a failure, opens under its area rather than the error title.
		setup: "🏰 Setup",
		server: "🛠️ Server",
		leveling: "📈 Leveling",
		community: "🧭 Community",
		arcade: "🎰 Arcade",
		commands: "📜 Commands",
		rules: "📖 Rules",
		ownerTools: "👑 Owner tools",
		// 🏪dero-market's states (2026-10 item 267 Session 2a): chips off here, the day's buys
		// spent, nothing to sell, a wallet short of one coin.
		market: "🏪 Dero market",
	},

	// The words utils/answerInChannel.ts shows itself. Discord cuts a notice title at 45.
	answerInChannel: {
		// A press on someone else's confirm then act prompt, which only its asker may answer:
		// a refusal, so a notice titled for what it is (2026-10 item 263 Phase 1c).
		notYoursTitle: "🔒 Not your prompt",
		notYours: "This prompt belongs to the member who asked for it. Run the command yourself to get your own.",
	},

	arrival: {
		title: "📺 The bot is here.",
		description: (guildName: string, ownerId: string) =>
			`Hey <@${ownerId}>,\n\n` +
			`I have joined **${guildName}**.\n\n` +
			"Before I can do anything useful, I need one thing from you:\n\n" +
			"**Run `/setup` and pick an admin role.**\n\n" +
			"Once that is done your admins get into 🏰 DERO HEADQUARTERS, where I walk you through the rest.",
	},

	// ── pairing claim code DM (FUTURE_PLANS item 63) ──
	// Same role as the rok-commander pairingCode, in plain streamer voice.
	// Names the code, the 15 minute expiry, where to paste it, and that
	// /dero plan issues a fresh code (2026-10 item 262 Phase 4).
	pairingCode: {
		title: "🔑 Connect this server",
		description: (code: string) =>
			"Use this code to connect this server to your dashboard:\n\n" +
			`**\`${code}\`**\n\n` +
			"Open the plugin panel on your Company Uno dashboard at companyuno.com and paste it in.\n\n" +
			"The code expires in **15 minutes**. Run `/dero plan` in this server to get a fresh code.",
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
		// The admin only third category (mirrors rok-commander, 2026-10 item 257 Phase 2a).
		headquartersCategoryName: "🏰 DERO HEADQUARTERS",
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
			// The audit trail (mirrors rok-commander, post-launch plan item 11).
			adminLog: "🗒️admin-log",
			// The three admin config channels and the public commands channel (mirrors
			// rok-commander, 2026-10 item 257 Phase 2a).
			deroConfig: "⚙️dero-config",
			onboardingConfig: "🧭onboarding",
			arcadeControl: "🎰arcade-control",
			// The fourth config channel (mirrors rok-commander, 2026-10 item 263 Phase 4a).
			serverConfig: "🛠️server-config",
			commandOutput: "💬dero-commands",
			// The join log and the rules post (mirrors rok-commander, 2026-10 item 247).
			welcome: "👋welcome",
			rules: "📘rules",
			// The two ARCADE GAMES channels. Channel NAMES are universal across packs
			// (the same reason the category name is), so these match rok-commander
			// exactly; only the intro copy below differs in voice.
			arcadeRules: "📋arcade-rules",
			arcadeChallenges: "⚔️challenges",
			arcadeGames: "🕹️games",
			// Admin hosted group games (mirrors rok-commander, post-launch plan item 3).
			partyGames: "🎉party-games",
			// The rated games' challenges and the network board (mirrors rok-commander,
			// 2026-10 item 254, Arcade 5).
			arcadeRatedChallenges: "🏆rated-challenges",
			// The coin market (mirrors rok-commander, 2026-10 item 267 Session 2a).
			deroMarket: "🏪dero-market",
			// The two voice rooms, universal names for the same reason (mirrors
			// rok-commander, 2026-10 item 235).
			meetingVoice: "🏛️ Meeting Hall",
			arcadeVoice: "🎮 Arcade Lounge",
		},
		// The setup invitation DM, in plain streamer voice (mirrors rok-commander,
		// 2026-11 item 285 Phase 1). Same {{mention}} and {{server}} tokens.
		invitationDm: {
			title: "🏰 One step to set me up",
			body:
				"I have joined **{{server}}**. One command gets me ready there.\n\n" +
				"Open 🔒admin in that server and press **Set up Dero**, or press {{mention}} and run it there. I will build 🏰 DERO HEADQUARTERS and walk you through the rest from there.\n\n" +
				"Only you, the server's owner, can run it.",
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

		// The invite card in #command-center (mirrors rok-commander), in plain voice.
		inviteCard: {
			title: "📺 Add Dero to your server",
			description: "Running a community of your own? Add Dero to your server and let the events, reminders, and rankings run themselves.",
			buttonLabel: "Add Dero to your server",
			buttonEmoji: "➕",
		},

		commandGuide: {
			title: "📖 Member Commands",
			description:
				"The slash commands every member can run today, and the buttons below open the most used ones just for you. The full command set lives in the admin channel.",
			fields: [
				{
					name: "🏆 Leaderboard",
					value: ["`/leaderboard`", "View participation rankings."].join("\n"),
				},
				{
					name: "📋 Events",
					value: ["`/events list`", "View all configured events."].join("\n"),
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
						"`/account view:levels`",
						"See who is most active in the server, this week, this month, or all time.",
						"`/rating`",
						"Your arcade rating in Hold'em, Battleship, Monopoly and Blackjack, the server's best, and the luckiest players.",
						"`/account view:achievements`",
						"What you have unlocked and what is closest. A few stay hidden until you earn them.",
					].join("\n"),
				},
			] satisfies IEmbedField[],
		},

		adminCommandGuide: {
			title: "🔒 Admin Command Guide",
			description:
				"The slash commands available to admins on this server. Each has a button below this guide that opens it with a form.\n\n" +
				"Members never see this guide, the admin channel is role-gated.",
			fields: [
				{
					name: "📺 Stream / Schedule Commands",
					value: [
						"`/events stream weekly`",
						"Set up a weekly recurring reminder on a fixed day and time.",
						"`/events stream announce`",
						"Schedule a one-off reminder for a specific future date and time.",
						"`/events stream soon`",
						"Post a quick going-live announcement. One-shot, no reminder.",
						"`/events pause`",
						"Pause reminders for one event without deleting it, or for every event when you name none.",
						"`/events resume`",
						"Resume one paused event, or every paused event when you name none.",
					].join("\n"),
				},
				{
					name: "📋 Event Management",
					value: ["`/events list`", "See every configured event.", "`/events delete`", "Remove a configured event."].join("\n"),
				},
				{
					name: "🛠️ Server Settings",
					value: [
						"`/server channels`",
						"Hide, show or rename the channels Dero manages.",
						"`/server`",
						"Channel auto heal, leaderboard tracking and the day the leaderboard week starts.",
						"`/leveling settings`",
						"Leveling: rates, the level cap, where level ups post, which channels count, rewards and boosts.",
						"`/leveling xp`",
						"Correct a member's XP or level, reset a member or the server, or export it all.",
						"`/dero-config`",
						"Dero's voice: the switch, Listen, who may give Dero tasks and the calls Dero may join.",
						"`/arcade`",
						"The arcade: on or off, bot opponents, how far a challenge reaches, the monthly post, network blocks and chips.",
					].join("\n"),
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

		// 🗒️admin-log's intro (mirrors rok-commander, post-launch plan item 11).
		adminLog: {
			title: "🗒️ Admin Log",
			description:
				"One line for every admin action Dero sees: schedule and event changes, settings changes, power-up toggles, voice list edits and self destruct attempts.\n\n" +
				"Each line names who did it and when. Only Dero posts here, so the trail stays complete.",
		},

		// The 🏰 DERO HEADQUARTERS config channels (mirrors rok-commander, 2026-10 item 257
		// Phase 2a). Admin copy is practical in both packs, so these three match it.
		deroConfig: {
			title: "⚙️ Dero Config",
			description:
				"Dero's voice and Dero's own settings live here: which voice rooms Dero may join, the voice switch and the rest of `/dero-config`.\n\n" +
				"This channel's setup steps arrive here, one step at a time.",
		},
		onboardingConfig: {
			title: "🧭 Onboarding",
			description:
				"Discord Community and Onboarding for this server: the member role, the channels a newcomer sees first and how they get in.\n\n" +
				"This channel's setup steps arrive here, one step at a time.",
		},
		arcadeControl: {
			title: "🎰 Arcade Control",
			description:
				"The arcade and its economy: chips, the arcade switches, registering for the rated network and this server's rating standing.\n\n" +
				"This channel's setup steps arrive here, one step at a time.",
		},
		serverConfig: {
			title: "🛠️ Server Config",
			description:
				"This server's own settings: the KvK season, the stream schedule, events, the server's channels, leveling and XP, and the server switches.\n\n" +
				"Every admin answer that belongs to no other channel posts here.",
		},
		// 💬dero-commands' intro, plain voice.
		commandOutput: {
			title: "💬 Dero Commands",
			description: "This is the place to run Dero's commands.\n\nIt is open to every member, so chat away.",
		},

		// Rules only, same structure as rok-commander's, plain voice. The two packs
		// differ in VOICE, never in keys: IPluginCopy is derived from the rok-commander
		// pack, so a key in one and not the other is a compile error.
		arcadeRules: {
			title: "📋 Arcade rules",
			description:
				"Every game in this arcade is open to everyone, and every one starts from 🕹️games. Only a ranked match ever costs chips. These are the rules each match follows.",

			roomTitle: "🏛️ How a room works",
			roomBody:
				"A match that takes more than a moment gets its own room under this category. The host decides who can see it: **Invite only** shows it to the members the host picks, and **Open to all** lets anyone hit **Join**, after which the host picks who plays.\n\n" +
				"Only the players can talk in a room; everyone who can see it can watch and react. When the match ends the room is locked and the result gets posted. The host can clear it right away with **Archive now**, and left alone it clears itself a few hours later. The record of every move outlives the room.",

			slotTitle: "🪑 One room per host",
			slotBody:
				"You can host one room at a time, and a challenge still gathering players counts as one. Finish it, give it up, or let it close, and the next one is yours.",

			idleTitle: "⏳ Idle rooms close",
			idleBody: (idleMinutes: number, monopolySeatHours: number): string =>
				`A room where nobody acts for ${idleMinutes} minutes is closed as abandoned, so a forgotten match never holds its host's spot. ` +
				`Monopoly is the exception: each seat has ${monopolySeatHours} hours to take its turn, because a good game runs for days. ` +
				"A hangman round in play waits as long as its players do, and its host ends it with **Give up**.",

			rematchTitle: "🔁 Rematch in the same room",
			rematchBody:
				"When a match ends, **Rematch** on the result card starts the next one in the same room with the same players. The finished match keeps its record, and the new one starts its own.",

			xpTitle: "📈 What playing earns",
			xpBody: (messageXp: number, reactionXp: number, soloWinXp: number, soloOtherXp: number, dailyCap: number): string =>
				`Every message earns ${messageXp} XP and every reaction ${reactionXp}. A game against Dero in 🕹️games pays ${soloWinXp} for a win and ${soloOtherXp} for anything else. ` +
				`Those three together stop at ${dailyCap} XP a day, and the day resets at midnight Central time.\n\n` +
				"A match against another member pays in full, win or lose, and a match in its own room pays more than one played in a channel. Check your level with `/account`.",

			ratingsTitle: "🏆 Ratings and the luck board",
			ratingsBody: (provisionalGames: number, minRatedHands: number, luckMinDecided: number): string =>
				"Only games of skill are rated: Texas Hold'em, Battleship, Monopoly and Blackjack. Every finished match moves each player's **rating**, " +
				`and a rating from fewer than ${provisionalGames} rated matches shows a **?** while it settles. ` +
				`A Hold'em table counts once ${minRatedHands} hands are dealt, running out of time in Battleship counts as a loss, and a room closed as abandoned moves no rating. ` +
				"A Blackjack table is rated against the dealer: finish above your buy in and you beat the house, level with it is a draw, below it a loss. Hangman is played together, so it is never rated.\n\n" +
				"Coin flip and dice roll are games of chance and are never rated. " +
				`Played against another member, they count toward this month's luck board instead, scored by wins above an even split, and a member shows up there from ${luckMinDecided} decided games. ` +
				// Rock paper scissors left the luck board (2026-10 item 280, owner ruling).
				"Rock paper scissors is a game of choice, not luck, so it is neither rated nor counted on the luck board. " +
				"`/rating me` shows yours, `/rating board` the top players here in one game, and `/rating luck` the luckiest.",

			chipsTitle: "🪙 Chips only move in ranked matches",
			chipsBody: (monopolyBuyIn: string): string =>
				"A **Rated** Hold'em or Blackjack table plays for a chip buy in from your wallet, and every chip a table holds goes back to the wallets when it ends. " +
				`A **Rated** Monopoly match costs each player ${monopolyBuyIn} and the winner takes the whole pot. Monopoly money stays on the board and never becomes chips. ` +
				"A **Rated** Battleship challenge can carry a chip wager both captains pay, and the winner takes both. " +
				"Once a ranked Hold'em, Monopoly or Battleship match begins, a player who leaves, surrenders, is removed, times out of it or leaves the server forfeits their chips to the winner, and Dero shows the amount before you confirm. " +
				"A **Casual** match never takes or pays a single chip: it plays with pretend chips that disappear when it ends, and so does a network table, a table with Dero bots, and a Blackjack table against Dero alone. " +
				"Leaving a Blackjack table cashes out your stack, and a bet already in play is lost.",

			houseRulesTitle: "📜 House rules",
			houseRulesBody: (cutCardPercent: number): string =>
				"**Monopoly:** the host rolls first, and a player bankrupt to the bank returns every lot unowned, with no auction. " +
				"**Battleship:** the host fires first. " +
				// The dead button rule (2026-10 item 280, owner ruling).
				"**Hold'em:** the big blind moves one seat every hand, so nobody skips it when a player busts; when last hand's big blind is gone, that hand has no small blind. " +
				"**Hangman:** guess single letters only, never the whole word. " +
				"**Coin flip:** nobody calls it; heads is the challenger. " +
				`**Blackjack:** US rules from a six deck shoe, with no insurance or even money, and a blackjack pays 3 to 2 rounded down. The dealer peeks for blackjack before anyone acts, and a cut card reshuffles the shoe once about ${cutCardPercent} percent of it is dealt. ` +
				// A ranked table is shared (2026-10 item 276, owner decisions D13 to D16); who may take
				// a seat mid game follows lateSeatRefusalOf (2026-10 item 280).
				"A **Rated** table needs two players to start, and while it deals anyone can take an empty seat at one open to all, joining at the next hand. An invite only table takes nobody new, and a player who left it or went broke can't sit back down. A table against Dero alone is just for fun, free and unrated.",

			voteButtonLabel: "Don't see your favorite game?",
		},

		arcadeChallenges: {
			title: "⚔️ Challenges",
			description: "Every challenge shows up here, except rated ones, which go to 🏆rated-challenges. Start one from 🕹️games.",
		},

		// Same one line shape as rok-commander's, plain voice.
		arcadeRatedChallenges: {
			title: "🏆 Rated Challenges",
			description: "Hold'em, Battleship, Monopoly and Blackjack challenges show up here, each with its badge: **RATED** counts toward `/rating` and plays for chips, **CASUAL** does neither. Start one from 🕹️games.",
		},

		// Same two message structure as rok-commander's, plain voice.
		arcadeGames: {
			title: "🕹️ Games",
			description:
				"Every game in the arcade starts here. Host one for yourself, play Dero right away, or challenge a member from the board below. The rules are in 📋arcade-rules.",

			rosterTitle: "🎮 The games",
			roster: [
				{ name: "🪙 Coin Flip", how: "One coin decides it. Flip against Dero here, or challenge a member from the board." },
				{ name: "🎲 Dice Roll", how: "Both roll a d20 and the highest wins. Against Dero here, or a member from the board." },
				{ name: "✊ Rock Paper Scissors", how: "Throw against Dero here, or face a member who picks in secret." },
				{ name: "🪢 Hangman", how: "Guess a word alone, from a category you pick, or open a room where the host writes the word." },
				{ name: "🃏 Blackjack", how: "Beat the dealer alone for fun, or open a table of up to five; a Rated table open to all takes new players while it deals." },
				{ name: "🚢 Battleship", how: "Fleets are placed for you, one shot a turn. Head to head, from the board." },
				{ name: "🃏 Texas hold em", how: "Up to six buy in with equal stacks, and the last player with chips wins. From the board." },
				{ name: "🏠 Monopoly", how: "Two to six players on one board, and a good match runs for days. From the board." },
			],

			playTitle: "🎯 Play now",
			playBody:
				"The first row sets up a game for you alone, or a blackjack table others can join. The second opens a room where you play Dero: a coin flip, a dice roll, or rock paper scissors. The list below them starts a solo hangman round from the category you pick. The last row is your daily: one fortune reading a day, and your daily chip claim.",

			soloLuckLabels: {
				coinflip: "Coin flip with Dero",
				diceroll: "Dice with Dero",
				rps: "Rock paper scissors with Dero",
			},
			hangmanCategoryPlaceholder: "Solo hangman: pick a word category",
			dailyLabels: {
				fortune: "Fortune",
				claim: "Claim daily rewards",
			},

			boardTitle: "⚔️ Challenge a member",
			boardDescription:
				"Pick a game below and its card gets posted in ⚔️challenges, or in 🏆rated-challenges for a rated game. You choose whether the room is **Invite only** or **Open to all** and who may watch, and once the players are in, a room is created and the match plays out inside it.",
		},

		// 🎉party-games' intro, plain voice (mirrors rok-commander, post-launch plan item 3).
		partyGames: {
			title: "🎉 Party Games",
			description:
				"When an admin starts a party game, everyone plays together here. A hangman round opens in this channel for the whole server at once, and admins can host a Texas hold em table or a Monopoly match from here too, with its challenge posted in 🏆rated-challenges.\n\n" +
				"Upcoming party games are announced in 📢announcements, and the list of who is coming lives in 🔜upcoming-events. RSVP there so the host knows to wait for you.",
		},

		// 🏪dero-market's intro, plain voice (mirrors rok-commander, 2026-10 item 267 Session 2a).
		deroMarket: {
			title: "🏪 Dero Market",
			description: (rate: { buyPrice: string; sellPrice: string; dailyCap: string }): string =>
				"Trade chips for Dero coins and coins back for chips.\n\n" +
				`**Buy.** One Dero coin costs ${rate.buyPrice}, up to ${rate.dailyCap} a day across every server.\n` +
				`**Sell.** One Dero coin pays ${rate.sellPrice}, as many as you hold.\n\n` +
				"Press a button below. You see both balances before you trade, and every finished trade is posted here with its trader's name.",
			closed:
				"Chips are switched off in this server, so the market is closed here. Your chips and coins are yours in every server, and the market is open wherever chips are on.",
		},

		// ── the voice rooms' intro (2026-10 item 245 Phase 4b) ──────────────
		// Same card as rok-commander's in plain voice: Join, Leave and Status sit
		// beneath it, and voice is promised only where an admin switched it on.
		voiceRoom: {
			title: "🎙️ Dero in This Room",
			description:
				"Where an admin has switched Dero's voice on, a member on Dero's task list who is in this call can bring Dero in with **Join** and send it away with **Leave**. **Status** shows anyone where Dero is.\n\n" +
				"In a call Dero listens only to members on its task list. Their speech goes to ElevenLabs to become text, and Dero keeps no audio and no transcript.",
			joinLabel: "Join",
			leaveLabel: "Leave",
			statusLabel: "Status",
		},

		adminWelcome: {
			title: "🔒 Admin Channel",
			description: (ownerId: string, adminRoleId: string) =>
				`Hey <@${ownerId}>, you finished setup.\n\n` +
				`Members with <@&${adminRoleId}> can also use this channel to operate the bot.\n\n` +
				"From here you can configure events, manage reminders, and check the dashboard.\n\n" +
				"*Members of the server cannot see this channel.*",
			setupButtonLabel: "Set up Dero",
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

		// Member role gating, key for key with rok-commander's, plain voice. Posted
		// once per guild by CommunityGatingAnnouncement; see the comment there.
		gatingAnnouncement: {
			member: {
				title: "🔒 Channels Now Need the Member Role",
				description: (memberRoleId: string) =>
					`This server's channels are now open to members with <@&${memberRoleId}>, which you get by finishing Discord's Onboarding. ` +
					"Without it, only the introductions channel is visible.\n\n" +
					"You can read this, so you already have it. If someone tells you the channels disappeared, they can open **Channels & Roles** at the top of the channel list and choose **Retake Onboarding**.\n\n" +
					"Nothing else changed. Levels, records and matches are all where you left them.",
			},
			admin: {
				title: "🔒 The Member Role Now Gates the Channels",
				description: (memberRoleId: string) =>
					`This server is a Discord Community, so the member role you chose in \`/setup\`, <@&${memberRoleId}>, now decides who sees my channels. ` +
					"Without it a member sees only the introductions channel. With it they see every public channel and both voice rooms. The admin channels are unchanged.\n\n" +
					`**Check one thing now:** your server's Onboarding must give new members <@&${memberRoleId}>, or every newcomer stops at introductions. You set that in Server Settings, under Onboarding.\n\n` +
					"Members who already hold the role see no change. Anyone who lost sight of a channel can open **Channels & Roles** and choose **Retake Onboarding**.",
			},
		},

		// The join and leave log, key for key with rok-commander's, plain voice.
		welcome: {
			title: "👋 Welcome Log",
			description:
				"Dero notes every member who joins or leaves the server here.\n\n" +
				"Say hi to newcomers in 📜introductions, where they can answer.",
			joinTitle: "👋 Member joined",
			joinLine: (displayName: string): string => `**${displayName}** joined the server.`,
			leaveTitle: "🚪 Member left",
			leaveLine: (displayName: string): string => `**${displayName}** left the server.`,
		},

		// The rules post. The rules themselves are the owner's words, shown verbatim
		// in every pack, so this reads rok-commander's one copy rather than a second
		// that could drift from it.
		rules: {
			title: "📘 Server Rules",
			defaultMarkdown: rokCommanderCopy.channelContent.rules.defaultMarkdown,
			editButtonLabel: "Edit rules",
		},

		// The notice board tutorial cards, key for key with rok-commander's, plain voice.
		tutorial: {
			intro: {
				title: "📜 Introductions",
				body:
					"Where newcomers say hello. Unlike most of Dero's channels, members can post here. Dero greets each new member here with a question, and they introduce themselves by replying with a line or two about who they are and what brought them in. The greeting stays pinned, so the chat never buries it.",
			},
			announcements: {
				title: "📢 Announcements",
				body:
					"Where every event reminder and stream announcement posts, pinging the member role. Members only read; the owner and the admin role can post an announcement of their own by writing in the channel. Keep Dero's role able to view and send here, or reminders cannot post.",
			},
			schedule: {
				title: "📅 Schedule",
				body:
					"One pinned post that Dero keeps current. You never edit it by hand: add, pause or delete an event with `/events` (or the 🛠️server-config steps) and the post updates itself. A recurring event, such as a weekly stream set with `/events stream weekly`, shows its next time, and that time moves forward each time its reminder fires.",
			},
			welcome: {
				title: "👋 Welcome",
				body:
					"Dero logs every member who joins or leaves here, by display name, pinging nobody. Members read it and only Dero writes. If your server already has its own welcome channel, Dero uses that one instead of building a second.",
			},
			rules: {
				title: "📘 Rules",
				body:
					"Your server rules in one pinned post. Members read them; the owner and the admin role press its Edit rules button to rewrite them, and the post updates in place. Discord Community asks for a rules channel when you turn it on, so build this one first. If your server already has its own rules channel, Dero uses that one instead of building a second.",
			},
			commands: {
				title: "📖 Command Center",
				body:
					"The pinned guide to every member command, with buttons for Account, Levels, Achievements and more. Members only read here, so the guide never gets buried; the commands themselves work in any channel.",
			},
			meetingVoice: {
				title: "🏛️ Meeting Hall",
				body:
					"A voice room for your community. Until Dero's voice is switched on in ⚙️dero-config it is an ordinary voice channel and nothing listens; once it is on, members on Dero's task list can bring Dero in with its Join button.",
			},
		},
	},

	// The game request ballot, key for key with rok-commander's, plain voice.
	gameRequests: {
		title: "🗳️ Game requests",
		intro: "Name a game you want in the arcade, or vote for one already named. The most wanted games rise to the top.",
		empty: "No game has been named yet. Be the first.",
		row: (rank: number, name: string, votes: number, isMine: boolean): string =>
			`${rank}. **${name}**, ${votes} ${votes === 1 ? "vote" : "votes"}${isMine ? " (including yours)" : ""}`,
		votePlaceholder: "Vote for a game (pick it again to take your vote back)",
		voteOption: (votes: number, isMine: boolean): string => `${votes} ${votes === 1 ? "vote" : "votes"}${isMine ? ", including yours" : ""}`,
		removePlaceholder: "Remove a game from the list (owner and admins)",
		addButtonLabel: "Add a game",
		full: (cap: number): string => `The list holds ${cap} games and it is full. The owner or an admin can remove one to make room.`,
		modalTitle: "Add a game to the list",
		modalLabel: "Game name",
		modalPlaceholder: "Chess",
		nameLength: (min: number, max: number): string => `A game name needs ${min} to ${max} characters.`,
		duplicate: (name: string): string => `**${name}** is already on the list. Find it in the list and vote for it there.`,
		added: (name: string): string => `**${name}** is on the list, and your vote is its first.`,
		voted: (name: string): string => `Your vote for **${name}** is counted.`,
		unvoted: (name: string): string => `You took your vote back from **${name}**.`,
		removed: (name: string): string => `**${name}** was removed from the list.`,
		notFound: "That game is no longer on the list.",
		adminOnly: "Only the server owner or an admin can remove a game from the list.",
		outsideGuild: "Game requests belong to a server. Open them from 📋arcade-rules.",
	},

	responses: {
		adminRolePending:
			"⚠️ **No admin role has been designated yet.**\n\n" +
			"Press **Set up Dero** below and choose the role that can configure the bot and the role your members have.",
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
			title: "🏰 Dero Is Set Up",
			description:
				"🏰 **DERO HEADQUARTERS is ready.**\n\n" +
				`<@&${adminRoleId}> now has access to the admin channel.\n\n` +
				"You can configure your first event with `/events stream weekly` or `/events stream announce`.",
		}),
		// Stubbed, kvkConfigured is the success response for /events kvk-season,
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
		// The Edit rules modal, owner and admin facing, so it reads the same as
		// rok-commander's plain wording.
		rulesEdit: rokCommanderCopy.responses.rulesEdit,
		// The 🎰arcade-control and 🛠️server-config buttons (2026-11 item 285 Phase 4).
		dismantleSuccess: "🎮 **The arcade is dismantled.** The ARCADE GAMES category and every channel in it are deleted, matches in progress included. It stays off across restarts until `/arcade on` turns it back on.",
		dismantleAlreadyOff: "🎮 **The arcade is already off.** `/arcade on` turns it back on.",
		enableStubComingSoon: "⏳ **Turning the arcade on from this card is coming soon.** Until then it stays as it is, and `/arcade on` turns it on.",
		renameInfoTitle: "✏️ Renaming a channel",
		renameInfoBody:
			"To rename a channel Dero keeps, use `/server channels rename`. Dero remembers the name you give it, so it survives auto heal and any rebuild.\n\n" +
			"Renaming it straight in Discord does not stick: while auto heal is on, Dero renames the channel back to its default name the next time it starts.",
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
			`A schedule named **${name}** already exists. Pause it with \`/events pause\` or pick a different name.`,
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
		notFound: "No schedule by that name. Use `/events list` to see what is configured.",
		alreadyPaused: (name: string) => `**${name}** is already paused.`,
		paused: (name: string) => `⏸️ **${name}** paused. Resume it with \`/events resume\`.`,
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
			`All ${total} schedules are already paused. Use \`/events resume\` with no event to resume them.`,
		paused: (count: number, skipped: number) =>
			skipped > 0
				? `⏸️ Paused **${count}** schedule(s). Skipped ${skipped} already-paused schedule(s) so their existing auto-resume dates stay intact.`
				: `⏸️ Paused **${count}** schedule(s). Resume one with \`/events resume\` and an event, or all of them with no event.`,
		pausedUntil: (count: number, skipped: number, untilUnix: number) =>
			skipped > 0
				? `⏸️ Paused **${count}** schedule(s) until <t:${untilUnix}:F> (<t:${untilUnix}:R>). Skipped ${skipped} already-paused schedule(s) so their existing auto-resume dates stay intact.`
				: `⏸️ Paused **${count}** schedule(s) until <t:${untilUnix}:F> (<t:${untilUnix}:R>). They will resume automatically.`,
		invalidDuration: "Duration invalid. Use a positive number of days, max 90.",
		partialFailure: (succeeded: number, failed: number) =>
			`Updated ${succeeded} schedule(s) but ${failed} failed. Run \`/events list\` to see which ones flipped, then retry the rest individually.`,
		failed: "Could not pause the schedules. Try again.",
	},

	continueAllSchedules: {
		noEvents: "No schedules to resume, this server has no events configured.",
		noneCurrentlyPaused: "No schedules are currently paused. Nothing to resume.",
		resumed: (count: number) =>
			`▶️ Resumed **${count}** schedule(s). Reminders will fire on each event's next scheduled time.`,
		partialFailure: (succeeded: number, failed: number) =>
			`Resumed ${succeeded} schedule(s) but ${failed} failed. Run \`/events list\` to see what is still paused, then retry the rest individually.`,
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
		// ── release 2.0.0 ── leveling, the arcade, Dero's voice, network play, onboarding ──
		// Owner decision 2026-10-24: the release prepared as 1.7.0 ships as 2.0.0, a
		// major version, because Dero's voice, its new look, the arcade, server against
		// server rankings and Community Onboarding (2026-10 item 247) land together, and
		// the seventeen retired command names break anything that typed them. The public
		// block's title is THE VERSE AWAKENS (2026-10 item 257, owner item 17, which
		// retired the borrowed evolution line and its opening sentence); the version number itself rides the
		// " (v2.0.0)" suffix postFeatureAnnouncement appends to each title.
		//
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
		// Monopoly gets its own lines in both arcade paragraphs because it is the
		// one game that runs for days; its voice referee sits in both voice
		// paragraphs because it only speaks where voice is switched on and a
		// member already brought Dero into the call.
		//
		// The drawn cards of 2026-10 item 243 get one paragraph in each embed. The
		// admin one says every card falls back to its text, and states the weekly
		// digest DM's real limits (BOT_CONSTANTS.LEVELING.WEEKLY_DIGEST_*, and no DM
		// where announcements are off), so an admin is never surprised by a DM.
		//
		// The 1.7.0 test fixes (2026-10 item 245) are folded in where each belongs,
		// every number read off BOT_CONSTANTS by hand and pinned by the test: the
		// 1 XP message and reaction with the 50 a day cap, the 🕹️games channel and
		// its solo games against Dero, the ten hangman shelves, rematch in the same
		// room, the 30 minute idle close, Hold'em's 3 minute clock and Leave table,
		// George as the ready voice, the merged commands and their buttons, and
		// /rating. A number changed in BOT_CONSTANTS is a sentence to change here.
		//
		// 2026-10 item 244's network play rides this release too (owner decision 2026-10-24,
		// Phase 5d): reach modes, host controls and network tables get a paragraph in
		// each embed. The member paragraph names what crosses servers exactly as the
		// network notice does (arcadeNetwork.consent.body), so the two never promise
		// different things. Item 247 gets a paragraph in each embed as well (👋welcome,
		// 📘rules, Enable Community and Configure Onboarding), and the admin one says
		// earlier members may need to retake Onboarding. Both embeds now sit within
		// about 30 characters of Discord's 4096 limit, so a new sentence here needs a
		// cut elsewhere.
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
			title: "⚔️ THE VERSE AWAKENS",
			description:
				"Warriors.\n\nA new look, a voice, a whole arcade, realm against realm rankings and a proper welcome for newcomers.\n\n**Renown.** The realm now keeps score. Speak in the halls, answer a comrade with a reaction, sit in an approved war room, or play a game, and you earn renown. A message or a reaction earns 1, and messages, reactions and quick games against me earn at most 50 a day, counted from midnight Central. Gather enough and you rise a level. I announce it here without pinging a soul. A secret, since you would find it anyway: level 2, level 3, level 5, level 7, level 11. Look at those numbers until you see it.\n`/account` shows your level, rank and record, `/account view:levels` who is most present, and `/account view:achievements` your honors; the buttons in #command-center show yours to you alone.\n\n**The arcade.** A new 🕹️games channel holds every game. Flip a coin, roll a die or throw rock paper scissors against me on the spot: 3 renown for a win, 1 for anything else. Hang a word alone from one of ten shelves, each word with its hint, or start a challenge for a rival. Each match gets a room of its own in the arcade, and a hangman host writes the word or lets me draw one. When a match ends, **Rematch** starts the next one in the same room. A room left 30 minutes without a move is closed, Monopoly and hangman aside. Blackjack is dealt right where you ask for it with `/mini-game blackjack`. Every move goes into the match's record.\nAt Hold'em each decision has 3 minutes on a live clock, the next hand deals itself, two timeouts in a row sit you out until you press I'm back, and **Leave table** gives up your seat and its chips whenever you choose.\nAnd **Monopoly** has arrived, for two to six, on a board of my own. You know the rules. Start a match from 🕹️games or with `/mini-game monopoly`, and settle in: a good one runs for days. `/rating` shows where you stand in Hold'em, Battleship, Monopoly and Blackjack.\n\n**Realm against realm.** Where your keepers open it, a Hold'em table can seat warriors from other servers, each playing from a channel in their own. First I tell you what crosses (your name, worn server tag, moves and ratings, never your chat) and you choose. `/rating servers` ranks realm against realm by the warriors who wear each tag, and `/rating network leave` deletes your consent and your ratings whenever you wish. A host may also hold a table to a rating band, approve each joiner or remove a player.\n\n**A proper welcome.** 👋welcome and 📘rules now stand in the notice board, and where your keepers set up Discord Onboarding, its last step opens the realm's channels to you.\n\n**Pictures.** Your `/account`, your level ups, the levels board, a fresh honor, a role you earn, every turn of blackjack and Hold'em, the end of a hangman or battleship match, a Monopoly trade, bid or victory, a welcome, a fortune and the challenge card now arrive as painted cards instead of lines of text. And on Mondays I send the most present among you a private card of your week.\n\n**My voice.** Where your keepers switch it on, I can speak. A Listen button on welcomes and on most fortunes reads the post aloud to you alone, or plays it in your voice call when I sit there with you. Members on my task list can give me small tasks with `/dero tell`, bring me into a voice call with `/dero join` or the Join button in 🏛️ Meeting Hall and 🎮 Arcade Lounge, and ask me for a Hold'em table, which I deal myself. When the host of a Monopoly match turns on the voice referee at its challenge card, I call the big moments out loud while I sit in a call with one of its players. In a call I listen only to members on my task list. Their speech goes to ElevenLabs to become text, and I record and keep nothing. Anyone on the task list can send me away with `/dero leave`.\n\nEvery game now pays Dero coins, the first currency of something larger. Gather them now, spend them later.\n\nWant something I do not do yet? Press the Suggestion Box below. I read every one of them, which is more than I can say for most prophecies.\n\nRise well, warriors. The scroll is open.",
		},
		innerSanctum: {
			title: "🏛️ THE ORACLE EXPLAINS WHAT CHANGED",
			description:
				"Those who hold the reins.\n\nVersion 2.0.0 is a major one. Here is what it does in your server and how to take it in hand.\n\n**Fewer commands, a button for each.** `/events pause` and `/events resume` act on one event, or every event when you name none. `/events stream announce`, `soon` and `weekly` hold the stream tools, `/server` holds auto heal, leaderboard tracking and the leaderboard week, `/events` lists and deletes events, and `/server channels rename` renames a channel I keep. Every admin command also has a button on the guide in your admin channel that opens it with a form and refuses anyone but the owner or an admin. Members get their own buttons in #command-center.\n\n**Leveling is already running.** Messages, reactions, approved voice channels and games earn renown. A message or a reaction pays 1, and messages, reactions and solo games against me pay a member at most 50 a day, reset at midnight Central. I read no message text, only that a message happened, where and by whom. Voice renown is off until you approve a voice channel by name. Nothing I post pings anyone.\n`/leveling settings` sets the cooldowns, the curve, which channels count, role rewards and where level ups post. `/leveling settings toggle enabled:false` turns it all off and keeps every record.\n`/leveling xp` corrects, resets a member or the whole server (it asks first) and exports it all as a file.\nI never hand out a role carrying Administrator or Manage Server, nor one above my own, so keep my role above any reward.\n\n**The arcade is open.** A 🎮 ARCADE GAMES category holds 🕹️games, where every game starts, 📋arcade-rules, ⚔️challenges and a 🎮 Arcade Lounge voice room, and the notice board gains a 🏛️ Meeting Hall voice room. Every match gets its own room under the arcade, seen only by its players unless the host opens it to all. A finished room clears four hours after the match unless its players rematch in it, and a room with no move for 30 minutes closes as abandoned, Monopoly and hangman aside. Hosts can band by rating, approve joiners and remove a player. Hold'em gives each decision 3 minutes, lets any player leave and lets the host end the table. Monopoly matches can run for days, and the host decides at the challenge card whether passed lots go to auction and whether I referee aloud.\n\n**Network play is yours to open.** `/arcade reach` sets challenges to invite only, this server (the default) or the network, where a Hold'em host may seat players from other servers. A player's name, tag, moves and ratings cross only after they accept a notice; chat never does. `/arcade server block` shuts a server out both ways.\n\n**Community and Onboarding.** 👋welcome and 📘rules join the notice board. On the admin guide, Enable Community turns on Discord Community with screening from your rules, and Configure Onboarding ends Onboarding with an answer that grants the member role, which opens my channels. Earlier members may need to retake Onboarding.\n\n**Most posts are now drawn cards**, in my new look, and each falls back to the text you know whenever a picture cannot be drawn. On Mondays at 9 am Central I send up to 25 of the week's most present members a private card of their week, never in a server where level up announcements are off.\n\n**My voice is switched off here**, and nothing listens or speaks until you turn it on. I speak in George's voice from the start, so `/dero-config enable` is the only step. The role, text channel and voice channel lists decide who may give me tasks, where I may post and which calls I may join; the voice room buttons follow them too. A monthly speech budget, $5 by default, is checked before every paid speech call. `/dero-config disable` or `/dero-config cap dollars:0` stops every speech call at once and ends a live call. In a call I hear only members on the task list; their speech goes to ElevenLabs to become text, and I keep no audio and no transcript. The Monopoly voice referee follows all of this: it speaks only into a call someone has already brought me into, and from the same monthly budget.",
		},
	},

	announceStream: {
		setupRequired: "Run `/setup` first so the bot has an announcements channel to post in.",
		invalidDateTime: "Date/time invalid. Use `MM/DD @HH:MM` like `04/26 @19:30`.",
		dateInPast: "That time is already in the past. Pick a future date and time.",
		// The typed time is read in the server's timezone (2026-10 item 263 Phase 4c), so
		// every refusal and the confirmation say which zone that is.
		zoneLine: (zone: string) => `Times are in ${zone}, this server's timezone.`,
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

	// Hold'em hand names are poker's own vocabulary and read the same in every voice,
	// so this pack points at the rok-commander words instead of keeping a second copy
	// that could drift from them.
	holdemHands: rokCommanderCopy.holdemHands,

	// ── arcade ratings (2026-10 item 244 Phase 3b) ────────────────
	// The same surfaces as the rok-commander pack's arcadeRatings, in the streamer
	// voice. "Rating", never Elo, in this voice too.
	arcadeRatings: {
		// Never read at runtime: Discord registers one command for every server, from
		// the default pack. Present because every pack carries the same shape.
		command: {
			description: "Arcade ratings: yours, this server's best, and the luckiest players",
			me: "Your rating in each rated game",
			board: "The best rated players of one game in this server",
			luck: "This month's luckiest players at coin flip, dice and rock paper scissors",
			gameOption: "Which rated game",
			scopeOption: "This server, or every player on the network who chose to be shown there",
			scopeServer: "This server",
			scopeNetwork: "The network",
			servers: "Servers on the network, ranked by the players who wear their tag",
			serversGameOption: "One rated game, or leave it out for every rated game",
			networkGroup: "Your place on the network",
			leave: "Leave the network: deletes your network consent and your ratings in every game",
		},
		provisionalMark: "?",
		provisionalNote: "A ? means the rating is still settling: fewer than 10 rated games.",
		notInGuild: "Ratings belong to a server. Run this inside one, not in a DM.",
		readFailed: "Could not load the ratings right now. Try again in a moment.",
		me: {
			title: (name: string) => `⚔️ ${name}'s arcade ratings`,
			rated: (game: string, rating: string, ratedGames: number) =>
				`**${game}**: ${rating}, from ${ratedGames} rated ${ratedGames === 1 ? "match" : "matches"}`,
			unrated: (game: string) => `**${game}**: no rated match yet`,
			footer: "Only games of skill are rated. Games of chance count toward the luck board instead.",
		},
		board: {
			title: (game: string) => `🏆 ${game} ratings in this server`,
			row: (place: number, name: string, rating: string) => `${place}. **${name}**: ${rating}`,
			empty: "Nobody in this server has a rating in this game yet. Finish a match to be the first.",
			networkTitle: (game: string) => `🌐 ${game} ratings across the network`,
			networkEmpty: "Nobody on the network has a rating in this game yet.",
		},
		luck: {
			networkTitle: "🌐 Luckiest players on the network this month",
			networkEmpty: (minimum: number) => `Nobody on the network has ${minimum} decided games of chance this month yet.`,
			title: "🍀 Luckiest players this month",
			description:
				"Coin flip, dice roll and rock paper scissors, scored by wins above an even split, plus how far each magic 8 ball reading beat the average reading. Ties do not count, and readings never count toward the decided games.",
			row: (place: number, name: string, score: string, wins: number, decided: number) =>
				`${place}. **${name}**: ${score} (${wins} of ${decided} won)`,
			empty: (minimum: number) => `Nobody has ${minimum} decided games of chance this month yet.`,
		},
		monthlyPost: {
			title: (month: string) => `📜 The arcade in ${month}`,
			titleSoFar: (month: string) => `📜 The arcade in ${month}, so far`,
			handsHeading: "Top winning hands",
			handsDetail: (count: number) => `won ${count} ${count === 1 ? "showdown" : "showdowns"}`,
			handsEmpty: "No Hold'em hand reached a showdown.",
			ratedHeading: "Top rated",
			ratedDetail: (game: string, rating: string) => `${game}, rated ${rating}`,
			ratedEmpty: "No rated match was finished.",
			luckHeading: "Luckiest",
			luckDetail: (score: string, wins: number, decided: number) => `${score} above even, ${wins} of ${decided} won`,
			luckEmpty: (minimum: number) => `Nobody reached ${minimum} decided games of chance.`,
			footer: "See your own with /rating me.",
		},
		servers: {
			title: (game: string | null) => (game ? `🏆 Network servers at ${game}` : "🏆 Network servers"),
			description: (minimum: number) =>
				`A server's rating is the mean of the top ${minimum} ratings among players who wear its server tag and chose to be shown on the network. A network server that can hand out tags needs ${minimum} such players to be ranked.`,
			row: (place: number, server: string, tag: string | null, rating: number, members: number) =>
				`${place}. **${server}**${tag ? ` [${tag}]` : ""}: ${rating}, from ${members} ${members === 1 ? "player" : "players"}`,
			empty: "No network server has enough players wearing its tag to be ranked yet.",
		},
		leave: {
			done: (ratingsDeleted: number) => {
				const kept = "Your luck in each server stays with that server.";
				if (ratingsDeleted === 0) return `You left the network and your consent is deleted. You had no rating to delete. ${kept}`;
				if (ratingsDeleted === 1) return `You left the network. Your consent and your rating are deleted. ${kept}`;
				return `You left the network. Your consent and your ratings in ${ratingsDeleted} games are deleted. ${kept}`;
			},
			nothing: "You were not on the network and had no rating, so there was nothing to delete.",
			failed: "Leaving the network did not finish just now. Run it again in a moment; it deletes whatever is left.",
		},
	},

	// The arcade's host controls read the same in every voice, like the rest of the
	// arcade's cards, so this pack points at the rok-commander words rather than
	// keeping a second copy that could drift from them.
	arcadeHostControls: rokCommanderCopy.arcadeHostControls,

	// The network tables' satellite words read the same in every voice too, for the
	// same reason as the host controls above.
	arcadeSatellites: rokCommanderCopy.arcadeSatellites,

	// And the network board, consent and door words (2026-10 item 244 Phase 5b), for
	// the same reason again.
	arcadeNetwork: rokCommanderCopy.arcadeNetwork,
};
