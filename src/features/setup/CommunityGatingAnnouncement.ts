import { TextChannel, type Client, type Guild } from "discord.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { infoEmbed } from "@utils/embedBuilder.js";

// ── CommunityGatingAnnouncement ──────────────────────────────────────
// What:  the one time pair of posts that tells a guild its channels now need the
//        member role (2026-10 item 247 Phase 1): #inner-sanctum in the admin voice,
//        #announcements in the member voice. Copy is the pack's
//        channelContent.gatingAnnouncement, resolved per guild. It decides nothing
//        about WHETHER a guild is gated; that is communityOverwrites' job.
// Who:   GuildSetupManager.reconcileCommunityGating, on a boot where the member
//        role gates a Community guild. No other caller.
// When:  posts at most once per guild, ever. Every later call costs one indexed
//        BotLog read and returns.
// Where: the shape of postFeatureAnnouncement (a BotLog key, has before, log after
//        both posts, no pings), deliberately written fresh rather than imported:
//        that module walks every guild per release, this one answers for a single
//        guild the reconcile hands it. No bot version is read, because the key is
//        not per release.
// How:   ① bail when the key is already logged; ② resolve both channels from the
//        stored row, deferring (no log) when either is missing; ③ post the admin
//        embed, then the public one; ④ log the key only after both succeeded.
//        The admin post goes FIRST on purpose. A failure between the two then
//        repeats the admin post on retry, in a channel only admins read, instead of
//        repeating the public one in front of every member: the double public post
//        postFeatureAnnouncement's own closing note accepts as a known risk.
//        Never throws: a failure is logged and the next boot retries.

/** What one call did, for the caller's log line and the tests. */
export type GatingAnnouncementOutcome = "posted" | "already-announced" | "deferred" | "failed";

/** The stored GuildConfig fields this module reads. */
export interface IGatingAnnouncementConfig extends ICopyConfig {
	announcementsChannelId?: string | null;
	adminChannelId?: string | null;
	memberRoleId?: string | null;
}

export const CommunityGatingAnnouncement = {
	/** Post the gating announcement to one guild if it has never had it. Never throws. */
	async post(client: Client, guild: Guild, stored: IGatingAnnouncementConfig): Promise<GatingAnnouncementOutcome> {
		try {
			if (await botLogStore.has(guild.id, BOT_LOG_EVENTS.MEMBER_ROLE_GATING_ANNOUNCED)) return "already-announced";

			const { announcementsChannelId, adminChannelId, memberRoleId } = stored;
			// A missing id or channel is the repair sweep's to fix, not a failure: leave
			// the key unset so the boot after the repair announces.
			if (!announcementsChannelId || !adminChannelId || !memberRoleId) return deferred(guild.id, "missing-ids");
			const announcementsChannel = await client.channels.fetch(announcementsChannelId).catch(() => null);
			const adminChannel = await client.channels.fetch(adminChannelId).catch(() => null);
			if (!(announcementsChannel instanceof TextChannel) || !(adminChannel instanceof TextChannel)) {
				return deferred(guild.id, "channels-unavailable");
			}

			// No pings, ever: the copy mentions the member role so a reader sees which
			// one, and parse: [] renders that mention without notifying anybody.
			const copy = getPluginCopy(stored);
			const { member, admin } = copy.channelContent.gatingAnnouncement;
			await adminChannel.send({
				embeds: [infoEmbed(admin.title, admin.description(memberRoleId), copy.COLORS.ADMIN, stored)],
				allowedMentions: { parse: [] },
			});
			await announcementsChannel.send({
				embeds: [infoEmbed(member.title, member.description(memberRoleId), copy.COLORS.ANNOUNCEMENTS, stored)],
				allowedMentions: { parse: [] },
			});

			await botLogStore.log(guild.id, BOT_LOG_EVENTS.MEMBER_ROLE_GATING_ANNOUNCED, { announcementsChannelId, adminChannelId });
			console.log(`[community-gating] guild ${guild.id} announcement posted`);
			return "posted";
		} catch (error) {
			console.warn(`[community-gating] guild ${guild.id} announcement failed; the next boot retries`, error);
			return "failed";
		}
	},
};

function deferred(guildId: string, reason: "missing-ids" | "channels-unavailable"): GatingAnnouncementOutcome {
	console.warn(`[community-gating] guild ${guildId} announcement deferred: ${reason}`);
	return "deferred";
}
