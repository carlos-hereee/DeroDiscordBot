import { Client, TextChannel } from "discord.js";
import { IGameEvent } from "@features/events/event.types.js";
import { reminderStore } from "@db/stores/reminderStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { reminderEmbed } from "@utils/embedBuilder.js";
import { buildAudienceMention } from "@utils/mentions.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { refreshNextUp } from "@features/schedule/NextUpBoard.js";
import { refreshLeaderboard } from "@features/leaderboard/LeaderboardBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

export async function fireReminder(client: Client, event: IGameEvent, occurrence: Date, offsetMinutes: number): Promise<void> {
	// ① resolve the destination channel. the single source of truth is the
	// guild's configured announcements channel. there is no per-event override
	// and never will be, the home base's announcement channel is the one place
	// an admin can move reminders. if the guild has not finished /setup we bail
	// because blindly posting to a wrong channel is worse than missing a fire.
	const config = await guildConfigStore.findByGuildId(event.guildId);
	if (!config?.announcementsChannelId) {
		console.error(LOG_MESSAGES.reminder.noAnnouncementsChannel(event.guildId));
		return;
	}

	const channel = await client.channels.fetch(config.announcementsChannelId);
	if (!channel || !(channel instanceof TextChannel)) {
		console.error(LOG_MESSAGES.reminder.channelNotFound(config.announcementsChannelId));
		return;
	}

	// ② build the embed. Resolve the event image with the guild default as the
	// fallback (media attachments). null when neither is set, in which case
	// reminderEmbed renders no thumbnail and the embed is unchanged from before.
	const img = event.imageUrl ?? config.defaultEventImageUrl ?? null;
	const embed = reminderEmbed(event, occurrence, offsetMinutes, img, config);

	// ③ compose the mention via the shared audience helper. A per-event override
	// (event.mentionRoleId) targets exactly that role, a deliberate narrow
	// audience (e.g. a streamer's "stream notifications" role), and is left as-is.
	// With no override the default audience is the guild member role PLUS the
	// opt-in "🔔 Announcements" role (config.notificationsRoleId), so a member who
	// tapped Toggle pings is added to event pings without anyone losing the
	// whole-member reach. Legacy guilds with neither role fall back to @here. The
	// helper returns content + allowedMentions together so the role we name can
	// never diverge from the role we whitelist.
	const { content: mention, allowedMentions } = buildAudienceMention({
		overrideRoleId: event.mentionRoleId,
		memberRoleId: config.memberRoleId,
		notificationsRoleId: config.notificationsRoleId,
	});

	// ④ post the message. allowedMentions (from the helper) whitelists exactly the
	// roles named in `content`, so a malformed event description cannot smuggle an
	// @everyone ping.
	const message = await channel.send({
		content: mention,
		embeds: [embed],
		allowedMentions,
	});

	// ⑤ add the acknowledgement reaction
	await message.react("✅");

	// ⑥ log to DB, this is what prevents duplicate fires
	// and what the ActivityTracker uses to link reactions back to events
	await reminderStore.create({
		eventId: event.eventId,
		eventOccurrence: occurrence,
		offsetMinutes,
		messageId: message.id,
		channelId: channel.id,
		firedAt: new Date(),
	});

	// ⑦ refresh the pinned schedule board so the "next occurrence" for this
	// event advances visibly. fire and forget so a Discord hiccup here
	// cannot undo the successful reminder fire.
	refreshSchedule(client, event.guildId).catch((err) => console.error(LOG_MESSAGES.schedule.refreshAfterReminderFailed, err));

	// ⑧ post any new upcoming decrees in the next-decree channel for this
	// guild. Fire-and-forget for the same reason as refreshSchedule above,
	// the NextUpBoard channel is append-only and a missed post just means
	// the next refresh trigger (next fire, next boot) catches up.
	refreshNextUp(client, event.guildId).catch((err) => console.error("[reminder] refreshNextUp failed after fire", err));

	// ⑨ refresh the pinned leaderboard board so this week's standings reflect
	// the fresh acknowledgement window. Fire-and-forget for the same reason as
	// the two refreshes above, a Discord hiccup here must not undo the
	// successful reminder fire.
	refreshLeaderboard(client, event.guildId).catch((err) => console.error(LOG_MESSAGES.leaderboard.refreshAfterReminderFailed, err));
}

/*

**Why the DB write happens last:**

The order here is intentional, post to Discord first, then write to DB.
If you did it in reverse and the Discord post failed, you'd have a DB record
saying the reminder fired when it never did, and the duplicate check would
block it from ever retrying. Failing fast before writing means a failed post
is always retryable on the next cron tick.

**Why Discord timestamps (`<t:...:F>`):**

Discord renders `<t:UNIX_TIMESTAMP:F>` in each user's own local timezone automatically.
So a Spanish speaker and an Arabic speaker in different timezones both see the event time
correctly without you doing any timezone math.

---

## The full picture as one sequence

ClientReady fires
      │
      ▼
startScheduler(client)
      │
      ▼  every 60 seconds
cron.schedule ticks
      │
      ▼
eventStore.findByGuildId(g)   ← what events exist? (per-guild, Future-A safe)
      │
      ▼
getUpcomingOccurrences()      ← when is the next one? (pure math, no DB)
      │
      ▼
diff within fire window?
      ├── NO  → skip, wait for next tick
      └── YES ▼

reminderStore.exists()        ← did we already fire this one?
      ├── YES → skip (duplicate protection)
      └── NO  ▼

fireReminder()
      ├── resolve channel from GuildConfig.announcementsChannelId
      ├── build embed
      ├── post message with role ping + react ✅
      └── reminderStore.create() ← write LAST, so failures are retryable

      */
