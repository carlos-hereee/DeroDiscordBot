import { Client, TextChannel } from "discord.js";
import { IGameEvent } from "@features/events/event.types.js";
import { reminderStore } from "@db/stores/reminderStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { testReminderEmbed } from "@utils/embedBuilder.js";
import { buildAudienceMention } from "@utils/mentions.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getUpcomingOccurrences } from "@features/events/occurrenceCalculator.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

// ── return type ───────────────────────────────────────────────
// route handler surfaces this to the dashboard. ok === true means the embed
// was posted to the channel. ok === false means the post never happened
// and the reason should be shown to the admin.
export type TTestReminderResult =
	| { ok: true; messageId: string; channelId: string; firedAt: Date }
	| {
			ok: false;
			reason: "guild_not_configured" | "channel_not_found" | "channel_wrong_type" | "post_failed";
			detail?: string;
	  };

/**
 * Fire a TEST reminder for an event from the dashboard.
 *
 * This is NOT a real reminder. It exists purely so alliance admins can verify
 * bot permissions and prep step formatting end to end without waiting for a
 * real event window.
 *
 * Invariants (do not break these):
 *   1. The embed title MUST be prefixed with [TEST]. testReminderEmbed handles it.
 *   2. NO PlayerActivity record is written. This route must not touch
 *      ParticipationStore or the ActivityTracker code path.
 *   3. The existing reminderStore duplicate check (keyed on
 *      eventId + eventOccurrence + offsetMinutes) must not block repeated test
 *      fires. We do this by writing the log entry with the sentinel offset
 *      BOT_CONSTANTS.REMINDER_LOG_OFFSETS.TEST, and by using firedAt (now) as
 *      the eventOccurrence so the compound unique index never collides.
 *   4. The test fire still writes to ReminderLog so there is an audit trail,
 *      but the sentinel offset lets any future "reminder history" view filter
 *      tests out of real reminder history.
 *   5. Rate limiting is enforced by the caller (the route handler). This
 *      function does not re-check the cooldown.
 */
export async function fireTestReminder(client: Client, event: IGameEvent): Promise<TTestReminderResult> {
	// ① resolve the destination channel. mirrors fireReminder: the single
	// source of truth is the guild's announcements channel set during /setup.
	// no per-event override. if the guild has not finished /setup the test
	// fire surfaces a readable reason to the dashboard.
	const config = await guildConfigStore.findByGuildId(event.guildId);
	if (!config) {
		return { ok: false, reason: "guild_not_configured", detail: "No GuildConfig found for this guild. Run /setup first." };
	}

	if (!config.announcementsChannelId) {
		return { ok: false, reason: "channel_not_found", detail: "No announcements channel configured for this guild." };
	}

	let channel;
	try {
		channel = await client.channels.fetch(config.announcementsChannelId);
	} catch (error) {
		console.error(LOG_MESSAGES.testReminder.fetchChannelFailed(config.announcementsChannelId), error);
		return { ok: false, reason: "channel_not_found", detail: (error as Error).message };
	}

	if (!channel) {
		return { ok: false, reason: "channel_not_found" };
	}
	if (!(channel instanceof TextChannel)) {
		return { ok: false, reason: "channel_wrong_type" };
	}

	// ② pick a "next occurrence" to show in the embed time field.
	// this is cosmetic — it lets the admin see how the real reminder will look.
	// if the event has no upcoming occurrences (eg season already ended),
	// we fall back to firstOccurrence so the embed still renders something sensible.
	const upcoming = getUpcomingOccurrences(event, 1);
	const nextOccurrence = upcoming.length > 0 ? upcoming[0] : new Date(event.firstOccurrence);

	// ③ build the embed. the [TEST] prefix lives inside testReminderEmbed
	// so it cannot be accidentally removed by a caller.
	const embed = testReminderEmbed(event, nextOccurrence, config);

	// ④ post the message. Mirror the real ReminderJob's audience EXACTLY (same
	// buildAudienceMention helper) so the test fire preview shows precisely which
	// role(s) the real fire would ping: a per-event override, else the guild member
	// role PLUS the opt-in "🔔 Announcements" role, else @here. We take only the
	// helper's `content`; allowedMentions stays fully suppressed below so the
	// role(s) render as a styled mention without anyone actually being notified.
	// This matches the spec invariant: the test fire must never ping the whole
	// channel or any role every time the admin clicks the button.
	const { content: mentionPreview } = buildAudienceMention({
		overrideRoleId: event.mentionRoleId,
		memberRoleId: config.memberRoleId,
		notificationsRoleId: config.notificationsRoleId,
	});
	let message;
	try {
		message = await channel.send({
			content: mentionPreview,
			embeds: [embed],
			allowedMentions: { parse: [], roles: [], users: [] },
		});
	} catch (error) {
		console.error(LOG_MESSAGES.testReminder.postFailed(config.announcementsChannelId), error);
		return { ok: false, reason: "post_failed", detail: (error as Error).message };
	}

	// ⑤ log to DB with the TEST sentinel so the compound unique index
	// { eventId, eventOccurrence, offsetMinutes } never collides across
	// repeated tests. firedAt is passed as eventOccurrence to guarantee
	// a unique tuple even in the pathological case where two tests fire
	// in the same millisecond.
	const firedAt = new Date();
	try {
		await reminderStore.create({
			eventId: event.eventId,
			eventOccurrence: firedAt,
			offsetMinutes: BOT_CONSTANTS.REMINDER_LOG_OFFSETS.TEST,
			messageId: message.id,
			channelId: channel.id,
			firedAt,
		});
	} catch (error) {
		// the post already went out, so we still return ok: true.
		// the audit trail is the only thing affected by a log write failure.
		console.error(LOG_MESSAGES.testReminder.logWriteFailedAfterPost, error);
	}

	return { ok: true, messageId: message.id, channelId: channel.id, firedAt };
}
