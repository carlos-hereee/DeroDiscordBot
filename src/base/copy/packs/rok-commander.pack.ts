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

// ── the default server rules (2026-10 item 247 Phase 2) ──────────────────
// The owner's own rules, numbered as the owner wrote them, with the two plan
// additions the draft did not already cover (Don't Impersonate, One Person One
// Account) as 13 and 14. Following Discord's rules is the owner's rule 10 and
// advertising is folded into rule 8, which is why the plan's four additions add
// two rules here. Plain words, not kingdom voice: these are the owner's rules, so
// every pack shows them verbatim (general-events reads this same constant). The
// owner replaces them per server with the Edit rules button, which saves
// GuildConfig.customRulesMarkdown; null there means this text.
const DEFAULT_SERVER_RULES = [
	"**Welcome!** By being in this server, you agree to follow these rules. Admins and mods have final say on interpretation and enforcement.",
	"**1. 🤝 Respect Everyone**\nBanter and trash talk are fine. Harassment, bullying, threats, or targeting someone to make them uncomfortable are not.",
	"**2. 🚫 No Hate Speech**\nNo racism, sexism, homophobia, transphobia, slurs, or attacks on anyone's identity, background, or beliefs.",
	"**3. 🔞 Keep It SFW**\nNo porn, explicit sexual content, gore, shock content, or anything that would get the server reported.",
	"**4. 🚯 No Spam**\nNo flooding chats, mass pings, repeated posts, bot abuse, or low-effort noise.",
	"**5. 🗂️ Use Channels as Intended**\nPost things where they belong. Doesn't need to be perfect, just don't derail or clutter channels on purpose.",
	"**6. 🔒 Respect Privacy**\nDon't share anyone's personal info, private messages, photos, or recordings without their permission. This includes doxxing in any form.",
	"**7. 🎙️ Don't Ruin Voice Chat**\nNo mic spam, ear-rape audio, soundboard abuse, music over conversations, or talking over others on purpose.",
	"**8. 🔗 No Sketchy Links or Content**\nNo scams, phishing, malware, fake giveaways, suspicious downloads, or unsolicited self-promo and advertising.",
	"**9. 🎮 No Cheating, Exploits, or Bad-Faith Game Behavior**\nNo sharing cheats, hacks, exploits, or account-selling. Don't use the server to coordinate anything that violates a game's or platform's terms of service.",
	"**10. 📜 Follow Discord's Terms of Service and Community Guidelines**\nAnything that breaks Discord's rules breaks ours too.",
	"**11. 👮 Listen to Staff**\nAdmins and mods are here to keep things running. If staff tells you to stop, change channels, or drop a topic, do it. Argue it in DMs after, not in chat.",
	"**12. 🧠 Use Common Sense**\nNot every situation needs its own rule. If you're doing something to annoy, provoke, or cause problems, don't.",
	"**13. 🎭 Don't Impersonate**\nDon't pretend to be another member, staff, a bot, or a public figure, and don't copy someone's name or avatar to fool people.",
	"**14. 👤 One Person, One Account**\nNo alt accounts to dodge a ban, timeout, or vote, and no sharing one account between people.",
	// The owner's draft named a placeholder here ("[admin contact / ticket
	// channel]"); a server admin by DM is the one route every server has.
	"**⚖️ Enforcement**\nBreaking the rules can result in a warning, timeout, kick, or ban depending on severity, intent, and history. Staff decisions are final; appeals go to a server admin by DM.",
].join("\n\n");

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
			"Streamers: run `/events stream weekly` for weekly streams or `/events stream announce` for one-offs.\n" +
			"ROK alliances: run `/events kvk-season` to set up the season schedule.",
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
		//        was "season concluded, run /events kvk-season" which
		//        read like a system status line and ignored the fact
		//        that members had spent weeks showing up for the bot.
		// Who:   every member of the guild reads this. Tone has to honor
		//        the work they put in, not just declare a state change.
		//        The admin-only mechanic ("run /events kvk-season")
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
			"Whether the kingdom feasts or rebuilds, the next decree always rises. When the call comes, an admin can summon the next schedule with `/events kvk-season`.\n\n" +
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
			"🏁 The KvK season has ended. The kingdom stands down.\n\n" + "Run `/events kvk-season` when the next campaign begins.",
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
	// user-facing strings for the /events kvk-season command. lives
	// here so every line the warrior sees in Discord can be audited and
	// adjusted from one place alongside the rest of the kingdom voice.
	configureReminders: {
		setupRequired: "This guild has not finished setup. Run /setup before configuring reminders.",
		ruinsInvalid: "Ruins date invalid, use format MM/DD @HH in UTC, the game's clock, e.g. `04/20 @12`",
		altarInvalid: "Altar date invalid, use format MM/DD @HH in UTC, the game's clock, e.g. `04/20 @12`",
		kauInvalid: "Kau Karuak date invalid, use format MM/DD in UTC, the game's clock, e.g. `04/20`",
		invalidInputsHeader: "❌ Invalid inputs:",
		ruinsAfterSeason: "Ruins date must be before the season end date",
		altarAfterSeason: "Altar date must be before the season end date",
		kauAfterSeason: "Kau Karuak Easy date must be before the season end date",
		dateConflictsHeader: "❌ Date conflicts:",
		cancelled: "❌ Configuration cancelled, run `/events kvk-season` again with the correct dates.",
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
		// The KvK season stays on UTC, the game's clock (2026-10 item 263 Phase 4c, owner
		// decision 17), while other typed times follow the server's timezone, so it says so.
		description:
			"Verify these dates match what you see in-game.\n" +
			"The dates you typed were read in **UTC**, the game's clock, whatever this server's timezone.\n" +
			"Timestamps shown in **your local timezone**.",
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
		title: "🔱 I Have Arrived.",
		description: (guildName: string, ownerId: string) =>
			`Greetings, <@${ownerId}>.\n\n` +
			`I have descended upon **${guildName}**.\n\n` +
			"Before I can establish my presence, " +
			"I require one thing from you:\n\n" +
			"**Run `/setup` in your server and " +
			"designate an admin role.**\n\n" +
			"Once done, 🏰 **DERO HEADQUARTERS** opens " +
			"to your admins and my throne is established.\n\n" +
			"*Do not keep me waiting.*",
	},

	// ── pairing claim code DM (FUTURE_PLANS item 63) ──
	// Second DM after arrival on a fresh install, and the only DM on a
	// re-invite. Gives the owner a one-time code to claim this guild from the
	// plugin dashboard with no slash command. Copy names the code, the 15
	// minute expiry, where to paste it, and that /dero plan issues a fresh
	// code (2026-10 item 262 Phase 4), since the DM is sent only on a join.
	pairingCode: {
		title: "🔑 Claim This Realm",
		description: (code: string) =>
			"To bind this server to your dashboard, present this code:\n\n" +
			`**\`${code}\`**\n\n` +
			"Open the ROK Commander panel on your Company Uno dashboard at companyuno.com and enter it there.\n\n" +
			"The code expires in **15 minutes**. Run `/dero plan` in your server and I will issue a fresh one.",
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
		// The THIRD managed category (2026-10 item 257 Phase 2a): admin only, holding
		// every admin channel and the three admin config channels, so admin controls sit
		// apart from member controls. Universal across packs like the other two.
		headquartersCategoryName: "🏰 DERO HEADQUARTERS",
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
			// The audit trail (post-launch plan item 11): admins read, only Dero writes,
			// one line per admin action. Universal across packs like every channel name.
			adminLog: "🗒️admin-log",
			// ── the three admin config channels (2026-10 item 257 Phase 2a) ──
			// Under headquartersCategoryName with the three admin channels above, which
			// move there too. Universal across packs like every channel name.
			deroConfig: "⚙️dero-config",
			onboardingConfig: "🧭onboarding",
			arcadeControl: "🎰arcade-control",
			// The fourth config channel (2026-10 item 263 Phase 4a): the server's own configs,
			// and where every admin answer with no domain of its own posts.
			serverConfig: "🛠️server-config",
			// Under the notice board: the public channel member command answers post in
			// (owner decision 7). Members may send here, since they run commands here.
			commandOutput: "💬dero-commands",
			// ── the join log and the rules post (2026-10 item 247 Phase 2) ──
			// Both under the homebase category, read only for members. Universal
			// across packs like every channel name. A server's own welcome or rules
			// channel is adopted under its existing name instead of being built.
			welcome: "👋welcome",
			rules: "📘rules",
			// ── the two ARCADE GAMES channels ───────────────────────
			// Both live under gamesCategoryName, NOT under the homebase category,
			// which is why every CHANNEL_SPECS entry now has to declare which
			// category it belongs to. Both are member facing and public: the rules
			// card answers "who can play what" and the board is where a match is
			// started, so a member who cannot see them cannot play at all.
			arcadeRules: "📋arcade-rules",
			arcadeChallenges: "⚔️challenges",
			// The third arcade channel (2026-10 item 245 Phase 4a): every game and every
			// host button, so the rules card holds only rules and ⚔️challenges holds
			// only the challenge posts themselves.
			arcadeGames: "🕹️games",
			// The fourth arcade channel (post-launch plan item 3): admin hosted group
			// games and the party game schedule. Members read and play through the
			// buttons; only admins and Dero post. Universal across packs.
			partyGames: "🎉party-games",
			// The fifth (2026-10 item 254, Arcade 5): the challenge cards of the rated games
			// (ratingEngine.RATED_GAMES) and the network board, so a member looking for a
			// match that counts finds them apart from the luck games. A plain text channel,
			// bot written like ⚔️challenges. Universal across packs.
			arcadeRatedChallenges: "🏆rated-challenges",
			// The sixth (2026-10 item 267 Session 2a): the market where chips buy Dero coins and
			// coins sell back for chips, from the two buttons under its intro. Only Dero posts
			// there. Universal across packs.
			deroMarket: "🏪dero-market",
			// ── the two VOICE rooms, one per managed category ───────────
			// Plain voice channels, groundwork for a later meeting notes feature:
			// nothing listens in either, and neither is on Dero's voice allowlist
			// (that stays an admin choice via /dero-config). Spaces and capitals are
			// deliberate, because Discord keeps them in a voice channel name, unlike a
			// text channel name, which it lowercases and dashes. 2026-10 item 235.
			meetingVoice: "🏛️ Meeting Hall",
			arcadeVoice: "🎮 Arcade Lounge",
		},
		// ── the setup invitation DM (2026-11 item 285 Phase 1) ──
		// Sent to the owner on GuildCreate and by the boot backfill, after the pairing
		// code DM. setupInvitation.ts swaps {{mention}} for the clickable /setup chip
		// (or a plain `/setup` when the command id cannot be resolved) and {{server}}
		// for the guild's name, since an owner of several servers needs to know which.
		// The body promises only what /setup does both before and after this plan's
		// Phase 2 (it builds Headquarters either way), so it never needs a rewrite.
		invitationDm: {
			title: "🏰 Your Throne Awaits",
			body:
				"I have taken my place in **{{server}}**, and one command stands between us and a proper headquarters.\n\n" +
				"Open 🔒inner-sanctum in that server and press **Set up Dero**, or press {{mention}} and run it there. I shall raise 🏰 DERO HEADQUARTERS and walk you through the rest from there.\n\n" +
				"*Only you, the realm's owner, may wield it.*",
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

		// ── the Summon Dero card in #command-center ──────────────
		// Its own pinned message (ChannelContent.inviteCard), with the invite Link
		// button (ChannelContent.buildInviteButton) beneath it. Pack fields so a
		// streamer server reads its own pitch and label (2026-10 item 262 Phase 4).
		// Discord caps a button label at 80 characters.
		inviteCard: {
			title: "🔱 Summon Dero to Your Realm",
			description:
				"Command a kingdom of your own? Dero answers the call. Bring him to your server and let the events, reminders, and rankings run themselves.",
			buttonLabel: "Summon me to your server, Mortal",
			buttonEmoji: "🔱",
		},

		// ── public #command-center guide ──────────────────────────
		// Members-only surface. Shows ONLY the commands any mortal can
		// run today: /leaderboard and /events list. Admin commands have
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
				"The buttons beneath this scroll open the most used of them for your eyes alone. More may be unlocked as you rise.",
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
						"`/account view:levels`",
						"See which warriors are most present in this realm, this week, this month, or all time.",
						"`/rating`",
						"Your arcade rating in Hold'em, Battleship, Monopoly and Blackjack, this realm's finest, and the luckiest hands.",
						"`/account view:achievements`",
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
				"Commands reserved for those with the admin role. Each has a button beneath this guide that opens it with a form.",
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
					value: ["`/events kvk-season`", "ROK (Rise of Kingdoms) specific. Event reminders for a KvK season."].join("\n"),
				},
				{
					name: "📺 Stream / General Schedule Commands",
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
						"Hide, show or rename the chambers I keep.",
						"`/server`",
						"Channel auto heal, leaderboard tracking and the day the leaderboard week starts.",
						"`/leveling settings`",
						"Leveling: rates, the level cap, where level ups post, which channels count, rewards and boosts.",
						"`/leveling xp`",
						"Correct a member's XP or level, reset a member or the server, or export it all.",
						"`/dero-config`",
						"My voice: the switch, Listen, who may give me tasks and the calls I may join.",
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

		// 🗒️admin-log's intro (post-launch plan item 11). Practical rather than kingdom
		// voice, like every admin surface: it says what lands here and that nobody but
		// Dero can post.
		adminLog: {
			title: "🗒️ Admin Log",
			description:
				"One line for every admin action Dero sees: schedule and event changes, settings changes, power-up toggles, voice list edits and self destruct attempts.\n\n" +
				"Each line names who did it and when. Only Dero posts here, so the trail stays complete.",
		},

		// ── 🏰 DERO HEADQUARTERS config channels (2026-10 item 257 Phase 2a) ──
		// Practical rather than kingdom voice, like every admin surface. Each says what
		// the channel is for and that its setup steps arrive here.
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
		// 💬dero-commands' intro, member facing, so the kingdom voice returns.
		commandOutput: {
			title: "💬 Dero Commands",
			description:
				"Summon Dero here, warrior: this is the hall for running Dero's commands.\n\n" +
				"Speak freely, for it is open to every member of the realm.",
		},

		// ── the arcade rules card (2026-10 item 245 Phase 4a) ────────────
		// RULES ONLY. The roster and the host buttons moved to 🕹️games, so this card
		// answers one question: how is a match here played. One field per rule, in the
		// order a newcomer meets them: what a room is, how many a host may hold, what
		// closes one, what follows one, what any of it earns, and which games are
		// rated. The numbers arrive as arguments from BOT_CONSTANTS (ChannelContent
		// passes them), so the card cannot promise a clock, an amount or a threshold the
		// code does not run. The ratings field names its games in prose, so
		// ChannelContent.arcade.test.ts pins them against ratingEngine's RATED_GAMES and
		// LUCK_GAMES: a game rated in code and missing here turns that test red.
		arcadeRules: {
			title: "📋 The Rules of the Arena",
			description:
				"Every game in this arcade is open to all, and every one starts from 🕹️games. Only a ranked match ever costs chips. These are the laws each match is played by.",

			roomTitle: "🏛️ How a room works",
			roomBody:
				"A match that takes more than a moment gets a room of its own under this category. Its host decides who may see it: **Invite only** shows it to the warriors the host picks, and **Open to all** lets anyone press **Join**, after which the host chooses who plays.\n\n" +
				"Only the players may speak in a room; everyone who can see it may watch and react. When the match ends I seal the room and post the result. The host may clear it at once with **Archive now**, and left alone it clears itself a few hours later. The record of every move outlives the room.",

			slotTitle: "🪑 One room per host",
			slotBody:
				"You may host one room at a time, and a challenge still gathering its players counts as one. Finish it, give it up, or let it close, and the next is yours.",

			idleTitle: "⏳ Idle rooms close",
			idleBody: (idleMinutes: number, monopolySeatHours: number): string =>
				`A room where nobody acts for ${idleMinutes} minutes is closed as abandoned, so a forgotten match never holds its host's seat. ` +
				`Monopoly is the exception: each seat has ${monopolySeatHours} hours to take its turn, because a good game runs for days. ` +
				"A hangman round in play waits for as long as its players do, and its host ends it with **Give up**.",

			rematchTitle: "🔁 Rematch in the same room",
			rematchBody:
				"When a match ends, **Rematch** on the result card starts the next one in the very same room with the same players. The finished match keeps its record, and the new one begins its own.",

			xpTitle: "📈 What playing earns",
			xpBody: (messageXp: number, reactionXp: number, soloWinXp: number, soloOtherXp: number, dailyCap: number): string =>
				`Every message earns ${messageXp} renown and every reaction ${reactionXp}. A game against me in 🕹️games pays ${soloWinXp} for a win and ${soloOtherXp} for anything else. ` +
				`Those three together stop at ${dailyCap} renown a day, and the day turns at midnight Central time.\n\n` +
				"A match against another warrior pays in full, win or lose, and a match in a room of its own pays more than one played in a channel. Check your standing with `/account`.",

			// Members call the number a "rating", never Elo (see arcadeRatings below).
			// A forfeit rates nothing in code, but the card does not advertise it as a
			// way out of a loss.
			ratingsTitle: "🏆 Ratings and the luck board",
			ratingsBody: (provisionalGames: number, minRatedHands: number, luckMinDecided: number): string =>
				"Only games of skill are rated: Texas Hold'em, Battleship, Monopoly and Blackjack. Every finished match moves each player's **rating**, " +
				`and a rating earned in fewer than ${provisionalGames} rated matches wears a **?** while it settles. ` +
				`A Hold'em table counts once ${minRatedHands} hands are dealt, running out of time at Battleship is a loss, and a room closed as abandoned moves no rating. ` +
				"A Blackjack table is rated against my dealer: end above your buy in and you beat the house, level with it is a draw, below it a loss. Hangman is played together, so it is never rated.\n\n" +
				"Coin flip and dice roll are games of chance and are never rated. " +
				`Played against another warrior, they feed this month's luck board instead, scored by wins above an even split, and a warrior appears there from ${luckMinDecided} decided games. ` +
				// Rock paper scissors left the luck board (2026-10 item 280, owner ruling).
				"Rock paper scissors is a game of wits, not fortune, so it is neither rated nor counted on the luck board. " +
				"`/rating me` shows yours, `/rating board` the finest of this realm in one game, and `/rating luck` fortune's favorites.",

			// Chips ride only on a ranked match (2026-10 item 276, owner decision D1), and a
			// Blackjack Leave is a cash out on either kind of table (decision D9). The Monopoly
			// pot, the Battleship wager and the forfeit rule are decisions D3, D4, D7, D10 and D12;
			// Discord caps a field at 1024 characters, so a new sentence here needs a cut elsewhere.
			chipsTitle: "🪙 Chips ride only on ranked matches",
			chipsBody: (monopolyBuyIn: string): string =>
				"A **Rated** Hold'em or Blackjack table plays for a chip buy in from your wallet, and every chip a table holds goes back to the wallets when it ends. " +
				`A **Rated** Monopoly match costs each player ${monopolyBuyIn} and the winner takes the whole pot; Monopoly money stays on the board and never becomes chips. ` +
				"A **Rated** Battleship challenge may carry a chip wager both captains pay, and the winner takes both. " +
				"Once a ranked Hold'em, Monopoly or Battleship match begins, whoever leaves, surrenders, is removed, times out of it or departs the realm forfeits their chips to the winner, and I name the amount before you confirm. " +
				"A **Casual** match never takes or pays a single chip: it is played with pretend chips that vanish when it ends, and so is a table open to the network, a table with my bots, and a Blackjack table against me alone. " +
				"Leaving a Blackjack table cashes out your stack, and a bet already on the felt is lost.",

			// The house rules where this arcade departs from the printed rules (2026-10 item 276,
			// moved from Phase 5): each is explained in code beside the rule it describes
			// (monopolyState, monopolyBankruptcy, battleshipState, hangmanState, versusResolve,
			// blackjackState), and the cut card's share arrives from CUT_CARD_PENETRATION.
			houseRulesTitle: "📜 House rules",
			houseRulesBody: (cutCardPercent: number): string =>
				"**Monopoly:** the host rolls first, and a warrior bankrupt to the bank returns every lot unowned, with no auction. " +
				"**Battleship:** the host fires first. " +
				// The dead button rule (2026-10 item 280, owner ruling).
				"**Hold'em:** the big blind moves one seat every hand, so nobody skips it when a warrior busts; when last hand's big blind is gone, that hand has no small blind. " +
				"**Hangman:** guess single letters only, never the whole word. " +
				"**Coin flip:** nobody calls it in the air; heads is the challenger. " +
				`**Blackjack:** played by US rules from a six deck shoe, with no insurance or even money, and a blackjack pays 3 to 2 rounded down. My dealer peeks for blackjack before anyone acts, and a cut card reshuffles the shoe once about ${cutCardPercent} percent of it is dealt. ` +
				// A ranked table is shared (2026-10 item 276, owner decisions D13 to D16); who may take
				// a seat mid game follows lateSeatRefusalOf (2026-10 item 280).
				"A **Rated** table needs two warriors to start, and while it deals any warrior may take an empty seat at one open to all, sitting down at the next hand. An invite only table takes nobody new, and a warrior who left it or went broke cannot sit again. A table against me alone is for sport, free and unrated.",

			// The one button this card carries: it opens the game request ballot
			// privately. Read by GuildSetupManager.resolveIntroComponents.
			voteButtonLabel: "Don't see your favorite game?",
		},

		// ── the ⚔️challenges intro ────────────────────────────────
		// One short line since Phase 4a: the start buttons moved to 🕹️games, and this
		// channel now holds only the challenge posts themselves.
		arcadeChallenges: {
			title: "⚔️ Challenges of the Realm",
			description: "Every challenge in the realm is posted here, save the rated ones, which go to 🏆rated-challenges. Start one from 🕹️games.",
		},

		// ── the 🏆rated-challenges intro (2026-10 item 254, Arcade 5) ──
		// One short line, like ⚔️challenges: the channel holds the rated games' cards and
		// the network board, each card wearing its RATED or CASUAL badge.
		arcadeRatedChallenges: {
			title: "🏆 Rated Challenges",
			description: "Hold'em, Battleship, Monopoly and Blackjack challenges are posted here, each wearing its badge: **RATED** counts toward `/rating` and plays for chips, **CASUAL** does neither. Start one from 🕹️games.",
		},

		// ── the 🕹️games channel (2026-10 item 245 Phase 4a) ─────────────
		// Two messages. The intro lists every game once, one line each, and carries the
		// play now controls (the host row, the solo luck row against Dero and the
		// hangman category select); the board message beneath it carries the Challenge
		// Board's start buttons, because all six rows do not fit in one message.
		// `roster` is what ChannelContent walks, one line per entry, so adding a game is
		// one entry here and the matching one in general-events.
		arcadeGames: {
			title: "🕹️ The Games Hall",
			description:
				"Every game in the arcade starts here. Host one for yourself, play me on the spot, or challenge a warrior from the board below. The laws of play are kept in 📋arcade-rules.",

			rosterTitle: "🎮 The games",
			roster: [
				{ name: "🪙 Coin Flip", how: "One coin decides it. Flip against me here, or challenge a warrior from the board." },
				{ name: "🎲 Dice Roll", how: "Both roll a d20 and the highest takes it. Against me here, or a warrior from the board." },
				{ name: "✊ Rock Paper Scissors", how: "Throw against me here, or face a warrior who chooses in secret." },
				{ name: "🪢 Hangman", how: "Guess my word alone, from a shelf of your choosing, or open a room where the host writes the word." },
				{ name: "🃏 Blackjack", how: "Beat my dealer alone for sport, or open a table of up to five; a Rated table open to all takes new warriors while it deals." },
				{ name: "🚢 Battleship", how: "I place the fleets, you fire one shot a turn. Head to head, from the board." },
				{ name: "🃏 Texas hold em", how: "Up to six buy in with equal stacks, and the last one holding chips takes the table. From the board." },
				{ name: "🏠 Monopoly", how: "Two to six on a board of my own, and a good match runs for days. From the board." },
			],

			playTitle: "🎯 Play now",
			playBody:
				"The first row sets a table for you alone, or a blackjack table others may join. The second opens a room where you play me: a coin flip, a roll of the dice, or rock paper scissors. The list beneath them gives you a hangman word from the shelf you name. The last row is your daily: one fortune a day, and your chips to claim.",

			// The solo luck row: each button opens a room where the member plays me
			// (2026-10 item 263 R3-7), and rock paper scissors asks for the throw there.
			soloLuckLabels: {
				coinflip: "Coin flip with Dero",
				diceroll: "Dice with Dero",
				rps: "Rock paper scissors with Dero",
			},
			hangmanCategoryPlaceholder: "Hangman alone: choose a shelf of words",
			// The daily row (2026-10 item 254): a fortune reading once a day and the daily chip claim.
			dailyLabels: {
				fortune: "Fortune",
				claim: "Claim daily rewards",
			},

			// The second message: the Challenge Board's start buttons.
			boardTitle: "⚔️ Challenge a Warrior",
			boardDescription:
				"Pick a game below and I post its card in ⚔️challenges, or in 🏆rated-challenges for a rated game. You choose whether the room is **Invite only** or **Open to all** and who may watch, and once the players are in I raise a room and the match plays out inside it.",
		},

		// ── 🎉party-games' intro (post-launch plan item 3) ──────────────────
		// Above the two admin buttons (Host hangman, Schedule a party game). Member
		// facing, so kingdom voice: it says what happens here and where the schedule is.
		partyGames: {
			title: "🎉 The Revel Hall",
			description:
				"When the keepers call a party game, the whole kingdom plays together here. A hangman round opens in this hall for every warrior at once, and the keepers may call a Texas hold em table or a Monopoly match from here too, whose challenge is cried in 🏆rated-challenges.\n\n" +
				"Revels to come are cried in 📢announcements, and the roll of who will attend is kept in 🔜upcoming-events. Mark yourself there so the host knows to wait for you.",
		},

		// ── 🏪dero-market's intro (2026-10 item 267 Session 2a) ─────────────────
		// Above the Buy coins and Sell coins buttons. The rate and the cap arrive formatted
		// from BOT_CONSTANTS.ECONOMY.MARKET (ChannelContent.deroMarketIntro), so a number
		// changed there changes here without an edit. `closed` replaces the description on a
		// server with chips switched off.
		deroMarket: {
			title: "🏪 The Dero Market",
			description: (rate: { buyPrice: string; sellPrice: string; dailyCap: string }): string =>
				"Here chips become Dero coins, and coins become chips again.\n\n" +
				`**Buy.** One Dero coin costs ${rate.buyPrice}, and a warrior may buy ${rate.dailyCap} a day across every realm I serve.\n` +
				`**Sell.** One Dero coin returns ${rate.sellPrice}, as many as you hold.\n\n` +
				"Press a button below. I show you both purses before you trade, and every finished trade is cried here with its trader's name.",
			closed:
				"The keepers of this realm have switched chips off, so the market is shut here. Your chips and coins are yours in every realm, and the market trades wherever chips are on.",
		},

		// ── the voice rooms' intro (2026-10 item 245 Phase 4b) ──────────────
		// The card in the text chat of 🏛️ Meeting Hall and 🎮 Arcade Lounge, with
		// /dero's Join, Leave and Status beneath it (features/voice/voiceRoomControls).
		// Voice is switched on per server, so the card promises it only there, and
		// it states what a call does with speech, as every voice surface does.
		voiceRoom: {
			title: "🎙️ Summon Dero to This Hall",
			description:
				"Where your keepers have switched my voice on, a warrior on my task list who stands in this call may bring me in with **Join** and send me away with **Leave**. **Status** tells anyone where I am.\n\n" +
				"In a call I listen only to members on my task list. Their speech goes to ElevenLabs to become text, and I keep no audio and no transcript.",
			joinLabel: "Join",
			leaveLabel: "Leave",
			statusLabel: "Status",
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
			// The button on the intro while no admin role is set, which opens /setup's own form.
			setupButtonLabel: "Set up Dero",
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

		// ── member role gating (2026-10 item 247 Phase 1) ──────────────
		// Posted once per guild by CommunityGatingAnnouncement, the first boot the
		// member role gates a Community server's channels: admin first, in
		// #inner-sanctum, then members, in #announcements. Each description takes
		// the member role's id so the post names the role; it is sent with
		// allowedMentions parse [], so the mention notifies nobody. The member post
		// is read only by members who already hold the role (#announcements is one
		// of the gated channels), so it speaks to them about the comrades who do not.
		gatingAnnouncement: {
			member: {
				title: "🛡️ The Halls Now Know Their Own",
				description: (memberRoleId: string) =>
					"Warriors.\n\n" +
					`The halls of this realm now open only to those who bear <@&${memberRoleId}>, and Discord's Onboarding is how a warrior earns it. ` +
					"Until then, only the introductions chamber stands open to them.\n\n" +
					"You read this, so you already bear it. If a comrade says the halls went dark, tell them to open **Channels & Roles** at the top of the channel list and choose **Retake Onboarding**.\n\n" +
					"Nothing else has changed. Your renown, your records and your matches stand where you left them.",
			},
			admin: {
				title: "🔐 The Member Role Now Guards the Halls",
				description: (memberRoleId: string) =>
					"Those who hold the reins.\n\n" +
					`This server runs as a Discord Community, so the member role you named in \`/setup\`, <@&${memberRoleId}>, now decides who sees my channels. ` +
					"Without it a member sees only the introductions channel. With it they see every public channel and both voice rooms. The admin channels are unchanged.\n\n" +
					`**Check one thing now:** your server's Onboarding must give new members <@&${memberRoleId}>, or every newcomer stops at introductions. You set that in Server Settings, under Onboarding.\n\n` +
					"Members who already hold the role see no change. Anyone who lost sight of a channel can open **Channels & Roles** and choose **Retake Onboarding**.",
			},
		},

		// ── 👋welcome, the join and leave log (2026-10 item 247 Phase 2) ──
		// The intro is the channel's one tracked message; the join and leave lines
		// are posted by features/setup/welcomeLog.ts, one small embed each, naming
		// the member by display name only and pinging nobody.
		welcome: {
			title: "👋 The Gate Ledger",
			description:
				"Every warrior who passes through the gates of this realm is written here, arriving or departing.\n\n" +
				"This ledger is mine to keep. Greet the newcomers in 📜introductions, where they can answer you.",
			joinTitle: "👋 A Warrior Arrives",
			joinLine: (displayName: string): string => `**${displayName}** has passed through the gates.`,
			leaveTitle: "🚪 A Warrior Departs",
			leaveLine: (displayName: string): string => `**${displayName}** has left the realm.`,
		},

		// ── 📘rules, the server rules post (2026-10 item 247 Phase 2) ──
		// Built by features/setup/rulesContent.ts: the title below over the owner's
		// saved rules, or over defaultMarkdown when they never edited. The button
		// opens the Edit rules modal for the owner and admins; anyone else who
		// presses it is refused privately.
		rules: {
			title: "📘 Server Rules",
			defaultMarkdown: DEFAULT_SERVER_RULES,
			editButtonLabel: "Edit rules",
		},

		// ── the notice board tutorial cards (2026-11 item 285 Phase 3) ──
		// One card per notice board channel an admin builds by hand, posted beneath the
		// chart in 🧭onboarding (features/setup/tutorialCards.ts). Admins read them, so the
		// voice stays light; each body teaches what the channel is for in one paragraph.
		tutorial: {
			intro: {
				title: "📜 Introductions",
				body:
					"The hall where newcomers announce themselves. Unlike most of my channels, members may write here. When a warrior arrives I greet them here with a question to answer, and they introduce themselves by replying with a line or two about who they are and what brings them to the realm. My greeting stays pinned, so their chatter never buries it.",
			},
			announcements: {
				title: "📢 Announcements",
				body:
					"Where my decrees reach the alliance. Every event reminder and season announcement posts here and pings the member role. Members only read; the owner and the admin role may post an announcement of their own by writing in the channel. Keep my role able to view and send here, or no reminder can reach your people.",
			},
			schedule: {
				title: "📅 Event Schedule",
				body:
					"One pinned post that I keep true. You never edit it by hand: add, pause or delete an event with `/events` (or the 🛠️server-config steps) and the post rewrites itself. A recurring event, such as a weekly stream set with `/events stream weekly`, shows its next time, and that time moves forward each time its reminder fires.",
			},
			welcome: {
				title: "👋 Welcome",
				body:
					"My gate ledger. I log every member who joins or leaves, by display name, and ping nobody. Members read it and only I write. If your server already keeps a welcome channel of its own, I use that one rather than raising a second.",
			},
			rules: {
				title: "📘 Rules",
				body:
					"The realm's laws in one pinned post. Members read them; the owner and the admin role press its Edit rules button to rewrite them, and the post changes in place. Discord Community asks for a rules channel when you turn it on, so raise this one first. If your server already keeps a rules channel of its own, I use that one rather than raising a second.",
			},
			commands: {
				title: "📖 Command Center",
				body:
					"The pinned guide to every member command, with buttons for Account, Levels, Achievements and more. Members only read here, so the guide is never buried; the commands themselves work in any channel.",
			},
			meetingVoice: {
				title: "🏛️ Meeting Hall",
				body:
					"A voice room for your council. Until you switch my voice on in ⚙️dero-config it is an ordinary voice channel and nothing listens; once it is on, members on my task list can bring me in with its Join button.",
			},
			commandOutput: {
				title: "💬 Dero Commands",
				body:
					"The one hall every member may speak in, built for running my commands. When a warrior asks me something, my answer lands here with a ping for that warrior alone. Without this hall my answers stay private, seen only by the one who asked.",
			},
			leaderboard: {
				title: "🏆 Leaderboard",
				body:
					"Two boards I keep true, side by side: the participation rankings from your events, and the levels your members earn over time. I rewrite both in place, so members only read here. Without this hall neither board has a place to stand.",
			},
			nextDecree: {
				title: "🔜 Upcoming Events",
				body:
					"As each event moves within the next day, I post it here with its time and any prep notes. Every post stays, so your people can scroll back to what was announced, and its Edit button changes that one occurrence. Without this hall those posts wait until you raise it.",
			},
		},
	},

	// ── the game request ballot (2026-10 item 245 Phase 4a) ─────────────
	// Opened privately by the "Don't see your favorite game?" button on the
	// 📋arcade-rules card (features/game-rooms/gameRequestHandlers.ts). Every line is
	// ephemeral to the member who pressed, so Dero's voice stays while the
	// instructions stay plain.
	gameRequests: {
		title: "🗳️ The Game Request Ballot",
		intro: "Name a game you wish the arcade had, or lend your voice to one already named. The most wanted rise to the top.",
		empty: "No game has been named yet. Be the first.",
		row: (rank: number, name: string, votes: number, isMine: boolean): string =>
			`${rank}. **${name}**, ${votes} ${votes === 1 ? "vote" : "votes"}${isMine ? " (yours among them)" : ""}`,
		votePlaceholder: "Vote for a game (choose it again to take your vote back)",
		voteOption: (votes: number, isMine: boolean): string => `${votes} ${votes === 1 ? "vote" : "votes"}${isMine ? ", yours among them" : ""}`,
		removePlaceholder: "Strike a game from the ballot (owner and admins)",
		addButtonLabel: "Add a game",
		full: (cap: number): string => `The ballot holds ${cap} games and it is full. The owner or an admin can strike one to make room.`,
		modalTitle: "Add a game to the ballot",
		modalLabel: "The game's name",
		modalPlaceholder: "Chess",
		nameLength: (min: number, max: number): string => `A game's name needs ${min} to ${max} characters.`,
		duplicate: (name: string): string => `**${name}** is already on the ballot. Find it in the list and vote for it there.`,
		added: (name: string): string => `**${name}** is on the ballot, and your vote is its first.`,
		voted: (name: string): string => `Your vote for **${name}** is counted.`,
		unvoted: (name: string): string => `You took your vote back from **${name}**.`,
		removed: (name: string): string => `**${name}** is struck from the ballot.`,
		notFound: "That game is no longer on the ballot.",
		adminOnly: "Only the server owner or an admin may strike a game from the ballot.",
		outsideGuild: "The ballot belongs to a server. Open it from 📋arcade-rules.",
	},

	responses: {
		// 🔒inner-sanctum's intro until setup runs, the first step of the setup tutorial: it
		// names the Set up Dero button beneath it (adminWelcome.setupButtonLabel), never a
		// typed command, so an owner who just added Dero knows what to press.
		adminRolePending:
			"⚠️ **No admin role has been designated yet.**\n\n" +
			"Press **Set up Dero** below and choose the role that may configure me and the role your members wear.",
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
		// /setup grants the roles and builds no channel, and a fresh install has no notice
		// board yet (2026-11 item 285 Phase 2), so this names Headquarters, which every
		// server set up through /setup has.
		setupSuccess: (adminRoleId: string) => ({
			title: "🏰 The Throne Is Claimed",
			description:
				"🏰 **DERO HEADQUARTERS is yours to command.**\n\n" +
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
		// ── the Edit rules modal (2026-10 item 247 Phase 2) ──────────────
		// Owner and admin facing and always ephemeral, so the instructions stay
		// plain. The modal is preloaded with the rules as they stand.
		rulesEdit: {
			modalTitle: "Edit the server rules",
			inputLabel: "Rules (Markdown works)",
			placeholder: "**1. Respect Everyone**\nOne rule per paragraph. **Bold** and *italic* work.",
			saved: "✅ The rules are saved, and the rules post shows them now.",
			savedNotRefreshed: "✅ The rules are saved, but I could not update the rules post. It catches up on my next restart.",
			reset: "✅ The rules match the default again, so the rules post follows the default wording from now on.",
			empty: "The rules cannot be empty. Nothing was changed.",
			failed: "I could not save the rules. Nothing was changed. Try again in a moment.",
			expired: "This control is no longer available.",
		},
		// ── the 🎰arcade-control and 🛠️server-config buttons (2026-11 item 285 Phase 4) ──
		// Admin facing and read in a Headquarters channel or a state notice, so the words
		// stay plain even in the kingdom voice. The Enable Arcade line is a stub: the
		// button promises nothing until real activation ships.
		dismantleSuccess: "🎮 **The arcade is dismantled.** The ARCADE GAMES category and every channel in it are deleted, matches in progress included. It stays down across restarts until `/arcade on` raises it again.",
		dismantleAlreadyOff: "🎮 **The arcade is already dismantled.** `/arcade on` raises it again.",
		enableStubComingSoon: "⏳ **Enabling the arcade from this card is coming soon.** Until then it stays as it is, and `/arcade on` raises it.",
		renameInfoTitle: "✏️ Renaming a channel",
		renameInfoBody:
			"To rename a channel I keep, use `/server channels rename`. I remember the name you give it, so it survives auto heal and any rebuild.\n\n" +
			"Renaming it straight in Discord does not stick: while auto heal is on, I rename the channel back to my default name the next time I start.",
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
			`A schedule named **${name}** already exists. Pause it with \`/events pause\` or pick a different name.`,
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

	// pause-all and resume-all act on every event in the guild at once.
	// Skip-already-paused semantics on the pause path preserve any per-event
	// pausedUntil dates the streamer set with /events pause earlier.
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

	// ── /events stream soon (panic button) ──────────────────────────────
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
		// a few characters of Discord's 4096 limit (the public one at 4093), so any new words here need a
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
				"Warriors.\n\nA new look, a voice, a whole arcade, realm against realm rankings and a proper welcome for newcomers.\n\n**Renown.** The realm now keeps score. Speak in the halls, answer a comrade with a reaction, sit in an approved war room, or play a game, and you earn renown. A message or a reaction earns 1, and messages, reactions and quick games against me earn at most 50 a day, counted from midnight Central. Gather enough and you rise a level. I announce it here without pinging a soul. A secret, since you would find it anyway: level 2, level 3, level 5, level 7, level 11. Look at those numbers until you see it.\n`/account` shows your level, rank and record, `/account view:levels` who is most present, and `/account view:achievements` your honors; the buttons in #command-center show yours to you alone.\n\n**The arcade.** A new 🕹️games channel holds every game. Flip a coin, roll a die or throw rock paper scissors against me on the spot: 3 renown for a win, 1 for anything else. Hang a word alone from one of ten shelves, each word with its hint, or start a challenge for a rival. Each match gets a room of its own in the arcade, and a hangman host writes the word or lets me draw one. When a match ends, **Rematch** starts the next one in the same room. A room left 30 minutes without a move is closed, Monopoly and hangman aside. Blackjack is dealt right where you ask for it with `/mini-game blackjack`. Every move goes into the match's record.\nAt Hold'em each decision has 3 minutes on a live clock, the next hand deals itself, two timeouts in a row sit you out until you press I'm back, and **Leave table** gives up your seat and its chips whenever you choose.\nAnd **Monopoly** has arrived, for two to six, on a board of my own. You know the rules. Start a match from 🕹️games or with `/mini-game monopoly`, and settle in: a good one runs for days. `/rating` shows where you stand in Hold'em, Battleship, Monopoly and Blackjack.\n\n**Realm against realm.** Where your keepers open it, a Hold'em table can seat warriors from other servers, each playing from a channel in their own. First I tell you what crosses (your name, worn server tag, moves and ratings, never your chat) and you choose. `/rating servers` ranks realm against realm by the warriors who wear each tag, and `/rating network leave` deletes your consent and your ratings whenever you wish. A host may also hold a table to a rating band, approve each joiner or remove a player.\n\n**A proper welcome.** 👋welcome and 📘rules now stand in the notice board, and where your keepers set up Discord Onboarding, its last step opens the realm's channels to you.\n\n**Pictures.** Your `/account`, your level ups, the levels board, a fresh honor, a role you earn, every turn of blackjack and Hold'em, the end of a hangman or battleship match, a Monopoly trade, bid or victory, a welcome, a fortune and the challenge card now arrive as painted cards instead of lines of text. And on Mondays I send the most present among you a private card of your week.\n\n**My voice.** Where your keepers switch it on, I can speak. A Listen button on welcomes and on most fortunes reads the post aloud to you alone, or plays it in your voice call when I sit there with you. Members on my task list can give me small tasks with `/dero tell`, bring me into a voice call with `/dero join` or the Join button in 🏛️ Meeting Hall and 🎮 Arcade Lounge, and ask me for a Hold'em table, which I deal myself. When the host of a Monopoly match turns on the voice referee at its challenge card, I call the big moments out loud while I sit in a call with one of its players. In a call I listen only to members on my task list. Their speech goes to ElevenLabs to become text, and I record and keep nothing. Anyone on the task list can send me away with `/dero leave`.\n\nEvery game now pays Dero coins, the first currency of something larger. Trade them for chips in 🏪dero-market.\n\nWant something I do not do yet? Press the Suggestion Box below. I read every one of them, which is more than I can say for most prophecies.\n\nRise well, warriors. The scroll is open.",
		},
		innerSanctum: {
			title: "🏛️ THE ORACLE EXPLAINS WHAT CHANGED",
			description:
				"Those who hold the reins.\n\nVersion 2.0.0 is a major one. Here is what it does in your server and how to take it in hand.\n\n**Fewer commands, a button for each.** `/events pause` and `/events resume` act on one event, or every event when you name none. `/events stream announce`, `soon` and `weekly` hold the stream tools, `/server` holds auto heal, leaderboard tracking and the leaderboard week, `/events` lists and deletes events, and `/server channels rename` renames a channel I keep. Every admin command also has a button on the guide in your admin channel that opens it with a form and refuses anyone but the owner or an admin. Members get their own buttons in #command-center.\n\n**Leveling is already running.** Messages, reactions, approved voice channels and games earn renown. A message or a reaction pays 1, and messages, reactions and solo games against me pay a member at most 50 a day, reset at midnight Central. I read no message text, only that a message happened, where and by whom. Voice renown is off until you approve a voice channel by name. Nothing I post pings anyone.\n`/leveling settings` sets the cooldowns, the curve, which channels count, role rewards and where level ups post. `/leveling settings toggle enabled:false` turns it all off and keeps every record.\n`/leveling xp` corrects, resets a member or the whole server (it asks first) and exports it all as a file.\nI never hand out a role carrying Administrator or Manage Server, nor one above my own, so keep my role above any reward.\n\n**The arcade is open.** A 🎮 ARCADE GAMES category holds 🕹️games, where every game starts, 📋arcade-rules, ⚔️challenges and a 🎮 Arcade Lounge voice room, and the notice board gains a 🏛️ Meeting Hall voice room. Every match gets its own room under the arcade, seen only by its players unless the host opens it to all. A finished room clears four hours after the match unless its players rematch in it, and a room with no move for 30 minutes closes as abandoned, Monopoly and hangman aside. Hosts can band by rating, approve joiners and remove a player. Hold'em gives each decision 3 minutes, lets any player leave and lets the host end the table. Monopoly matches can run for days, and the host decides at the challenge card whether passed lots go to auction and whether I referee aloud.\n\n**Network play is yours to open.** `/arcade reach` sets challenges to invite only, this server (the default) or the network, where a Hold'em host may seat players from other servers. A player's name, tag, moves and ratings cross only after they accept a notice; chat never does. `/arcade server block` shuts a server out both ways.\n\n**Community and Onboarding.** 👋welcome and 📘rules join the notice board. On the admin guide, Enable Community turns on Discord Community with screening from your rules, and Configure Onboarding ends Onboarding with an answer that grants the member role, which opens my channels. Earlier members may need to retake Onboarding.\n\n**Most posts are now drawn cards**, in my new look, and each falls back to the text you know whenever a picture cannot be drawn. On Mondays at 9 am Central I send up to 25 of the week's most present members a private card of their week, never in a server where level up announcements are off.\n\n**My voice is switched off here**, and nothing listens or speaks until you turn it on. I speak in George's voice from the start, so `/dero-config enable` is the only step. The role, text channel and voice channel lists decide who may give me tasks, where I may post and which calls I may join; the voice room buttons follow them too. A monthly speech budget, $5 by default, is checked before every paid speech call. `/dero-config disable` or `/dero-config cap dollars:0` stops every speech call at once and ends a live call. In a call I hear only members on the task list; their speech goes to ElevenLabs to become text, and I keep no audio and no transcript. The Monopoly voice referee follows all of this: it speaks only into a call someone has already brought me into, and from the same monthly budget.",
		},
	},

	// ── /events stream announce (planned standalone) ─────────────────────
	// Different from /events stream soon: this is for a planned one-off stream
	// happening hours or days from now. Same primitive (one-time event),
	// stricter input (explicit date+time, optional title and description).
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
			// ── the network (2026-10 item 244 Phase 5b) ──
			scopeOption: "This realm, or every warrior on the network who chose to be seen there",
			scopeServer: "This realm",
			scopeNetwork: "The network",
			servers: "The realms on the network, ranked by the warriors who wear their tag",
			serversGameOption: "One rated game, or leave it out for every rated game",
			networkGroup: "Your place on the network",
			leave: "Leave the network: deletes your network consent and your ratings in every game",
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
			// The network scope: every warrior who accepted the network notice, wherever they play.
			networkTitle: (game: string) => `🌐 ${game} ratings across the network`,
			networkEmpty: "No warrior on the network holds a rating in this game yet.",
		},
		luck: {
			networkTitle: "🌐 The luckiest warriors on the network this month",
			networkEmpty: (minimum: number) => `No warrior on the network has ${minimum} decided games of chance this month yet.`,
			title: "🍀 The luckiest warriors this month",
			description:
				"Coin flip, dice roll and rock paper scissors, scored by wins above an even split, plus how far each magic 8 ball reading beat the average reading. A tie decides nothing and counts for nothing, and readings never count toward the decided games.",
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
		// ── the server board and leaving the network (2026-10 item 244 Phase 5b) ──
		servers: {
			title: (game: string | null) => (game ? `🏰 Realms of the network at ${game}` : "🏰 Realms of the network"),
			description: (minimum: number) =>
				`A realm's rating is the mean of the top ${minimum} ratings among the warriors who wear its server tag and chose to be seen on the network. A realm on the network that can hand out tags needs ${minimum} such warriors to be ranked.`,
			row: (place: number, server: string, tag: string | null, rating: number, members: number) =>
				`${place}. **${server}**${tag ? ` [${tag}]` : ""}: ${rating}, from ${members} ${members === 1 ? "warrior" : "warriors"}`,
			empty: "No realm on the network has enough warriors wearing its tag to be ranked yet.",
		},
		leave: {
			done: (ratingsDeleted: number) => {
				const kept = "Your luck in each realm stays with that realm.";
				if (ratingsDeleted === 0) return `You have left the network and your consent is gone. You held no rating to delete. ${kept}`;
				if (ratingsDeleted === 1) return `You have left the network. Your consent is gone, and so is your rating. ${kept}`;
				return `You have left the network. Your consent is gone, and so are your ratings in ${ratingsDeleted} games. ${kept}`;
			},
			nothing: "You were not on the network and held no rating, so there was nothing to delete.",
			failed: "The scrolls would not finish letting go of your network records just now. Ask again in a moment; it deletes whatever is left.",
		},
	},

	// ── arcade host controls (2026-10 item 244 Phase 4) ───────────
	// What members read from a host's say over who joins: the challenge card's band,
	// approval and Remove a player controls, the refusals a joiner gets, and Hold'em's
	// open seats. Written plain, like the rest of the arcade's cards (gameRoomsCopy),
	// because a button label reads the same in every voice; the general-events pack
	// reuses this object rather than keeping a second copy that could drift. Game
	// names come from gameRoomsCopy.gameLabel, so they are not repeated here.
	arcadeHostControls: {
		// The server's challenge reach (an admin's /arcade reach).
		reach: {
			publicRefused: "This server allows invite only challenges. Choose Invite only, or ask an admin about the server's challenge reach.",
		},
		// The host's rating band, for the rated games only.
		band: {
			placeholder: "Rating band",
			options: {
				any: { label: "Any rating", description: "Anyone may join" },
				close: { label: "Close", description: (width: number) => `Ratings within ${width} of the host's` },
				tight: { label: "Tight", description: (width: number) => `Ratings within ${width} of the host's` },
			},
			cardLine: (label: string, width: number | null) =>
				width === null ? `Rating band: **${label}**, anyone may join.` : `Rating band: **${label}**, ratings within ${width} of the host's may join.`,
			// A joiner still settling (fewer than 10 rated games) fits any band, and so does
			// everyone at a table whose host is still settling, which is why this names only
			// a settled rating.
			refused: (game: string) =>
				`Your ${game} rating is outside the band this host set. Look for another challenge, or one open to any rating.`,
		},
		// The host approving each joiner.
		approval: {
			toggleLabel: (enabled: boolean) => (enabled ? "Stop approving joiners" : "Approve each joiner"),
			cardLine: (waiting: number) =>
				waiting === 0
					? "The host approves each joiner. Nobody is waiting."
					: `The host approves each joiner. ${waiting} waiting for an answer.`,
			asked: "Your request to join is with the host. You are in as soon as they accept it.",
			alreadyAsked: "Your request is already with the host.",
			requestsLabel: (waiting: number) => `Requests (${waiting})`,
			requestsEmpty: "Nobody is waiting for an answer.",
			requestsPrompt: "Accept or decline the members who asked to join. A declined member may ask again.",
			acceptPlaceholder: "Accept",
			declinePlaceholder: "Decline",
			accepted: (count: number) => (count === 1 ? "Accepted 1 member." : `Accepted ${count} members.`),
			declined: (count: number) => (count === 1 ? "Declined 1 member." : `Declined ${count} members.`),
			// Said beside an accepted Hold'em player whose seat could not be taken yet; the
			// reason that follows is the table's own refusal.
			acceptedNotSeated: (userId: string, reason: string) => `<@${userId}> is accepted but not seated: ${reason}`,
			// The pool reached its member cap before every accepted member fit.
			poolFull: (max: number) => `The challenge reached ${max} members, so the rest stay waiting.`,
		},
		// The host removing a member, before the match or during it.
		kick: {
			buttonLabel: "Remove a player",
			placeholder: "Choose who to remove",
			prompt: "Choose who to remove. A removed member cannot rejoin this room, and a match they were removed from never moves their rating.",
			empty: "There is nobody to remove.",
			removed: (userId: string) => `Removed <@${userId}>. They cannot rejoin this room.`,
			// `byId` is whoever pressed: the host, or an admin using the override.
			trailLine: (byId: string, userId: string) => `🚫 <@${byId}> removed <@${userId}> from the room.`,
			// The room row has let the member go, but the live table or board was busy and
			// still holds their seat. A second press finishes the job, since it retries the seat.
			seatStillHeld: (userId: string) => `<@${userId}> is out of the room, but the table was busy and still holds their seat. Press Remove a player again.`,
			gone: "That member is no longer in this room.",
			refusedRejoin: "The host removed you from this room, so you cannot join it again.",
		},
		// Hold'em's open seats: late joiners dealt in at the next hand.
		seats: {
			openLabel: "Open seats",
			closeLabel: "Close seats",
			takeLabel: "Take a seat",
			openedLine: (hostId: string) => `🪑 <@${hostId}> opened the empty seats. A new player is dealt in at the start of the next hand.`,
			closedLine: (hostId: string) => `🪑 <@${hostId}> closed the seats.`,
			alreadyOpen: "The seats are already open.",
			alreadyClosed: "The seats are already closed.",
			closedRefused: "The seats at this table are closed.",
			notPlaying: "Seats open once the first hand is dealt. Until then, buy in.",
			alreadyPlayed: "You already played at this table, and a tournament has no buying back in.",
			alreadyWaiting: "Your seat is already waiting for the next hand.",
			heldReply: (stack: number) => `Your seat is held. You are dealt in at the start of the next hand with ${stack} chips.`,
			heldLine: (userId: string) => `🪑 <@${userId}> takes a seat for the next hand.`,
			seatedLine: (userId: string, stack: number) => `🪑 <@${userId}> sits down with ${stack} chips.`,
			// Under the seats on the table card while somebody waits for the deal.
			waitingLine: (userIds: readonly string[]) => `🪑 Dealt in next hand: ${userIds.map((userId) => `<@${userId}>`).join(", ")}`,
		},
	},

	// ── network tables: satellite rooms (2026-10 item 244 Phase 5a) ─
	// What members read when a table hosted in one server seats players from another
	// through a linked channel there. Plain like the host controls, and shared by the
	// general-events pack for the same reason. Nothing here quotes anything a member
	// typed: a satellite relays moves and the table, never chat.
	arcadeSatellites: {
		// How a player is named at a network table, in both servers: a mention of a member
		// of another server does not resolve, so a name stands in for it. The tag is the
		// server tag the player wears, when they wear one.
		playerLabel: (name: string, tag: string | null) => (tag ? `${name} [${tag}]` : name),
		// For a player Discord cannot tell us about any more. Never a raw id.
		unknownPlayer: "a player",
		// The first message in a satellite channel, before the table.
		opener: {
			title: "🌐 A table from another server",
			description: (game: string, userIds: readonly string[]) =>
				[
					`This channel mirrors a ${game} table hosted in another server.`,
					"Play your seat with the buttons on the table below. Your moves and the table are shared with the hosting server.",
					"Anything typed here stays in this server.",
					"",
					`Seated from this server: ${userIds.map((userId) => `<@${userId}>`).join(", ")}`,
				].join("\n"),
		},
		// Why a satellite could not be opened. Said to whoever asked for the seat.
		refusals: {
			notNetwork: "This table is not open to other servers.",
			notNetworkGame: (game: string) => `A ${game} table cannot seat players from other servers.`,
			roomClosed: "That table has already closed.",
			sameServer: "Players in the hosting server play in its own room.",
			notSetUp: "This server has no arcade category yet, so it cannot seat players at tables hosted elsewhere. An admin can run /setup to build it.",
			noPlayers: "Name at least one player to seat.",
			notMember: "A player named is not a member of this server.",
			inHostServer: "A player named is a member of the hosting server, so they play in its own room.",
			removed: "The host removed a player named from this table, so they cannot rejoin it.",
			missingPermissions: "Dero cannot create a channel in this server's arcade category. An admin needs to grant Manage Channels.",
			createFailed: "Something went wrong opening the table here. Try again in a moment.",
		},
		// A press in a satellite that only the hosting server's room can take.
		hostRoomOnly: "That control works only in the table's own room, in the hosting server. Here you play your own seat.",
		// A press in a satellite by a member it does not seat (an admin reading along).
		notSeatedHere: "Only the players seated from this server can play here.",
		// Why a seat left a network table without anyone pressing anything. Said in the
		// room and in every satellite still open.
		seatOut: {
			leftServer: (userId: string) => `🚪 <@${userId}> left their server, so their seat leaves the table.`,
			serverRemovedDero: (userId: string) => `🚪 <@${userId}>'s server removed Dero, so their seat leaves the table.`,
			channelGone: (userId: string) => `🚪 The channel <@${userId}> played from was deleted, so their seat leaves the table.`,
			// A network ban or a block list entry (2026-10 item 244 Phase 5c). Neutral on purpose:
			// neither names who acted or why, and the owner's ban note never reaches a member.
			banned: (userId: string) => `🚪 This table can no longer seat <@${userId}> from another server, so their seat leaves the table.`,
			blocked: (userId: string) => `🚪 <@${userId}>'s server and this table's server no longer share tables, so their seat leaves the table.`,
		},
		// The finished room's Rematch, for a table that seated other servers: a rematch
		// plays on in the host's channel, which the other servers' players cannot see.
		rematchRefused: "A table shared with other servers has no rematch. Start a new challenge instead.",
	},

	// ── network tables: the board, consent and the doors (2026-10 item 244 Phase 5b) ─
	// What members read around a satellite: the host's network option, the one time
	// network notice, the network board in each network server's challenges channel,
	// why a seat was refused, and the tag notice after a rated win. Plain like the
	// satellite words, and shared by the general-events pack for the same reason.
	// Members call the number a "rating", never Elo.
	arcadeNetwork: {
		// The host's third visibility choice, offered when the server's reach is network.
		visibilityLabel: "Open to the network",
		cardLine: (hostId: string) =>
			`<@${hostId}> is hosting a table open to this server and to players from other network servers. Once the table opens, it is listed on the network board.`,
		// Why the network choice was refused.
		hostRefusals: {
			notHost: "Only the host can open their own table to the network.",
			notOnNetwork: "This server is not on the network. An admin can open it with /arcade reach.",
			notNetworkGame: (game: string) => `A ${game} table cannot be opened to the network yet.`,
			banned: "Network tables are closed to you.",
			serverBanned: "Network tables are closed to this server.",
		},
		// The one time network notice, before anything of a member's is shown in another server.
		consent: {
			title: "🌐 Playing across servers",
			body: [
				"Network tables seat players from several servers. Before you play at one, here is what crosses servers:",
				"",
				"• Your display name and the server tag you wear",
				"• Your moves at the table and the table itself",
				"• Your rating in each rated game, on network boards and server rankings",
				"",
				"Nothing you type in a channel is shared. You can leave at any time with `/rating network leave`, which deletes your consent and your ratings.",
			].join("\n"),
			acceptLabel: "I agree",
			declineLabel: "Not now",
			// After accepting from a door that does not continue by itself (a Join or Buy in in this server).
			acceptedPressAgain: "Thanks, you are on the network. Press the button again to take your seat.",
			accepted: "Thanks, you are on the network.",
			declined: "No problem. Nothing of yours is shared, and you can still play every table in your own server.",
		},
		// The network board: one message per network server, listing other servers' open tables.
		board: {
			title: "🌐 Network tables",
			description: "Tables hosted in other servers on the network that are taking players. Pick one to ask for a seat.",
			empty: "No network table is taking players right now. A table opened to the network in any network server shows up here.",
			closedHere: "Network tables are closed to this server.",
			// One table's line: `phase` says whether it is buying in or seating between hands.
			tableLine: (game: string, host: string, server: string, seated: number, cap: number, phase: "joining" | "seatsOpen") =>
				`**${game}** hosted by ${host} from **${server}**: ${seated} of ${cap} seats, ${phase === "joining" ? "buying in" : "seating at the next hand"}`,
			// What a table's host has set, after its line, when anything is set.
			bandNote: (band: string) => `rating band ${band}`,
			approvalNote: "the host approves each player",
			placeholder: "Choose a table to join",
			optionLabel: (game: string, server: string) => `${game} from ${server}`,
			optionDescription: (host: string, seated: number, cap: number) => `Hosted by ${host}, ${seated} of ${cap} seats`,
		},
		// Why a seat at a network table was refused, said privately to whoever asked.
		joinRefusals: {
			serverOffNetwork: "This server is not on the network any more, so it cannot seat players at tables hosted elsewhere.",
			tableGone: "That table is no longer taking players.",
			bannedUser: "Network tables are closed to you.",
			bannedServer: "Network tables are closed to this server.",
			hostServerClosed: "That table's server is no longer on the network.",
			blocked: "That table's server and this one do not share tables.",
			outsideBand: (game: string) => `Your ${game} rating is outside the band this host set. Look for another table.`,
			removed: "The host removed you from that table, so you cannot rejoin it.",
		},
		// A seat that worked: the satellite channel to play from.
		seatReady: (channelId: string) => `Your seat is ready in <#${channelId}>. Buy in there.`,
		alreadySeated: (channelId: string) => `You already have a seat at that table, in <#${channelId}>.`,
		asked: "Your request is with the host. Once they accept it, your seat opens in a channel here.",
		alreadyAsked: "Your request is already with the host.",
		// Said to the host, after "accepted but not seated:", when a member from another
		// server can no longer be seated by the time the host accepts them.
		hostAccept: {
			serverGone: "their server is no longer on the network",
			closed: "network tables are now closed to them or their server",
		},
		// After a rated win, at most once in 30 days, when the server tag the winner wears
		// belongs to a server that is not on the network.
		tagNotice: {
			notInServer: (userId: string, tag: string, inviteUrl: string) =>
				`🏷️ <@${userId}>, your server tag **${tag}** belongs to a server Dero is not in yet. Bring Dero there and its rated wins can count toward a server ranking: ${inviteUrl}`,
			notOnNetwork: (userId: string, server: string) =>
				`🏷️ <@${userId}>, your server tag belongs to **${server}**, which is not on the network yet. Ask its admins to open it with /arcade reach, and its rated wins can count toward a server ranking.`,
		},
	},
};
