import { TextChannel, type Client, type Guild } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { communityCopy } from "./communityCopy.js";
import { COMMUNITY_CUSTOM_IDS } from "./communityControls.js";

// ── communityButtonsPointer ──────────────────────────────────────────
// What:  the one time #inner-sanctum post that points admins at the new community
//        buttons on the admin guide (2026-10 item 247 Phase 3). Admin only: nothing
//        here posts to #announcements.
// Who:   main.ts, once per boot through postCommunityButtonsPointers, after the
//        intro refresh has had its chance to put the row on every guide.
// When:  at most once per guild, ever, and only for a setup complete guild whose
//        guide already carries the buttons. Every later boot costs one indexed
//        BotLog read per guild and returns.
// Where: the shape of postFeatureAnnouncement and CommunityGatingAnnouncement (a
//        BotLog key, has before, log after the post, no pings), written fresh because
//        this one checks the guide it points at.
// How:   ① skip a guild that is not set up, or whose homebase was self destructed;
//        ② bail when the key is logged; ③ defer (no log) while the guide does not
//        show its community button yet, so the post never points at a button nobody can
//        see; ④ post, then log. Never throws: a failure is logged and the next boot
//        retries.

/** What one call did, for the boot log and the tests. */
export type CommunityPointerOutcome = "posted" | "already-posted" | "not-set-up" | "deferred" | "failed";

/** The stored GuildConfig fields this module reads. */
export interface ICommunityPointerConfig extends ICopyConfig {
	setupComplete?: boolean | null;
	homebaseDestroyed?: boolean | null;
	adminChannelId?: string | null;
	adminCommandsChannelId?: string | null;
	introMessageIds?: { adminCommandsChannelId?: string | null } | null;
}

type DeferReason = "missing-ids" | "buttons-not-rendered" | "channel-unavailable";

export const CommunityButtonsPointer = {
	/** Post the pointer to one guild if it has never had it. Never throws. */
	async post(client: Client, guild: Guild, stored: ICommunityPointerConfig): Promise<CommunityPointerOutcome> {
		try {
			if (!stored.setupComplete || stored.homebaseDestroyed) return "not-set-up";
			if (await botLogStore.has(guild.id, BOT_LOG_EVENTS.COMMUNITY_BUTTONS_AVAILABLE_NOTICE)) return "already-posted";

			const { adminChannelId, adminCommandsChannelId } = stored;
			// A missing id or channel is the repair sweep's to fix: leave the key unset
			// so the boot after the repair posts.
			if (!adminChannelId || !adminCommandsChannelId) return deferred(guild.id, "missing-ids");
			if (!(await guideShowsCommunityButtons(client, stored))) return deferred(guild.id, "buttons-not-rendered");
			const adminChannel = await client.channels.fetch(adminChannelId).catch(() => null);
			if (!(adminChannel instanceof TextChannel)) return deferred(guild.id, "channel-unavailable");

			const copy = getPluginCopy(stored);
			await adminChannel.send({
				embeds: [infoEmbed(communityCopy.pointer.title, communityCopy.pointer.description(adminCommandsChannelId), copy.COLORS.ADMIN, stored)],
				allowedMentions: { parse: [] },
			});
			await botLogStore.log(guild.id, BOT_LOG_EVENTS.COMMUNITY_BUTTONS_AVAILABLE_NOTICE, { adminChannelId, adminCommandsChannelId });
			console.log(`[community-pointer] guild ${guild.id} pointer posted`);
			return "posted";
		} catch (error) {
			console.warn(`[community-pointer] guild ${guild.id} pointer failed; the next boot retries`, error);
			return "failed";
		}
	},
};

/** Boot entry point: offer the pointer to every guild, one at a time so one guild's failure cannot stall the rest. */
export async function postCommunityButtonsPointers(client: Client): Promise<void> {
	for (const guild of client.guilds.cache.values()) {
		const stored = (await guildConfigStore.findByGuildId(guild.id).catch(() => null)) as ICommunityPointerConfig | null;
		if (!stored) continue;
		await CommunityButtonsPointer.post(client, guild, stored);
	}
}

// True when the tracked admin guide already carries its community button: Enable
// Community, or Configure Onboarding on a server where Community is on (the row shows
// one of the two, post-launch plan item 8). The intro
// refresh edits the guide earlier in the same boot, but an edit it could not make
// (a 50013, a deleted guide awaiting its repost) would otherwise leave the pointer
// naming a button that is not there.
async function guideShowsCommunityButtons(client: Client, stored: ICommunityPointerConfig): Promise<boolean> {
	const guideId = stored.introMessageIds?.adminCommandsChannelId;
	if (!stored.adminCommandsChannelId || !guideId) return false;
	const channel = await client.channels.fetch(stored.adminCommandsChannelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return false;
	const guide = await channel.messages.fetch(guideId).catch(() => null);
	if (!guide) return false;
	return guide.components.some((row) => {
		// toJSON reads a live message row in the API shape, the way
		// GuildSetupManager.componentsAreEquivalent reads it.
		const json = row.toJSON() as { components?: Array<{ custom_id?: string }> };
		return (json.components ?? []).some((component) => component.custom_id === COMMUNITY_CUSTOM_IDS.enable || component.custom_id === COMMUNITY_CUSTOM_IDS.configure);
	});
}

function deferred(guildId: string, reason: DeferReason): CommunityPointerOutcome {
	console.warn(`[community-pointer] guild ${guildId} pointer deferred: ${reason}`);
	return "deferred";
}
