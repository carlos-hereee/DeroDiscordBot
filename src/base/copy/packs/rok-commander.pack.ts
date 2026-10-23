import type { IEmbedField, IRankName } from "../types.js";
import { COLORS, FOOTER, AUTHOR } from "../brand.js";

// ── ROK Commander copy pack ───────────────────────────────────────────────
// What:  the canonical "kingdom voice" copy for the original ROK Commander
//        plugin. Every static and templated string the bot renders for a
//        guild whose `GuildConfig.pluginId === "rok-commander"` (or null,
//        which the lookup treats as the back-compat default) is sourced
//        from this object.
// Who:   the legacy `embedContent` shim has been retired. Call sites now
//        resolve copy through `getPluginCopy(guildConfig)` from
//        `@base/copy/getCopy` (which honors `pluginId` and routes the right
//        pack at runtime), or import `rokCommanderCopy` / the brand constants
//        from `@base/copy/brand` directly when they need this pack specifically.
// When:  every embed, slash command response, and channel intro that has
//        ROK-flavored copy reads from this object. Per-guild owner overrides
//        (Phase 3 of the streamer plugin spec) layer on top via
//        `getCopyOverride(key, guildConfig)` before falling back here.
// Where: this file is the SHAPE of `IPluginCopy`. Sibling packs (general-events
//        for the streamer plugin, neutral pack later, etc.) must satisfy the
//        same shape so callers stay polymorphic.
// How:   moved verbatim from the previous `embed-content.ts` location with
//        zero copy edits. The file split is the architectural change; the
//        words shipped to mortals are unchanged so this can land without
//        any visual diff in Discord.
export const rokCommanderCopy = {
	// Brand identity (footer wordmark, Dero author, color palette) is shared
	// across every pack, see @base/copy/brand. Referenced here so
	// getPluginCopy(config).FOOTER / .AUTHOR / .COLORS keep resolving off the
	// pack, and so IPluginCopy (= typeof rokCommanderCopy) still carries them.
	FOOTER,
	AUTHOR,
	COLORS,

	// ── new-member greeter (v1.6) ──────────────────────────────────────
	// Welcome framings posted in the introductions channel when a member joins
	// (welcomeNewMember). Each takes the member mention AND a randomly chosen
	// icebreaker (from @features/greeter/icebreakers, a shared neutral bank of
	// ~500) and weaves them into a kingdom-voiced welcome. Posted as message
	// CONTENT, not an embed, so the ping actually notifies, Discord does not
	// fire notifications for mentions inside embed descriptions. The framing
	// carries the voice; the icebreaker carries the variety (a few framings ×
	// hundreds of questions = thousands of distinct welcomes).
	greeter: {
		framings: [
			(user: string, q: string) => `⚔️ A new challenger approaches. Welcome, ${user}. First trial: ${q}`,
			(user: string, q: string) => `🔱 The gates swing open for you, ${user}. Tell the war council: ${q}`,
			(user: string, q: string) => `🛡️ Hail and welcome, ${user}. Settle one for the realm: ${q}`,
			(user: string, q: string) => `📜 The realm gains a new soul. Welcome, ${user}. ${q}`,
			(user: string, q: string) => `🏰 Welcome to the kingdom, ${user}. ${q}`,
			(user: string, q: string) => `🐉 A fresh face in the ranks. Welcome, ${user}. Most pressing question of the day: ${q}`,
		] as Array<(user: string, q: string) => string>,
		// The welcome card under the greeting (2026-10 item 243 Phase 4). The
		// card cannot draw a mention, so it names the member and the realm in
		// plain text; the ping stays in the message content above it.
		card: {
			kicker: "A NEW SOUL ARRIVES",
			title: (name: string) => `Welcome, ${name}`,
			subtitle: (guildName: string) => `The gates of ${guildName} swing open`,
			memberCount: (count: number) => `Warrior number ${count.toLocaleString("en-US")}`,
		},
	},

	listEvents: {
		title: "📅 Active KvK Events",
		noEvents:
			"📭 No active events are configured for this server yet.\n\n" +
			"Streamers: run `/configure-stream-schedule` for weekly streams or `/announce-stream` for one-offs.\n" +
			"ROK alliances: run `/configure-kvk-season` to set up the season schedule.",
		fieldName: (name: string, type: "recurring" | "one-time") => (type === "recurring" ? `🔁 ${name}` : `📌 ${name}`),
		nextOccurrenceLabel: "Next occurrence",
		scheduledDateLabel: "Scheduled date",
		intervalLabel: (hours: number) => `Repeats every **${hours} hours**`,
		seasonEndLabel: "Season ends",
		// single destination line shown once at the top of the list. reminders
		// always post to the guild's announcements channel, so repeating it
		// per event was dead weight.
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
		title: (name: string, minutes: number) => `⚔️ ${name} starts in ${minutes} minutes!`,
		description: "Prepare now so you're ready when the event begins.",
		checklistField: "📋 Preparation Checklist",
		timeField: "🕐 Event Time",
	},

	testReminder: {
		// [TEST] prefix is not optional. it is the user-facing safety signal
		// that this fire is a drill dispatched from the dashboard and not a real alert.
		title: (name: string) => `[TEST] ⚔️ ${name}, reminder drill`,
		description:
			"This is a drill dispatched from the admin dashboard. " +
			"No warrior is expected to act on it. " +
			"The real decree will arrive at the scheduled time.",
		checklistField: "📋 Preparation Checklist (preview)",
		timeField: "🕐 Next Real Occurrence",
	},

	seasonEnd: {
		// ── season-end announcement (announcements channel) ──────
		// What:  the single message posted in #announcements when a
		//        guild's season expires. Voice leans kingdom-flavored
		//        and motivational, not transactional. The previous copy
		//        was "season concluded, run /configure-kvk-season" which
		//        read like a system status line and ignored the fact
		//        that members had spent weeks showing up for the bot.
		// Who:   every member of the guild reads this. Tone has to honor
		//        the work they put in, not just declare a state change.
		//        The admin-only mechanic ("run /configure-kvk-season")
		//        is still present because the bot owner and the alliance
		//        leadership reading this message often overlap, but it
		//        is demoted to the closing line.
		// When:  exactly once per guild per season, gated by the
		//        guild-scoped dedup in announceSeasonEnd. Never edit
		//        this by tweaking past messages, refreshIntroEmbeds is
		//        the only safe place to anchor-edit; one-shot
		//        announcements like this one stand as posted.
		title: "🏁 KvK Season Concluded, Stand Down, Heroes",
		description:
			"The campaign closes. To every warrior who answered the bell, every commander who held the line, every governor who marched out when it counted, thank you. Your discipline shaped this season.\n\n" +
			"Whether the kingdom feasts or rebuilds, the next decree always rises. When the call comes, an admin can summon the next schedule with `/configure-kvk-season`.\n\n" +
			"Sharpen your blades. The realm remembers what you did here.",
	},

	leaderboard: {
		title: (name: string) => `🏆 ${name}, Leaderboard`,
		footer: "Full leaderboard available on the admin dashboard",
		row: (medal: string, username: string, score: number, events: number, acknowledged: number) =>
			`${medal} **${username}**\n` + `Score: ${score} | ` + `Events: ${events} | ` + `Reminders acknowledged: ${acknowledged}`,
		medals: ["🥇", "🥈", "🥉"],
		// Shown on the pinned LeaderboardBoard when no warrior has earned a
		// standing in the current window yet. Points Mortals at the two ways to
		// climb so an empty board reads as an invitation, not a dead feature.
		boardEmptyState:
			"No deeds recorded yet this week. React ✅ to event reminders and join the call during events to claim your place on the board.",
	},

	// ── schedule board (public, lives in the event-schedule channel) ──
	// this is the content of the pinned message ScheduleBoard keeps fresh.
	// it is different copy from listEvents (which is an ephemeral admin reply).
	// Voice is kept NEUTRAL here (not kingdom flavored) per the owner: every guild
	// renders this pack today regardless of pluginId, so ROK-specific wording would
	// leak into non-ROK servers. seasonEnded stays KvK-specific because that state
	// only ever fires for KvK guilds.
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
		seasonEnded:
			"🏁 The KvK season has ended. The kingdom stands down.\n\n" + "Run `/configure-kvk-season` when the next campaign begins.",
		fieldName: (name: string, type: "recurring" | "one-time") => (type === "recurring" ? `🔁 ${name}` : `📌 ${name}`),
		nextOccurrenceLabel: "Next",
		scheduledDateLabel: "Scheduled",
		intervalLabel: (hours: number) => `Repeats every **${hours} hours**`,
		// Single source of truth for the bolded season-end banner that now
		// renders once at the top of the embed description. Replaced the
		// old per-row seasonEndLabel after the embed redesign moved the
		// season anchor out of every event row.
		seasonEndTopLabel: "Season ends",
		// Field-name heading that introduces the "Events Completed This Season"
		// block at the bottom of the embed. Field names render naturally bold
		// in Discord, so no markdown is required around the title.
		completedSectionTitle: "📜 Events Completed This Season",
		// Label rendered alongside the date a one-time event was concluded
		// (its firstOccurrence timestamp). Lives in completed-block rows.
		completedDateLabel: "Concluded",
		footer: "Updated automatically.",
	},
	// user-facing strings for the /configure-kvk-season command. lives
	// here so every line the warrior sees in Discord can be audited and
	// adjusted from one place alongside the rest of the kingdom voice.
	configureReminders: {
		setupRequired: "This guild has not finished setup. Run /setup before configuring reminders.",
		ruinsInvalid: "Ruins date invalid, use format MM/DD @HH e.g. `04/20 @12`",
		altarInvalid: "Altar date invalid, use format MM/DD @HH e.g. `04/20 @12`",
		kauInvalid: "Kau Karuak date invalid, use format MM/DD e.g. `04/20`",
		invalidInputsHeader: "❌ Invalid inputs:",
		ruinsAfterSeason: "Ruins date must be before the season end date",
		altarAfterSeason: "Altar date must be before the season end date",
		kauAfterSeason: "Kau Karuak Easy date must be before the season end date",
		dateConflictsHeader: "❌ Date conflicts:",
		cancelled: "❌ Configuration cancelled, run `/configure-kvk-season` again with the correct dates.",
		settingUp: "⏳ Setting up reminders...",
		timedOut: "⏱️ Configuration timed out, please run the command again.",
		confirmButtonLabel: "✅ Confirm, Dates are correct",
		editButtonLabel: "✏️ Edit, Dates need changing",
		// formats an array of error lines into the bulleted block that sits
		// under invalidInputsHeader or dateConflictsHeader.
		bulletList: (items: string[]) => items.map((item) => `- ${item}`).join("\n"),

		// ── checklist prompt (Accept defaults / Customize) ─────────
		// Shown as a second ephemeral step after the admin confirms the
		// season dates. Accept keeps the per event type defaults from
		// rok-events.json. Customize opens a modal where the admin types
		// a universal checklist applied to every event this call creates.
		// Skip dismisses the prompt without changing prepSteps (same as
		// Accept in effect; separate button so the intent is explicit and
		// the log line reads clearly).
		checklistPromptTitle: "📋 Preparation Checklist",
		checklistPromptDescription:
			"Each event fires a reminder with a preparation checklist. " +
			"Accept the kingdom's defaults, or customize one list that applies to every event in this season.\n\n" +
			"**Default checklist:**\n" +
			"1. Activate stats token\n" +
			"2. Fetch rune buff\n" +
			"3. Use army expansion\n\n" +
			"You can always edit per event later from the dashboard.",
		checklistAcceptButtonLabel: "✅ Accept defaults",
		checklistCustomizeButtonLabel: "✏️ Customize",
		checklistSkipButtonLabel: "⏭️ Skip for now",
		// Modal copy. Discord modal title cap is 45 chars, label 45, placeholder 100.
		checklistModalTitle: "Customize preparation checklist",
		checklistModalInputLabel: "Checklist items (one per line)",
		checklistModalInputPlaceholder: "1. Activate stats token\n2. Fetch rune buff\n3. Use army expansion",
		// Rendered under the confirmation embed after the admin lands on a
		// final choice. Helps the audit trail: the admin can scroll back and
		// see which checklist they picked for this season.
		checklistResolvedAccept: "✅ Defaults applied to every event in this season.",
		checklistResolvedCustom: (itemCount: number) =>
			`✅ Custom checklist applied (${itemCount} item${itemCount === 1 ? "" : "s"}) to every event in this season.`,
		checklistResolvedSkipped: "⏭️ Skipped, defaults applied. Edit per event from the dashboard any time.",
		checklistEmptyError: "❌ Checklist cannot be empty. Customize requires at least one item, or use Accept defaults instead.",
		checklistPromptTimedOut: "⏱️ Checklist prompt timed out, defaults were applied to every event.",
	},
	kvkConfirmation: {
		title: "⚔️ KvK Reminder Configuration, Please Confirm",
		description: "Verify these dates match what you see in-game.\n" + "Timestamps shown in **your local timezone**.",
		fields: {
			seasonEnd: "📅 Season End",
			ruins: {
				name: "🏚️ Ancient Ruins",
				interval: "Repeats every **40 hours** until season end",
			},
			altar: {
				name: "🕯️ Altar of Darkness",
				interval: "Repeats every **86 hours** until season end",
			},
			kau: {
				name: "⚔️ Trial of Kau Karuak",
			},
			channel: "📢 Reminder Channel",
		},
	},

	error: {
		title: "❌ Error",
	},

	arrival: {
		title: "🔱 I Have Arrived.",
		description: (guildName: string, ownerId: string) =>
			`Greetings, <@${ownerId}>.\n\n` +
			`I have descended upon **${guildName}**.\n\n` +
			"Before I can establish my presence, " +
			"I require one thing from you:\n\n" +
			"**Run `/setup` in your server and " +
			"designate an admin role.**\n\n" +
			"Once done, 🪧 **NOTICE BOARD** will be " +
			"constructed and my throne established.\n\n" +
			"*Do not keep me waiting.*",
	},

	// ── pairing claim code DM (FUTURE_PLANS item 63) ──
	// Second DM after arrival on a fresh install, and the only DM on a
	// re-invite. Gives the owner a one-time code to claim this guild from the
	// plugin dashboard with no slash command. Copy names the code, the 15
	// minute expiry, where to paste it, and that re-inviting issues a fresh
	// code.
	pairingCode: {
		title: "🔑 Claim This Realm",
		description: (code: string) =>
			"To bind this server to your dashboard, present this code:\n\n" +
			`**\`${code}\`**\n\n` +
			"Open the ROK Commander panel on your Company Uno dashboard at companyuno.com and enter it there.\n\n" +
			"The code expires in **15 minutes**. Re-invite me and I will issue a fresh one.",
	},

	setup: {
		// Universal category name across packs. Decision 2026-05-22: the category
		// name is the first field that goes universal across packs (intro copy,
		// leaderboard framing, command guide tone all stay kingdom voice). The
		// category is the bot's brand mark in every server, and ROK-coded names
		// alienated streamer / community guilds. See general-events.pack.ts for
		// the full rationale.
		categoryName: "🪧 NOTICE BOARD",
		// The SECOND managed category, holding the game rules card and the
		// challenge board. Universal across packs for exactly the reason
		// categoryName is: a category is the bot's brand mark in every server.
		// Single leading emoji, matching the NOTICE BOARD convention.
		gamesCategoryName: "🎮 ARCADE GAMES",
		// appended to categoryName when NODE_ENV=development so a dev instance
		// sharing a guild with prod builds a visually distinct home base.
		// GuildSetupManager reads this and composes the final name. Applies to
		// BOTH categories, via resolveCategoryName and resolveGamesCategoryName.
		devSuffix: " (dev)",
		channels: {
			intro: "📜introductions",
			commands: "📖command-center",
			leaderboard: "🏆leaderboard",
			schedule: "📅event-schedule",
			announcements: "📢announcements",
			admin: "🔒inner-sanctum",
			// ── seventh homebase channel ──────────────────────────
			// What:  home of the NextUpBoard. A new post appears here
			//        whenever an event enters the 24h rolling horizon
			//        (or a same day group fires together as "today's
			//        decrees"). Each post is permanent audit trail,
			//        the bot never edits these.
			// Who:   NextUpBoard posts. GuildSetupManager provisions.
			// Where: sits beside 📢announcements in the homebase
			//        category; readable by mortals, writable only by
			//        the bot via category level overwrites.
			nextDecree: "🔜upcoming-events",
			// Eighth channel: admin-only command + control surface (the admin command
			// guide moved out of inner-sanctum, with the admin control buttons folded
			// into its pinned row).
			adminCommands: "🎛️admin-controls",
			// ── the two ARCADE GAMES channels ───────────────────────
			// Both live under gamesCategoryName, NOT under the homebase category,
			// which is why every CHANNEL_SPECS entry now has to declare which
			// category it belongs to. Both are member facing and public: the rules
			// card answers "who can play what" and the board is where a match is
			// started, so a member who cannot see them cannot play at all.
			arcadeRules: "📋arcade-rules",
			arcadeChallenges: "⚔️challenges",
			// ── the two VOICE rooms, one per managed category ───────────
			// Plain voice channels, groundwork for a later meeting notes feature:
			// nothing listens in either, and neither is on Dero's voice allowlist
			// (that stays an admin choice via /dero-config). Spaces and capitals are
			// deliberate, because Discord keeps them in a voice channel name, unlike a
			// text channel name, which it lowercases and dashes. 2026-10 item 235.
			meetingVoice: "🏛️ Meeting Hall",
			arcadeVoice: "🎮 Arcade Lounge",
		},
	},

	channelContent: {
		introduction: {
			title: "🔱 I Have Descended.",
			// What:  pinned intro embed that greets every mortal who enters
			//        the 📜introductions channel. Also doubles as the public
			//        pitch for anyone who wanders in from outside the
			//        alliance, the invite button sits right beneath this
			//        embed and the copy must earn a stranger's click.
			// Who:   every mortal in the guild + any outsider who has been
			//        shown the channel by a current member.
			// When:  posted once during /setup; edited in place by
			//        refreshIntroEmbeds on every boot so copy revisions
			//        land without re-running setup.
			// Where: paired with the "Summon me to your server, Mortal"
			//        link button composed in ChannelContent.introductionComponents().
			description:
				"Mortals of this alliance. I am Dero Dero.\n\n" +
				"My Creator forged me as a gift to those who build great things. They have sent me to your side, and I am yours to command.\n\n" +
				"Through me, your events shall be remembered. Your victories recorded. Your efforts recognized. The worthy shall rise, and their names shall not be forgotten.\n\n" +
				"── What I Do ──\n\n" +
				"⚔️ Remind your members of important dates, battles, and events.\n" +
				"📺 Post stream, announcement, and event reminders on a fixed schedule.\n" +
				"🏆 Track participation and rank the worthy on living leaderboards.\n" +
				"📅 Keep important schedules pinned and always within reach.\n" +
				"📜 Preserve records, achievements, and community milestones.\n" +
				"🌟 Turn activity into history and members into legends.\n\n" +
				"── And This Is Only The Beginning ──\n\n" +
				"I am constantly evolving. New powers, tools, and systems are being forged even now. As my Creator's work continues, so too shall my capabilities.\n\n" +
				"Now then.\n\n" +
				"Gather your people. Organize your ranks. Build something worthy of legend.\n\n" +
				"Command me in a realm of your own. The button below shall summon me.",
		},

		// ── public #command-center guide ──────────────────────────
		// Members-only surface. Shows ONLY the commands any mortal can
		// run today: /leaderboard and /list-events. Admin commands have
		// been moved to commandContentAdmin below which is posted to
		// #inner-sanctum and gated by the admin role.
		commandGuide: {
			title: "📖 The Sacred Texts, Member Commands",
			// Description carries the beloved "tools of your trade / wield
			// with purpose / Impress me" line, restored 2026-04-24 after
			// it had been truncated during the public/admin split. Then a
			// blank line and a short "more may be unlocked" teaser so the
			// embed sets up the short command list below without feeling
			// empty.
			description:
				"The tools available to every mortal of this alliance. Go on, wield them with purpose. Learn them. Use them. **Impress me.**\n\n" +
				"More may be unlocked as you rise.",
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
				// header of src/features/games/gamesCopy.ts).
				// The two commands are named TOGETHER on purpose: /secret-code buffs
				// the fortune subcommand while living outside the command that holds
				// it, and this guide is the only surface that can make that pairing
				// obvious. It is also the first time /secret-code has appeared in any
				// guide at all, despite being live since 2026-07-04.
				{
					name: "🎲 Games of Chance",
					value: [
						"`/mini-game`",
						"Duel a rival, throw rock paper scissors, hang a word, or tempt the crystal ball.",
						"`/secret-code`",
						"Whisper a phrase you have uncovered. Fortune may favor your readings forever.",
						"`/account`",
						"Your renown: level, rank in the realm, your record in every game, and the honors you hold.",
						"`/levels`",
						"See which warriors are most present in this realm, this week, this month, or all time.",
						"`/rating`",
						"Your arcade rating in Hold'em, Battleship and Monopoly, this realm's finest, and the luckiest hands.",
						"`/achievements`",
						"The honors you have claimed, and the ones within reach. Some stay secret until earned.",
					].join("\n"),
				},
			] satisfies IEmbedField[],
		},

		// ── #inner-sanctum admin command guide ────────────────────
		// Second pinned message in the admin channel. Posted alongside
		// adminWelcome and tracked separately on
		// GuildConfig.introMessageIds.adminCommandGuideId so
		// refreshIntroEmbeds can edit it in place on every boot.
		// Visibility is gated by the admin channel's role overwrite, so
		// mortals never see this content even if they stumble into a
		// leaked preview link.
		adminCommandGuide: {
			title: "🔒 The Inner Sanctum, Admin Command Guide",
			// Description matches the Member Commands voice: opens with
			// the "tools of your trade / wield / Impress me" line that
			// the owner specifically asked to preserve, then frames the
			// scope. Earlier draft ended with "I'll be watching either
			// way" which read as creepy surveillance; removed 2026-04-24.
			description:
				"These are the tools of your trade. Go on, wield them with purpose. Learn them. Use them. **Impress me.**\n\n" +
				"Commands reserved for those with the admin role.",
			// ── whitespace strategy ─────────────────────────────────
			// One blank line between sections. Commands within a section
			// list command name then description on two consecutive
			// lines, next command immediately after. This mirrors the
			// owner's target layout sketched out in the 2026-04-24
			// session (command on its own line, description on the next,
			// blank line between entire sections).
			fields: [
				{
					// ROK-specific commands grouped at top so alliance
					// leadership recognises their tools without scanning
					// the stream-adjacent blocks below.
					name: "⚔️ ROK KvK Commands",
					value: ["`/configure-kvk-season`", "ROK (Rise of Kingdoms) specific. Event reminders for a KvK season."].join("\n"),
				},
				{
					name: "📺 Stream / General Schedule Commands",
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
			title: "🏆 Hall of the Worthy",
			description:
				"Alliance participation rankings will be posted here " +
				"after each event.\n\n" +
				"Every contribution counts. " +
				"The worthy earn their place at the top.",
		},

		announcements: {
			title: "📢 Announcements",
			description:
				"Event reminders and season announcements will be posted here.\n\n" + "*My decrees to the alliance will find you here.*",
		},

		// ── next decree intro ──────────────────────────────────────────
		// What:  pinned intro embed that sits above the NextUpBoard posts.
		//        Explains to mortals why this channel accumulates posts
		//        (as opposed to scheduleChannelId's single edited message).
		// Who:   ChannelContent.nextDecreeIntro() pulls from here.
		// Where: posted once by populateChannels on first setup; edited in
		//        place on every boot via refreshIntroEmbeds.
		nextDecree: {
			// Intentionally neutral (not kingdom voice) per the owner: this channel
			// reads as "upcoming events" for every audience.
			title: "🔜 Upcoming Events",
			description:
				"A heads-up for what is coming next.\n\n" +
				"As each event moves within the next day, a fresh post appears here with its time and any prep notes.\n\n" +
				"*Posts stay so you can scroll back to confirm what was announced.*",
		},

		// ── the arcade rules card ─────────────────────────────────
		// Grouped BY PLAYER COUNT rather than one entry per game, and that is the
		// whole design. A flat list was already crowded at five games and would be
		// unreadable at eight; grouping answers the question a member actually
		// arrives with, which is "what can I play right now, with the people I
		// have". Adding a game is one entry in one group, so the card cannot drift
		// from the roster the way a hand written paragraph would.
		//
		// A game may appear in TWO groups when it genuinely has two modes.
		// Blackjack does: alone against the dealer, or a table others join. That is
		// not duplication, it is the honest answer to both questions.
		arcadeRules: {
			title: "📋 The Rules of the Arena",
			description:
				"Welcome to the arcade. Every game here is free to play, open to all, and every match earns renown toward your level.\n\n" +
				"Pick a game below, or press **Host a game** and I shall set the table for you.",

			hostTitle: "🎲 How to host a game",
			hostBody:
				"Press **Host a game** beneath this scroll for anything you can play alone or with a crowd. I raise the table where it belongs and announce it.\n\n" +
				"For a head to head match, go to the challenge board and pick your game there. I post a card, you choose who may see the room, and the match plays out inside it.\n\n" +
				"You may also summon any game yourself with `/mini-game`.",

			joinTitle: "🚪 How to join a game",
			joinBody:
				"An open game posts a card with a button on it. Press it and you are in.\n\n" +
				"On the challenge board, a card marked **Open to all** takes anyone who presses **Join**; the host then chooses who plays, and everyone else who joined may watch. A card marked **Invite only** is visible to the people the host picked and nobody else.\n\n" +
				"Party games seat anyone who presses **Take a seat** before the dealing starts.",

			// The non-game half of the arcade's lifecycle, which is most of what a
			// member actually needs explaining. Added Phase 4, when rooms became the
			// way a head to head match is played rather than a thing the plan promised.
			roomTitle: "🏛️ What happens in a room",
			roomBody:
				"A head to head match gets its own channel under this category. Only the players may speak in it; anyone the host invited, or the whole server if the card was open, may watch and react.\n\n" +
				"When the match ends I seal the room. Nobody can type, the result is posted, and the host may clear it away at once with **Archive now**. Left alone, it clears itself a few hours later.\n\n" +
				"The record of the match survives the room. Every move is kept, so a sealed room is a story you can still read until it is swept.",

			levelingTitle: "📈 How playing raises your level",
			levelingBody:
				"Every match pays renown, win or lose, because showing up is the thing being rewarded. Winning pays more, and a rare hand pays more still.\n\n" +
				"Renown becomes levels. Check yours with `/account`, and see who stands where with `/levels`.",

			soloTitle: "🎯 Play alone (1 player)",
			versusTitle: "⚔️ Head to head (exactly 2)",
			partyTitle: "🎉 Party games (2 or more)",

			solo: [
				{ name: "🃏 Blackjack", how: "Beat my dealer without passing 21." },
				{ name: "🔮 Fortune", how: "Ask the crystal ball. Expect nothing useful." },
			],
			versus: [
				{ name: "🪙 Coin Flip", how: "One coin decides it. No ties, ever." },
				{ name: "🎲 Dice Roll", how: "Both roll a d20. Highest takes it, and a tie means nobody does." },
				{ name: "✂️ Rock Paper Scissors", how: "Both choose in secret. I reveal together." },
				{ name: "🚢 Battleship", how: "I place the fleets, you fire one shot a turn. Sink every ship first." },
			],
			party: [
				{ name: "🪢 Hangman", how: "A word, six wrong guesses, and a whole channel shouting letters." },
				{ name: "🃏 Blackjack table", how: "Up to five seats against my dealer. Everyone plays their own hand." },
				{ name: "🃏 Texas hold em", how: "Up to six buy in with equal stacks. The blinds climb, and the last one holding chips takes the table." },
			],

			hostButtonLabel: "Host a game",
			hostPickerPlaceholder: "Choose a game to host",
			hostPickerTitle: "🎲 What shall we play?",
			hostNoChannel: "The arcade is not built yet. An admin must run `/setup`.",
			hostFailed: "I could not set that table. Try again in a moment.",
			hostStarted: (game: string): string => `Your ${game} is live. Go and play.`,
		},

		// ── the challenge board ───────────────────────────────────
		arcadeChallenges: {
			title: "⚔️ The Challenge Board",
			description:
				"This is where a match begins.\n\n" +
				"Choose a game below. I post a card here, you decide whether the room is **Invite only** or **Open to all**, and once the players are in I raise a room and the match plays out inside it.\n\n" +
				"You may hold one challenge at a time. Finish it and the next is yours.\n\n" +
				"*A finished room is sealed, then cleared away. The record of it survives.*",
		},

		adminWelcome: {
			title: "🔱 The Inner Sanctum",
			description: (ownerId: string, adminRoleId: string) =>
				`Welcome, <@${ownerId}>. You have constructed my throne.\n\n` +
				`Members with <@&${adminRoleId}> may also operate ` +
				"from this chamber.\n\n" +
				"From here you may configure events, manage reminders, " +
				"and oversee your alliance.\n\n" +
				"*The noobs need not know this place exists.*",
		},

		// ── self heal notices ──────────────────────────────────────────
		// Posted to the inner sanctum at bot wake up when ensureHomebase
		// detects that one or more homebase channels were deleted while the
		// bot was offline. Kingdom voice matches the rest of the bot's
		// medieval Discord copy, but ends with a plain warning so the admin
		// understands the operational consequence.
		channelRepairNotice: {
			title: "🔧 A Chamber Has Been Restored",
			description: (channelName: string) =>
				`I noticed **${channelName}** had been razed from my castle. ` +
				"I have rebuilt it.\n\n" +
				"⚠️ Every chamber in **🪧 NOTICE BOARD** is load bearing. " +
				"If any are removed, I cannot function properly. " +
				"Do not delete them.",
			// Summary copy used when MULTIPLE channels are restored in one
			// sweep. One embed replaces the per-channel spam pattern.
			summaryTitle: "🔧 Chambers Have Been Restored",
			summaryBody: (count: number) =>
				`I noticed ${count} chamber${count === 1 ? "" : "s"} had been razed from my castle. ` +
				"I have rebuilt them.\n\n" +
				"⚠️ Every chamber in **🪧 NOTICE BOARD** is load bearing. " +
				"If any are removed, I cannot function properly. " +
				"Do not delete them.\n\n" +
				"Restored chambers:",
		},
		castleRebuiltNotice: {
			title: "🔱 The Castle Has Been Rebuilt",
			description:
				"My homebase was gone when I awoke. " +
				"I have reconstructed **🪧 NOTICE BOARD** and every chamber within it.\n\n" +
				"⚠️ The entire category and its channels are load bearing. " +
				"Do not delete them. " +
				"Without them I cannot serve this alliance.",
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
			"⚠️ **Oops. You don't have wizard powers.**\n\n" +
			"Only the server owner may establish " +
			"**🪧 NOTICE BOARD**.\n" +
			"Know your place.",
		alreadySetup:
			"🪧 **NOTICE BOARD already stands.**\n\n" +
			"My throne has already been constructed.\n" +
			"It does not need to be built twice.",
		setupSuccess: (adminRoleId: string) => ({
			title: "🪧 NOTICE BOARD Established",
			description:
				"🪧 **NOTICE BOARD has been established.**\n\n" +
				`<@&${adminRoleId}> has been granted access ` +
				"to the inner sanctum.\n\n" +
				"My presence is now known. Inform your alliance.\n" +
				"They should be grateful.",
		}),
		kvkConfigured: (seasonEnd: number, channelId: string) =>
			[
				"✅ **KvK reminders configured successfully!**",
				"",
				"**Events scheduled:**",
				"- 🏚️ Ancient Ruins *(every 40h)*",
				"- 🕯️ Altar of Darkness *(every 86h)*",
				"- ⚔️ Trial of Kau Karuak *(Easy → Normal → Hard → Nightmare)*",
				"",
				`**Season ends:** <t:${seasonEnd}:D>`,
				`**Reminder channel:** <#${channelId}>`,
			].join("\n"),
		setupFailed: "Something went wrong during setup. Please try again.",
		// shown to the admin when GuildEventManager.configureKvKSeason throws.
		// keeps the error vague on purpose: real diagnosis lives in the logs,
		// the user just needs to know to retry.
		kvkConfigureFailed: "❌ Something went wrong saving the configuration. Please try again.",
		// generic fallback surfaced when a slash command's execute handler
		// throws. logs have the stack; user sees a soft failure message.
		commandExecuteFailure: "Something went wrong executing this command.",
		// shown during /setup when the bot hasn't finished autoSetup yet (the
		// category + channels are still being constructed by the server).
		setupChannelsPending: "Channels not yet constructed. Please wait a moment and try again.",
		setupPending: {
			title: "🔱 Setting Up",
			description: "Constructing **NOTICE BOARD**... Stand by.",
		},
		setupRequired:
			"⚠️ **My throne has not been constructed.**\n\n" + "An admin must run `/setup` before any commands can be used.",
	},

	// ── streamer / general schedule copy ──────────────────────────
	// Copy lives in this same copy pack (same audit point as the
	// kingdom voice) but speaks plainly. Streamers want a working
	// schedule, not a roleplay. Voice still leans casual gamer, Discord
	// communities skew that way and the streamer who first asked for the
	// bot is in that audience.
	streamSchedule: {
		setupRequired: "Run `/setup` first so the bot has an announcements channel to post in.",
		invalidTime: "Time invalid. Use 24h `HH:MM` like `19:30` or `09:00`.",
		invalidDay: "Day invalid. Pick one of: monday, tuesday, wednesday, thursday, friday, saturday, sunday.",
		alreadyExists: (name: string) =>
			`A schedule named **${name}** already exists. Pause it with \`/pause-schedule\` or pick a different name.`,
		// Confirmation embed that previews the schedule before persisting.
		// Times use Discord <t:UNIX:t> so each viewer sees their local time.
		confirm: {
			title: "📺 Confirm stream schedule",
			description: (name: string, dayLabel: string, nextOccurrenceUnix: number) =>
				[
					`**${name}**, every **${dayLabel}**.`,
					`Next stream: <t:${nextOccurrenceUnix}:F> (<t:${nextOccurrenceUnix}:R>)`,
					"",
					"Reminders fire at the offsets configured for this guild (default: 30 and 15 minutes before).",
				].join("\n"),
			// Three line summary of who gets pinged and where.
			audienceLine: (mentionRoleId: string | null, channelId: string) =>
				mentionRoleId ? `Pinging <@&${mentionRoleId}> in <#${channelId}>.` : `Pinging the guild member role in <#${channelId}>.`,
			// Optional auto-pause cap. Shown only when the streamer set a duration.
			autoPauseLine: (untilUnix: number) => `Auto-pauses on <t:${untilUnix}:F> (<t:${untilUnix}:R>) unless extended.`,
			confirmButtonLabel: "✅ Save schedule",
			cancelButtonLabel: "✖️ Cancel",
		},
		cancelled: "Cancelled. Nothing was saved.",
		timedOut: "Timed out. Run the command again when ready.",
		saved: (name: string) => `✅ **${name}** is live. The bot will post reminders before every stream.`,
		saveFailed: "Could not save the schedule. Try again, if it keeps failing, ping the bot owner.",
	},

	// ── pause / continue ──────────────────────────────────────────
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

	// pause-all and resume-all act on every event in the guild at once.
	// Skip-already-paused semantics on the pause path preserve any per-event
	// pausedUntil dates the streamer set with /pause-schedule earlier.
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

	// ── /go-live-soon (panic button) ──────────────────────────────
	// Drops a one-off announcement for a stream starting in the next few
	// hours. NOT a recurring event, this is a single now-ish nudge, the
	// kind a streamer fires from the green room when life happened and
	// they did not pre-announce.
	goLiveSoon: {
		setupRequired: "Run `/setup` first so the bot has an announcements channel to post in.",
		invalidLeadTime: "Pick a lead time from the list (now / 10m / 30m / 1h / 3h / 6h).",
		// Renders inline in the announcement body. Streamer-typed `note`
		// is appended verbatim under this header (Discord will sanitize
		// the markdown but the bot still does not allowedMentions @everyone).
		announcementTitle: "📺 Going live soon",
		announcementBody: (leadLabel: string, startUnix: number, note: string | null) =>
			[`Stream starts **${leadLabel}**, <t:${startUnix}:t> (<t:${startUnix}:R>).`, note ? `\n${note}` : ""]
				.filter(Boolean)
				.join("\n"),
		posted: "✅ Announcement posted.",
		postFailed: "Could not post the announcement. Check bot permissions on the announcements channel.",
	},

	// ── feature announcements ─────────────────────────────────────
	// What:  once-per-version broadcast posted on boot. Two surfaces
	//        per guild: #announcements (godly pitch voice, public) and
	//        #inner-sanctum (plain admin voice, no ping). Keyed by the
	//        bot's package.json version, idempotent via botLogStore.
	// Who:   postFeatureAnnouncement reads this, once per (guild, version).
	// When:  on boot, after ensureHomebase + refreshIntroEmbeds +
	//        refreshAllSchedules, so everything else is settled before
	//        we broadcast. New guilds (setupComplete:false) are skipped
	//       , their intro embed tells them what the bot does; they do
	//        not need a "what's new" for features already live.
	// Where: ⚠️ NOT a one file change. This copy is duplicated VERBATIM into
	//        general-events.pack.ts by the 2026-07-04 owner decision, so a
	//        release-day edit is FOUR sub-blocks across TWO files: public and
	//        innerSanctum here, and the same two there. Editing only this pack
	//        leaves every general-events guild announcing the PREVIOUS release,
	//        which fails silently and no test catches. Diff the two blocks when
	//        you are done; identical is the invariant, not a coincidence.
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
				"Warriors.\n\nFour gifts arrive at once. I have been busy.\n\n**Renown.** The realm now keeps score. Speak in the halls, answer a comrade with a reaction, sit in an approved war room, or play a game, and you earn renown. Gather enough and you rise a level. I shall announce it here, and I shall never ping a soul doing it. A secret, since you would find it anyway: level 2, level 3, level 5, level 7, level 11. Look at those numbers until you see it.\n`/account` shows your level, your rank and your record in every game.\n`/levels` shows who is most present, this week, this month or since the beginning.\n`/achievements` shows the honors you have claimed. Some stay hidden until they are earned.\n\n**The arena.** Games now have rooms of their own. Go to ⚔️challenges, start a challenge, choose invite only or open to all, and once your rivals are gathered a room opens in the arcade for that match alone. Hangman with a word the host writes, coin flip, dice roll, rock paper scissors, battleship and Texas Hold'em are all played there, and blackjack is dealt right where you ask for it with `/mini-game blackjack`. Every move goes into the match's record, which outlives the room.\nAnd **Monopoly** has arrived, for two to six, on a board of my own. You know the rules. Start a match from ⚔️challenges or with `/mini-game monopoly`, and settle in: a good one runs for days.\n\n**Pictures.** Your `/account`, your level ups, the levels board, a fresh honor, a role you earn, the end of a hangman, battleship or blackjack match, a Hold'em showdown, a Monopoly trade, bid or victory, a welcome, a fortune and the challenge card now arrive as painted cards instead of lines of text. And on Mondays I send the most present among you a private card of your week.\n\n**My voice.** Where your keepers switch it on, I can speak. A Listen button on welcomes and on most fortunes reads the post aloud to you alone, or plays it in your voice call when I sit there with you. Members on my task list can give me small tasks with `/dero tell`, bring me into a voice call with `/dero join`, and ask me for a Hold'em table, which I deal myself. When the host of a Monopoly match turns on the voice referee at its challenge card, I call the big moments out loud while I sit in a call with one of its players. Every bankruptcy, announced with the gravity it deserves. In a call I listen only to members on my task list. Their speech goes to ElevenLabs to become text, and I record and keep nothing. Anyone on the task list can send me away with `/dero leave`.\n\nWant something I do not do yet? Press the Suggestion Box below. I read every one of them, which is more than I can say for most prophecies.\n\nRise well, warriors. The scroll is open.",
		},
		innerSanctum: {
			title: "🏛️ THE ORACLE EXPLAINS WHAT CHANGED",
			description:
				"Those who hold the reins.\n\nFour things arrived with this release. Here is what each one does in your server and how to take it in hand.\n\n**Leveling is already running.** Messages, reactions, approved voice channels and games earn renown. I read no message text: I know that a message happened, where and by whom, and nothing else. Message renown has a sixty second cooldown. Voice renown is off until you approve a voice channel by name. Nothing I post pings anyone.\n`/setup-level-system` sets the rates, the curve, which channels count, role rewards and where level ups post. `/setup-level-system toggle enabled:false` turns it all off, keeps every record, and resumes where it stopped when you switch it back on.\n`/xp` corrects, resets a member or the whole server (it asks first) and exports everything as a file.\nI will not hand out a role carrying Administrator or Manage Server, and I cannot grant a role above my own, so keep my role above any reward.\n\n**The arcade is open.** A new 🎮 ARCADE GAMES category holds 📋arcade-rules, ⚔️challenges and a 🎮 Arcade Lounge voice room, and the notice board gains a 🏛️ Meeting Hall voice room. Every match gets its own room under the arcade, seen only by its players unless the host opens it to all, and the room clears four hours after the match ends. The match record is kept. Monopoly matches can run for days, and the host decides at the challenge card whether passed lots go to auction and whether I referee the match out loud.\n\n**Most posts are now drawn cards.** Profiles, level ups, the levels board, honors, role rewards, match results, welcomes, fortunes, the challenge card and my voice calls each post as a picture, and each falls back to the text you know whenever a picture cannot be drawn. On Mondays at 9 am Central I send up to 25 of the week's most present members a private card of their week; no such message goes out in a server where level up announcements are off.\n\n**My voice is switched off here**, and nothing listens or speaks until you turn it on. My voice comes ready, so `/dero-config enable` is the only step. The role, text channel and voice channel lists decide who may give me tasks, where I may post and which calls I may join. A monthly speech budget, $5 by default, is checked before every paid speech call. `/dero-config disable` or `/dero-config cap dollars:0` stops every speech call at once and ends a live call. In a call I hear only members on the task list; their speech goes to ElevenLabs to become text, and I keep no audio and no transcript. The Monopoly voice referee follows all of this: it speaks only into a call someone has already brought me into, and from the same monthly budget.",
		},
	},

	// ── /announce-stream (planned standalone) ─────────────────────
	// Different from /go-live-soon: this is for a planned one-off stream
	// happening hours or days from now. Same primitive (one-time event),
	// stricter input (explicit date+time, optional title and description).
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

	// ── Hold'em hand names (2026-10 item 244) ─────────────────────
	// How a winning showdown hand reads to members ("pair of aces", "aces full",
	// "ace high flush"). The month's counts store a stable key built from
	// HAND_CATEGORIES and RANK_LABELS (features/games/holdemHand.ts), and
	// features/ratings/gameResultCounts.ts phrases it with these words, so a wording
	// change here never splits a month's counts. Poker's own vocabulary, so it reads
	// the same in every voice; the general-events pack reuses this object.
	holdemHands: {
		// Keyed by the rank's RANK_LABELS label, so the numeric rank table stays the one in holdemHand.ts.
		rankNames: {
			"2": { one: "two", many: "twos" },
			"3": { one: "three", many: "threes" },
			"4": { one: "four", many: "fours" },
			"5": { one: "five", many: "fives" },
			"6": { one: "six", many: "sixes" },
			"7": { one: "seven", many: "sevens" },
			"8": { one: "eight", many: "eights" },
			"9": { one: "nine", many: "nines" },
			"10": { one: "ten", many: "tens" },
			J: { one: "jack", many: "jacks" },
			Q: { one: "queen", many: "queens" },
			K: { one: "king", many: "kings" },
			A: { one: "ace", many: "aces" },
		},
		// One phrase per hand category, given the hand's top rank: the pair, the trips
		// of a full house, the high card of a straight or flush.
		byCategory: {
			"high card": (rank: IRankName) => `${rank.one} high`,
			pair: (rank: IRankName) => `pair of ${rank.many}`,
			"two pair": (rank: IRankName) => `${rank.many} up`,
			"three of a kind": (rank: IRankName) => `three ${rank.many}`,
			straight: (rank: IRankName) => `${rank.one} high straight`,
			flush: (rank: IRankName) => `${rank.one} high flush`,
			"full house": (rank: IRankName) => `${rank.many} full`,
			"four of a kind": (rank: IRankName) => `four ${rank.many}`,
			"straight flush": (rank: IRankName) => `${rank.one} high straight flush`,
		},
		// The ace high straight flush has a name of its own, and every player knows it.
		royalFlush: "royal flush",
	},

	// ── arcade ratings (2026-10 item 244 Phase 3b) ────────────────
	// What members read from /rating and from the monthly arcade post. Members
	// call it a "rating", never Elo: it is OpenSkill, and the word promises
	// nothing about the math. Game names come from gameRoomsCopy.gameLabel, the
	// one place a game slug becomes words, so they are not repeated here.
	arcadeRatings: {
		// The slash command's descriptions. Discord registers one set for every server,
		// so /rating reads these from this default pack rather than per guild.
		command: {
			description: "Arcade ratings: yours, this realm's finest, and fortune's favorites",
			me: "Your rating in each rated game",
			board: "The finest rated warriors of one game in this realm",
			luck: "This month's luckiest warriors at coin flip, dice and rock paper scissors",
			gameOption: "Which rated game",
		},
		// Appended to a rating under 10 rated games, so an early number never reads as settled.
		provisionalMark: "?",
		provisionalNote: "A ? marks a rating still settling, earned in fewer than 10 rated games.",
		notInGuild: "Ratings are kept within a realm. Ask me inside a server, not a DM.",
		readFailed: "The ratings scrolls would not open just now. Try again in a moment.",
		me: {
			title: (name: string) => `⚔️ ${name}'s arcade ratings`,
			rated: (game: string, rating: string, ratedGames: number) =>
				`**${game}**: ${rating}, from ${ratedGames} rated ${ratedGames === 1 ? "match" : "matches"}`,
			unrated: (game: string) => `**${game}**: no rated match yet`,
			footer: "Only games of skill are rated. Games of chance feed the luck board instead.",
		},
		board: {
			title: (game: string) => `🏆 ${game} ratings in this realm`,
			row: (place: number, name: string, rating: string) => `${place}. **${name}**: ${rating}`,
			empty: "No warrior of this realm holds a rating in this game yet. Finish a match and claim the first.",
		},
		luck: {
			title: "🍀 The luckiest warriors this month",
			description:
				"Coin flip, dice roll and rock paper scissors, scored by wins above an even split. A tie decides nothing and counts for nothing.",
			row: (place: number, name: string, score: string, wins: number, decided: number) =>
				`${place}. **${name}**: ${score} (${wins} of ${decided} won)`,
			empty: (minimum: number) => `No warrior has ${minimum} decided games of chance this month yet. Fortune is still deciding.`,
		},
		// ── the monthly arcade post, on the 1st in the leaderboard channel ──
		monthlyPost: {
			title: (month: string) => `📜 The arcade in ${month}`,
			// The hand triggered preview of a month still under way, so it never reads as the month's final word.
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
			footer: "Ask for your own with /rating me.",
		},
	},
};
