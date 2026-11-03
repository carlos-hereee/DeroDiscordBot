import type { TextChannel, VoiceChannel } from "discord.js";

export interface ISetupConfig {
	guildId: string;
	ownerId: string;
}

export interface IAdminRoleConfig {
	guildId: string;
	ownerId: string;
	adminRoleId: string;
	// required as of the April 2026 update. the member role is pinged on every
	// event reminder so it must be set before reminders can fire cleanly.
	// GuildConfigModel still allows null at the schema layer to keep legacy
	// pre-update rows readable, but every new /setup run must supply this.
	memberRoleId: string;
}

// ── ids saved to the database after setup, one group per managed category ──
// Grouped by the category each channel lives under because a forced rebuild builds
// a category's group only when it built that category, and keeps a reused category's
// live channels instead (2026-10 item 273). These are hand written literals, NOT
// derived from CHANNEL_FIELDS, so these interfaces and that array are lists that must
// be extended together; the compiler catches the direction that matters (a missing
// id here fails the group builder's return).

// 🪧 NOTICE BOARD, always built: a forced rebuild only runs when this category is gone.
export interface IHomebaseChannelIds {
	categoryId: string;
	introChannelId: string;
	commandsChannelId: string;
	leaderboardChannelId: string;
	scheduleChannelId: string;
	announcementsChannelId: string;
	// id of 🛡️next-decree. separate channel from announcements so
	// the NextUpBoard's permanent-post audit trail does not drown the
	// 15/30 minute reminder pings.
	nextDecreeChannelId: string;
	// 👋welcome and 📘rules (2026-10 item 247 Phase 2). Either may be a channel the
	// server already had, adopted into the homebase rather than built.
	welcomeChannelId: string;
	rulesChannelId: string;
	// The notice board's voice room (2026-10 item 235).
	meetingVoiceChannelId: string;
	// 💬dero-commands under the notice board, where member command answers post.
	commandOutputChannelId: string;
}

// 🎮 ARCADE GAMES, the SECOND managed category.
export interface IArcadeChannelIds {
	gamesCategoryId: string;
	arcadeRulesChannelId: string;
	arcadeChallengesChannelId: string;
	arcadeGamesChannelId: string;
	// 🎉party-games, admin hosted group games (post-launch plan item 3).
	partyGamesChannelId: string;
	// 🏆rated-challenges, the rated games' challenges (2026-10 item 254, Arcade 5).
	arcadeRatedChallengesChannelId: string;
	// 🏪dero-market, chips for Dero coins and back (2026-10 item 267 Session 2a).
	deroMarketChannelId: string;
	// The arcade's voice room, 🎮 Arcade Lounge (2026-10 item 235).
	arcadeVoiceChannelId: string;
}

// 🏰 DERO HEADQUARTERS, the THIRD managed category (2026-10 item 257 Phase 2a): its own
// id, 🔒inner-sanctum, 🗒️admin-log and the four admin config channels. Every channel but
// 🔒inner-sanctum is null while it waits for setup (2026-11 item 285 debug pass): a build
// with no admin role makes 🔒inner-sanctum alone, and Set up Dero builds the rest.
export interface IHeadquartersChannelIds {
	headquartersCategoryId: string;
	adminChannelId: string;
	// 🗒️admin-log, the bot write only audit trail (post-launch plan item 11).
	adminLogChannelId: string | null;
	deroConfigChannelId: string | null;
	onboardingConfigChannelId: string | null;
	arcadeControlChannelId: string | null;
	// 🛠️server-config, the fourth config channel (2026-10 item 263 Phase 4a).
	serverConfigChannelId: string | null;
}

// ── live channel objects, passed straight to the intro posters so nothing is re-fetched ──
export interface IHomebaseChannelObjects {
	introChannel: TextChannel;
	commandsChannel: TextChannel;
	leaderboardChannel: TextChannel;
	scheduleChannel: TextChannel;
	announcementsChannel: TextChannel;
	nextDecreeChannel: TextChannel;
	welcomeChannel: TextChannel;
	rulesChannel: TextChannel;
	// The voice rooms carry a /dero card in their text chat (2026-10 item 245).
	meetingVoiceChannel: VoiceChannel;
	commandOutputChannel: TextChannel;
}

export interface IArcadeChannelObjects {
	arcadeRulesChannel: TextChannel;
	arcadeChallengesChannel: TextChannel;
	arcadeGamesChannel: TextChannel;
	partyGamesChannel: TextChannel;
	arcadeRatedChallengesChannel: TextChannel;
	deroMarketChannel: TextChannel;
	arcadeVoiceChannel: VoiceChannel;
}

// Null exactly where IHeadquartersChannelIds is: a channel waiting for setup is not built.
export interface IHeadquartersChannelObjects {
	adminChannel: TextChannel;
	adminLogChannel: TextChannel | null;
	deroConfigChannel: TextChannel | null;
	onboardingConfigChannel: TextChannel | null;
	arcadeControlChannel: TextChannel | null;
	serverConfigChannel: TextChannel | null;
}

/** One built group: the ids to persist and the live channels to post intros into. */
export interface IBuiltGroup<TIds, TObjects> {
	ids: TIds;
	objects: TObjects;
}

// return shape of GuildSetupManager.ensureHomebase. the ready sweep in main.ts
// reads action to decide whether to send the owner the first-time arrival DM:
//   • "built"   , no prior GuildConfig existed, a fresh homebase was just
//                  constructed. DM the owner, log INTRO_DM_SENT.
//   • "rebuilt" , a stale GuildConfig was cleared and replaced (category
//                  gone or foreign). A "castle rebuilt" notice is posted in
//                  the new inner sanctum by ensureHomebase itself. No DM.
//   • "repaired", category was intact and owned by this bot, but one or
//                  more individual channels were missing and were rebuilt.
//                  repairedChannels lists the human readable names (same
//                  strings the copy pack's setup.channels exposes). A per
//                  channel notice is posted to the inner sanctum.
//   • "skipped" , stored homebase exists in full and is owned by this bot.
export interface IEnsureHomebaseResult {
	action: "built" | "rebuilt" | "repaired" | "skipped";
	// populated only when action === "repaired". empty array on every other
	// branch. kept on the result even though the caller currently does not
	// read it so tests and future wiring (dashboard audit log, etc) have a
	// structured signal instead of only log strings.
	repairedChannels: string[];
}
