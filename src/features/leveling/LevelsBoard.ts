import { AttachmentBuilder, Client, DiscordAPIError, EmbedBuilder, Message, TextChannel } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { levelFromTotalXp } from "./levelCurve.js";
import { levelingCopy } from "./levelingCopy.js";
import { buildLevelsBoardCardEmbed, buildLevelsBoardEmbed, type LevelsBoardEntry } from "./levelingEmbeds.js";
import { getLevelingConfig } from "./levelingConfig.js";
import { LEVELS_BOARD_AVATAR_SIZE, renderLevelsBoardCard } from "./levelsBoardRenderer.js";
import { avatarRequestFor, isRenderPayload, withRenderFallback, type AvatarRequest } from "@features/renderer/index.js";
import { BOARD_POSTED, boardNotPosted, type BoardRefreshResult } from "@base/interfaces/IBoardRefreshResult.js";

// ── LevelsBoard ────────────────────────────────────────────────────────────
// A SECOND self-refreshing message in the guild's leaderboard channel, beside
// the participation board that has been there since v1.6.
//
// What:  the guild's all-time xp standings, edited in place.
// Who:   a boot sweep in main.ts, the hourly safety tick in ReminderScheduler,
//        and a coalesced refresh after a level up.
// When:  at most once per guild per LEADERBOARD_REFRESH_DEBOUNCE_MS window.
// Where: the SAME channel as LeaderboardBoard, anchored by its own
//        GuildConfig.levelsMessageId. It must never read or write
//        leaderboardMessageId.
//
// ⚠️ TWO BOARDS IN ONE CHANNEL IS THE MOST LIKELY CONFUSION IN THIS FEATURE, for
// members and for the next engineer alike. They answer different questions:
//
//   LeaderboardBoard   participation SCORE, aggregated from PlayerActivity,
//                      keyed by event and occurrence. "Did this warrior show up
//                      for this KvK event?"
//   this one           XP and LEVELS, from MemberLevel. "How present is this
//                      member in this server over time?"
//
// So every embed this renders carries a one line subtitle saying which question
// it answers, and its color is deliberately far from the participation board's
// Gold. Do NOT import LeaderboardBoard and do NOT try to generalize the two into
// one module: they read different collections, render different embeds, and
// answer different questions. Two clear files beat one abstract one here.
//
// ⚠️ NO NEW DISCORD CHANNEL. Reusing leaderboardChannelId is a deliberate cost
// decision: a levels channel would need a CHANNEL_SPECS entry, a SLOT_LABELS
// entry in features/setup/renameChannel.ts, a rename path, and a backfill for every existing
// guild, and GuildSetupManager.createChannels has ZERO test coverage today. All
// of that to separate two things that are both standings.
//
// ⚠️ THE BOARD IS ALL TIME, deliberately. "This week" and "this month" live on
// /account view:levels instead. The board's own subtitle promises presence "all the time",
// and an all-time render needs no join: the period collection stores a userId
// and an xp total but no display name, so a weekly board would have to look up
// every member on every refresh to say who they are.

/**
 * Refresh one guild's levels board. Safe to call fire and forget: it swallows
 * every error and logs it, so a refresh failure can never block the level up,
 * boot sweep, or cron tick that triggered it. Says whether the board was posted
 * or edited, and why not when it was not; only Refresh standings reads that.
 */
