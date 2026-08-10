import { Client, TextChannel, Message, DiscordAPIError } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { eventStore } from "@db/stores/eventStore.js";
import { activityStore } from "@db/stores/activityStore.js";
import { leaderboardEmbed } from "@utils/embedBuilder.js";
import { thisWeekRange, weekBoundaryTitle, type WeekStart } from "@features/leaderboard/leaderboardWindow.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── LeaderboardBoard ──────────────────────────────────────────────────
// Owns a single pinned message per guild in the leaderboard channel created
// during /setup. The message shows this week's participation standings,
// aggregated across every event the guild runs, and refreshes itself so
// members see the leaderboard without running /leaderboard. (v1.6 Phase 2,
// item 13.)
//
// Refresh triggers:
//  1. After ReminderScheduler fires a real reminder (ReminderJob.fireReminder).
//  2. After ActivityTracker writes a ✅ reaction or voice session row, coalesced
//     per guild (scheduleLeaderboardRefresh) so a busy event does not produce
//     dozens of edits.
//  3. Once per boot via the startup sweep (refreshAllLeaderboards in main.ts)
//     so a long-offline bot is not stale, plus the hourly safety tick in
//     ReminderScheduler which also catches the weekly window rolling over with
//     no activity to trigger a refresh.
//
// Invariants (mirrors ScheduleBoard):
//  1. One message per guild. Stored on GuildConfig.leaderboardMessageId.
//  2. Edit in place whenever possible. If the message was deleted by an admin
//     we recover by posting a new one and updating the stored id.
//  3. Never throw. Refresh failures are logged and swallowed so they cannot
//     block the triggering action (reminder fire, activity write, boot sweep).
//  4. If the guild has not finished /setup (no leaderboardChannelId) we bail
//     quietly. Setup reaches its own terminal state eventually.
//  5. NOT gated on leaderboardTrackingEnabled: that toggle only stops new
//     writes; historical standings keep rendering, same as /leaderboard.

/**
 * Refresh the leaderboard board for a single guild. Safe to call fire and
 * forget, swallows any error and logs it. Returns nothing.
 */
export async function refreshLeaderboard(client: Client, guildId: string): Promise<void> {
	try {
		const config = await guildConfigStore.findByGuildId(guildId);
		// self-destructed guild: homebase channels are gone, nothing to refresh.
		if (config?.homebaseDestroyed) return;
		if (!config?.leaderboardChannelId) {
			// guild has not finished its home base build yet. silent bail is
			// correct, autoSetup / ensureHomebase will take care of this state.
			return;
		}

		const channel = await client.channels.fetch(config.leaderboardChannelId).catch(() => null);
		if (!channel || !(channel instanceof TextChannel)) {
			console.error(LOG_MESSAGES.leaderboard.channelMissing(config.leaderboardChannelId, guildId));
			return;
		}

		// Weekly window anchored to the guild's configured weekStart (Phase 1).
		// Legacy/unset config falls back to Sunday, matching the /leaderboard
		// "This week" view.
		const weekStart: WeekStart = config.weekStart === "monday" ? "monday" : "sunday";
		const range = thisWeekRange(weekStart);

		// Aggregate this week's standings across every event the guild owns. Same
		// server-side aggregation primitive the /leaderboard command uses, with a
		// dateRange so the board scopes to the current week.
		const events = await eventStore.findByGuildId(guildId);
		const eventIds = events.map((e) => e.eventId);
		const records = await activityStore.findAllGroupedByPlayerInEvents(eventIds, range);

		// Top 10, same shape /leaderboard renders. An empty list is fine, the
		// embed builder renders the board's empty-state copy in that case.
		const ranked = records.slice(0, 10).map(
			(r: { username: string; totalScore: number; eventsAttended: number; totalAcknowledged: number }) => ({
				username: r.username,
				totalScore: r.totalScore,
				eventsAttended: r.eventsAttended,
				totalAcknowledged: r.totalAcknowledged,
			})
		);

		const embed = leaderboardEmbed(weekBoundaryTitle(weekStart), ranked, config);

		await postOrEdit(channel, config.leaderboardMessageId ?? null, embed, guildId);
	} catch (error) {
		console.error(LOG_MESSAGES.leaderboard.unexpectedError(guildId), error);
	}
}

