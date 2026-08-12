import { PermissionFlagsBits } from "discord.js";

// ── channelOverwrites ────────────────────────────────────────────────
// What:  the permission overwrite shapes that more than one feature has to agree on.
//        Today that is exactly one: the bot's own overwrite on a channel it manages.
// Who:   GuildSetupManager (the homebase category, all ten channels, and every repair)
//        and roomPermissions (every game room channel).
// When:  at channel-create time and on every repair or lock.
// Where: deliberately in utils rather than in either feature, because a util may not
//        import a feature. roomPermissions is a PURE module and must stay so; importing
//        GuildSetupManager to reach this set would drag the stores, the copy packs and
//        ChannelContent into it, and would risk an import cycle through the setup feature.
// How:   a plain function of the bot's user id, so both callers reach it without a Guild.
//
// ⚠️ THIS EXISTS TO PREVENT A SECOND COPY OF THE LIST. This codebase has been bitten
// repeatedly by two hand-maintained lists that must agree and silently do not (see the
// CHANNEL_SPECS family). A bot overwrite that is right in setup and one flag short in
// game rooms would produce a room the bot cannot post into, discovered at post time.

// Every permission the bot needs on a channel it owns.
//
// ViewChannel and SendMessages are the load-bearing pair: a channel that denies
// @everyone SendMessages (every public homebase channel, every public room) would
// otherwise suppress the bot's OWN posts, and one that denies @everyone ViewChannel
// (the admin channels, every invite-only room) would hide the channel from the bot
// entirely, because the bot is a member of @everyone like anyone else. Both failures
// surface at post time, long after the create reported success.
export function buildBotSelfOverwrite(botId: string): { id: string; allow: bigint[] } {
	return {
		id: botId,
		allow: [
			PermissionFlagsBits.ViewChannel,
			PermissionFlagsBits.ManageChannels,
			PermissionFlagsBits.ManageRoles,
			PermissionFlagsBits.SendMessages,
			PermissionFlagsBits.EmbedLinks,
			PermissionFlagsBits.ReadMessageHistory,
			PermissionFlagsBits.ManageMessages,
			PermissionFlagsBits.AddReactions,
			PermissionFlagsBits.MentionEveryone,
		],
	};
}
