import type { TextChannel } from "discord.js";

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
	// id of the admin-only command channel. Holds the relocated admin command
	// guide + the admin power-up panel; kept out of inner-sanctum so daily
	// announcements there do not bury the quick-action controls.
	adminCommandsChannelId: string;
	// ── 🎮 ARCADE GAMES, the SECOND managed category ──
	// Declared here rather than left to the boot sweep because a fresh install
	// should produce both categories in one pass. These three are hand written
	// literals, NOT derived from CHANNEL_FIELDS, so this interface and that array
	// are two lists that must be extended together; the compiler catches the
	// direction that matters (a missing id here fails createChannels' return).
	gamesCategoryId: string;
	arcadeRulesChannelId: string;
	gamesChallengesChannelId: string;
}

// live channel objects returned from createChannels
// passed directly to populateChannels so we don't re-fetch from Discord
export interface IChannelObjects {
	introChannel: TextChannel;
	commandsChannel: TextChannel;
	leaderboardChannel: TextChannel;
	scheduleChannel: TextChannel;
	adminChannel: TextChannel;
	announcementsChannel: TextChannel;
	nextDecreeChannel: TextChannel;
	adminCommandsChannel: TextChannel;
	arcadeRulesChannel: TextChannel;
	gamesChallengesChannel: TextChannel;
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
