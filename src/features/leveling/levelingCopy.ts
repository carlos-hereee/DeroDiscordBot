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
// inside slash command identifiers (set-level, reset-member) are
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
			"Run **/leveling settings** to change the rates, pick which channels count, choose role rewards, approve voice channels, or turn the whole thing off.",
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
		record: "Record",
		// The month's coin flip, dice and rps luck, as the luck board counts it.
		luck: "Luck this month",
		// Magic 8 ball readings join the score above the average reading (2026-10 item 250
		// Phase 5), and are named beside the games once the member has read it this month.
		luckLine: ({ wins, decided, readings, score }: { wins: number; decided: number; readings?: number; score: number | null }, minDecided: number): string => {
			const games = `**${wins}** won of **${decided}** decided`;
			const tally = readings ? `${games} and **${readings}** magic 8 ball ${readings === 1 ? "reading" : "readings"}` : games;
			if (score === null) return `${tally}. A luck score shows from ${minDecided} decided games.`;
			const margin = Math.abs(score).toLocaleString(undefined, { maximumFractionDigits: 1 });
			return `${tally}, **${margin}** ${score >= 0 ? "above" : "below"} an even split.`;
		},
		noLuckYet: "No coin flip, dice or rps decided this month.",
		// The member's chips in this server (2026-10 item 250 Phase 5). The claim hint
		// shows only on the member's own profile, since nobody claims for anyone else.
		chipsLine: (balance: number, claim: { nextClaimAt: Date | null; now: Date } | null): string => {
			const amount = `**${balance.toLocaleString("en-US")}** ${balance === 1 ? "chip" : "chips"}`;
			if (!claim) return `${amount}.`;
			if (claim.nextClaimAt === null || claim.nextClaimAt.getTime() <= claim.now.getTime()) return `${amount}. Your claim is ready: \`/claim\`.`;
			return `${amount}. Next claim <t:${Math.floor(claim.nextClaimAt.getTime() / 1000)}:R>.`;
		},
		// The currencies field (2026-10 item 257, Phase 3a): Hold'em chips in this server,
		// or off where the server switched them off, and Dero coins, which are global.
		currencies: "Currencies",
		holdemChips: "Hold'em chips",
		chipsOff: "off in this server",
		deroCoins: "Dero coins",
		coinsLine: (balance: number): string => `**${balance.toLocaleString("en-US")}**`,
		// The secret code boost (FortuneBuff), its own line beside the game luck: the gold
		// reading chance a member holds above the base.
		luckBoostLine: (percent: number): string => `Luck boost: **+${percent}%** gold chance`,
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

	// The views /account offers, its `view` option's choice labels.
	accountViews: {
		profile: "Profile",
		levels: "Levels",
		achievements: "Achievements",
		saved: "Saved matches",
	},
	// The same three views as buttons on the #command-center guide (PowerUps).
	guideButtons: {
		account: "Account",
		levels: "Levels",
		achievements: "Achievements",
	},

	board: {
		title: "Server levels",
		emptyState: "Nobody has earned XP yet. Say something and you will be first.",
		allTime: "All time",
		thisWeek: "This week",
		thisMonth: "This month",
	},

	// ── achievements ──
	// The tier names are the ladder members read at a glance, so they stay short
	// and in one place rather than being formatted at each render site.
	achievements: {
		unlockedOne: "Achievement unlocked",
		unlockedMany: "Achievements unlocked",
		unlockedBy: (userId: string): string => `<@${userId}> earned:`,
		// The id is rendered rather than the label on purpose: ids are stable and
		// searchable, and a member comparing screenshots is comparing ids.
		unlockLine: (id: string, tier: string, earnedBy: string): string => `**${id}** (${tier}) • ${earnedBy}`,
		hiddenNote: "Some achievements stay hidden until you earn them.",
	},

	// ── the canvas cards (2026-10 item 243 Phase 2) ──
	// Words drawn INTO a card's pixels. They read identically in both voices like
	// the labels above, and a card cannot carry a mention, so nothing here takes
	// an id. Uppercase is set here rather than by the renderer, so what the copy
	// says is exactly what the card shows.
	cards: {
		levelBadge: (level: number): string => `LEVEL ${level}`,
		primeLevel: "PRIME LEVEL",
		milestoneLevel: "MILESTONE LEVEL",
		rankOf: (rank: number, size: number): string => `#${rank.toLocaleString()} of ${size.toLocaleString()}`,
		unranked: "Not ranked yet",
		xpProgress: (into: number, span: number): string => `${into.toLocaleString()} / ${span.toLocaleString()} XP`,
		record: "Record",
		presence: "Presence",
		winLoss: (won: number, lost: number, drawn: number): string => `${won}W  ${lost}L  ${drawn}D`,
		moreUnlocks: (count: number): string => `and ${count} more`,
		// ── the account card's record, luck and chips (2026-10 item 254) ──
		// The text profile's lines carry bold marks and a Discord timestamp, neither of
		// which a card can draw, so the card has its own plain words for them.
		recordColumns: { played: "P", won: "W", lost: "L", drawn: "D", assists: "Ast", ratio: "W/L" },
		luckWins: (wins: number, decided: number): string => `${wins.toLocaleString()} won of ${decided.toLocaleString()} decided`,
		luckReadings: (readings: number): string => `${readings.toLocaleString()} magic 8 ball ${readings === 1 ? "reading" : "readings"}`,
		luckScore: (score: number): string => `${Math.abs(score).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${score >= 0 ? "above" : "below"} even`,
		luckScoreLater: (minDecided: number): string => `Score from ${minDecided} decided`,
		noLuck: "Nothing decided yet",
		claimReady: "Claim ready: /claim",
		// The currencies panel and the luck boost line (2026-10 item 257, Phase 3a).
		chipsCard: (balance: number): string => `Hold'em chips ${balance.toLocaleString("en-US")}`,
		chipsOffCard: "Hold'em chips off",
		coinsCard: (balance: number): string => `Dero coins ${balance.toLocaleString("en-US")}`,
		luckBoost: (percent: number): string => `Luck boost +${percent}% gold chance`,
		// ── the achievements card (2026-10 item 254) ──
		achievementsTitle: "ACHIEVEMENTS",
		heldCount: (count: number): string => `${count.toLocaleString()} held`,
		inProgressLine: (label: string, nextTier: string): string => `${label} (${nextTier})`,
		progressOf: (current: number, threshold: number): string => `${current.toLocaleString()} / ${threshold.toLocaleString()}`,
		// Hours and minutes, since a card cannot count down the way a Discord timestamp does.
		nextClaimIn: (hours: number, minutes: number): string => `Next claim in ${hours > 0 ? `${hours}h ` : ""}${minutes}m`,
		// ── platform cards (2026-10 item 243 Phase 4) ──
		roleUnlocked: "ROLE UNLOCKED",
		unlockedAtLevel: (level: number): string => `Unlocked at level ${level}`,
		weekRecap: "YOUR WEEK",
		weekXp: (xp: number): string => `${xp.toLocaleString()} XP`,
		weekXpLabel: "earned this week",
		weekRank: (rank: number, active: number): string => `#${rank.toLocaleString()} of ${active.toLocaleString()}`,
		weekRankLabel: "this week's standing",
		levelLabel: "current level",
	},

	// ── role unlock (2026-10 item 243 Phase 4) ──
	// Posted once, the first time a reward role lands on a member. The mentions
	// sit inside an embed, which never pings, and the send carries no mentions
	// besides.
	roleUnlock: {
		title: "Role unlocked",
		unlockedBy: (userId: string, roleId: string, level: number): string =>
			`<@${userId}> unlocked <@&${roleId}> at level ${level}.`,
	},

	// ── the weekly digest DM (2026-10 item 243 Phase 4) ──
	// A direct message, so nothing here takes a mention: a role or channel
	// mention renders as raw text outside its server. The guild is named instead.
	weeklyDigest: {
		title: (guildName: string): string => `Your week in ${guildName}`,
		xpLine: (xp: number): string => `You earned **${xp.toLocaleString()} XP** this week.`,
		rankLine: (rank: number, active: number): string =>
			`That puts you **#${rank.toLocaleString()}** of ${active.toLocaleString()} active members.`,
		levelLine: (level: number): string => `You are level **${level}**. Keep showing up.`,
		footer: "Sent once a week to the members who were active. An admin can turn leveling announcements off.",
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
