import { Events, TextChannel, escapeMarkdown, type Client, type GuildMember, type PartialGuildMember } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { greetAllowed } from "@features/greeter/welcomeNewMember.js";

// ── welcomeLog ───────────────────────────────────────────────────────
// What:  the 👋welcome channel's join and leave log (2026-10 item 247 Phase 2):
//        one short embed per member who joins or leaves, naming them by display
//        name. It greets nobody (the greeter does that in introductions) and
//        pings nobody.
// Who:   registered once from main.ts beside registerGreeter, which listens to the
//        same GuildMemberAdd for the icebreaker. Two listeners on one event, on
//        purpose: the log and the welcome are different jobs in different channels.
// When:  every non bot join and leave in a guild whose row names a welcome
//        channel. A self destructed homebase is skipped, and a raid is bounded by
//        the greeter's throttle in a bucket of its own.
// How:   ① drop bots; ② take a throttle slot; ③ read the row and resolve the
//        channel; ④ post. Fire and forget: a failure is logged with ids only and
//        never reaches the gateway listener.

/** Which side of the door a member went. */
export type WelcomeLogEvent = "join" | "leave";

// Its own budget in the greeter's throttle, so the log and the welcome do not
// spend each other's slots on the same join.
const WELCOME_LOG_THROTTLE_BUCKET = "welcome-log";

/** Post one join or leave line to the guild's welcome channel. Resolves true only when it posted; never throws. */
export async function postWelcomeLogEntry(member: GuildMember | PartialGuildMember, event: WelcomeLogEvent): Promise<boolean> {
	// A bot joining is not an arrival anyone needs logged, and that includes Dero
	// itself being removed from a server.
	if (member.user.bot) return false;
	if (!greetAllowed(member.guild.id, WELCOME_LOG_THROTTLE_BUCKET)) {
		console.warn(`[welcome-log] join-flood throttle hit in guild ${member.guild.id}; skipping a ${event} line`);
		return false;
	}

	try {
		const config = await guildConfigStore.findByGuildId(member.guild.id);
		if (!config?.welcomeChannelId || config.homebaseDestroyed) return false;
		const channel = await member.client.channels.fetch(config.welcomeChannelId).catch(() => null);
		if (!(channel instanceof TextChannel)) return false;

		const copy = getPluginCopy(config);
		const welcome = copy.channelContent.welcome;
		// escapeMarkdown, because a display name is the member's own text and a name
		// made of asterisks or backticks would otherwise restyle the whole line.
		const name = escapeMarkdown(member.displayName);
		const embed =
			event === "join"
				? infoEmbed(welcome.joinTitle, welcome.joinLine(name), copy.COLORS.ARRIVAL)
				: infoEmbed(welcome.leaveTitle, welcome.leaveLine(name), copy.COLORS.DERO);
		await channel.send({ embeds: [embed.setTimestamp()], allowedMentions: { parse: [] } });
		return true;
	} catch (error) {
		console.warn(`[welcome-log] failed to post a ${event} line for ${member.id} in guild ${member.guild.id}`, error);
		return false;
	}
}

/** Attach the join and leave listeners. Called once at boot from main.ts. */
export function registerWelcomeLog(client: Client): void {
	client.on(Events.GuildMemberAdd, (member) => void postWelcomeLogEntry(member, "join"));
	client.on(Events.GuildMemberRemove, (member) => void postWelcomeLogEntry(member, "leave"));
}
