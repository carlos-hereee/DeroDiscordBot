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

// shape of IDs saved to the database after setup
export interface ICreatedChannels {
	categoryId: string;
	introChannelId: string;
	commandsChannelId: string;
	leaderboardChannelId: string;
	scheduleChannelId: string;
	announcementsChannelId: string;
	adminChannelId: string;
	// id of 🛡️next-decree. separate channel from announcements so
	// the NextUpBoard's permanent-post audit trail does not drown the
	// 15/30 minute reminder pings.
	nextDecreeChannelId: string;
	// 🗒️admin-log, the bot write only audit trail (post-launch plan item 11).
	adminLogChannelId: string;
	// 👋welcome and 📘rules (2026-10 item 247 Phase 2). Either may be a channel the
	// server already had, adopted into the homebase rather than built.
	welcomeChannelId: string;
	rulesChannelId: string;
	// ── 🎮 ARCADE GAMES, the SECOND managed category ──
	// Declared here rather than left to the boot sweep because a fresh install
	// should produce both categories in one pass. These three are hand written
	// literals, NOT derived from CHANNEL_FIELDS, so this interface and that array
	// are two lists that must be extended together; the compiler catches the
	// direction that matters (a missing id here fails createChannels' return).
	gamesCategoryId: string;
	arcadeRulesChannelId: string;
	arcadeChallengesChannelId: string;
	arcadeGamesChannelId: string;
	// 🎉party-games, admin hosted group games (post-launch plan item 3).
	partyGamesChannelId: string;
	// 🏆rated-challenges, the rated games' challenges (2026-10 item 254, Arcade 5).
	arcadeRatedChallengesChannelId: string;
	// ── the two voice rooms (2026-10 item 235), one under each category ──
	meetingVoiceChannelId: string;
	arcadeVoiceChannelId: string;
	// ── 🏰 DERO HEADQUARTERS, the THIRD managed category (2026-10 item 257 Phase 2a) ──
	// The three admin channels above live under it on a fresh install; these are its
	// own id and the four admin config channels it adds (🛠️server-config, 2026-10 item 263).
	headquartersCategoryId: string;
	deroConfigChannelId: string;
	onboardingConfigChannelId: string;
	arcadeControlChannelId: string;
	// 🛠️server-config, the fourth config channel (2026-10 item 263 Phase 4a).
	serverConfigChannelId: string;
	// 💬dero-commands under the notice board, where member command answers post.
	commandOutputChannelId: string;
}

// live channel objects returned from createChannels
// passed directly to populateChannels so we don't re-fetch from Discord.
// The two voice rooms are absent on purpose: populateChannels posts nothing
// to them, so only their ids (ICreatedChannels) travel on.
export interface IChannelObjects {
	introChannel: TextChannel;
	commandsChannel: TextChannel;
	leaderboardChannel: TextChannel;
	scheduleChannel: TextChannel;
	adminChannel: TextChannel;
	announcementsChannel: TextChannel;
	nextDecreeChannel: TextChannel;
	adminLogChannel: TextChannel;
	welcomeChannel: TextChannel;
	rulesChannel: TextChannel;
	arcadeRulesChannel: TextChannel;
	arcadeChallengesChannel: TextChannel;
	arcadeGamesChannel: TextChannel;
	partyGamesChannel: TextChannel;
	arcadeRatedChallengesChannel: TextChannel;
	// The two voice rooms, so a fresh build can post their intros (2026-10 item 245).
	meetingVoiceChannel: VoiceChannel;
	arcadeVoiceChannel: VoiceChannel;
	// 🏰 DERO HEADQUARTERS' config channels and 💬dero-commands (2026-10 item 257 Phase 2a).
	deroConfigChannel: TextChannel;
	onboardingConfigChannel: TextChannel;
	arcadeControlChannel: TextChannel;
	serverConfigChannel: TextChannel;
	commandOutputChannel: TextChannel;
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
