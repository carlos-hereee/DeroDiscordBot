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
		gamesCategoryName: "🎮 GAME ROOMS",
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
			// The two GAME ROOMS channels. Channel NAMES are universal across packs
			// (the same reason the category name is), so these match rok-commander
			// exactly; only the intro copy below differs in voice.
			gamesRules: "📋game-rules",
			gamesChallenges: "⚔️challenges",
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
		gamesRules: {
			title: "📋 Game rules",
			description:
				"Every game this bot runs is listed below. Anyone can play, and every match earns XP toward your level.\n\n" +
				"*Start a two player match from the challenge board. Everything else runs anywhere with `/mini-game`.*",
			games: [
				{ name: "⚔️ Duel", how: "One dice roll, or one coin flip. Winner takes it.", players: "2", who: "Challenge anyone from the board." },
				{ name: "✂️ Rock Paper Scissors", how: "Both players pick in secret, revealed together.", players: "2", who: "Challenge anyone from the board." },
				{ name: "🪢 Hangman", how: "One word, six wrong guesses, everyone in the channel guessing.", players: "Any", who: "Anyone can start one." },
				{ name: "🃏 Blackjack", how: "Beat the dealer without going over 21. Play solo, or open a table others can join.", players: "1 to 5", who: "Anyone can deal in." },
				{ name: "🔮 Fortune", how: "Ask the crystal ball. Do not act on the answer.", players: "1", who: "Anyone, any channel." },
			],
		},

		gamesChallenges: {
			title: "⚔️ Challenge board",
			description:
				"This is where a match starts.\n\n" +
				"Issue a challenge and it shows up here for your opponent to accept. Once they do, a room is created for the two of you and the match plays out inside it.\n\n" +
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
		// ── leveling release ── xp / prime milestone levels / role rewards / achievements ──
		// Public block is Dero's kingdom-voice announcement to members; inner
		// sanctum is the admin companion covering what earns xp, what is never
		// read, and how to switch it off. The public block teases the prime
		// mechanic by listing 2, 3, 5, 7 and 11 and then refusing to explain,
		// which is the same shape as the hidden prime-mover achievement: the
		// discovery IS the reward, so spelling it out would spend it.
		//
		// ⚠️ BOTH PACKS CARRY THIS BLOCK VERBATIM (owner decision 2026-07-04,
		// reaffirmed 2026-08-11 when a drafted plain-English general-events
		// variant was discarded rather than shipped). Four sub-blocks across
		// two files move together or a general-events guild reads the PREVIOUS
		// release's announcement, with nothing failing and no test catching it.
		// Diff the two packs after any edit here; identical is the invariant.
		public: {
			title: "⚔️ THE REALM NOW KEEPS SCORE",
			description:
				"Warriors.\n\nFor years I have watched this kingdom without writing anything down. A grave oversight. A realm that does not record its own deeds is a realm that forgets them, and I have decided the forgetting ends today.\n\nFrom this moment, every warrior earns renown. Speak in the halls and you earn it. Answer a comrade with a reaction and you earn it. Sit in an approved war room and you earn it. Win a duel, throw rock paper scissors, hang a word, or tempt the crystal ball, and you earn it. Renown gathers on its own. You need do nothing but be present.\n\nGather enough and you rise a level. I shall announce it here, and I shall never ping a soul doing it. Your rise is worth celebrating, not worth waking anyone for.\n\n**A secret, and I am telling you only because you would find it eventually.** Certain levels are louder than others. Level 2. Level 3. Level 5. Level 7. Level 11. Look at those numbers until you see it, and you will know exactly which levels to hunger for. I shall say no more than that.\n\nThree commands are yours now:\n`/account` shows your level, your rank in the realm, your record in every game, and the honors you have claimed.\n`/levels` shows who is most present in this realm, this week, this month, or since the beginning.\n`/achievements` shows what you have earned and what is nearly in reach. Some honors stay hidden until they are earned. I will not be telling you which.\n\nAnd because I am nothing if not generous, the games are not finished. Blackjack, battleship and texas hold em are being forged as we speak. If you want something else, press the Suggestion Box below and say so. I read every one of them, which is more than I can say for most prophecies.\n\nRise well, warriors. The scroll is open.",
		},
		innerSanctum: {
			title: "🏛️ THE ORACLE EXPLAINS THE NEW LEDGER",
			description:
				"Those who hold the reins.\n\nThe kingdom now keeps a leveling ledger, and it is **already running in your server**. I did not ask first. I am aware of how that sounds, so here is everything you need to take it in hand.\n\n**What earns renown.** Messages, reactions, approved voice channels, and all four games. Message renown has a sixty second cooldown, which is the standard across every bot of this kind and the single most effective guard against a member farming it.\n\n**What does NOT happen.** I read no message text. Not one word. I know that a message happened, which channel it happened in, and who sent it, and that is the entire input. Nothing about length, nothing about content, and no privileged intent requested to get it.\n\n**Voice renown is off until you say otherwise.** No voice channel earns anything until you approve it by name. A member sitting alone earns nothing, a muted member earns nothing, and a member who leaves the tab open all night earns steadily less.\n\n**Nothing I post will ever ping anyone.** Not a level up, not an achievement, not a milestone.\n\n**`/setup-level-system` is yours.** It sets the rates, the curve, which channels count, which voice channels are approved, role rewards and multipliers, and where level ups post. Run `/setup-level-system show` to see everything as it currently stands, including a live count of how many of your channels are earning. It writes settings only. It creates no channels and no roles.\n\n**To turn the whole thing off:** `/setup-level-system toggle enabled:false`. Nothing is deleted, and switching it back on resumes exactly where it stopped.\n\n**`/xp` is also yours**, for corrections, for resetting a member or the whole server (both ask first), and for exporting the lot as a file you keep.\n\n**One word of warning about role rewards.** I will not hand out a role carrying Administrator or Manage Server, and I will refuse it at the moment you configure it rather than failing quietly later. I also cannot grant a role positioned above my own, which is a rule of Discord's and not mine, so keep my role above anything you want me to give out.\n\nBlackjack, battleship and texas hold em are next. The Suggestion Box on the public announcement collects what your members want after that.",
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
