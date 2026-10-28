import { ChannelType, PermissionFlagsBits, type Guild, type GuildMember, type NewsChannel, type TextChannel } from "discord.js";

// ── channelGate ───────────────────────────────────────────────────────────
// What:  the one rule for whether Dero may post in a channel on a speaker's
//        behalf: on the list a task may post in (taskChannel.ts: the guild's
//        💬dero-commands, since the text allowlist retired), present in THIS guild's cache, a
//        text or announcement channel, sendable by the bot, and visible to the
//        speaker.
// Who:   brainJob (which channels a job offers the brain) and the executor
//        (whether a post_message may go out). One helper for both (house rule
//        17), so the brain is never offered a channel the executor would refuse,
//        and never refused one it was offered unless something changed between.
// When:  at job creation and again at execution.
// Where: reads the guild cache only, never the API, and looks a channel up by
//        id only. There is no path from a channel NAME to a channel here.
// How:   the allowlist check runs first and is pure, so a brain naming an
//        unlisted channel costs nothing and touches nothing.
//
// The speaker visibility check is what keeps the plan's privacy rule ("the
// brain never receives any id the speaker could not already see") true when the
// task channel is one a member cannot read: they can neither see it offered to
// the brain nor make Dero post in it.

export type PostableChannel = TextChannel | NewsChannel;

export type ChannelRefusal = "channel_not_allowed" | "channel_unavailable" | "bot_lacks_permission" | "channel_not_visible";

export type ChannelGateResult = { ok: true; channel: PostableChannel } | { ok: false; reason: ChannelRefusal };

const BOT_POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

export interface ChannelGateInput {
	guild: Guild;
	channelId: string;
	allowedChannelIds: readonly string[];
	speaker: GuildMember;
}

/** Whether Dero may post in this channel for this speaker, and the channel when it may. */
export function checkPostableChannel({ guild, channelId, allowedChannelIds, speaker }: ChannelGateInput): ChannelGateResult {
	if (!allowedChannelIds.includes(channelId)) return { ok: false, reason: "channel_not_allowed" };

	const channel = guild.channels.cache.get(channelId);
	// The guild match is belt and braces: this guild's cache should only hold its
	// own channels, but a result is bound to its job's guild and this line says so.
	if (!channel || channel.guildId !== guild.id) return { ok: false, reason: "channel_unavailable" };
	if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
		return { ok: false, reason: "channel_unavailable" };
	}

	const botMember = guild.members.me;
	if (!botMember || !channel.permissionsFor(botMember)?.has(BOT_POST_PERMISSIONS)) {
		return { ok: false, reason: "bot_lacks_permission" };
	}
	if (!channel.permissionsFor(speaker)?.has(PermissionFlagsBits.ViewChannel)) {
		return { ok: false, reason: "channel_not_visible" };
	}
	return { ok: true, channel };
}
