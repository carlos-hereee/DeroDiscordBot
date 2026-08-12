// ── leveling user-facing copy ──────────────────────────────────────────────
// Feature-local copy module. Centralizes every string the leveling system shows
// so none is hardcoded in a handler, WITHOUT threading through the pluginId copy
// packs. This follows gamesCopy.ts and fortuneCopy.ts, and it is worth restating
// their reasoning because CLAUDE.md rule 5 says the opposite by default:
//
//   "Level", "XP to next" and "Rank" have no kingdom voice and no streamer
//   voice. They read identically in both packs, so a two voice split here would
//   double the authoring work for content that would come out the same.
//
// ⚠️ ONE EXCEPTION, and it is the reason this file is not simply a copy of
// gamesCopy's posture. The DERO CONGRATULATIONS is the single string in this
// feature with a real voice: "You reached level 13" and "Your renown grows,
// warrior" are genuinely different products. So its default lives here AND it is
// overridable per guild through:
//
//   getCopyOverride("leveling.levelUp", guildConfig)
//   getCopyOverride("leveling.milestone", guildConfig)
//
// This is VERIFIED, not assumed, so do not re-investigate it: getCopyOverride at
// src/base/copy/getCopy.ts line 77 takes an ARBITRARY string key and returns
// guildConfig.copyOverrides.get(key) or undefined. It is not scoped to pack
// fields, and copyOverrides is already a Mongoose Map of String. No schema change
// is needed to make these two keys overridable, and the owner can retune the one
// voiced string in this feature without a deploy.
//
// ⚠️ THE RULE THAT OUTLIVES THIS FILE: leveling must NEVER award xp based on
// message length, word count, or message content of any kind. Two reasons, and
// both are permanent. ① It would require the privileged MessageContent intent,
// which src/main.ts deliberately does not request and which is gated by Discord
// verification at 100+ guilds, so requesting it while unused is pure verification
// risk. ② Length based xp is the most gameable mode in this category. The xp roll
// function takes no message text as a parameter, which is the structural half of
// this rule; this comment is the other half.
//
// House rule for every string below: no dashes in user-facing copy. Hyphens
// inside slash command identifiers (setup-level-system, reset-member) are
// identifiers, not dashes, and are correct.

// ── the level up template vocabulary ───────────────────────────────────────
// Tags an owner may use in an overridden congratulations. Rendered by
// levelUpAnnouncer; anything not in this list is left in the string verbatim
// rather than replaced with an empty space, so a typo reads as a typo instead of
// silently deleting itself.
//
//   {user.mention}  a <@id> mention. Renders as a name and NOTIFIES NOBODY,
//                   because every leveling send pins allowedMentions to parse [].
//   {user.name}     the member's display name, no mention
//   {user.level}    the level just reached
//   {user.xp}       progress INTO that level, not the lifetime total
//   {guild.name}    the server name
//   {earned:...}    a conditional block, rendered only when a role reward was
//                   granted in the same beat and dropped entirely when not
export const LEVEL_UP_TAGS = ["user.mention", "user.name", "user.level", "user.xp", "guild.name"] as const;