export async function refreshLevelsBoard(client: Client, guildId: string): Promise<BoardRefreshResult> {
	try {
		const context = await getLevelingConfig(guildId);
		// Self destructed guild: the homebase channels are gone, nothing to refresh.
		if (!context) return boardNotPosted("not-set-up");
		if (context.homebaseDestroyed) return boardNotPosted("homebase-destroyed");
		// A guild that turned leveling off keeps its board rather than having it
		// wiped: the standings are history, and the toggle stops new writes, not
		// old data. Same posture as leaderboardTrackingEnabled.
		if (!context.leaderboardChannelId) {
			// Setup has not finished. Silent bail is correct, autoSetup and
			// ensureHomebase reach their own terminal state eventually.
			return boardNotPosted("not-set-up");
		}

		const channel = await client.channels.fetch(context.leaderboardChannelId).catch(() => null);
		if (!channel || !(channel instanceof TextChannel)) {
			console.error(LOG_MESSAGES.leveling.boardChannelMissing(context.leaderboardChannelId, guildId));
			return boardNotPosted("channel-missing");
		}

		const settings = context.settings;
		const rows = await memberLevelStore.topByTotalXp(guildId, 10);
		const avatars = await resolveBoardAvatars(client, guildId, rows.map((row) => row.userId));
		const entries: LevelsBoardEntry[] = rows.map((row) => ({
			userId: row.userId,
			username: row.username,
			// Derived, never stored, so the board cannot drift from /account after a
			// curve change the way a cached level field would.
			level: levelFromTotalXp(row.totalXp, settings.curve, settings.curveMultiplier, settings.maxLevel),
			xp: row.totalXp,
			avatar: avatars.get(row.userId) ?? null,
		}));

		// The card when it renders, the text board when it does not.
		const windowLabel = levelingCopy.board.allTime;
		const board = await withRenderFallback(
			() => renderLevelsBoardCard(windowLabel, entries),
			() => buildLevelsBoardEmbed(windowLabel, entries)
		);
		const message: BoardMessage = isRenderPayload(board)
			? { embeds: [buildLevelsBoardCardEmbed(windowLabel, board.ref)], files: [board.attachment] }
			: { embeds: [board], files: [] };
		const config = await guildConfigStore.findByGuildId(guildId);
		return await postOrEdit(channel, (config?.levelsMessageId as string | null) ?? null, message, guildId);
	} catch (error) {
		console.error(LOG_MESSAGES.leveling.boardPostFailed(guildId), error);
		return boardNotPosted("unexpected-error");
	}
}

/**
 * Refresh every guild. Used by the boot sweep and the hourly cron tick. An error
 * in one guild never stops the sweep.
 */
export async function refreshAllLevelsBoards(client: Client): Promise<void> {
	for (const [guildId] of client.guilds.cache) {
		await refreshLevelsBoard(client, guildId);
	}
}

// The board's faces, for the members still in the guild. Members missing from
// the cache are fetched in one gateway request rather than one REST call each,
// and a member who left simply draws the placeholder. Never throws: a board
// without faces is still a board.
async function resolveBoardAvatars(client: Client, guildId: string, userIds: readonly string[]): Promise<Map<string, AvatarRequest>> {
	const avatars = new Map<string, AvatarRequest>();
	try {
		const guild = client.guilds.cache.get(guildId);
		if (!guild || userIds.length === 0) return avatars;
		const uncached = userIds.filter((userId) => !guild.members.cache.has(userId));
		if (uncached.length > 0) {
			await guild.members.fetch({ user: [...uncached] }).catch((error: unknown) => {
				console.warn(LOG_MESSAGES.leveling.boardAvatarsFailed(guildId), error);
			});
		}
		for (const userId of userIds) {
			const member = guild.members.cache.get(userId);
			if (member) avatars.set(userId, avatarRequestFor(member.user, LEVELS_BOARD_AVATAR_SIZE));
		}
	} catch (error) {
		console.warn(LOG_MESSAGES.leveling.boardAvatarsFailed(guildId), error);
	}
	return avatars;
}