/**
 * Refresh every guild the bot is installed in. Used on bot startup and by the
 * hourly cron tick in ReminderScheduler. Errors in any single guild do not
 * stop the sweep.
 */
export async function refreshAllLeaderboards(client: Client): Promise<void> {
	for (const [guildId] of client.guilds.cache) {
		await refreshLeaderboard(client, guildId);
	}
}

// ── activity-driven refresh (coalescing throttle) ───────────────────────
// Per-guild timers so a flurry of activity collapses to one edit per window.
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Request a leaderboard refresh after activity, coalesced per guild. Safe to
 * call on every ✅ reaction / voice event, at most one refresh fires per
 * guild per LEADERBOARD_REFRESH_DEBOUNCE_MS window.
 */
export function scheduleLeaderboardRefresh(client: Client, guildId: string): void {
	// Coalescing throttle, NOT a reset-on-each-call debounce: the FIRST activity
	// schedules a refresh one window out and subsequent activity within that
	// window is absorbed (the timer is left running). This guarantees the board
	// updates at least once per window during a busy event, where a reset-style
	// debounce would starve the board for the whole event if reactions never
	// pause for a full window.
	if (refreshTimers.has(guildId)) return;
	const timer = setTimeout(() => {
		refreshTimers.delete(guildId);
		refreshLeaderboard(client, guildId).catch((err) =>
			console.error(LOG_MESSAGES.leaderboard.refreshAfterActivityFailed, err)
		);
	}, BOT_CONSTANTS.LEADERBOARD_REFRESH_DEBOUNCE_MS);
	refreshTimers.set(guildId, timer);
}

// ── private helpers ────────────────────────────────────────────────────

async function postOrEdit(
	channel: TextChannel,
	existingMessageId: string | null,
	embed: ReturnType<typeof leaderboardEmbed>,
	guildId: string
): Promise<void> {
	// resolve our own bot id so the author guard below can compare cheaply.
	const selfId = channel.client.user?.id;

	// happy path: edit the existing message in place.
	if (existingMessageId) {
		try {
			const existing = await channel.messages.fetch(existingMessageId);

			// If the stored message is not authored by this bot the whole homebase
			// is stale (rotated token, cross-environment DB seeding, shared cluster).
			// ScheduleBoard owns the heavyweight rebuildHomebase recovery; the
			// leaderboard board must NOT trigger a second rebuild nor post into a
			// foreign channel. Bail quietly, the next refresh after ScheduleBoard
			// has rebuilt the homebase will post a fresh board we own.
			if (selfId && existing.author.id !== selfId) {
				console.warn(LOG_MESSAGES.leaderboard.staleAuthor(existingMessageId, guildId));
				return;
			}

			// Embed-only board: the Phase 5 power-up buttons live on a separate
			// pinned message, so there are no components to reapply here.
			await existing.edit({ embeds: [embed] });
			return;
		} catch (error) {
			// 10008 Unknown Message → admin deleted it. 10003 Unknown Channel →
			// channel was wiped. Both resolve the same way: drop into the post path
			// and send a fresh message, updating the stored id.
			if (error instanceof DiscordAPIError && (error.code === 10008 || error.code === 10003)) {
				console.warn(LOG_MESSAGES.leaderboard.storedMessageDeleted(existingMessageId, guildId));
			} else if (error instanceof DiscordAPIError && error.code === 50005) {
				// cache race: the pre-check missed the author mismatch but Discord
				// caught it on edit. Same posture as the pre-check, bail, do not
				// repost into a channel we may not own.
				console.warn(LOG_MESSAGES.leaderboard.staleAuthor(existingMessageId, guildId));
				return;
			} else {
				console.error(LOG_MESSAGES.leaderboard.editFailed(existingMessageId, guildId), error);
				// unknown error: do not fall through. the next trigger retries.
				return;
			}
		}
	}

	// recovery path (or first post ever): send a new message, pin it, persist the id.
	let message: Message;
	try {
		message = await channel.send({ embeds: [embed] });
	} catch (error) {
		console.error(LOG_MESSAGES.leaderboard.postFailed(guildId), error);
		return;
	}

	// No pin: the leaderboard channel is read-only, so the board stays put without
	// one (2026-06 pinning policy, only the member-writable introductions channel
	// is pinned).

	await guildConfigStore.update(guildId, { leaderboardMessageId: message.id });
}