export const levelingCopy = {
	// ── the one voiced string, and its milestone sibling ──
	// Defaults only. A guild that sets leveling.levelUp or leveling.milestone in
	// copyOverrides replaces these entirely.
	levelUp: {
		// The ORDINARY level. Deliberately one compact line with no embed and no
		// art: at the volume a live guild produces, an embed per level up is what
		// trains a community to mute the announcements channel.
		defaultTemplate: "{user.mention} reached **level {user.level}**.",

		// A PRIME level. This one earns the full card, so it can afford a sentence.
		milestoneTemplate: "{user.mention} reached **level {user.level}**, a milestone. Dero salutes you.",

		milestoneTitle: "A milestone level",
		ordinaryTitle: "Level up",

		// Appended when a role landed in the same beat. This is the {earned:...}
		// block's rendered form.
		earnedRole: (roleId: string): string => `\n\nEarned: <@&${roleId}>`,

		// The combined message, sent instead of N separate ones once a burst passes
		// BOT_CONSTANTS.LEVELING.ANNOUNCE_BURST_THRESHOLD.
		combinedTitle: "Level ups",
		combinedIntro: (count: number): string => `${count} members leveled up.`,
		combinedLine: (userId: string, level: number, milestone: boolean): string =>
			`${milestone ? "✦" : "•"} <@${userId}> reached level **${level}**${milestone ? " (milestone)" : ""}`,

		// Explains the mechanic the first time a member sees it, because prime
		// milestones are invisible otherwise: nobody deduces "the loud ones are
		// prime numbers" from a single celebration.
		milestoneFooter: "Milestone levels are the prime numbered ones.",
	},

	// ── the one time admin notice ──
	// Leveling ships ON in every guild with no opt in, which means some admin will
	// otherwise meet this feature for the first time when a member asks them about
	// it. Posted to the admin channel on the FIRST level up ever recorded in a
	// guild, once, and never again.
	adminNotice: {
		title: "Leveling is now live in this server",
		body: [
			"Members now earn XP for chatting, reacting, and playing Dero's games, and level ups post here in your announcements channel.",
			"",
			"It is on by default and it never pings anyone.",
			"",
			"Run **/setup-level-system** to change the rates, pick which channels count, choose role rewards, approve voice channels, or turn the whole thing off.",
		].join("\n"),
	},

	// ── structural copy ──
	// Reads identically in the kingdom voice and the streamer voice, which is the
	// whole reason this file opts out of the packs.
	labels: {
		level: "Level",
		xp: "XP",
		totalXp: "Total XP",
		xpIntoLevel: "XP into level",
		xpToNext: "XP to next",
		rank: "Rank",
		guildRank: "Server rank",
		weekRank: "This week",
		monthRank: "This month",
		messages: "Messages",
		reactions: "Reactions given",
		voiceMinutes: "Voice minutes",
		played: "Played",
		won: "Won",
		lost: "Lost",
		drawn: "Drawn",
		assists: "Assists",
		ratio: "W/L",
		overall: "Overall",
		achievements: "Achievements",
		inProgress: "In progress",
		nextMilestone: "Your next level is a milestone.",
		noRecordYet: "No games played yet.",
		noAchievementsYet: "No achievements yet. Keep going.",
	},

	// ── the two boards share a channel, so each one says what it measures ──
	// The mitigation for the single most likely confusion in this feature: a
	// member scrolling #leaderboard sees two pinned standings and must never have
	// to guess which is which. Every embed either board renders carries its own
	// line, and the two lines are written here together so they stay contrasting.
	boardSubtitles: {
		levels: "How present you are in this server, all the time.",
		participation: "Who showed up for events. See /leaderboard.",
	},

	board: {
		title: "Server levels",
		emptyState: "Nobody has earned XP yet. Say something and you will be first.",
		allTime: "All time",
		thisWeek: "This week",
		thisMonth: "This month",
	},

	// ── errors and refusals ──
	errors: {
		disabled: "Leveling is turned off in this server.",
		noData: "No leveling data yet for this server.",
		memberNoData: "That member has not earned any XP yet.",
		botMember: "Bots do not level up.",
		outsideGuild: "Leveling only works inside a server, not in a DM.",
		// Refused at CONFIG time with a clear message, not silently at grant time.
		// A leveling bot handing out admin because someone chatted a lot is a
		// security incident, not a bug.
		rewardRolePrivileged:
			"That role carries Administrator or Manage Server, so Dero will not hand it out as a level reward. Pick a role without those permissions.",
		rewardRoleTooHigh:
			"That role sits at or above Dero's own highest role, so Dero cannot assign it. Move Dero's role above it in Server Settings and try again.",
		rewardRoleManaged: "That role is managed by an integration, so no bot can assign it. Pick a normal role.",
	},
};