// ── the coalescing throttle ────────────────────────────────────────────────
// Copied in shape from scheduleLeaderboardRefresh, including the reasoning that
// is not obvious: the FIRST level up schedules a refresh one window out and
// every later one inside that window is ABSORBED with the timer LEFT RUNNING.
// Deliberately not a reset-on-each-call debounce, which would starve the board
// for an entire busy evening and only update once everything went quiet.
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleLevelsBoardRefresh(client: Client, guildId: string): void {
	if (refreshTimers.has(guildId)) return;
	const timer = setTimeout(() => {
		refreshTimers.delete(guildId);
		refreshLevelsBoard(client, guildId).catch((error) =>
			console.error(LOG_MESSAGES.leveling.boardPostFailed(guildId), error)
		);
	}, BOT_CONSTANTS.LEADERBOARD_REFRESH_DEBOUNCE_MS);
	timer.unref?.();
	refreshTimers.set(guildId, timer);
}

export const _clearLevelsBoardTimers = (): void => {
	for (const timer of refreshTimers.values()) clearTimeout(timer);
	refreshTimers.clear();
};

// ── postOrEdit ─────────────────────────────────────────────────────────────
// Structure, invariants and error taxonomy copied wholesale from
// LeaderboardBoard.postOrEdit. The three behaviours worth restating, because
// each of them is load bearing:
//
//   • a stored message NOT authored by this bot means the whole homebase is
//     stale (rotated token, cross environment DB seeding, a shared cluster).
//     BAIL QUIETLY. ScheduleBoard owns the heavyweight rebuild; a second board
//     must not trigger a second rebuild, and must never post into a channel it
//     may not own.
//   • 10008 (unknown message) and 10003 (unknown channel) both mean "an admin
//     deleted it", and both resolve the same way: fall through and post fresh,
//     persisting the new id.
//   • any OTHER error returns without posting, so the next trigger retries
//     rather than this one duplicating the board.
//
// An edit always sends `attachments: []` beside the new files. Without it the
// previous card stays attached under the new one, and a board that falls back to
// text would keep showing a stale card as a loose file.
interface BoardMessage {
	embeds: EmbedBuilder[];
	files: AttachmentBuilder[];
}

async function postOrEdit(channel: TextChannel, existingMessageId: string | null, board: BoardMessage, guildId: string): Promise<BoardRefreshResult> {
	const selfId = channel.client.user?.id;

	if (existingMessageId) {
		try {
			const existing = await channel.messages.fetch(existingMessageId);
			if (selfId && existing.author.id !== selfId) {
				console.warn(LOG_MESSAGES.leveling.boardStaleAuthor(existingMessageId, guildId));
				return boardNotPosted("foreign-message");
			}
			await existing.edit({ embeds: board.embeds, files: board.files, attachments: [] });
			return BOARD_POSTED;
		} catch (error) {
			if (error instanceof DiscordAPIError && (error.code === 10008 || error.code === 10003)) {
				console.warn(LOG_MESSAGES.leveling.boardStoredMessageDeleted(existingMessageId, guildId));
			} else if (error instanceof DiscordAPIError && error.code === 50005) {
				// Cache race: the author pre-check missed it but Discord caught it on
				// edit. Same posture as the pre-check, bail rather than repost.
				console.warn(LOG_MESSAGES.leveling.boardStaleAuthor(existingMessageId, guildId));
				return boardNotPosted("foreign-message");
			} else {
				console.error(LOG_MESSAGES.leveling.boardEditFailed(existingMessageId, guildId), error);
				return boardNotPosted("edit-failed");
			}
		}
	}

	let message: Message;
	try {
		message = await channel.send({ embeds: board.embeds, files: board.files });
	} catch (error) {
		console.error(LOG_MESSAGES.leveling.boardPostFailed(guildId), error);
		return boardNotPosted("post-failed");
	}

	// No pin, matching LeaderboardBoard: the leaderboard channel is read only so
	// the board stays put without one, and the 2026-06 pinning policy only pins
	// the member-writable introductions channel.
	//
	// ⚠️ levelsMessageId, never leaderboardMessageId. Writing the wrong field
	// would make each board overwrite the other's message on every refresh.
	await guildConfigStore.update(guildId, { levelsMessageId: message.id });
	return BOARD_POSTED;
}
